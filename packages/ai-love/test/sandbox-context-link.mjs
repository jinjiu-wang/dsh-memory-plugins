#!/usr/bin/env node
// 爱ai · 上下文联通预加热沙盒
//
// 不碰真实 ~/.dsh 与真实会话：
//   1. 在临时目录造 DSH_HOME、qq-bridge 会话组、非 QQ 会话组、伪 bridge state；
//   2. 用假 ctx 加载 Host 面板，调 /ai-love/context-link 看只读状态；
//   3. 用真实 CLI（link-context.mjs）建 junction，再从面板路由确认已联通；
//   4. 通过 junction 读写 >8MiB 文件并校验 sha256（证明落盘不截断）；
//   5. 回迁、断链保护、非 QQ 目录隔离、DSH 运行保护。
//
// 用法：
//   node test/sandbox-context-link.mjs
//   AI_LOVE_PKG_ROOT=~/.dsh/plugins/ai-love node test/sandbox-context-link.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';

const PKG_ROOT = process.env.AI_LOVE_PKG_ROOT
  ? path.resolve(process.env.AI_LOVE_PKG_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
function expect(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `　— ${detail}` : ''}`);
}

function sha(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 优先用非系统盘做目标；拿不到就退回临时目录。 */
function makeRoots() {
  const sessionBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-love-sandbox-'));
  for (const letter of ['D:', 'E:', 'F:']) {
    const drive = `${letter}\\`;
    try {
      if (!fs.existsSync(drive)) continue;
      const dir = path.join(drive, `ai-love-sandbox-${process.pid}-${Date.now().toString(36)}`);
      fs.mkdirSync(dir);
      return { base: sessionBase, linkRoot: path.join(dir, 'sessions'), crossVolume: true, cleanup: dir };
    } catch {
      // 光驱/只读盘，换下一个
    }
  }
  return {
    base: sessionBase,
    linkRoot: path.join(sessionBase, 'link-target', 'sessions'),
    crossVolume: false,
    cleanup: '',
  };
}

const roots = makeRoots();
const DSH_HOME = path.join(roots.base, 'dsh');
const SESSIONS = path.join(DSH_HOME, 'sessions');
const MEMORY = path.join(roots.base, 'memory');
const BACKUP = path.join(roots.base, 'backup');
const BRIDGE = path.join(roots.base, 'bridge');
const GROUP = '--C-Users-sandbox-Documents-qq-bridge-main-state-agents--';
const GROUP2 = '--C-Users-sandbox-Documents-qq-bridge-main-state-slang-agent--';
const OTHER = '--C-Users-sandbox-Documents-other-app--';
const SOURCE = path.join(SESSIONS, GROUP);
const TARGET = path.join(roots.linkRoot, GROUP);

fs.mkdirSync(path.join(SOURCE, 'nested'), { recursive: true });
fs.mkdirSync(path.join(SESSIONS, GROUP2), { recursive: true });
fs.mkdirSync(path.join(SESSIONS, OTHER), { recursive: true });
fs.mkdirSync(path.join(BRIDGE, 'state'), { recursive: true });
fs.mkdirSync(MEMORY, { recursive: true });
fs.writeFileSync(path.join(BRIDGE, 'state', 'tool-calls.jsonl'), '', 'utf8');

const big = Buffer.alloc(9 * 1024 * 1024 + 4097, 0x41);
big.write('AI-LOVE-SANDBOX-TAIL', big.length - 21, 'utf8');
const small = Buffer.from('{"seq":1,"text":"沙盒里的 QQ 对话"}\n'.repeat(200), 'utf8');
fs.writeFileSync(path.join(SOURCE, 'nested', 'session.v4.jsonl.zstd'), big);
fs.writeFileSync(path.join(SOURCE, 'activity.jsonl'), small);
fs.writeFileSync(path.join(SESSIONS, GROUP2, 'slang.jsonl'), '{"word":"沙盒"}\n', 'utf8');
fs.writeFileSync(path.join(SESSIONS, OTHER, 'keep.txt'), 'do-not-touch', 'utf8');

process.env.DSH_HOME = DSH_HOME;

console.log(`沙盒会话：${SESSIONS}`);
console.log(`沙盒目标：${roots.linkRoot}${roots.crossVolume ? '（非系统盘）' : '（临时目录，同盘）'}`);
console.log(`插件源  ：${PKG_ROOT}\n`);

/* ── 假 ctx + 面板路由 ─────────────────────────────── */
function makeCtx() {
  const routes = new Map();
  const ctx = {
    logger: { warn() {}, info() {} },
    effect(fn) {
      fn();
      return () => {};
    },
    on() {
      return () => {};
    },
    inject(services, callback) {
      if (!services.includes('webServer')) return null;
      return callback({
        effect(fn) {
          fn();
          return () => {};
        },
        webServer: {
          register(spec) {
            routes.set(spec.path, spec.handler);
            return () => routes.delete(spec.path);
          },
        },
      });
    },
  };
  return { ctx, routes };
}

function makeReq() {
  const req = new EventEmitter();
  req.method = 'GET';
  setImmediate(() => req.emit('end'));
  return req;
}
function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(value) {
      this.body = value ?? '';
    },
  };
}

async function callRoute(routes, name) {
  const handler = routes.get(`/ai-love/${name}`);
  if (!handler) throw new Error(`没有 /ai-love/${name} 路由`);
  const res = makeRes();
  await handler(makeReq(), res);
  return { status: res.statusCode, json: JSON.parse(res.body || '{}') };
}

const panel = await import(pathToFileURL(path.join(PKG_ROOT, 'src/host/panel.mjs')).href);
const { ctx, routes } = makeCtx();
panel.apply(ctx, {
  memoryDir: MEMORY,
  backupDir: BACKUP,
  contextLinkDir: roots.linkRoot,
  bridgeDir: BRIDGE,
});
expect('面板：挂上了 /ai-love/context-link', routes.has('/ai-love/context-link'));

let link = await callRoute(routes, 'context-link');
expect('面板只读：能读到 2 个 qq-bridge 会话组', link.status === 200 && link.json.totals?.groups === 2, JSON.stringify(link.json.totals));
expect('面板只读：两个组都是待激活', link.json.groups?.every((row) => row.state === 'ready'));
expect('面板只读：非 QQ 目录没被发现', !link.json.groups?.some((row) => row.name === OTHER));

/* ── DSH 运行保护（当前机器 DSH 确实在跑） ─────────── */
const core = await import(pathToFileURL(path.join(PKG_ROOT, 'src/core/context-link.mjs')).href);
const running = core.detectDshRunning();
if (running.running) {
  let refused = false;
  try {
    await core.applyContextLinks({ sessionsRoot: SESSIONS, linkRoot: roots.linkRoot });
  } catch (error) {
    refused = /DSH 还在运行/.test(String(error));
  }
  expect('安全闸：DSH 运行时拒绝搬迁', refused);
} else {
  expect('安全闸：本机没有运行中的 DSH，跳过运行保护断言', true, 'detectDshRunning=false');
}

/* ── 用真实 CLI 建立联接 ──────────────────────────── */
const cli = path.join(PKG_ROOT, 'link-context.mjs');
const applyRun = spawnSync(
  process.execPath,
  [cli, '--apply', '--allow-running', '--sessions', SESSIONS, '--link-root', roots.linkRoot, '--json'],
  { encoding: 'utf8', timeout: 120000, env: { ...process.env, DSH_HOME } },
);
let applied = null;
try {
  applied = JSON.parse(applyRun.stdout || '{}');
} catch {
  applied = null;
}
expect(
  'CLI：建立联接成功',
  applyRun.status === 0 && applied?.ok === true,
  `${applyRun.status} ${(applyRun.stdout || applyRun.stderr || '').slice(0, 160)}`,
);
expect('CLI：两个组都 linked', applied?.results?.every((row) => row.status === 'linked'));
expect('junction：源路径变成联接', fs.lstatSync(SOURCE).isSymbolicLink());
expect('junction：目标落在指定根下', core.samePath(fs.realpathSync(SOURCE), TARGET));

link = await callRoute(routes, 'context-link');
expect('面板：搬迁后显示已联通', link.json.totals?.linked === 2, JSON.stringify(link.json.totals));
expect('面板：报告目标是否系统盘', typeof link.json.linkRootOnSystemDrive === 'boolean', String(link.json.linkRootOnSystemDrive));

/* ── >8MiB 通过 junction 读写 ─────────────────────── */
const through = fs.readFileSync(path.join(SOURCE, 'nested', 'session.v4.jsonl.zstd'));
expect('大文件：9MiB+ 原样读回', through.length === big.length && sha(through) === sha(big), `${through.length} 字节`);
expect('大文件：超过 8MiB 已知上传上限', big.length > 8 * 1024 * 1024, `${big.length} 字节`);
const extra = Buffer.alloc(1024 * 1024, 0x42);
fs.appendFileSync(path.join(SOURCE, 'nested', 'session.v4.jsonl.zstd'), extra);
const onTarget = fs.readFileSync(path.join(TARGET, 'nested', 'session.v4.jsonl.zstd'));
expect(
  '大文件：通过 junction 追加 1MiB 落到目标盘且不截断',
  onTarget.length === big.length + extra.length && sha(onTarget) === sha(Buffer.concat([big, extra])),
  `${onTarget.length} 字节`,
);
expect('非 QQ：目录原样保留', fs.readFileSync(path.join(SESSIONS, OTHER, 'keep.txt'), 'utf8') === 'do-not-touch');
expect('非 QQ：没有被建成联接', !fs.lstatSync(path.join(SESSIONS, OTHER)).isSymbolicLink());

/* ── 幂等：再跑一次不改动 ─────────────────────────── */
const again = spawnSync(
  process.execPath,
  [cli, '--apply', '--allow-running', '--sessions', SESSIONS, '--link-root', roots.linkRoot, '--json'],
  { encoding: 'utf8', timeout: 30000, env: { ...process.env, DSH_HOME } },
);
let againJson = null;
try {
  againJson = JSON.parse(again.stdout || '{}');
} catch {
  againJson = null;
}
expect('幂等：第二次 apply 全是 already-linked', again.status === 0 && againJson?.results?.every((row) => row.status === 'already-linked'));

/* ── 冲突：目标非空时只报错，不碰源 ───────────────── */
const conflictGroup = '--C-Users-sandbox-qq-bridge-conflict--';
const conflictSource = path.join(SESSIONS, conflictGroup);
const conflictTarget = path.join(roots.linkRoot, conflictGroup);
fs.mkdirSync(conflictSource, { recursive: true });
fs.writeFileSync(path.join(conflictSource, 'a.jsonl'), 'source', 'utf8');
fs.mkdirSync(conflictTarget, { recursive: true });
fs.writeFileSync(path.join(conflictTarget, 'existing.txt'), 'keep-me', 'utf8');
const conflict = await core.applyContextLinks({
  sessionsRoot: SESSIONS,
  linkRoot: roots.linkRoot,
  groups: [conflictGroup],
  allowWhileRunning: true,
});
expect('冲突：拒绝搬迁并报“内容不同/非空”', conflict.ok === false && /内容不同|非空/.test(conflict.errors[0]?.error || ''));
expect('冲突：源目录没有变', !fs.lstatSync(conflictSource).isSymbolicLink() && fs.readFileSync(path.join(conflictSource, 'a.jsonl'), 'utf8') === 'source');
expect('冲突：目标已有文件没被动', fs.readFileSync(path.join(conflictTarget, 'existing.txt'), 'utf8') === 'keep-me');

/* ── 回迁 ─────────────────────────────────────────── */
const unlinkRun = spawnSync(
  process.execPath,
  [cli, '--unlink', '--allow-running', '--sessions', SESSIONS, '--link-root', roots.linkRoot, '--json'],
  { encoding: 'utf8', timeout: 120000, env: { ...process.env, DSH_HOME } },
);
let unlinked = null;
try {
  unlinked = JSON.parse(unlinkRun.stdout || '{}');
} catch {
  unlinked = null;
}
const restoredRows = (unlinked?.results || []).filter((row) => row.status !== 'not-linked');
expect(
  'CLI：回迁成功',
  unlinkRun.status === 0 &&
    unlinked?.ok === true &&
    restoredRows.length === 2 &&
    restoredRows.every((row) => row.status === 'restored'),
  `${unlinkRun.status} ${(unlinkRun.stdout || unlinkRun.stderr || '').slice(0, 160)}`,
);
expect('回迁：源恢复成普通目录', !fs.lstatSync(SOURCE).isSymbolicLink() && fs.statSync(SOURCE).isDirectory());
const restored = fs.readFileSync(path.join(SOURCE, 'nested', 'session.v4.jsonl.zstd'));
expect('回迁：追加后的 10MiB 内容一字不差', sha(restored) === sha(Buffer.concat([big, extra])), `${restored.length} 字节`);
expect('回迁：D: 目标已删掉', !fs.existsSync(TARGET));

link = await callRoute(routes, 'context-link');
expect('面板：回迁后回到待激活', link.json.totals?.linked === 0 && link.json.totals?.ready >= 2, JSON.stringify(link.json.totals));

/* ── 收尾 ─────────────────────────────────────────── */
try {
  fs.rmSync(roots.base, { recursive: true, force: true });
} catch {
  // 临时目录
}
if (roots.cleanup) {
  try {
    fs.rmSync(roots.cleanup, { recursive: true, force: true });
  } catch {
    // 目标盘清理失败不影响结论
  }
}

const failed = results.filter((row) => !row.ok);
console.log(`\n预加热沙盒：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  for (const row of failed) console.log(`  ✘ ${row.name}　${row.detail}`);
  process.exitCode = 1;
}
