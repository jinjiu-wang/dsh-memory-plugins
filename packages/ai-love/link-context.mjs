#!/usr/bin/env node
// 爱ai · QQ 上下文联通 CLI
//
// 把 ~/.dsh/sessions 里 qq-bridge 的会话日志目录，用 Windows 目录联接
// 接到非系统盘的 <备份目录>/sessions 下。搬迁要求 DSH 完全退出。
//
// 用法：
//   node link-context.mjs                     # 看状态（只读）
//   node link-context.mjs --apply             # 建立联接（先托盘退出 DSH）
//   node link-context.mjs --unlink            # 回迁到 C:（先托盘退出 DSH）
//   node link-context.mjs --status --json     # 给脚本看
//
// 可选：
//   --dsh-home <dir>     默认 DSH_HOME 或 ~/.dsh
//   --sessions <dir>     默认 <dsh-home>/sessions
//   --backup-dir <dir>   默认自动找非系统盘的「爱ai」
//   --link-root <dir>    直接指定联接目标根（优先于 --backup-dir）
//   --group <name>       只处理某个会话组，可重复
//   --allow-running      危险：DSH 运行时也搬迁（只给沙盒/测试用）
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import {
  applyContextLinks,
  detectDshRunning,
  resolveLinkRoot,
  resolveSessionsRoot,
  scanContextLinks,
  unlinkContextLinks,
} from './src/core/context-link.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = args[i + 1];
  // 漏写值时别把下一个开关当成路径。
  return typeof value === 'string' && !value.startsWith('--') ? value : undefined;
};
const flag = (name) => args.includes(`--${name}`);
const groups = [];
let groupValueMissing = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] !== '--group') continue;
  const value = args[i + 1];
  // 漏写组名时别把下一个开关当成组名，也别悄悄退化成“处理全部组”。
  if (typeof value === 'string' && !value.startsWith('--')) groups.push(value);
  else groupValueMissing = true;
}

if (flag('help') || flag('h')) {
  console.log(`ai-love · QQ 上下文联通

  node link-context.mjs                    看状态（只读）
  node link-context.mjs --apply            建立目录联接（DSH 必须先完全退出）
  node link-context.mjs --unlink           回迁到 C:（DSH 必须先完全退出）

可选：--dsh-home <dir>  --sessions <dir>  --backup-dir <dir>  --link-root <dir>
      --group <name>（可重复）  --json  --allow-running（危险，沙盒用）

退出码：看状态时 0 = 读到了状态（有冲突/待激活/中断也算正常）；1 = 扫描失败。
        --apply/--unlink 时 0 = 全部成功；1 = 有失败（详情见输出）。`);
  process.exit(0);
}

if (groupValueMissing) {
  console.error('--group 后面缺少组名；不想只处理部分组就不要加 --group。');
  process.exit(1);
}

const action = flag('apply') ? 'apply' : flag('unlink') ? 'unlink' : 'status';
const json = flag('json');
const allowRunning = flag('allow-running');
const dshHome = opt('dsh-home');
const sessionsRoot = opt('sessions');
const backupDir = opt('backup-dir');
const explicitLinkRoot = opt('link-root');

/** 安装器记下的目录，保证 CLI 默认和面板看的是同一处。 */
function readInstallState(home) {
  try {
    return JSON.parse(readFileSync(path.join(home, 'plugins', 'ai-love', '.install-state.json'), 'utf8'));
  } catch {
    return {};
  }
}
function currentDshHome() {
  const env = process.env.DSH_HOME;
  return typeof env === 'string' && env.trim() !== '' ? path.resolve(env.trim()) : path.join(os.homedir(), '.dsh');
}
const stateHome = typeof dshHome === 'string' && dshHome.trim() !== '' ? path.resolve(dshHome) : currentDshHome();
const installState = readInstallState(stateHome);
// 安装状态只对同一个 DSH 主目录有效；换过 home 的旧状态不能拿来定位。
const sameHome =
  typeof installState.dshHome !== 'string' ||
  installState.dshHome.trim() === '' ||
  path.resolve(installState.dshHome).toLowerCase() === path.resolve(stateHome).toLowerCase();
const state = sameHome ? installState : {};

let linkRoot;
if (typeof explicitLinkRoot === 'string' && explicitLinkRoot.trim() !== '') {
  linkRoot = path.resolve(explicitLinkRoot);
} else if (typeof backupDir === 'string' && backupDir.trim() !== '') {
  linkRoot = resolveLinkRoot({ backupDir });
} else if (typeof state.contextLinkRoot === 'string' && state.contextLinkRoot.trim() !== '') {
  linkRoot = path.resolve(state.contextLinkRoot);
} else {
  linkRoot = resolveLinkRoot({ backupDir: state.backupDir ?? '' });
}

