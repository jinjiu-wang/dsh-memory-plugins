// 小肥鱼鲸鱼娘：配置、开关、Python 记忆服务的烟测。
// 跑法：node --test test/smoke.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  detectPython,
  normalizeConfig,
  resolveBridgeFiles,
} from '../src/core/config.mjs';
import {
  linkEnabled,
  linkReason,
  readLinkState,
  readLocalSettings,
  writeLinkFlag,
  writeLocalSettings,
} from '../src/core/state.mjs';
import { PythonService } from '../src/host/python-service.mjs';

const tmp = (label) => fs.mkdtemp(path.join(os.tmpdir(), `xiaofeiyu-${label}-`));

function record(overrides = {}) {
  return {
    schema_version: 1,
    source: 'ai-love',
    external_id: '',
    ts_ms: 1793000000000,
    chat_type: 'private',
    group_id: '',
    peer: 'u1',
    session_id: 's1',
    kind: 'summary',
    text: '',
    status: '',
    importance: 0.5,
    subject: '',
    category: '',
    ask: '',
    why: '',
    ...overrides,
  };
}

test('配置：默认目录、区间夹紧、显式路径优先', () => {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(os.tmpdir(), 'xiaofeiyu-home');
  try {
    const config = normalizeConfig({});
    assert.equal(config.dataDir, path.join(process.env.DSH_HOME, 'xiaofeiyu-whale'));
    assert.equal(config.dbPath, path.join(config.dataDir, 'memory.db'));
    assert.equal(config.bridgeDir, path.join(process.env.DSH_HOME, 'memory-bridge'));
    assert.equal(config.autoInterop, true);
    assert.equal(config.intervalSeconds, DEFAULT_INTERVAL_SECONDS);

    const custom = normalizeConfig({
      dataDir: path.join(os.tmpdir(), 'xd'),
      bridgeDir: path.join(os.tmpdir(), 'xb'),
      intervalSeconds: 1,
      autoInterop: false,
    });
    assert.equal(custom.dataDir, path.resolve(path.join(os.tmpdir(), 'xd')));
    assert.equal(custom.dbPath, path.join(custom.dataDir, 'memory.db'));
    assert.equal(custom.bridgeDir, path.resolve(path.join(os.tmpdir(), 'xb')));
    assert.equal(custom.intervalSeconds, MIN_INTERVAL_SECONDS);
    assert.equal(custom.autoInterop, false);

    const files = resolveBridgeFiles(custom.bridgeDir);
    assert.equal(files.aiLoveFile, path.join(custom.bridgeDir, 'ai-love.jsonl'));
    assert.equal(files.peerFile, path.join(custom.bridgeDir, 'xiaofeiyu-whale.jsonl'));
    assert.equal(files.linkFile, path.join(custom.bridgeDir, 'link.json'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test('Python 探测：失效的显式路径回退，裸命令原样保留', () => {
  const missing = path.join(os.tmpdir(), 'xiaofeiyu-missing-python', 'python.exe');
  assert.notEqual(detectPython(missing), missing);
  assert.equal(detectPython('python.exe'), 'python.exe');

  const previous = process.env.XIAOFEIYU_PYTHON;
  process.env.XIAOFEIYU_PYTHON = 'python';
  try {
    assert.equal(detectPython(''), 'python');
  } finally {
    if (previous === undefined) delete process.env.XIAOFEIYU_PYTHON;
    else process.env.XIAOFEIYU_PYTHON = previous;
  }
});

test('开关：本地设置与共享 link.json 都要开才自动联通', async () => {
  const dir = await tmp('state');
  assert.deepEqual(readLocalSettings(dir), { autoInterop: true });

  writeLocalSettings(dir, { autoInterop: false });
  assert.deepEqual(readLocalSettings(dir), { autoInterop: false });
  writeLocalSettings(dir, { autoInterop: true });
  assert.deepEqual(readLocalSettings(dir), { autoInterop: true });

  assert.deepEqual(
    { ...readLinkState(dir), updatedAt: 0 },
    { aiLove: true, xiaofeiyu: true, updatedAt: 0 },
  );
  writeLinkFlag(dir, 'aiLove', false);
  assert.equal(readLinkState(dir).aiLove, false);
  writeLinkFlag(dir, 'aiLove', true);
  assert.equal(readLinkState(dir).aiLove, true);

  const open = { aiLove: true, xiaofeiyu: true, updatedAt: 0 };
  assert.equal(linkEnabled(true, open), true);
  assert.equal(linkEnabled(false, open), false);
  assert.equal(linkEnabled(true, { ...open, aiLove: false }), false);
  assert.equal(linkEnabled(true, { ...open, xiaofeiyu: false }), false);
  assert.match(linkReason(false, open), /本插件/);
  assert.match(linkReason(true, { ...open, aiLove: false }), /爱ai/);
  assert.match(linkReason(true, { ...open, xiaofeiyu: false }), /小肥鱼鲸鱼娘/);
  assert.equal(linkReason(true, open), '');
});

const python = detectPython();
const pythonMissing = python.includes(path.sep) && !existsSync(python);

test('Python 记忆服务：ping、导入、自动同步、导出、检索', { skip: pythonMissing }, async () => {
  const root = await tmp('bridge');
  const bridgeDir = path.join(root, 'bridge');
  const dbPath = path.join(root, 'data', 'memory.db');
  await fs.mkdir(bridgeDir, { recursive: true });
  const service = new PythonService({ python, dbPath, bridgeDir, logger: console });
  try {
    await service.ensureStarted(20000);
    const ping = await service.call('ping');
    assert.ok(ping.pid > 0);
    assert.equal(path.resolve(ping.db), path.resolve(dbPath));

    const incoming = [
      record({ external_id: 'ai-love:summary:s1:1', kind: 'summary', text: '周日一起去吃烤鸭。' }),
      record({
        external_id: 'ai-love:fact:s1:2',
        kind: 'fact',
        text: '用户不吃香菜。',
        subject: '饮食',
        category: '偏好',
        importance: 0.9,
        status: 'confirmed',
      }),
      record({
        external_id: 'ai-love:uncertain:s1:3',
        kind: 'uncertain',
        text: '生日只说了月份。',
        status: 'open',
        ask: '哪一天？',
      }),
    ];
    const body = incoming.map((row) => JSON.stringify(row)).join('\n');
    await fs.writeFile(path.join(bridgeDir, 'ai-love.jsonl'), `${body}\n`, 'utf8');

    const imported = await service.call('import_file', { file: 'ai-love.jsonl' });
    assert.equal(imported.result.summary, 1);
    assert.equal(imported.result.fact, 1);
    assert.equal(imported.result.uncertain, 1);

    const again = await service.call('import_file', { file: 'ai-love.jsonl' });
    assert.equal(again.result.summary, 0);
    assert.equal(again.result.summary_updated, 1);
    assert.equal(again.result.fact_updated, 1);
    assert.equal(again.result.uncertain_updated, 1);

    const state = await service.call('state', { limit: 10 });
    // 0.2.0 起「待确认」是独立表，不再混进 facts；facts 只算事实卡。
    assert.ok(state.stats.facts >= 1);
    assert.ok(state.stats.uncertain >= 1);
    assert.ok(state.stats.summaries >= 1);
    assert.ok(state.facts.some((row) => row.fact === '用户不吃香菜。'));
    assert.ok(state.pending.some((row) => row.fact === '生日只说了月份。'));

    const synced = await service.call('auto_sync', {
      importFile: 'ai-love.jsonl',
      exportFile: 'xiaofeiyu-whale.jsonl',
    });
    assert.ok(synced.exported >= 3);
    assert.equal(path.resolve(synced.exportFile), path.resolve(bridgeDir, 'xiaofeiyu-whale.jsonl'));

    const lines = (await fs.readFile(path.join(bridgeDir, 'xiaofeiyu-whale.jsonl'), 'utf8'))
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '');
    const kinds = new Set();
    for (const line of lines) {
      const row = JSON.parse(line);
      assert.equal(row.schema_version, 1);
      assert.ok(['summary', 'fact', 'note', 'uncertain'].includes(row.kind));
      assert.notEqual(row.kind, 'activity');
      assert.ok(row.external_id !== '');
      kinds.add(row.kind);
    }
    assert.ok(kinds.has('summary'));
    assert.ok(kinds.has('fact'));
    assert.ok(kinds.has('uncertain'));

    const found = await service.call('search', { query: '烤鸭', limit: 5 });
    assert.equal(found.query, '烤鸭');
    assert.ok(Array.isArray(found.hits));
  } finally {
    await service.stop();
  }
});

test('Python 记忆服务：越界路径被拒绝', { skip: pythonMissing }, async () => {
  const root = await tmp('escape');
  const bridgeDir = path.join(root, 'bridge');
  const service = new PythonService({
    python,
    dbPath: path.join(root, 'data', 'memory.db'),
    bridgeDir,
    logger: console,
  });
  try {
    await service.ensureStarted(20000);
    await assert.rejects(
      () => service.call('export_file', { file: path.join(root, 'outside.jsonl') }),
      /路径必须位于/,
    );
  } finally {
    await service.stop();
  }
});

test('Python 服务崩溃：挂起的调用立即失败，不等超时', { skip: pythonMissing }, async () => {
  const root = await tmp('crash');
  const service = new PythonService({
    python,
    dbPath: path.join(root, 'data', 'memory.db'),
    bridgeDir: path.join(root, 'bridge'),
    logger: { warn() {} },
  });
  try {
    await service.ensureStarted(20000);
    const pending = new Promise((resolve, reject) => {
      service.pending.set('crash-probe', { resolve, reject, timer: setTimeout(() => {}, 60_000) });
    });
    const started = Date.now();
    service.child.kill();
    const error = await pending.then(() => null, (caught) => caught);
    assert.ok(error instanceof Error, '退出时应该 reject 挂起调用');
    assert.ok(Date.now() - started < 5000, '不应等满超时');
    assert.equal(service.pending.size, 0);
  } finally {
    await service.stop();
  }
});
