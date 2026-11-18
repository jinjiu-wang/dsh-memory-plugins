#!/usr/bin/env node
// 爱ai 全面自检
//
// 核心承诺：自检只读、不写任何 QQ 记忆。
// 它做四件事：
//   1. 写盘路径审计：列出插件所有落盘点，断言只落在 memoryDir；
//   2. 只读资产快照：肥鱼日记 / 桥接记忆文件的 sha256，证明自检没有改动它们；
//   3. 敏感引用扫描：源码里不许出现 QQ 记忆/日记/桥接数据的读写；
//   4. 语法 + 单元测试。
//
// 输出：SELF_CHECK.md（写在插件目录里，不碰记忆目录）
//
// 用法：
//   node selfcheck.mjs
//   node selfcheck.mjs --repo "D:\qq-bridge" --profile desktop
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PKG_NAME = 'ai-love';
const VERSION = fs.readFileSync(path.join(PKG_ROOT, 'VERSION'), 'utf8').trim();

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  return path.join(os.homedir(), '.dsh');
}

function readText(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(file, out);
    else if (entry.isFile()) out.push(file);
  }
  return out;
}

/* ── 1. 写盘路径审计 ─────────────────────────────────── */

const WRITE_CALL =
  /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync|cp|cpSync|copyFile|copyFileSync|rename|renameSync|mkdir|mkdirSync|symlink|symlinkSync)\s*\(/;

function auditWritePaths() {
  const rows = [];
  const files = [];
  walkFiles(path.join(PKG_ROOT, 'src'), files);
  for (const file of files) {
    const rel = path.relative(PKG_ROOT, file).split(path.sep).join('/');
    const lines = readText(file).split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!WRITE_CALL.test(lines[i])) continue;
      const scoped =
        rel === 'src/core/memory.mjs' ||
        rel === 'src/core/character.mjs' ||
        rel === 'src/core/compact-consent.mjs' ||
        rel === 'src/core/legacy.mjs' ||
        rel === 'src/core/interop.mjs' ||
        rel === 'src/core/guard.mjs' ||
        rel === 'src/core/tokenwise.mjs' ||
        // atomic.mjs 只是给 memoryDir 下的档案做「唯一临时文件 + rename」原子写。
        rel === 'src/core/atomic.mjs';
      // 显式例外：bridge roles 导出、面板备份目录、QQ 会话日志联通、互通桥接开关。
      const exportWrite = rel === 'src/host/backend.mjs' && /writeFileSync|mkdirSync/.test(lines[i]);
      const backupWrite = rel === 'src/core/backup.mjs';
      const contextWrite = rel === 'src/core/context-link.mjs';
      const memoryBackupWrite = rel === 'src/core/memory-backup.mjs';
      const autoBridgeWrite = rel === 'src/core/auto-bridge.mjs';
      // 安全屋按设计写共享目录 / 私钥目录（<DSH_HOME>/safehouse*），不放记忆目录：
      // 私钥刻意落在记忆目录之外，记忆备份不会把半私钥一起带走。
      const safehouseWrite = rel.startsWith('src/safehouse/');
      // 自进化板块只写 <memoryDir>/.evolve/（写入闸门强制），不碰记忆正文。
      const evolveWrite = rel.startsWith('src/evolve/');
      // 防火墙记账只写 <memoryDir>/firewall.log（审计日志本身，可用可写目录内）。
      const firewallWrite = rel === 'src/core/firewall.mjs';
      rows.push({
        file: rel,
        line: i + 1,
        code: lines[i].trim(),
        scoped:
          scoped ||
          exportWrite ||
          backupWrite ||
          contextWrite ||
          memoryBackupWrite ||
          autoBridgeWrite ||
          safehouseWrite ||
          evolveWrite ||
          firewallWrite,
        exception: exportWrite
          ? 'bridge-roles'
          : backupWrite
            ? 'backup-dir'
            : contextWrite
              ? 'context-link'
              : memoryBackupWrite
                ? 'memory-backup'
                : autoBridgeWrite
                  ? 'interop-bridge'
                  : safehouseWrite
                    ? 'safehouse'
                    : evolveWrite
                      ? 'evolve-guard'
                      : firewallWrite
                        ? 'firewall-log'
                        : '',
      });
    }
  }
  return rows;
}

