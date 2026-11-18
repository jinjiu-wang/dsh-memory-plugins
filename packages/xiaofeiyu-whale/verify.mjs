#!/usr/bin/env node
// 小肥鱼鲸鱼娘 · 安装校验（只读）
//   node verify.mjs
//   node verify.mjs --dsh-home "C:\tmp\dsh"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PKG_NAME = 'xiaofeiyu-whale';
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
};

function dshHome() {
  const given = opt('dsh-home');
  if (typeof given === 'string' && given.trim() !== '') return path.resolve(given);
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return path.resolve(env.trim());
  return path.join(os.homedir(), '.dsh');
}

function findProfile() {
  const base = path.join(dshHome(), 'profiles');
  const given = opt('profile');
  if (given) {
    const candidate = path.isAbsolute(given) ? given : path.join(base, given);
    return fs.existsSync(path.join(candidate, 'package.json')) ? candidate : null;
  }
  for (const name of ['desktop', 'web']) {
    const candidate = path.join(base, name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

function installedPython() {
  const patchFile = path.join(dshHome(), 'plugins', PKG_NAME, 'cordis.patch.yml');
  try {
    const line = fs
      .readFileSync(patchFile, 'utf8')
      .split(/\r?\n/)
      .find((row) => /^\s*python:\s*\S/.test(row));
    if (line === undefined) return '';
    const raw = line.replace(/^\s*python:\s*/, '').trim().replace(/^['"]|['"]$/g, '');
    return raw !== '' && fs.existsSync(raw) ? raw : '';
  } catch {
    return '';
  }
}

function pythonCommand() {
  const explicit = opt('python');
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit.trim());
  const saved = installedPython();
  if (saved !== '') return saved;
  const runtimes = path.join(dshHome(), 'dsh-runtimes');
  try {
    for (const entry of fs.readdirSync(runtimes, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const rel of [
        ['dependencies', 'python', 'python.exe'],
        ['dependencies', 'python', 'bin', 'python3'],
      ]) {
        const candidate = path.join(runtimes, entry.name, ...rel);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // 看 PATH
  }
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

const issues = [];
const notes = [];
const check = (ok, message) => {
  if (!ok) issues.push(message);
  return ok;
};

const pkgJsonFile = path.join(PKG_ROOT, 'package.json');
if (!check(fs.existsSync(pkgJsonFile), '缺 package.json')) {
  console.error(issues.join('\n'));
  process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync(pkgJsonFile, 'utf8'));
check(pkg.name === PKG_NAME, `package.json name 不是 ${PKG_NAME}`);
check(typeof pkg.version === 'string' && pkg.version !== '', 'package.json 缺 version');
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json 缺 dsh.bundle.patch');
check(pkg.dsh?.client?.immediately === true, 'package.json 缺 dsh.client.immediately=true（启动即加载侧栏）');
check(pkg.exports?.['./client'] === './src/client/index.js', 'package.json 缺 ./client 导出');
check(pkg.exports?.['.'] === './src/host/index.mjs', 'package.json 缺 host 入口导出');

for (const rel of [
  'cordis.patch.yml',
  'src/host/index.mjs',
  'src/host/python-service.mjs',
  'src/core/config.mjs',
  'src/core/state.mjs',
  'src/client/index.js',
  'python/bridge_server.py',
  'python/memory/__init__.py',
  'python/memory/interop.py',
  'install.mjs',
  'uninstall.mjs',
]) {
  check(fs.existsSync(path.join(PKG_ROOT, rel)), `缺 ${rel}`);
}

const patchFile = path.join(PKG_ROOT, 'cordis.patch.yml');
if (fs.existsSync(patchFile)) {
  const patch = fs.readFileSync(patchFile, 'utf8');
  const exactId = /^\s*-\s*id:[ \t]*xiaofeiyu-whale[ \t]*$/m.test(patch);
  const exactName = /^\s*name:[ \t]*['"]?xiaofeiyu-whale['"]?[ \t]*$/m.test(patch);
  check(exactId, 'cordis.patch.yml 缺精确的插件 id（- id: xiaofeiyu-whale）');
  check(exactName, 'cordis.patch.yml 缺精确的插件 name');
  for (const key of ['dataDir', 'dbPath', 'bridgeDir', 'autoInterop', 'intervalSeconds']) {
    check(new RegExp(`^\\s*${key}:`, 'm').test(patch), `cordis.patch.yml 缺 ${key}`);
  }
}

for (const rel of ['src/host/index.mjs', 'src/core/config.mjs', 'src/core/state.mjs', 'src/host/python-service.mjs', 'src/client/index.js']) {
  const file = path.join(PKG_ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  check(result.status === 0, `${rel} 语法错误：${result.stderr || result.stdout}`);
}

const python = pythonCommand();
const pyFiles = [path.join(PKG_ROOT, 'python', 'bridge_server.py')];
const memoryDir = path.join(PKG_ROOT, 'python', 'memory');
try {
  for (const name of fs.readdirSync(memoryDir)) {
    if (name.endsWith('.py')) pyFiles.push(path.join(memoryDir, name));
  }
} catch {
  issues.push('缺 python/memory 目录');
}
const py = spawnSync(
  python,
  [
    '-c',
    'import ast,sys,pathlib; [ast.parse(pathlib.Path(p).read_text(encoding="utf-8-sig"), filename=p) for p in sys.argv[1:]]',
    ...pyFiles,
  ],
  { encoding: 'utf8', timeout: 30000 },
);
if (py.status !== 0) {
  issues.push(`Python 语法检查失败（${python}）：${py.stderr || py.stdout}`);
} else {
  notes.push(`Python 可用：${python}`);
}

const profile = findProfile();
if (profile === null) {
  notes.push('未找到 DSH profile（未检查安装注册）');
} else {
  const profilePkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
  check(
    typeof profilePkg.dependencies?.[PKG_NAME] === 'string',
    `profile 里没有 ${PKG_NAME} 依赖（先跑 install.mjs）`,
  );
  check(
    Array.isArray(profilePkg.dsh?.profile?.bundles) && profilePkg.dsh.profile.bundles.includes(PKG_NAME),
    `profile 的 dsh.profile.bundles 里没有 ${PKG_NAME}（侧栏不会加载）`,
  );
  check(
    fs.existsSync(path.join(profile, 'node_modules', PKG_NAME, 'package.json')),
    'profile/node_modules 里没有安装副本',
  );
  notes.push(`profile：${profile}`);
}

const stateFile = path.join(dshHome(), 'plugins', PKG_NAME, '.install-state.json');
if (fs.existsSync(stateFile)) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    notes.push(`安装记录：v${state.version} → ${state.packageDir}`);
  } catch {
    issues.push('.install-state.json 读不了');
  }
}

console.log('小肥鱼鲸鱼娘 · 安装校验');
console.log(`包目录：${PKG_ROOT}`);
console.log(`版本  ：${pkg.version}`);
for (const note of notes) console.log(`  · ${note}`);
if (issues.length === 0) {
  console.log('\n✔ 校验通过');
} else {
  console.error(`\n❌ 发现 ${issues.length} 个问题：`);
  for (const issue of issues) console.error(`  - ${issue}`);
  process.exitCode = 1;
}