const sessionsRootOption =
  typeof sessionsRoot === 'string'
    ? sessionsRoot
    : typeof dshHome === 'string'
      ? undefined
      : typeof state.sessionsRoot === 'string' && state.sessionsRoot.trim() !== ''
        ? state.sessionsRoot
        : undefined;

const baseOptions = {
  ...(typeof dshHome === 'string' ? { dshHome } : {}),
  ...(typeof sessionsRootOption === 'string' ? { sessionsRoot: sessionsRootOption } : {}),
  linkRoot,
  ...(groups.length > 0 ? { groups } : {}),
  allowWhileRunning: allowRunning,
  config: { backupDir: backupDir ?? '', contextLinkDir: linkRoot },
};

function stateLabel(state) {
  return (
    {
      linked: '已联通',
      ready: '待激活',
      conflict: '目标冲突',
      'broken-link': '联接目标丢失',
      'linked-elsewhere': '联接到别处',
      unsupported: '不支持',
      interrupted: '上次搬迁中断',
      missing: '源目录缺失',
      error: '读取失败',
    }[state] || String(state || '')
  );
}

function sizeLabel(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function printStatus(status) {
  console.log(`DSH 会话根：${status.sessionsRoot}`);
  console.log(`联通目标  ：${status.linkRoot}${status.linkRootOnSystemDrive ? '（系统盘，建议换）' : ''}`);
  if (status.error) console.log(`扫描失败  ：${status.error}`);
  const running = status.dshRunning ?? detectDshRunning();
  if (running.unknown) {
    console.log(`DSH 状态  ：无法确认（${running.error ?? 'tasklist 失败'}）—— 默认按运行中处理，不能搬迁`);
  } else if (running.running) {
    console.log(`DSH 状态  ：运行中（pid ${running.processes.map((row) => row.pid).join(', ')}）—— 只能查看，不能搬迁`);
  } else {
    console.log('DSH 状态  ：未运行');
  }
  console.log(
    `QQ 会话组 ：${status.totals.groups} 个（已联通 ${status.totals.linked}，待激活 ${status.totals.ready}，冲突 ${status.totals.conflicts}，断链 ${status.totals.broken}，中断 ${status.totals.interrupted ?? 0}）· 共 ${sizeLabel(status.totals.bytes)}`,
  );
  if (Array.isArray(status.orphans) && status.orphans.length > 0) {
    console.log(`未归类的残留：${status.orphans.length} 个（需要人工确认）`);
    for (const row of status.orphans) console.log(`  - ${row.path}`);
  }
  if (status.groups.length === 0) {
    console.log('\n没有找到名字里带 qq-bridge 的会话目录。先在 QQ 里聊几句，让 DSH 写出会话日志。');
    return;
  }
  console.log('');
  for (const row of status.groups) {
    const actual = row.actualTarget && row.actualTarget !== '' ? ` → ${row.actualTarget}` : '';
    console.log(`- ${row.name}`);
    console.log(`  ${stateLabel(row.state)} · ${row.files} 文件 · ${sizeLabel(row.bytes)}${actual}`);
    if (row.detail) console.log(`  ${row.detail}`);
  }
  if (status.totals.ready > 0 || status.totals.conflicts > 0) {
    console.log('\n要激活：先从托盘完全退出 DSH，再运行 node link-context.mjs --apply');
  }
}

function printResult(result, verb) {
  for (const row of result.results) {
    const extra = row.bytes !== undefined ? ` · ${sizeLabel(row.bytes)}` : '';
    console.log(`  ✔ ${row.group}：${row.status}${extra}`);
  }
  for (const warning of result.warnings) console.log(`  ⚠️  ${warning}`);
  for (const error of result.errors) console.log(`  ✘ ${error.group}：${error.error}`);
  console.log('');
  console.log(
    `${verb}：成功 ${result.results.length} 个，失败 ${result.errors.length} 个，警告 ${result.warnings.length} 个。`,
  );
  printStatus(result.status);
}

try {
  if (action === 'status') {
    const status = await scanContextLinks(baseOptions);
    if (json) console.log(JSON.stringify(status, null, 2));
    else printStatus(status);
    process.exit(status.ok ? 0 : 1);
  }

  if (action !== 'status' && allowRunning && !json) {
    console.log(
      '⚠️  已启用 --allow-running：DSH 运行中搬迁可能损坏正在写的日志，只允许在沙盒/测试里用。\n',
    );
  }

  const result = action === 'apply' ? await applyContextLinks(baseOptions) : await unlinkContextLinks(baseOptions);
  if (json) console.log(JSON.stringify(result, null, 2));
  else printResult(result, action === 'apply' ? '建立联接' : '回迁');
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(`✘ ${message}`);
  process.exit(1);
}