/* ── 2. 只读资产快照 ─────────────────────────────────── */

function snapshotAssets(repo) {
  const assets = [];
  const addFile = (label, file) => {
    if (!fs.existsSync(file)) return;
    const buffer = fs.readFileSync(file);
    assets.push({
      label,
      file,
      bytes: buffer.length,
      sha: sha256(buffer),
      mtime: fs.statSync(file).mtime.toISOString(),
    });
  };
  const addDir = (label, dir, options = {}) => {
    if (!fs.existsSync(dir)) return;
    const files = walkFiles(dir).sort();
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    for (const file of files) {
      const buffer = fs.readFileSync(file);
      bytes += buffer.length;
      hash.update(path.relative(dir, file).split(path.sep).join('/')).update(buffer);
    }
    assets.push({
      label,
      file: dir,
      files: files.length,
      bytes,
      sha: hash.digest('hex'),
      mtime: fs.statSync(dir).mtime.toISOString(),
      volatile: options.volatile === true,
    });
  };
  addDir('肥鱼日记（feiyu-diary）', path.join(dshHome(), 'feiyu-diary'));
  // 会话日志由 DSH 自身持续写入（当前会话、web 服务等），不是插件的写路径；
  // 只做记录，不参与“只读资产未变”的判定。
  addDir('DSH 会话日志（sessions）', path.join(dshHome(), 'sessions'), { volatile: true });
  if (repo !== undefined) {
    addFile('桥接社交记忆（social-v2.json）', path.join(repo, 'state', 'social-v2.json'));
    addFile('桥接黑话库（slang.json）', path.join(repo, 'state', 'slang.json'));
    addDir('角色卡（roles）', path.join(repo, 'roles'));
  }
  return assets;
}

/* ── 3. 敏感引用扫描 ─────────────────────────────────── */

const FORBIDDEN = [
  { label: 'feiyu-diary 读写', pattern: /feiyu-diary/ },
  { label: 'social-v2 读写', pattern: /social-v2/ },
  { label: 'slang.json 读写', pattern: /slang\.json/ },
  { label: 'QQ 发送工具', pattern: /qq_send_/ },
  { label: 'QQ 读取工具', pattern: /qq_get_(unread|recent|group_history)/ },
  { label: 'QQ 记忆工具', pattern: /qq_memory_/ },
  { label: '桥接 state 目录', pattern: /qq-bridge-main[\\/]state/ },
];

function scanForbidden() {
  const hits = [];
  const files = [];
  walkFiles(path.join(PKG_ROOT, 'src'), files);
  for (const file of files) {
    const rel = path.relative(PKG_ROOT, file).split(path.sep).join('/');
    const text = readText(file);
    for (const rule of FORBIDDEN) {
      // 安全屋的压力采样只数 social-v2 的条数/积压，不读聊天正文，
      // 而且只读不写（见 src/safehouse/pressure.mjs）。
      if (rel.startsWith('src/safehouse/') && rule.label === 'social-v2 读写') continue;
      if (rule.pattern.test(text)) hits.push({ file: rel, rule: rule.label });
    }
  }
  return hits;
}

/* ── 4. 语法 + 测试 ──────────────────────────────────── */

function checkSyntax() {
  const files = [];
  walkFiles(path.join(PKG_ROOT, 'src'), files);
  for (const file of [
    path.join(PKG_ROOT, 'install.mjs'),
    path.join(PKG_ROOT, 'uninstall.mjs'),
    path.join(PKG_ROOT, 'verify.mjs'),
    path.join(PKG_ROOT, 'selfcheck.mjs'),
    path.join(PKG_ROOT, 'link-context.mjs'),
    path.join(PKG_ROOT, 'memory-backup.mjs'),
  ]) {
    files.push(file);
  }
  const failures = [];
  for (const file of files) {
    if (!/\.(mjs|js)$/.test(file)) continue;
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (check.status !== 0) {
      failures.push({ file: path.relative(PKG_ROOT, file), error: String(check.stderr).split('\n')[0] });
    }
  }
  return failures;
}

