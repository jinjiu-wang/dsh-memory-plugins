#!/usr/bin/env node
// 小肥鱼鲸鱼娘 · 自检（不碰真实记忆，全部在临时目录）
//   node selfcheck.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { detectPython, normalizeConfig } from './src/core/config.mjs';
import {
  linkEnabled,
  readLinkState,
  readLocalSettings,
  writeLinkFlag,
  writeLocalSettings,
} from './src/core/state.mjs';
import { PythonService } from './src/host/python-service.mjs';

const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url));
const checks = [];
const notes = [];
function pass(name) {
  checks.push({ name, ok: true });
  console.log(`  ✔ ${name}`);
}
function fail(name, error) {
  checks.push({ name, ok: false });
  console.log(`  ✖ ${name}：${error instanceof Error ? error.message : String(error)}`);
}

async function step(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (error) {
    fail(name, error);
  }
}

console.log('小肥鱼鲸鱼娘 · 自检');

await step('必需文件齐全', () => {
  for (const rel of [
    'package.json',
    'cordis.patch.yml',
    'src/host/index.mjs',
    'src/host/python-service.mjs',
    'src/core/config.mjs',
    'src/core/state.mjs',
    'src/client/index.js',
    'python/bridge_server.py',
    'python/memory/interop.py',
  ]) {
    assert.ok(fs.existsSync(path.join(PKG_ROOT, rel)), `缺 ${rel}`);
  }
});

await step('JS 语法', () => {
  for (const rel of ['src/host/index.mjs', 'src/host/python-service.mjs', 'src/core/config.mjs', 'src/core/state.mjs', 'src/client/index.js']) {
    const result = spawnSync(process.execPath, ['--check', path.join(PKG_ROOT, rel)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${rel}: ${result.stderr || result.stdout}`);
  }
});

const python = detectPython();
await step('Python 语法', () => {
  const files = [path.join(PKG_ROOT, 'python', 'bridge_server.py')];
  const memoryDir = path.join(PKG_ROOT, 'python', 'memory');
  for (const name of fs.readdirSync(memoryDir)) {
    if (name.endsWith('.py')) files.push(path.join(memoryDir, name));
  }
  const result = spawnSync(
    python,
    [
      '-c',
      'import ast,sys,pathlib; [ast.parse(pathlib.Path(p).read_text(encoding="utf-8-sig"), filename=p) for p in sys.argv[1:]]',
      ...files,
    ],
    { encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  notes.push(`Python：${python}`);
});

await step('配置默认值与目录', () => {
  const config = normalizeConfig({});
  assert.ok(path.isAbsolute(config.dataDir));
  assert.ok(config.dbPath.endsWith('memory.db'));
  assert.ok(path.isAbsolute(config.bridgeDir));
  assert.equal(config.autoInterop, true);
});

await step('开关与共享 link 语义', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xiaofeiyu-self-'));
  assert.deepEqual(readLocalSettings(dir), { autoInterop: true });
  writeLocalSettings(dir, { autoInterop: false });
  assert.equal(readLocalSettings(dir).autoInterop, false);
  assert.equal(readLinkState(dir).aiLove, true);
  writeLinkFlag(dir, 'xiaofeiyu', false);
  assert.equal(readLinkState(dir).xiaofeiyu, false);
  assert.equal(linkEnabled(true, { aiLove: true, xiaofeiyu: false }), false);
  assert.equal(linkEnabled(true, { aiLove: true, xiaofeiyu: true }), true);
});

await step('Python 服务 ping / 导入 / 自动同步', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'xiaofeiyu-self-service-'));
  const bridgeDir = path.join(root, 'bridge');
  await fsp.mkdir(bridgeDir, { recursive: true });
  const service = new PythonService({
    python,
    dbPath: path.join(root, 'data', 'memory.db'),
    bridgeDir,
    logger: { warn() {} },
  });
  try {
    await service.ensureStarted(20000);
    const ping = await service.call('ping');
    assert.ok(ping.pid > 0);
    const record = {
      schema_version: 1,
      source: 'ai-love',
      external_id: 'self:fact:1',
      ts_ms: 1793000000000,
      chat_type: 'private',
      group_id: '',
      peer: 'u1',
      session_id: 's1',
      kind: 'fact',
      text: '自检事实。',
      status: 'confirmed',
      importance: 0.8,
      subject: '自检',
      category: '自检',
      ask: '',
      why: '',
    };
    await fsp.writeFile(path.join(bridgeDir, 'ai-love.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
    const synced = await service.call('auto_sync', {
      importFile: 'ai-love.jsonl',
      exportFile: 'xiaofeiyu-whale.jsonl',
    });
    assert.equal(synced.imported.fact, 1);
    assert.ok(synced.exported >= 1);
  } finally {
    await service.stop();
  }
});

await step('烟测套件', () => {
  const result = spawnSync(process.execPath, ['--test', path.join(PKG_ROOT, 'test', 'smoke.mjs')], {
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(result.status, 0, (result.stdout || '').split(/\r?\n/).slice(-12).join('\n'));
});

const failed = checks.filter((item) => !item.ok);
console.log('');
for (const note of notes) console.log(`  · ${note}`);
if (failed.length === 0) {
  console.log(`\n✅ 自检通过（${checks.length} 项）`);
} else {
  console.log(`\n❌ 自检失败 ${failed.length}/${checks.length} 项`);
  process.exitCode = 1;
}
