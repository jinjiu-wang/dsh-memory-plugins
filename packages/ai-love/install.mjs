#!/usr/bin/env node
// ai-love 安装器
//
// 做五件事（幂等）：
//   1. 把插件包复制到 ~/.dsh/plugins/ai-love 并以 file: 依赖装进 DSH profile
//   2. 把 QQ preset 里的 compaction-basic 换成 ai-love（qq-chat-v2 / qq-chat）
//   3. 重新生成 qq-agent-presets 的 bundle patch
//   4. 语法检查 + 校验 patch 真的带上了新行
//   5. 写安装状态，供 uninstall.mjs 回滚
//
// 用法：
//   node install.mjs                    # 自动找 qq-bridge 与 desktop profile
//   node install.mjs --dry-run          # 只看计划，不写盘
//   node install.mjs --repo "D:\qq-bridge" --profile desktop
//   node install.mjs --no-preset        # 只装包，不改 QQ preset（先自己看看）
//
// 装完必须：完整退出 DSH 再打开（托盘退出，不是关窗口）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectBackupDir } from './src/core/backup.mjs';
import {
  isQqSessionGroup,
  isSafeGroupName,
  isSystemVolume,
  resolveLinkRoot,
  resolveSessionsRoot,
  samePath,
  scanContextLinks,
} from './src/core/context-link.mjs';
import {
  MemoryBackup,
  resolveMemoryBackupMemoryDir,
  resolveMemoryBackupRoot,
} from './src/core/memory-backup.mjs';

const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = fs.readFileSync(path.join(PKG_ROOT, 'VERSION'), 'utf8').trim();
const PKG_NAME = 'ai-love';
const PRESETS = ['qq-chat-v2', 'qq-chat'];

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
};
const flag = (name) => args.includes(`--${name}`);
const DRY = flag('dry-run');
const NO_PRESET = flag('no-preset');

let changed = 0;
const log = (s) => console.log(s);
const act = (s) => {
  if (!DRY) changed += 1;
  log(DRY ? `  (dry) ${s}` : `  ✔ ${s}`);
};