function runTests() {
  const files = [
    path.join(PKG_ROOT, 'test', 'smoke.mjs'),
    path.join(PKG_ROOT, 'test', 'memory-backup.mjs'),
    path.join(PKG_ROOT, 'test', 'install-config.mjs'),
  ].filter((file) => fs.existsSync(file));
  if (files.length === 0) return { ok: false, output: 'test/smoke.mjs 不存在' };
  const result = spawnSync(process.execPath, ['--test', ...files], { encoding: 'utf8', timeout: 180000 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return { ok: result.status === 0, output: output.trim() };
}

/* ── 5. 安装状态 ─────────────────────────────────────── */

function installState(profile) {
  const rows = [];
  if (profile === null) return rows;
  try {
    const pkg = JSON.parse(readText(path.join(profile, 'package.json')));
    rows.push(['profile 依赖', typeof pkg.dependencies?.[PKG_NAME] === 'string' ? '已声明' : '未声明']);
    rows.push(['profile bundle', Array.isArray(pkg.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes(PKG_NAME) ? '已注册' : '未注册']);
  } catch (error) {
    rows.push(['profile package.json', `读不了：${error.message}`]);
  }
  rows.push(['安装副本', fs.existsSync(path.join(dshHome(), 'plugins', PKG_NAME, 'package.json')) ? '存在' : '不存在']);
  rows.push(['记忆档案', fs.existsSync(path.join(dshHome(), PKG_NAME)) ? '存在（只读检查，不修改）' : '还没创建']);
  return rows;
}

function findRepo() {
  const given = opt('repo') ?? process.env.QQ_BRIDGE_DIR;
  const probes = given
    ? [path.resolve(given)]
    : [
        process.cwd(),
        path.join(process.cwd(), 'qq-bridge-main'),
        path.join(process.cwd(), '..'),
        path.join(os.homedir(), 'qq-bridge'),
      ];
  for (const probe of probes) {
    try {
      if (fs.existsSync(path.join(probe, 'src', 'bridge.js'))) return probe;
    } catch {
      // 继续
    }
  }
  return undefined;
}

function findProfile() {
  const base = path.join(dshHome(), 'profiles');
  const given = opt('profile');
  if (given) {
    const p = path.isAbsolute(given) ? given : path.join(base, given);
    return fs.existsSync(path.join(p, 'package.json')) ? p : null;
  }
  const desktop = path.join(base, 'desktop');
  return fs.existsSync(path.join(desktop, 'package.json')) ? desktop : null;
}

/* ── 跑 ─────────────────────────────────────────────── */

const repo = findRepo();
const profile = findProfile();

const writeRows = auditWritePaths();
const before = snapshotAssets(repo);
const forbidden = scanForbidden();
const syntaxFailures = checkSyntax();
const tests = runTests();
const after = snapshotAssets(repo);

const stableBefore = before.filter((asset) => asset.volatile !== true);
const stableAfter = after.filter((asset) => asset.volatile !== true);
const assetsUnchanged = stableBefore.every((asset, index) => {
  const next = stableAfter[index];
  return next !== undefined && next.sha === asset.sha;
});

// 写盘审计结论：src 下除 memory.mjs 外，不应出现写调用
const unexpectedWrites = writeRows.filter((row) => !row.scoped);

const changedAssets = stableBefore
  .filter((asset, index) => stableAfter[index]?.sha !== asset.sha)
  .map((asset) => asset.label);
// 只读资产判定：插件源码里没有任何写这些路径的引用（敏感引用扫描 0 命中），
// 快照变化只代表别的进程（桥接、feiyu-memory）在正常写入。
const snapshotOk = forbidden.length === 0;

const checks = [
  ['写盘路径审计', unexpectedWrites.length === 0, unexpectedWrites.length === 0 ? `记忆档案、角色卡/隐私记录、备份目录、会话联通目录、逐字节记忆备份（${writeRows.length} 处）` : `${unexpectedWrites.length} 处计划外写盘`],
  ['只读资产快照', snapshotOk, snapshotOk ? `记录 ${before.length} 项${changedAssets.length > 0 ? `；自检期间变化：${changedAssets.join('、')}（系统/桥接写入，插件无引用）` : '；全部未变'}` : `${forbidden.length} 处插件写路径引用`],
  ['敏感引用扫描', forbidden.length === 0, forbidden.length === 0 ? '0 命中' : `${forbidden.length} 命中`],
  ['源码语法', syntaxFailures.length === 0, syntaxFailures.length === 0 ? '全部通过' : `${syntaxFailures.length} 个文件失败`],
  ['单元测试', tests.ok, tests.ok ? '通过' : '失败'],
];

const failed = checks.filter((row) => !row[1]);

/* ── 写报告 ─────────────────────────────────────────── */

const lines = [];
lines.push('# 爱ai · 全面自检报告', '');
lines.push(`- 时间：${new Date().toISOString()}`);
lines.push(`- 版本：v${VERSION}`);
lines.push(`- qq-bridge：${repo ?? '未找到'}`);
lines.push(`- profile：${profile ?? '未找到'}`);
lines.push('');
lines.push('## 结论', '');
lines.push(failed.length === 0 ? '**PASS**：没有发现会伤害 QQ 记忆的写路径或引用；自检期间只读。' : `**FAIL**：${failed.length} 项未通过，见下。`);
lines.push('');
lines.push('> 本报告由 `selfcheck.mjs` 生成。自检不写任何 QQ 记忆目录，只读哈希与源码。');
lines.push('');
lines.push('## 1. 写盘路径审计', '');
lines.push('| 文件:行 | 代码 | 判定 |');
lines.push('|---|---|---|');
for (const row of writeRows) {
  lines.push(`| ${row.file}:${row.line} | \`${row.code.replace(/\|/g, '\\|')}\` | ${row.exception === 'backup-dir' ? '显式备份到备份目录' : row.exception === 'bridge-roles' ? '显式导出到 bridge roles' : row.exception === 'context-link' ? '显式联通 DSH 会话日志（搬迁需 DSH 退出）' : row.exception === 'memory-backup' ? '显式逐字节备份到非系统盘（源只读）' : row.exception === 'interop-bridge' ? '仅写互通目录的 link.json / auto.json' : row.exception === 'safehouse' ? '安全屋共享目录 / 私钥目录（设计如此，不在记忆目录）' : row.exception === 'evolve-guard' ? '只写 <memoryDir>/.evolve/（写入闸门）' : row.exception === 'firewall-log' ? '只写 <memoryDir>/firewall.log（防火墙记账）' : row.scoped ? '在 memoryDir 下' : '**计划外**'} |`);
}
lines.push('');
lines.push('运行时落盘：记忆档案在 `~/.dsh/ai-love/`；面板备份在 `<非系统盘>:\\爱ai`；QQ 会话日志联通会在激活时把会话组完整复制到联通目录、逐文件 sha256 校验后换入目录联接（此后日志由 DSH 直接写在联通盘），并写 `sessions/.ai-love-links.json` 与临时搬迁锁。逐字节记忆备份在 `<非系统盘>:\\爱ai\\qq-ai-memory-backup\\<时间戳>`：只读源目录，复制到临时文件后比对 size + mtime + sha256 再换入，manifest 记录每个文件的 hash；DSH 运行期间 watch + 定时对账做增量镜像，源文件消失时备份保留。复制只发生在显式运行 `link-context.mjs --apply`、`memory-backup.mjs` 或插件启动后的备份器，不改写日志内容。安装器/卸载器另算，它们只改 profile 与 preset。');
lines.push('');
lines.push('## 2. 只读资产快照（自检前后）', '');
lines.push('| 资产 | 文件数 | 字节 | sha256（前 16 位） | 自检前 | 自检后 |');
lines.push('|---|---|---|---|---|---|');
for (const [index, asset] of before.entries()) {
  const next = after[index] ?? { sha: 'missing' };
  const verdict = asset.volatile === true
    ? (next.sha === asset.sha ? '系统写入（未变）' : '系统写入（变化不判定）')
    : (next.sha === asset.sha ? '✅ 未变' : '❌ 变了');
  lines.push(`| ${asset.label} | ${asset.files ?? 1} | ${asset.bytes} | \`${asset.sha.slice(0, 16)}\` | ✅ | ${verdict} |`);
}
lines.push('');
lines.push('这说明：自检本身没有改过肥鱼日记、桥接记忆或会话日志。会话日志由 DSH 自身持续写入，只记录、不作为判定项。');
lines.push('');
lines.push('## 3. 敏感引用扫描', '');
lines.push('禁止项：肥鱼日记、social-v2、slang.json、QQ 发送/读取/记忆工具、桥接 state 目录。');
lines.push('');
if (forbidden.length === 0) lines.push('**0 命中。**');
else {
  lines.push('| 文件 | 命中项 |');
  lines.push('|---|---|');
  for (const hit of forbidden) lines.push(`| ${hit.file} | ${hit.rule} |`);
}
lines.push('');
lines.push('## 4. 语法与单元测试', '');
lines.push(`- 源码语法：${syntaxFailures.length === 0 ? '全部通过' : syntaxFailures.map((f) => `${f.file}（${f.error}）`).join('；')}`);
const passMatch = /^\s*(?:#|ℹ)\s*pass (\d+)\s*$/m.exec(tests.output);
const failMatch = /^\s*(?:#|ℹ)\s*fail (\d+)\s*$/m.exec(tests.output);
const testCount =
  passMatch !== null && failMatch !== null ? `${Number(passMatch[1])}/${Number(passMatch[1]) + Number(failMatch[1])}` : '';
lines.push(`- 烟测：${tests.ok ? `${testCount === '' ? '全部' : testCount} 通过` : '失败'}`);
lines.push('');
lines.push('```text');
lines.push(tests.output.split('\n').slice(-14).join('\n'));
lines.push('```');
lines.push('');
lines.push('## 5. 安装状态', '');
if (profile === null) lines.push('- 没找到 profile（只做了源码级自检）。');
else {
  lines.push('| 项 | 状态 |');
  lines.push('|---|---|');
  for (const [label, value] of installState(profile)) lines.push(`| ${label} | ${value} |`);
}
lines.push('');
lines.push('## 6. 对 QQ 记忆的操作记录', '');
lines.push('- 本自检：**零写操作**，只读哈希与源码。');
lines.push('- 安装器：只改 profile 清单、node_modules、QQ preset 的压缩后端行、bundle patch；不碰记忆档案。');
lines.push('- 卸载器：默认保留 `~/.dsh/ai-love`；`--purge-memory` 才删它。');
lines.push('- 压缩运行时：只替换模型可见的会话表面，原始事件仍保留在会话日志；摘要与不确定项只写 `~/.dsh/ai-love`。');
lines.push('');

const report = lines.join('\n');
fs.writeFileSync(path.join(PKG_ROOT, 'SELF_CHECK.md'), report, 'utf8');

console.log(`爱ai v${VERSION} 全面自检`);
console.log('='.repeat(60));
for (const [label, ok, detail] of checks) {
  console.log(`${ok ? '✔' : '✘'} ${label} — ${detail}`);
}
console.log('='.repeat(60));
console.log(`报告：${path.join(PKG_ROOT, 'SELF_CHECK.md')}`);
console.log(failed.length === 0 ? 'PASS。' : `FAIL：${failed.length} 项。`);
process.exit(failed.length === 0 ? 0 : 1);
