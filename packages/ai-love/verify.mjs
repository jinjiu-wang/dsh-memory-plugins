#!/usr/bin/env node
// ai-love 自检。装完/改完跑一遍，别靠猜。
//
// 检查项：
//   1. profile 里装了包（package.json + node_modules）
//   2. QQ preset 源文件已换成 ai-love
//   3. 生成的 bundle patch 真的带上了新行
//   4. 安装副本的源码语法都过
//   5. 记忆目录状态（只报告，不创建）
//
// 用法：node verify.mjs [--repo <qq-bridge>] [--profile desktop]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 路径比较不依赖安装副本里的其他模块，缺文件时也能把报告跑完。 */
function samePath(left, right) {
  const norm = (value) => {
    const resolved = path.resolve(String(value));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(left) === norm(right);
}

const PKG_NAME = 'ai-love';
const PRESETS = ['qq-chat-v2', 'qq-chat'];
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
  'src/evolve/index.mjs',
  'src/evolve/journal.mjs',
  'src/evolve/guard.mjs',
  'src/evolve/registry.mjs',
  'src/evolve/loops.mjs',
];

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
};

const CONFIG_KEYS = ['backupDir', 'contextLinkDir', 'memoryBackup', 'memoryBackupDir'];

/** 读 YAML 标量的字面值（去掉引号/转义），用来比较 preset 与生成的 patch。 */
function yamlScalar(text, key) {
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

const results = [];
const ok = (label, detail = '') => results.push({ ok: true, label, detail });
const bad = (label, detail = '') => results.push({ ok: false, label, detail });

function readText(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function dshHome() {
  const given = opt('dsh-home');
  if (given !== undefined && given.trim() !== '') return path.resolve(given);
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  return path.join(os.homedir(), '.dsh');
}

function findRepo() {
  const given = opt('repo') ?? process.env.QQ_BRIDGE_DIR;
  const probes = given
    ? [path.resolve(given)]
    : [
        process.cwd(),
        path.join(process.cwd(), '..'),
        path.join(process.cwd(), 'qq-bridge-main'),
        path.join(process.cwd(), 'qq-bridge'),
        path.join(os.homedir(), 'qq-bridge'),
        path.join(os.homedir(), 'Documents', 'qq-bridge'),
      ];
  for (const probe of probes) {
    try {
      if (fs.existsSync(path.join(probe, 'src', 'bridge.js')) && fs.existsSync(path.join(probe, 'dsh', 'agent-presets'))) {
        return probe;
      }
    } catch {
      // 继续
    }
  }
  return null;
}

function findProfile() {
  const base = path.join(dshHome(), 'profiles');
  const given = opt('profile');
  if (given) {
    const p = path.isAbsolute(given) ? given : path.join(base, given);
    return fs.existsSync(path.join(p, 'package.json')) ? p : null;
  }
  const preferred = path.join(base, 'desktop');
  if (fs.existsSync(path.join(preferred, 'package.json'))) return preferred;
  const web = path.join(base, 'web');
  return fs.existsSync(path.join(web, 'package.json')) ? web : null;
}

const profile = findProfile();
const repo = findRepo();
const installDir = path.join(dshHome(), 'plugins', PKG_NAME);

// 1. profile
if (profile === null) {
  bad('找到 profile');
} else {
  ok('找到 profile', profile);
  try {
    const pkg = JSON.parse(readText(path.join(profile, 'package.json')));
    if (typeof pkg.dependencies?.[PKG_NAME] === 'string') ok('profile 依赖声明', pkg.dependencies[PKG_NAME]);
    else bad('profile 依赖声明', 'package.json 里没有 ai-love');
    if (Array.isArray(pkg.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes(PKG_NAME)) {
      ok('profile bundle 注册', 'dsh.profile.bundles');
    } else {
      bad('profile bundle 注册', 'dsh.profile.bundles 里没有 ai-love（左侧栏不会加载）');
    }
  } catch (error) {
    bad('profile package.json 可读', error.message);
  }
  if (fs.existsSync(path.join(profile, 'node_modules', PKG_NAME, 'package.json'))) ok('profile node_modules');
  else bad('profile node_modules', 'node_modules/ai-love 不存在');
}

// 2. preset 源
if (repo === null) {
  bad('找到 qq-bridge');
} else {
  ok('找到 qq-bridge', repo);
  for (const name of PRESETS) {
    const file = path.join(repo, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
    if (!fs.existsSync(file)) {
      bad(`preset ${name}`, '文件不存在');
      continue;
    }
    const text = readText(file);
    if (text.includes(`name: '${PKG_NAME}/backend'`)) ok(`preset ${name}`, '已指向 ai-love/backend');
    else if (text.includes(`name: '${PKG_NAME}'`)) bad(`preset ${name}`, '还是旧结构 ai-love（压缩后端应为 ai-love/backend）');
    else if (text.includes("name: '@deepseek-ai/dsh-compaction-basic'")) bad(`preset ${name}`, '还是 compaction-basic');
    else if (text.includes("name: 'feiyu-compact'")) bad(`preset ${name}`, '还是旧名 feiyu-compact');
    else bad(`preset ${name}`, '既没有 ai-love/backend 也没有 compaction-basic');
    // 后台读的是 preset config；目录配置漏在这里，面板和实时备份就会各用一套路径。
    if (!text.includes('backupDir:') || !text.includes('contextLinkDir:')) {
      bad(`preset ${name}`, '缺 backupDir/contextLinkDir（后台与面板路径可能不一致）');
    } else if (!text.includes('memoryBackup:') || !text.includes('memoryBackupDir:')) {
      bad(`preset ${name}`, '缺 memoryBackup/memoryBackupDir（后台不会启动逐字节备份）');
    }
  }

  // 3. 生成的 patch
  for (const name of PRESETS) {
    const file = path.join(repo, 'plugins', 'qq-agent-presets', 'presets', `${name}.patch.yml`);
    if (!fs.existsSync(file)) {
      bad(`patch ${name}`, '文件不存在');
      continue;
    }
    const text = readText(file);
    if (new RegExp(`name:\\s*['"]?${PKG_NAME}/backend['"]?`).test(text)) ok(`patch ${name}`, '已带上 ai-love/backend');
    else bad(`patch ${name}`, '没带上 ai-love/backend');
    if (text.includes("name: '@deepseek-ai/dsh-compaction-basic'")) {
      bad(`patch ${name}`, '仍含 compaction-basic（需要重新生成）');
    }
    if (text.includes("name: 'feiyu-compact'")) {
      bad(`patch ${name}`, '仍含旧名 feiyu-compact（需要重新生成）');
    }
    const presetFile = path.join(repo, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
    const presetText = fs.existsSync(presetFile) ? readText(presetFile) : '';
    for (const key of CONFIG_KEYS) {
      const patchValue = yamlScalar(text, key);
      if (patchValue === null) {
        bad(`patch ${name}`, `缺 ${key}（需要重新生成）`);
        continue;
      }
      if (presetText === '') continue;
      const presetValue = yamlScalar(presetText, key);
      if (presetValue === null) {
        bad(`preset ${name}`, `缺 ${key}（后台与面板路径可能不一致）`);
      } else {
        const same = key === 'memoryBackup' ? presetValue === patchValue : samePath(presetValue, patchValue);
        if (!same) bad(`patch ${name}`, `${key}=${patchValue} 与 preset=${presetValue} 不一致`);
      }
    }
  }
}

// 3.5 bundle patch（必须是裸包名，否则客户端模块扫描不到）
if (fs.existsSync(installDir)) {
  const bundlePatch = path.join(installDir, 'cordis.patch.yml');
  if (!fs.existsSync(bundlePatch)) {
    bad('bundle patch', '缺 cordis.patch.yml');
  } else {
    const text = readText(bundlePatch);
    const before = results.filter((row) => !row.ok).length;
    if (!text.includes('ai-love-panel')) bad('bundle patch', '缺 ai-love-panel 行');
    else if (!text.includes(`name: '${PKG_NAME}'`)) bad('bundle patch', '行名不是裸包名 ai-love（左侧栏不会加载）');
    if (!/name:\s*['"]ai-love\/evolve['"]/.test(text)) {
      bad('bundle patch', "缺 name: 'ai-love/evolve' 行（自进化板块不会被加载）");
    }
    let state = null;
    try {
      state = JSON.parse(readText(path.join(installDir, '.install-state.json')));
    } catch {
      state = null;
    }
    for (const key of CONFIG_KEYS) {
      const value = yamlScalar(text, key);
      if (value === null) {
        bad('bundle patch', `缺 ${key}（面板路径会退化成默认值）`);
        continue;
      }
      if (state === null) continue;
      const want =
        key === 'backupDir'
          ? state.backupDir
          : key === 'contextLinkDir'
            ? state.contextLinkRoot
            : key === 'memoryBackupDir'
              ? state.memoryBackupRoot
              : 'true';
      if (typeof want !== 'string' || want === '') continue;
      const same = key === 'memoryBackup' ? value === want : samePath(value, want);
      if (!same) bad('bundle patch', `${key}=${value} 与安装状态 ${want} 不一致`);
    }
    if (results.filter((row) => !row.ok).length === before) {
      ok('bundle patch', '裸包名 ai-love + ai-love-panel + ai-love/evolve + 目录/逐字节备份配置');
    }
  }
  const stateFile = path.join(installDir, '.install-state.json');
  if (!fs.existsSync(stateFile)) {
    bad('安装状态', '缺 .install-state.json（卸载时无法定位会话根）');
  } else {
    try {
      const state = JSON.parse(readText(stateFile));
      if (typeof state.sessionsRoot === 'string' && state.sessionsRoot !== '') ok('安装状态', state.sessionsRoot);
      else bad('安装状态', '缺 sessionsRoot');
      if (typeof state.contextLinkRoot !== 'string' || state.contextLinkRoot === '') {
        bad('安装状态', '缺 contextLinkRoot');
      }
      if (typeof state.memoryBackupRoot !== 'string' || state.memoryBackupRoot === '') {
        bad('安装状态', '缺 memoryBackupRoot');
      } else if (repo !== null) {
        for (const name of PRESETS) {
          const patchFile = path.join(repo, 'plugins', 'qq-agent-presets', 'presets', `${name}.patch.yml`);
          if (!fs.existsSync(patchFile)) continue;
          const value = yamlScalar(readText(patchFile), 'memoryBackupDir');
          if (value !== null && !samePath(value, state.memoryBackupRoot)) {
            bad(`patch ${name}`, `memoryBackupDir=${value} 与安装状态 ${state.memoryBackupRoot} 不一致`);
          }
        }
      }
    } catch (error) {
      bad('安装状态', `读不了：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// 4. 安装副本语法
if (!fs.existsSync(installDir)) {
  bad('安装副本', `${installDir} 不存在`);
} else {
  ok('安装副本', installDir);
  for (const rel of SRC_FILES) {
    const file = path.join(installDir, rel);
    if (!fs.existsSync(file)) {
      bad(`语法 ${rel}`, '文件不存在');
      continue;
    }
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (check.status === 0) ok(`语法 ${rel}`);
    else bad(`语法 ${rel}`, String(check.stderr).split('\n')[0]);
  }
  try {
    const pkg = JSON.parse(readText(path.join(installDir, 'package.json')));
    if (pkg.exports?.['./evolve'] === './src/evolve/index.mjs') ok('自进化入口', 'package.json exports ./evolve');
    else bad('自进化入口', "package.json 缺 exports['./evolve']（name: 'ai-love/evolve' 会解析失败）");
  } catch (error) {
    bad('自进化入口', `读不了安装副本 package.json：${error instanceof Error ? error.message : String(error)}`);
  }
}

// 5. 记忆目录
const memoryDir = path.join(dshHome(), PKG_NAME);
if (fs.existsSync(memoryDir)) {
  const parts = [];
  for (const name of ['summaries', 'uncertain.jsonl', 'activity.jsonl']) {
    if (fs.existsSync(path.join(memoryDir, name))) parts.push(name);
  }
  ok('记忆档案', parts.length > 0 ? parts.join('、') : '目录存在（还没写东西）');
} else {
  ok('记忆档案', '还没创建（第一次压缩后出现）');
}

console.log('ai-love 自检');
console.log('='.repeat(60));
for (const item of results) {
  console.log(`${item.ok ? '✔' : '✘'} ${item.label}${item.detail ? ` — ${item.detail}` : ''}`);
}
const failed = results.filter((item) => !item.ok);
console.log('='.repeat(60));
console.log(failed.length === 0 ? '全绿。重启 DSH 后生效。' : `${failed.length} 项未通过，见上面的 ✘。`);
process.exit(failed.length === 0 ? 0 : 1);