function readText(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function writeText(file, text) {
  if (DRY) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function backupOnce(file, suffix) {
  if (DRY || !fs.existsSync(file)) return null;
  const bak = `${file}.${suffix}`;
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  return bak;
}

function sameDir(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pathInside(parent, child) {
  const norm = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const rel = path.relative(norm(parent), norm(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** 目标不存在时沿父目录逐级 realpath，用于把 junction/符号链接解成真实位置。 */
function realpathLooseSync(target) {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      const resolved = fs.realpathSync.native(current);
      return tail.length === 0 ? resolved : path.join(resolved, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function dshHome() {
  const given = opt('dsh-home');
  if (typeof given === 'string' && given.trim() !== '') return path.resolve(given);
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return path.resolve(env.trim());
  return path.join(os.homedir(), '.dsh');
}

/** 自定义/沙盒 DSH_HOME：所有默认落点都必须留在该 home 内，不能碰真实盘。 */
function usesCustomDshHome() {
  return (
    opt('dsh-home') !== undefined ||
    (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '')
  );
}

/* ── 找 qq-bridge ─────────────────────────────────────── */
function looksLikeRepo(dir) {
  try {
    return (
      fs.existsSync(path.join(dir, 'src', 'bridge.js')) &&
      fs.existsSync(path.join(dir, 'config.json')) &&
      fs.existsSync(path.join(dir, 'dsh', 'agent-presets'))
    );
  } catch {
    return false;
  }
}

function findRepo() {
  const given = opt('repo') ?? process.env.QQ_BRIDGE_DIR;
  if (given) {
    const p = path.resolve(given);
    return looksLikeRepo(p) ? p : null;
  }
  const probes = [
    process.cwd(),
    path.join(process.cwd(), '..'),
    path.join(process.cwd(), 'qq-bridge-main'),
    path.join(process.cwd(), 'qq-bridge'),
    path.join(os.homedir(), 'qq-bridge'),
    path.join(os.homedir(), 'Documents', 'qq-bridge'),
  ];
  for (const probe of probes) {
    const abs = path.resolve(probe);
    if (looksLikeRepo(abs)) return abs;
  }
  return null;
}

/* ── 找 DSH profile ───────────────────────────────────── */
function findProfile() {
  const base = path.join(dshHome(), 'profiles');
  const given = opt('profile');
  if (given) {
    const p = path.isAbsolute(given) ? given : path.join(base, given);
    return fs.existsSync(path.join(p, 'package.json')) ? p : null;
  }
  const preferred = path.join(base, 'desktop');
  if (fs.existsSync(path.join(preferred, 'package.json'))) return preferred;
  if (fs.existsSync(path.join(base, 'web', 'package.json'))) return path.join(base, 'web');
  return null;
}

/* ── 找 DSH 运行时 ────────────────────────────────────── */
function findRuntime() {
  const base = path.join(dshHome(), 'dsh-runtimes');
  try {
    const dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const name of dirs) {
      const root = path.join(base, name, 'dependencies');
      const node = path.join(root, 'node', 'bin', 'node.exe');
      const nodeAlt = path.join(root, 'node', 'node.exe');
      const pnpm = path.join(root, 'pnpm', 'bin', 'pnpm.mjs');
      if (fs.existsSync(pnpm)) {
        const nodePath = fs.existsSync(node) ? node : fs.existsSync(nodeAlt) ? nodeAlt : process.execPath;
        return { node: nodePath, pnpm };
      }
    }
  } catch {
    // 忽略
  }
  return { node: process.execPath, pnpm: null };
}

/* ── 1. 装包 ──────────────────────────────────────────── */
/** 在非系统盘建「爱ai」备份文件夹（面板模块文档的落点）。 */
function ensureBackupDir() {
  log(`\n[1.5/6] 备份目录`);
  // 与面板同一套 detectBackupDir：优先固定磁盘，不再拿第一个存在的盘符（可能是 U 盘 / 光驱）。
  const requested = opt('backup-dir') ?? process.env.AI_LOVE_BACKUP_DIR ?? '';
  const dir =
    usesCustomDshHome() && String(requested).trim() === ''
      ? path.join(dshHome(), 'ai-love-backup')
      : detectBackupDir(requested);
  if (!DRY) {
    fs.mkdirSync(dir, { recursive: true });
    const readme = path.join(dir, 'README.md');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(
        readme,
        [
          '# 爱ai · 管理面板备份',
          '',
          '这个文件夹由「爱ai」插件在安装时创建，用来按模块保存管理面板上的文字文档：',
          '概览、逻辑痕迹、记忆卡、拿不准的记忆、压缩自检、角色卡、隐私记录、配置、上下文联通。',
          '',
          '面板运行时自动同步（默认 10 分钟一次），也可以在面板「备份」区块点「立即同步」。',
          '',
          '隐私记录只在 AI 退役且可读时保存正文，其余只写状态。',
          '',
        ].join('\n'),
        'utf8',
      );
    }
  }
  act(`备份目录：${dir}`);
  return dir;
}

/** 逐字节记忆备份根：--memory-backup-dir / 环境变量 / <面板备份目录>/qq-ai-memory-backup。 */
function resolveMemoryBackupRootForInstall(backupDir) {
  const explicit = opt('memory-backup-dir') ?? process.env.AI_LOVE_MEMORY_BACKUP_DIR ?? '';
  const given = String(explicit).trim();
  if (given !== '') return path.resolve(given);
  // 用了自定义/沙盒 DSH_HOME（--dsh-home 或环境变量）时，默认把快照根留在该 home 下，
  // 避免一次测试安装把快照写进真实非系统盘目录、改写生产 .current.json。
  if (usesCustomDshHome()) return path.join(dshHome(), 'qq-ai-memory-backup');
  return resolveMemoryBackupRoot({ backupDir });
}

/**
 * 在 bundle patch 的 `memoryDir: ''` 所在 config 块里补键/订正值（幂等）。
 * 返回 null 表示找不到锚点；added/updated 都为空表示本来就一致。
 */
export function addBundleConfigKeys(text, entries) {
  const lines = text.split(/\r?\n/);
  const anchor = lines.findIndex((line) => /^[ \t]*memoryDir:[ \t]*''[ \t]*$/.test(line));
  if (anchor === -1) return null;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^([ \t]*)/.exec(lines[anchor])?.[1] ?? '';
  let end = anchor + 1;
  for (let i = anchor + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (!line.startsWith(indent)) break;
    end = i + 1;
  }
  const inserts = [];
  const added = [];
  const updated = [];
  for (const [key, value] of entries) {
    const index = lines.findIndex(
      (line, i) => i >= anchor + 1 && i < end && line.startsWith(`${indent}${key}:`),
    );
    if (index === -1) {
      inserts.push(`${indent}${key}: ${value}`);
      added.push(key);
      continue;
    }
    const lead = /^([ \t]*)/.exec(lines[index])?.[1] ?? indent;
    const nextLine = `${lead}${key}: ${value}`;
    if (lines[index] !== nextLine) {
      lines[index] = nextLine;
      updated.push(key);
    }
  }
  if (inserts.length > 0) lines.splice(end, 0, ...inserts);
  return { text: lines.join(eol), added, updated };
}

/** 把备份/联通目录写进安装副本的 bundle patch，保证面板与安装器用同一个路径。 */
function writeBundleConfig(dir, paths) {
  const file = path.join(dir, 'cordis.patch.yml');
  if (!fs.existsSync(file)) return;
  const result = addBundleConfigKeys(readText(file), presetDirEntries(paths));
  if (result === null) {
    log('  ⚠️  cordis.patch.yml 里找不到 memoryDir，跳过目录配置写入');
    return;
  }
  const changedKeys = [...result.added, ...result.updated.map((key) => `${key}(更新)`)];
  if (changedKeys.length === 0) {
    log('  · bundle config 已含备份/联通/逐字节备份目录');
    return;
  }
  if (DRY) {
    log(`  (dry) 写入 bundle config：${changedKeys.join(' / ')}`);
    return;
  }
  fs.writeFileSync(file, result.text, 'utf8');
  act(`bundle config 写入 ${changedKeys.join(' / ')}`);
}

/** 旧版入口与审计文档，安装时从副本中删除。 */
const REMOVED_FILES = [
  'src/host/index.mjs',
  'LOGIC_AUDIT.md',
  'INHERIT_AUDIT.md',
];

/** ai-love 注册给模型的工具名（白名单补丁按这份清单增删）。 */
const AI_LOVE_ACTIVE_TOOLS = [
  'compact_recall',
  'compact_pending',
  'compact_consent',
  'memory_facts',
  'memory_export',
  'memory_import',
  'character_check',
  'character_update',
  'character_summarize',
  'character_export',
  'character_vote',
  'legacy_write',
  'legacy_review',
  'legacy_read',
];

/** 摘除名单额外包含旧版工具名，升级/卸载时把历史补丁清干净。 */
const AI_LOVE_TOOLS = [...AI_LOVE_ACTIVE_TOOLS];

/**
 * 把 ai-love 的工具名加进 qq-agent-presets 的执行期白名单。
 *
 * 为什么必须做：QQ 会话的安全守卫（qq-tool-restrict.mjs）只放行 QQ MCP 工具和
 * 少量无害模型侧工具；不加这一步，QQ 上的 AI 调 compact_consent 以及
 * memory 系列、character 系列、legacy 系列工具会被拒绝（错误：不在 QQ 桥接白名单内），
 * 功能永远跑不通。
 * 幂等：每次先摘掉全部历史条目再按清单重写；改前留 .bak-ai-love。
 * v0.16.1：已被（手工）改过但没有备份时，用「摘掉全部历史工具名」的文本合成基线，
 * 卸载才回得去；基线只写一次，重装不会把已打过补丁的版本覆盖成基线。
 */
function patchToolRestrict(repo) {
  log(`\n[4.5/6] 放行 ai-love 工具（qq-agent-presets 白名单）`);
  const file = path.join(repo, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
  if (!fs.existsSync(file)) {
    log('  · 没找到 qq-agent-presets，跳过（不影响插件本体）');
    return false;
  }
  const text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const marker = 'const SAFE_EXACT = new Set([';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes(marker));
  const end = start === -1 ? -1 : lines.findIndex((line, i) => i > start && line.trim() === '])');
  if (start === -1 || end === -1) {
    log('  ⚠️  SAFE_EXACT 结构变了，请手动把 ai-love 工具加进白名单');
    return false;
  }
  const isAiLoveLine = (line) => {
    const trimmed = line.trim();
    if (AI_LOVE_TOOLS.some((tool) => trimmed.includes(`'${tool}'`))) return true;
    return /^\s*\/\//.test(line) &&
      /角色卡|隐私记录|character_|legacy_|亡语/.test(line);
  };
  const region = lines.slice(start + 1, end);
  const drop = new Set();
  for (let i = 0; i < region.length; i += 1) {
    if (isAiLoveLine(region[i])) drop.add(i);
  }
  const firstTool = region.findIndex((line) =>
    AI_LOVE_TOOLS.some((tool) => line.trim().includes(`'${tool}'`)),
  );
  // 连在第一个工具名上方的整段注释都属于 ai-love，一并摘掉。
  if (firstTool !== -1) {
    for (let i = firstTool - 1; i >= 0; i -= 1) {
      if (!region[i].trim().startsWith('//')) break;
      drop.add(i);
    }
  }
  const kept = region.filter((_, i) => !drop.has(i));
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  const block = [
    '  // ai-love（爱ai）模型侧工具：只读写 ~/.dsh/ai-love 下的记忆/角色卡/隐私记录，不碰任意路径。',
    "  'compact_recall', 'compact_pending', 'compact_consent',",
    "  'memory_facts', 'memory_export', 'memory_import',",
    "  'character_check', 'character_update', 'character_summarize',",
    "  'character_export', 'character_vote',",
    "  'legacy_write', 'legacy_review', 'legacy_read',",
  ];
  const nextLines = [...lines.slice(0, start + 1), ...kept, ...block, ...lines.slice(end)];
  const next = nextLines.join(eol);
  const bakFile = `${file}.bak-ai-love`;
  const baseline = [...lines.slice(0, start + 1), ...kept, ...lines.slice(end)].join(eol);
  const bakDirty = !fs.existsSync(bakFile) || /character_|legacy_|角色卡|隐私记录|亡语/.test(readText(bakFile));
  if (!DRY && bakDirty) fs.writeFileSync(bakFile, baseline, 'utf8');
  if (next === text) {
    log('  · 白名单已是完整的 ai-love 工具集，无需改动');
    return true;
  }
  if (DRY) {
    log(`  (dry) 会更新白名单：移除旧条目/注释，放行 ${AI_LOVE_ACTIVE_TOOLS.length} 个 ai-love 工具`);
    return true;
  }
  fs.writeFileSync(file, next, 'utf8');
  act('qq-tool-restrict.mjs：放行 ai-love 全部工具');
  return true;
}

function copyPackage() {
  const target = path.join(dshHome(), 'plugins', PKG_NAME);
  log(`\n[1/6] 安装包到 ${target}`);
  if (
    sameDir(PKG_ROOT, target) ||
    sameDir(realpathLooseSync(PKG_ROOT), realpathLooseSync(target))
  ) {
    log('  · 安装源就是安装副本，跳过复制');
    return target;
  }
  const files = [
    'package.json',
    'VERSION',
    'README.md',
    'COMPACTION_PROTOCOL.md',
    '使用说明.md',
    'cordis.patch.yml',
    'icon.svg',
    'locale',
    'src',
    'bridge',
    'test',
    'link-context.mjs',
    'memory-backup.mjs',
    'install.mjs',
    'uninstall.mjs',
    'verify.mjs',
    'selfcheck.mjs',
  ];
  for (const rel of files) {
    const from = path.join(PKG_ROOT, rel);
    const to = path.join(target, rel);
    if (!fs.existsSync(from)) {
      if (rel !== 'README.md') log(`  ⚠️  包里缺 ${rel}`);
      continue;
    }
    if (DRY) log(`  (dry) 复制 ${rel}`);
    else {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true, force: true });
    }
  }
  // 旧版人设模块与审计文档不再随包发布，安装时从副本里摘掉。
  for (const rel of REMOVED_FILES) {
    const stale = path.join(target, rel);
    if (!fs.existsSync(stale)) continue;
    if (DRY) log(`  (dry) 移除旧版 ${rel}`);
    else {
      fs.rmSync(stale, { recursive: true, force: true });
      act(`移除旧版 ${rel}`);
    }
  }
  if (!DRY) changed += 1;
  return target;
}

function installIntoProfile(pkgDir, profile, runtime) {
  log(`\n[2/6] 装进 profile 依赖 + bundle`);
  const pkgJsonFile = path.join(profile, 'package.json');
  const pkg = JSON.parse(readText(pkgJsonFile));
  pkg.dependencies ??= {};
  pkg.dsh ??= {};
  pkg.dsh.profile ??= {};
  pkg.dsh.profile.bundles ??= [];

  const wanted = `file:${pkgDir.replace(/\\/g, '/')}`;
  let dirty = false;
  if (pkg.dependencies[PKG_NAME] !== wanted) {
    pkg.dependencies[PKG_NAME] = wanted;
    dirty = true;
    act(`package.json 依赖 ${PKG_NAME}: ${wanted}`);
  } else {
    log('  · 依赖已指向当前包');
  }
  if (!pkg.dsh.profile.bundles.includes(PKG_NAME)) {
    pkg.dsh.profile.bundles.push(PKG_NAME);
    dirty = true;
    act(`dsh.profile.bundles += ${PKG_NAME}（左侧栏面板与 client bundle 靠它加载）`);
  } else {
    log('  · bundle 已注册');
  }
  if (dirty) {
    backupOnce(pkgJsonFile, 'ai-love.bak');
    writeText(pkgJsonFile, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  // 默认直接放真实目录：不触发 pnpm 全量安装，风险最小。
  // Node 解析只看 node_modules/ai-love 是否存在；package.json 的 file: 依赖
  // 让下一次 pnpm install 也保持一致。
  if (!flag('pnpm')) {
    const target = path.join(profile, 'node_modules', PKG_NAME);
    if (DRY) {
      log(`  (dry) 复制 node_modules/${PKG_NAME}`);
    } else {
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(pkgDir, target, { recursive: true, force: true });
    }
    act('node_modules 已就位');
    return;
  }

  if (!runtime.pnpm) {
    log('  ⚠️  找不到 DSH 的 pnpm；改为直接复制到 node_modules');
    const target = path.join(profile, 'node_modules', PKG_NAME);
    if (!DRY) {
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(pkgDir, target, { recursive: true, force: true });
    }
    act('node_modules 已复制');
    return;
  }

  log(`  · 用 ${runtime.pnpm} 安装（可能几十秒）`);
  if (DRY) {
    log(`  (dry) ${runtime.node} ${runtime.pnpm} add "file:${pkgDir}"`);
    return;
  }
  const result = spawnSync(
    runtime.node,
    [runtime.pnpm, 'add', `file:${pkgDir}`, '--prefer-offline', '--config.confirmModulesPurge=false'],
    {
      cwd: profile,
      encoding: 'utf8',
      env: { ...process.env, npm_config_registry: process.env.npm_config_registry ?? 'https://registry.npmmirror.com' },
      timeout: 180000,
    },
  );
  if (result.status !== 0) {
    log('  ⚠️  pnpm add 失败，回退到直接复制 node_modules');
    if (result.stdout) log(result.stdout.trim().split('\n').slice(-8).join('\n'));
    if (result.stderr) log(result.stderr.trim().split('\n').slice(-8).join('\n'));
    const target = path.join(profile, 'node_modules', PKG_NAME);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(pkgDir, target, { recursive: true, force: true });
    act('node_modules 已复制（回退路径）');
    return;
  }
  act('pnpm add 完成');
}

/* ── 2. 改 preset ─────────────────────────────────────── */
const BACKEND_ROW = `${PKG_NAME}/backend`;

/** 从 bridge config.json 读管理员 QQ，写进预设 config 供自我识别用。 */
function readOwnerQQ(repo) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(repo, 'config.json'), 'utf8'));
    return String(cfg?.ownerQQ ?? '').trim();
  } catch {
    return '';
  }
}

/** 后台真正读的是 preset 的 config；面板读 bundle patch。两处必须写同一组目录。 */
export function presetDirEntries({ backupDir, linkRoot, memoryBackupRoot } = {}) {
  const entries = [];
  if (typeof backupDir === 'string' && backupDir !== '') {
    entries.push(['backupDir', JSON.stringify(backupDir)]);
  }
  if (typeof linkRoot === 'string' && linkRoot !== '') {
    entries.push(['contextLinkDir', JSON.stringify(linkRoot)]);
  }
  entries.push(['memoryBackup', 'true']);
  if (typeof memoryBackupRoot === 'string' && memoryBackupRoot !== '') {
    entries.push(['memoryBackupDir', JSON.stringify(memoryBackupRoot)]);
  }
  return entries;
}

/**
 * 往 `- id: ai-love` 的 config 块里补缺失键、订正已有值（幂等）。
 * 返回 null 表示结构不认识；added/updated 都为空表示本来就一致。
 */
export function addAiLoveConfigKeys(text, entries) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const idIdx = lines.findIndex((line) => /^\s*-\s+id:\s*ai-love\s*$/.test(line));
  if (idIdx === -1) return null;
  let configIdx = -1;
  for (let i = idIdx + 1; i < Math.min(idIdx + 10, lines.length); i += 1) {
    if (/^\s*config:\s*$/.test(lines[i])) {
      configIdx = i;
      break;
    }
  }
  if (configIdx === -1) return null;
  const configIndent = /^([ \t]*)/.exec(lines[configIdx])?.[1] ?? '';
  const indent = `${configIndent}  `;
  let end = configIdx + 1;
  for (let i = configIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const lead = /^([ \t]*)/.exec(line)?.[1] ?? '';
    if (lead.length <= configIndent.length) break;
    end = i + 1;
  }
  const added = [];
  const updated = [];
  const inserts = [];
  for (const [key, value] of entries) {
    const index = lines.findIndex(
      (line, i) => i >= configIdx + 1 && i < end && line.startsWith(`${indent}${key}:`),
    );
    if (index === -1) {
      inserts.push(`${indent}${key}: ${value}`);
      added.push(key);
      continue;
    }
    const lead = /^([ \t]*)/.exec(lines[index])?.[1] ?? indent;
    const nextLine = `${lead}${key}: ${value}`;
    if (lines[index] !== nextLine) {
      lines[index] = nextLine;
      updated.push(key);
    }
  }
  if (inserts.length > 0) lines.splice(end, 0, ...inserts);
  return { text: lines.join(eol), added, updated };
}

function patchPresetFile(file, repo, paths = {}) {
  if (!fs.existsSync(file)) return { file, changed: false, reason: '不存在' };
  const text = readText(file);
  const entries = presetDirEntries(paths);
  if (text.includes(`name: '${BACKEND_ROW}'`)) {
    // 已经是 ai-love/backend：补 bridgeDir（失败率采样）、ownerQQ（自我识别）和目录配置。
    const needBridge = !text.includes('bridgeDir:');
    const needOwner = !text.includes('ownerQQ:');
    let next = text;
    if (needBridge || needOwner) {
      const eol0 = text.includes('\r\n') ? '\r\n' : '\n';
      const lines0 = text.split(/\r?\n/);
      const idx = lines0.findIndex((line) => line.includes(`name: '${BACKEND_ROW}'`));
      if (idx === -1) return { file, changed: false, reason: '已是 ai-love/backend' };
      let configIdx = -1;
      for (let i = idx + 1; i < Math.min(idx + 8, lines0.length); i += 1) {
        if (/^\s*config:\s*$/.test(lines0[i])) {
          configIdx = i;
          break;
        }
      }
      if (configIdx === -1) return { file, changed: false, reason: '已有后端但找不到 config 行' };
      const indent0 = (/^([ \t]*)/.exec(lines0[configIdx])?.[1] ?? '') + '  ';
      const inserts = [];
      if (needBridge) inserts.push(`${indent0}bridgeDir: ${JSON.stringify(repo)}`);
      if (needOwner) inserts.push(`${indent0}ownerQQ: ${JSON.stringify(readOwnerQQ(repo))}`);
      lines0.splice(configIdx + 1, 0, ...inserts);
      next = lines0.join(eol0);
    }
    const ensured = addAiLoveConfigKeys(next, entries);
    if (ensured === null) return { file, changed: false, reason: '已有后端但找不到 config 行' };
    const bits = [
      ...(needBridge ? ['bridgeDir'] : []),
      ...(needOwner ? ['ownerQQ'] : []),
      ...ensured.added,
      ...ensured.updated.map((key) => `${key}(更新)`),
    ];
    if (bits.length === 0) return { file, changed: false, reason: '已是 ai-love/backend' };
    writeText(file, ensured.text);
    act(`写入 ${bits.join(' / ')} 到 ${path.basename(path.dirname(file))}/agent.cordis.yml`);
    return { file, changed: true };
  }
  if (
    !text.includes('compaction-basic') &&
    !text.includes('feiyu-compact') &&
    !text.includes(`name: '${PKG_NAME}'`)
  ) {
    return { file, changed: false, reason: '没有可替换的压缩后端行' };
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let patched = false;
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^([ \t]*)-\s+id:\s*(compaction-basic|feiyu-compact|ai-love)\s*$/.exec(lines[i]);
    if (!match) continue;
    const indent = match[1];
    const next = lines[i + 1] ?? '';
    if (!/^\s*name:\s*'(@deepseek-ai\/dsh-compaction-basic|feiyu-compact|ai-love)'/.test(next)) continue;
    // 吞掉旧行后面可能残留的 config 块（上一版安装留下的），避免重复键
    let end = i + 2;
    while (end < lines.length) {
      const line = lines[end];
      if (line.trim() === '') break;
      const lead = /^([ \t]*)/.exec(line)?.[1] ?? '';
      if (lead.length <= indent.length) break;
      end += 1;
    }
    lines.splice(
      i,
      end - i,
      `${indent}- id: ${PKG_NAME}`,
      `${indent}  name: '${BACKEND_ROW}'`,
      `${indent}  config:`,
      `${indent}    style: qq`,
      // 给面板的自优化用它读 bridge 的 tool-calls.jsonl（失败率回退，绕开 DSH 工具钩子）。
      `${indent}    bridgeDir: ${JSON.stringify(repo)}`,
      // 自我识别：管理员 QQ（来自 bridge config.json）。
      `${indent}    ownerQQ: ${JSON.stringify(readOwnerQQ(repo))}`,
      // 后台读 preset config：备份/联通/逐字节备份目录必须和面板 bundle 一致。
      ...entries.map(([key, value]) => `${indent}    ${key}: ${value}`),
    );
    patched = true;
    break;
  }
  if (!patched) return { file, changed: false, reason: '结构不匹配，未改' };
  const backup = backupOnce(file, 'ai-love.bak');
  writeText(file, lines.join(eol));
  act(`替换 ${path.basename(path.dirname(file))}/agent.cordis.yml 的压缩后端（ai-love/backend）`);
  return { file, changed: true, backup };
}

function patchPresets(repo, paths = {}) {
  log(`\n[4/6] 替换 QQ preset 的压缩后端`);
  const results = [];
  for (const name of PRESETS) {
    const file = path.join(repo, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
    const result = patchPresetFile(file, repo, paths);
    if (!result.changed) log(`  · ${name}: ${result.reason}`);
    results.push(result);
  }
  return results;
}

/* ── 2.5 清理旧名 ─────────────────────────────────────── */
function cleanupOldName(profile) {
  const old = 'feiyu-compact';
  log(`\n[3/6] 清理旧名 ${old}`);
  const pkgJsonFile = path.join(profile, 'package.json');
  let pkg = null;
  try {
    pkg = JSON.parse(readText(pkgJsonFile));
  } catch {
    pkg = null;
  }
  if (pkg !== null) {
    let dirty = false;
    if (pkg.dependencies && pkg.dependencies[old] !== undefined) {
      delete pkg.dependencies[old];
      dirty = true;
    }
    if (Array.isArray(pkg.dsh?.profile?.bundles)) {
      const next = pkg.dsh.profile.bundles.filter((name) => name !== old);
      if (next.length !== pkg.dsh.profile.bundles.length) {
        pkg.dsh.profile.bundles = next;
        dirty = true;
      }
    }
    if (dirty) {
      writeText(pkgJsonFile, `${JSON.stringify(pkg, null, 2)}\n`);
      act('profile 清单里移除了 feiyu-compact');
    } else {
      log('  · 清单里没有旧名');
    }
  }
  for (const dir of [path.join(profile, 'node_modules', old), path.join(dshHome(), 'plugins', old)]) {
    if (!fs.existsSync(dir)) continue;
    if (!DRY) fs.rmSync(dir, { recursive: true, force: true });
    act(`删除旧安装 ${dir}`);
  }
  // 旧记忆目录 ~/.dsh/feiyu-compact 不在这里删：那是用户数据，不是安装残留。
}

/* ── 3. 重新生成 patch ────────────────────────────────── */
function rebuildPatches(repo, runtime) {
  log(`\n[5/6] 重新生成 bundle patch`);
  const script = path.join(repo, 'scripts', 'build-agent-preset-patches.mjs');
  if (!fs.existsSync(script)) {
    log('  ⚠️  找不到 build-agent-preset-patches.mjs，跳过（请手动跑一次）');
    return false;
  }
  if (DRY) {
    log(`  (dry) ${runtime.node} scripts/build-agent-preset-patches.mjs`);
    return true;
  }
  const result = spawnSync(runtime.node, [script], { cwd: repo, encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0) {
    log('  ❌ 生成失败：');
    if (result.stdout) log(result.stdout.trim());
    if (result.stderr) log(result.stderr.trim());
    return false;
  }
  log('  ✔ 已生成');
  return true;
}

/* ── 4. 验证 ──────────────────────────────────────────── */
/** 读 YAML 里某个标量的字面值（去掉引号/转义；用于跨 preset/patch/状态比较）。 */
export function yamlScalar(text, key) {
  const match = new RegExp(`^\\s*${key}:\\s*(.*?)\\s*$`, 'm').exec(text);
  if (match === null) return null;
  const raw = match[1];
  if (raw === '') return '';
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

/** 与 presetDirEntries 同序的「键 → 期望值」。 */
export function expectedDirConfig(paths = {}) {
  const rows = [];
  if (typeof paths.backupDir === 'string' && paths.backupDir !== '') {
    rows.push(['backupDir', paths.backupDir]);
  }
  if (typeof paths.linkRoot === 'string' && paths.linkRoot !== '') {
    rows.push(['contextLinkDir', paths.linkRoot]);
  }
  rows.push(['memoryBackup', 'true']);
  if (typeof paths.memoryBackupRoot === 'string' && paths.memoryBackupRoot !== '') {
    rows.push(['memoryBackupDir', paths.memoryBackupRoot]);
  }
  return rows;
}

function verify(repo, profile, options = {}) {
  const skipPreset = options.skipPreset === true;
  log(`\n[6/6] 验证`);
  const issues = [];
  let syntaxSkipWarned = false;
  const pkgJson = path.join(profile, 'package.json');
  try {
    const pkg = JSON.parse(readText(pkgJson));
    if (typeof pkg.dependencies?.[PKG_NAME] !== 'string') issues.push('profile package.json 里没有 ai-love 依赖');
    if (!Array.isArray(pkg.dsh?.profile?.bundles) || !pkg.dsh.profile.bundles.includes(PKG_NAME)) {
      issues.push('profile 的 dsh.profile.bundles 里没有 ai-love（左侧栏不会加载）');
    }
  } catch (error) {
    issues.push(`profile package.json 读不了：${error.message}`);
  }
  if (!fs.existsSync(path.join(profile, 'node_modules', PKG_NAME, 'package.json'))) {
    issues.push('profile/node_modules/ai-love 不存在');
  }
  const bundlePatch = path.join(dshHome(), 'plugins', PKG_NAME, 'cordis.patch.yml');
  if (fs.existsSync(bundlePatch)) {
    const text = readText(bundlePatch);
    if (!text.includes('ai-love-panel')) issues.push('bundle patch 里没有 ai-love-panel 行（面板接口不会挂载）');
    for (const [key, expected] of expectedDirConfig(options.paths ?? {})) {
      const actual = yamlScalar(text, key);
      if (actual === null) {
        issues.push(`bundle patch 缺 ${key}（面板路径会退化成默认值）`);
      } else if (key === 'memoryBackup' ? actual !== expected : !samePath(actual, expected)) {
        issues.push(`bundle patch 的 ${key}=${actual} 与安装目标 ${expected} 不一致`);
      }
    }
  } else {
    issues.push('安装副本缺 cordis.patch.yml');
  }
  if (!skipPreset) {
    for (const name of PRESETS) {
      const patchFile = path.join(repo, 'plugins', 'qq-agent-presets', 'presets', `${name}.patch.yml`);
      if (!fs.existsSync(patchFile)) {
        issues.push(`缺少 ${name}.patch.yml`);
        continue;
      }
      const text = readText(patchFile);
      if (!new RegExp(`name:\\s*['"]?${PKG_NAME}['"]?`).test(text)) {
        issues.push(`${name}.patch.yml 里没有 ai-love 行`);
      }
      if (text.includes("name: '@deepseek-ai/dsh-compaction-basic'")) {
        issues.push(`${name}.patch.yml 仍带着 compaction-basic（没重新生成？）`);
      }
      if (text.includes("name: 'feiyu-compact'")) {
        issues.push(`${name}.patch.yml 仍带着旧名 feiyu-compact（没重新生成？）`);
      }
      for (const [key, expected] of expectedDirConfig(options.paths)) {
        const actual = yamlScalar(text, key);
        if (actual === null) {
          issues.push(`${name}.patch.yml 缺 ${key}（没重新生成？）`);
        } else if (actual !== expected) {
          issues.push(`${name}.patch.yml 的 ${key}=${actual} 与安装目标 ${expected} 不一致`);
        }
      }
    }
  }
  for (const file of SRC_FILES) {
    const full = path.join(path.join(dshHome(), 'plugins', PKG_NAME), file);
    if (!fs.existsSync(full)) {
      issues.push(`安装副本缺 ${file}`);
      continue;
    }
    const check = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
    if (check.error?.code === 'EPERM' || check.error?.code === 'EACCES') {
      // 沙盒/杀软环境不允许起子进程：这不是语法错误，跳过而不是判失败
      if (!syntaxSkipWarned) {
        log('  · 环境不允许起子进程（EPERM），跳过语法自检，安装继续');
        syntaxSkipWarned = true;
      }
      continue;
    }
    if (check.status !== 0) {
      const why = check.stderr?.toString().split('\n')[0] || check.error?.message || '无法启动 node';
      issues.push(`${file} 语法检查失败：${why}`);
    }
  }
  for (const rel of REMOVED_FILES) {
    if (fs.existsSync(path.join(dshHome(), 'plugins', PKG_NAME, rel))) {
      issues.push(`安装副本仍残留旧版文件 ${rel}`);
    }
  }
  // 桥接侧门闸：bridge.js 已经 import 但文件没同步过去，桥接会启动失败。
  try {
    const bridgeText = readText(path.join(repo, 'src', 'bridge.js'));
    const gateFile = path.join(repo, 'src', 'core', 'safehouse-gate.mjs');
    if (bridgeText.includes("from './core/safehouse-gate.mjs'") && !fs.existsSync(gateFile)) {
      issues.push('bridge.js 引用了 safehouse-gate.mjs，但文件不存在（桥接会起不来）');
    }
  } catch {
    /* 桥接不在本机也不影响面板 */
  }
  if (issues.length === 0) {
    log('  ✔ 全部通过');
    return true;
  }
  for (const issue of issues) log(`  ✘ ${issue}`);
  return false;
}

const SRC_FILES = [
  'src/host/backend.mjs',
  'src/host/panel.mjs',
  'src/client/index.js',
  'src/core/config.mjs',
  'src/core/summarizer.mjs',
  'src/core/uncertain.mjs',
  'src/core/memory.mjs',
  'src/core/compact-consent.mjs',
  'src/core/backup.mjs',
  'src/core/context-link.mjs',
  'src/core/memory-backup.mjs',
  'link-context.mjs',
  'memory-backup.mjs',
  'install.mjs',
  'uninstall.mjs',
  'verify.mjs',
  'selfcheck.mjs',
  'src/core/protocol.mjs',
  'src/core/interop.mjs',
  'src/core/character.mjs',
  'src/core/legacy.mjs',
  'src/core/identity.mjs',
  'src/core/guard.mjs',
  'src/core/tokenwise.mjs',
  'src/core/region.mjs',
  'src/core/atomic.mjs',
  'src/safehouse/agent-hooks.mjs',
  'src/safehouse/channel.mjs',
  'src/safehouse/constants.mjs',
  'src/safehouse/extension.mjs',
  'src/safehouse/index.mjs',
  'src/safehouse/keys.mjs',
  'src/safehouse/pressure.mjs',
  'src/safehouse/rules.mjs',
  'src/safehouse/server.mjs',
  'src/safehouse/service.mjs',
  'src/safehouse/store.mjs',
  'src/safehouse/util.mjs',
];

/* ── 安全屋门闸（桥接侧，只复制文件 + 检查接线） ────────────── */

/**
 * 安全屋是否生效，取决于桥接是否在 `bridge.js` 里接了门闸。
 * 安装器只负责把 `bridge/safehouse-gate.mjs` 复制到 `repo/src/core/`，
 * 以及明确告诉用户「代码没接线，所以不会挡消息」——绝不偷偷改 bridge.js。
 */
function syncSafehouseGate(repo) {
  log(`\n[4.7/6] 安全屋门闸（桥接侧）`);
  const source = path.join(PKG_ROOT, 'bridge', 'safehouse-gate.mjs');
  const target = path.join(repo, 'src', 'core', 'safehouse-gate.mjs');
  const bridgeFile = path.join(repo, 'src', 'bridge.js');
  let bridgeText = '';
  try {
    bridgeText = fs.readFileSync(bridgeFile, 'utf8');
  } catch {
    log('  ⚠️  读不到 bridge/src/bridge.js，跳过门闸检查');
    return 'inactive';
  }
  const wired = bridgeText.includes("from './core/safehouse-gate.mjs'")
    && bridgeText.includes('readSafehouseGate(');
  const hasGate = fs.existsSync(target);
  if (fs.existsSync(source) && (!hasGate || fs.readFileSync(target, 'utf8') !== fs.readFileSync(source, 'utf8'))) {
    if (!DRY) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    act(`同步门闸文件 ${target}`);
  } else if (hasGate) {
    log('  · 门闸文件已是当前版本');
  }
  if (!wired) {
    log('  ⚠️  bridge.js 还没接安全屋门闸：安全屋开着也不会挡消息（聊天不受影响）。');
    log(`      按 ${path.join(PKG_ROOT, 'bridge', '安全屋接入.md')} 打 4 处补丁后再验收。`);
    return 'inactive';
  }
  if (!fs.existsSync(target)) {
    log('  ❌ bridge.js 已引用 safehouse-gate.mjs，但文件不存在：桥接会启动失败。');
    log('      把插件包里的 bridge/safehouse-gate.mjs 复制到 bridge/src/core/ 再重试。');
    return 'broken';
  }
  log('  ✔ bridge.js 已接入安全屋门闸');
  return 'ok';
}

/* ── 跑起来 ───────────────────────────────────────────── */
export async function runInstall() {
for (const name of ['repo', 'profile', 'backup-dir', 'memory-backup-dir', 'dsh-home']) {
  if (!args.includes(`--${name}`)) continue;
  const value = opt(name);
  if (value === undefined || value.trim() === '') {
    log(`❌ --${name} 需要一个非空值`);
    process.exitCode = 1;
    return;
  }
}
log(`ai-love v${VERSION} 安装器`);
log('='.repeat(60));

const REPO = findRepo();
if (!REPO && !NO_PRESET) {
  log('❌ 找不到 qq-bridge 安装目录（需要含 src/bridge.js、config.json、dsh/agent-presets）。');
  log('   用 --repo 指定，例如： node install.mjs --repo "C:\\\\Users\\\\你\\\\qq-bridge-main"');
  log('   只想先装插件本体：加 --no-preset（不碰 QQ preset）。');
  process.exit(1);
}
const PROFILE = findProfile();
if (!PROFILE) {
  log('❌ 找不到 DSH profile。用 --profile 指定（~/.dsh/profiles 下的目录名）。');
  process.exit(1);
}
const RUNTIME = findRuntime();

log(`安装源   : ${PKG_ROOT}`);
log(`qq-bridge: ${REPO ?? '未找到（--no-preset：只装插件本体，不改 QQ preset）'}`);
log(`profile  : ${PROFILE}`);
log(`模式     : ${DRY ? 'dry-run（不写盘）' : '正式安装'}${NO_PRESET ? ' / 不改 preset' : ''}`);

/* 先做隔离预检：不合规就不要先写出备份目录和安装副本，避免半装。 */
try {
  assertBackupIsolation(
    resolveMemoryBackupRootForInstall(
      detectBackupDir(opt('backup-dir') ?? process.env.AI_LOVE_BACKUP_DIR ?? ''),
    ),
  );
} catch (error) {
  log(`\n❌ ${error.message}`);
  log('   请用 --memory-backup-dir 指定非系统盘上的独立目录，再重新安装。');
  process.exit(1);
}

const installDir = copyPackage();
const backupDir = ensureBackupDir();
const memoryBackupRoot = resolveMemoryBackupRootForInstall(backupDir);

function assertBackupIsolation(root) {
  const backup = realpathLooseSync(root);
  const sessionsRoot = resolveSessionsRoot({ dshHome: dshHome() });
  const sources = [
    ['DSH 会话根', sessionsRoot],
    ['爱ai 档案目录', resolveMemoryBackupMemoryDir({ dshHome: dshHome() })],
  ];
  try {
    for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!isQqSessionGroup(entry.name) || !isSafeGroupName(entry.name)) continue;
      sources.push([`QQ 会话组 ${entry.name}`, path.join(sessionsRoot, entry.name)]);
    }
  } catch {
    // 会话根还没建
  }
  for (const [label, source] of sources) {
    const target = realpathLooseSync(source);
    if (sameDir(backup, target) || pathInside(target, backup) || pathInside(backup, target)) {
      throw new Error(`逐字节备份根与${label}重叠（${backup} ↔ ${target}）`);
    }
  }
}
try {
  assertBackupIsolation(memoryBackupRoot);
} catch (error) {
  log(`\n❌ ${error.message}`);
  log('   请用 --memory-backup-dir 指定非系统盘上的独立目录，再重新安装。');
  process.exit(1);
}
if (isSystemVolume(memoryBackupRoot)) {
  log(`  ⚠️  逐字节备份根在系统盘（${memoryBackupRoot}），建议用 --memory-backup-dir 指到非系统盘`);
}
/* ── 1.6 QQ 上下文联通：只探测，不搬运行中的会话 ─────── */
log('\n[1.6/6] QQ 会话日志联通（只读探测）');
const linkRoot = resolveLinkRoot({ backupDir });
writeBundleConfig(installDir, { backupDir, linkRoot, memoryBackupRoot });
try {
  const status = await scanContextLinks({ linkRoot });
  if (status.totals.groups === 0) {
    log(`  · 目标：${linkRoot}`);
    log('  · 还没找到 qq-bridge 会话组；先在 QQ 聊几句，再运行 node link-context.mjs 查看');
  } else {
    log(
      `  · ${status.totals.groups} 个 QQ 会话组：已联通 ${status.totals.linked}，待激活 ${status.totals.ready}，共 ${status.totals.bytes} 字节`,
    );
    log(`  · 目标：${linkRoot}${status.linkRootOnSystemDrive ? '（系统盘，建议确认非系统盘）' : ''}`);
    if (status.dshRunning.running) {
      log('  · DSH 正在运行：安装器不会动会话日志');
    }
    if (status.totals.ready > 0 || status.totals.conflicts > 0) {
      log('  · 激活：先从托盘完全退出 DSH，再运行 node link-context.mjs --apply');
    }
  }
} catch (error) {
  log(`  ⚠️ 探测失败：${error instanceof Error ? error.message : String(error)}`);
}

/* ── 1.7 逐字节记忆备份：先留好此刻的原始数据 ─────────── */
log('\n[1.7/6] 记忆逐字节备份（首份快照 / 增量）');
const memoryBackupSessions = resolveSessionsRoot({ dshHome: dshHome() });
const memoryBackupMemoryDir = resolveMemoryBackupMemoryDir({ dshHome: dshHome() });
if (DRY) {
  log(`  (dry) 会建快照：${memoryBackupRoot}`);
  log(`  · 源：${memoryBackupSessions} 下的 QQ 会话组 + ${memoryBackupMemoryDir}`);
} else {
  try {
    const backup = new MemoryBackup({
      root: memoryBackupRoot,
      sessionsRoot: memoryBackupSessions,
      memoryDir: memoryBackupMemoryDir,
      watch: false,
    });
    const result = await backup.syncOnce({ reason: 'install' });
    if (result.busy) {
      log(`  ⚠️ ${result.error}`);
    } else {
      log(
        `  ✔ 快照 ${result.folderName}：${result.files} 个文件 / ${result.bytes} 字节` +
          `（本次复制 ${result.copied}，目录 ${memoryBackupRoot}）`,
      );
      if (!result.ok) log(`  ⚠️ ${result.errors.length} 个文件本次没备成功；DSH 启动后会自动再追`);
    }
  } catch (error) {
    log(`  ⚠️ 备份失败（不影响安装）：${error instanceof Error ? error.message : String(error)}`);
  }
}

installIntoProfile(installDir, PROFILE, RUNTIME);
cleanupOldName(PROFILE);
let patchesBuilt = true;
if (!NO_PRESET) {
  patchPresets(REPO, { backupDir, linkRoot, memoryBackupRoot });
  patchToolRestrict(REPO);
  patchesBuilt = rebuildPatches(REPO, RUNTIME);
}
const gateState = REPO ? syncSafehouseGate(REPO) : 'inactive';
if (gateState === 'broken') patchesBuilt = false;
const verified = DRY
  ? true
  : verify(REPO, PROFILE, {
      skipPreset: NO_PRESET,
      paths: { backupDir, linkRoot, memoryBackupRoot },
    });
const ok = patchesBuilt && verified;

const stateFile = path.join(dshHome(), 'plugins', PKG_NAME, '.install-state.json');
if (!DRY) {
  const state = {
    version: VERSION,
    installedAt: new Date().toISOString(),
    source: PKG_ROOT,
    repo: REPO,
    profile: PROFILE,
    backupDir,
    contextLinkRoot: linkRoot,
    memoryBackupRoot,
    dshHome: dshHome(),
    sessionsRoot: path.join(dshHome(), 'sessions'),
    presetChanged: !NO_PRESET,
  };
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch {
    // 状态写失败不影响安装本身
  }
}

log('\n' + '='.repeat(60));
log(DRY ? 'dry-run 结束：以上是它打算做的改动。' : `安装结束（写入 ${changed} 处）`);
log('');
log('下一步：');
log('  1) 完整退出 DSH（托盘图标右键退出，不是关窗口）');
log('  2) 想把 QQ 会话日志接到非系统盘：node link-context.mjs --apply');
log('  3) 重新打开 DSH；再重启桥接（关掉 start.bat 窗口再打开）');
log('  4) 在 QQ 里长聊到触发压缩，或发 /compact 手动压一次');
log('  5) 看 ~/.dsh/ai-love/ 下有没有 summaries/、uncertain.jsonl、activity.jsonl');
log(`  6) 逐字节记忆备份：${memoryBackupRoot}（DSH 运行期间实时增量；校验用 node memory-backup.mjs --verify）`);
log('');
if (!ok) log('⚠️  验证有失败项，先看上面的 ✘；回滚用 node uninstall.mjs --repo "<qq-bridge>"。');
if (!ok) process.exitCode = 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runInstall();
}
