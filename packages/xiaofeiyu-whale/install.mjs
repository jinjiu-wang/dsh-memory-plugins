#!/usr/bin/env node
// 小肥鱼鲸鱼娘 安装器
//
// 做四件事（幂等）：
//   1. 把插件包复制到 ~/.dsh/plugins/xiaofeiyu-whale
//   2. 以 file: 依赖装进 DSH profile，并注册 dsh.profile.bundles
//   3. 把目录/开关默认值写进安装副本的 cordis.patch.yml
//   4. 快速校验：JS 语法、Python 语法、必需文件
//
// 用法：
//   node install.mjs                         # 自动找 desktop profile
//   node install.mjs --dry-run               # 只看计划，不写盘
//   node install.mjs --profile desktop
//   node install.mjs --dsh-home "C:\tmp\dsh" # 沙盒/自定义 DSH_HOME
//   node install.mjs --python "C:\...\python.exe"
//
// 装完必须：完整退出 DSH 再打开（托盘退出，不是关窗口）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = fs.readFileSync(path.join(PKG_ROOT, 'VERSION'), 'utf8').trim();
const PKG_NAME = 'xiaofeiyu-whale';

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

let changed = 0;
const log = (text) => console.log(text);
const act = (text) => {
  if (!DRY) changed += 1;
  log(DRY ? `  (dry) ${text}` : `  ✔ ${text}`);
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

function yamlString(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

/** 读安装副本现有的 config 值；重装时不带参数也要保住上次的路径/解释器。 */
function readBundleConfig(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of readText(file).split(/\r?\n/)) {
    const match = /^\s+([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (match === null) continue;
    let value = match[2];
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    values[match[1]] = value;
  }
  return values;
}

function writeBundleConfig(dir, values) {
  const file = path.join(dir, 'cordis.patch.yml');
  if (!fs.existsSync(file)) return;
  const text = readText(file);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const updated = [];
  const missing = [];
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^(\\s*)${key}:.*$`);
    let found = false;
    for (let index = 0; index < lines.length; index += 1) {
      const match = pattern.exec(lines[index]);
      if (match === null) continue;
      found = true;
      const next = `${match[1]}${key}: ${value}`;
      if (lines[index] !== next) {
        lines[index] = next;
        updated.push(key);
      }
      break;
    }
    if (!found) missing.push([key, value]);
  }
  if (missing.length > 0) {
    // --python / --bridge-dir 等参数要真的落进 config 块，否则重启后运行时读不到。
    const configIndex = lines.findIndex((line) => /^\s*config:\s*$/.test(line));
    if (configIndex >= 0) {
      const configIndent = lines[configIndex].match(/^\s*/)[0].length;
      let insertAt = configIndex + 1;
      let childIndent = null;
      for (let index = configIndex + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (line.trim() === '') continue;
        const indent = line.match(/^\s*/)[0].length;
        if (indent <= configIndent) break;
        if (childIndent === null) childIndent = indent;
        insertAt = index + 1;
      }
      const indentText = ' '.repeat(childIndent === null ? configIndent + 2 : childIndent);
      lines.splice(insertAt, 0, ...missing.map(([key, value]) => `${indentText}${key}: ${value}`));
      updated.push(...missing.map(([key]) => key));
    }
  }
  if (updated.length === 0) {
    log('  · bundle config 已是最新');
    return;
  }
  writeText(file, lines.join(eol));
  act(`bundle config 写入 ${updated.join(' / ')}`);
}

const COPY_FILES = [
  'package.json',
  'VERSION',
  'README.md',
  'cordis.patch.yml',
  'icon.svg',
  'locale',
  'src',
  'python',
  'test',
  'install.mjs',
  'uninstall.mjs',
  'verify.mjs',
  'selfcheck.mjs',
];

function copyPackage(target) {
  log(`\n[1/4] 安装包到 ${target}`);
  if (sameDir(PKG_ROOT, target)) {
    log('  · 安装源就是安装副本，跳过复制');
    return target;
  }
  for (const rel of COPY_FILES) {
    const from = path.join(PKG_ROOT, rel);
    const to = path.join(target, rel);
    if (!fs.existsSync(from)) {
      if (rel !== 'README.md') log(`  ⚠️  包里缺 ${rel}`);
      continue;
    }
    if (DRY) {
      log(`  (dry) 复制 ${rel}`);
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, {
      recursive: true,
      force: true,
      filter: (source) => !source.split(path.sep).includes('__pycache__') && !source.endsWith('.pyc'),
    });
  }
  if (!DRY) changed += 1;
  return target;
}

function installIntoProfile(pkgDir, profile) {
  log(`\n[2/4] 装进 profile 依赖 + bundle`);
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
    act(`dsh.profile.bundles += ${PKG_NAME}（侧栏图标与面板靠它加载）`);
  } else {
    log('  · bundle 已注册');
  }
  if (dirty) {
    backupOnce(pkgJsonFile, 'xiaofeiyu-whale.bak');
    writeText(pkgJsonFile, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  const target = path.join(profile, 'node_modules', PKG_NAME);
  if (DRY) {
    log(`  (dry) 复制 node_modules/${PKG_NAME}`);
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(pkgDir, target, {
    recursive: true,
    force: true,
    filter: (source) => !source.split(path.sep).includes('__pycache__') && !source.endsWith('.pyc'),
  });
  act('node_modules 已就位');
}

function isUsablePython(value) {
  const given = String(value ?? '').trim();
  if (given === '') return false;
  const looksLikePath = given.includes('/') || given.includes('\\');
  return looksLikePath ? fs.existsSync(given) : true;
}

function pythonCommand(explicit = '') {
  const given = String(explicit ?? '').trim();
  if (given !== '') {
    // 失效的绝对路径（DSH 升级换运行时）不能把安装卡死；裸命令名交给 PATH。
    const looksLikePath = given.includes('/') || given.includes('\\');
    if (looksLikePath && fs.existsSync(given)) return path.resolve(given);
    if (!looksLikePath) return given;
  }
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
    // 没有运行时目录就看 PATH
  }
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

function quickVerify(dir, python) {
  log(`\n[4/4] 快速校验`);
  const required = [
    'package.json',
    'cordis.patch.yml',
    'src/host/index.mjs',
    'src/client/index.js',
    'python/bridge_server.py',
    'python/memory/interop.py',
  ];
  const missing = required.filter((rel) => !fs.existsSync(path.join(dir, rel)));
  if (missing.length > 0) throw new Error(`安装副本缺文件：${missing.join('、')}`);

  let jsFail = 0;
  let saidSpawnSkip = false;
  for (const rel of ['src/host/index.mjs', 'src/core/config.mjs', 'src/core/state.mjs', 'src/host/python-service.mjs', 'src/client/index.js']) {
    const result = spawnSync(process.execPath, ['--check', path.join(dir, rel)], { encoding: 'utf8' });
    if (result.error) {
      // 受限环境（不允许起子进程）拿不到 stderr——跳过自检但把原因说清楚，别打印 undefined
      if (!saidSpawnSkip) {
        log(`  · 跳过语法自检（环境不允许起子进程：${result.error.code || result.error.message}）`);
        saidSpawnSkip = true;
      }
      continue;
    }
    if (result.status !== 0) {
      jsFail += 1;
      const why = String(result.stderr || result.stdout || '').split('\n')[0] || `退出码 ${result.status}`;
      log(`  ✘ ${rel} 语法检查失败：${why}`);
    }
  }
  if (jsFail > 0) throw new Error(`${jsFail} 个文件语法检查没通过`);
  act('JS 语法检查通过');

  const py = spawnSync(python, ['-c', 'import sys, sqlite3; print(sys.version); print(sqlite3.sqlite_version)'], {
    encoding: 'utf8',
    timeout: 20000,
  });
  if (py.error) {
    log(`  · Python 自检跳过（环境不允许起子进程：${py.error.code || py.error.message}），安装继续`);
  } else if (py.status !== 0) {
    const why = String(py.stderr || py.stdout || '').trim().split(/\r?\n/).slice(-2).join(' ').trim();
    throw new Error(`Python 不可用（${python}）：${why || '无法启动'}`);
  } else {
    act(`Python 可用：${String(py.stdout || '').trim().split(/\r?\n/)[0]}`);
  }
}

/** 装好之后把我方在共享开关里的那一格置回 true（之前卸载过就会是 false）。 */
function reviveLinkFlag(bridgeDir) {
  try {
    const file = path.join(bridgeDir, 'link.json');
    if (!fs.existsSync(file)) return;
    // 有的编辑器/工具会写 BOM，JSON.parse 会炸——先剥掉
    const before = JSON.parse(String(fs.readFileSync(file, 'utf8') || '{}').replace(/^\uFEFF/, ''));
    if (before === null || typeof before !== 'object' || before.xiaofeiyu !== false) return;
    const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
    fs.writeFileSync(tmp, `${JSON.stringify({ ...before, xiaofeiyu: true, updatedAt: Date.now() }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    log('  ✔ 共享开关里 xiaofeiyu 已恢复为 true');
  } catch (e) {
    log(`  · 共享开关没改成（${e && e.message ? e.message : e}）`);
  }
}
function main() {
  log('小肥鱼鲸鱼娘 · 安装器');
  const profile = findProfile();
  if (profile === null) {
    throw new Error(`找不到 DSH profile。用 --profile 指定（${path.join(dshHome(), 'profiles')} 下的目录名）。`);
  }
  const target = path.join(dshHome(), 'plugins', PKG_NAME);
  const previous = readBundleConfig(path.join(target, 'cordis.patch.yml'));
  const dataDir = opt('data-dir') ?? previous.dataDir ?? '';
  const dbPath = opt('db-path') ?? previous.dbPath ?? '';
  const bridgeDir = opt('bridge-dir') ?? previous.bridgeDir ?? '';
  const python = opt('python') ?? previous.python ?? '';
  if (python.trim() !== '' && !isUsablePython(python)) {
    log(`  ⚠️  指定的 Python 不存在（${python}），改用自动探测`);
  }
  const savedPython = isUsablePython(python) ? python : '';

  log(`版本     : ${VERSION}`);
  log(`包目录   : ${target}`);
  log(`profile  : ${profile}`);
  log(`数据目录 : ${dataDir || `<DSH_HOME>/${PKG_NAME}`}`);
  log(`互通目录 : ${bridgeDir || '<DSH_HOME>/memory-bridge'}`);
  log(`模式     : ${DRY ? 'dry-run（不写盘）' : '正式安装'}`);

  if (!DRY) fs.mkdirSync(target, { recursive: true });
  copyPackage(target);

  log(`\n[3/4] 写入安装副本的路径配置`);
  writeBundleConfig(target, {
    dataDir: yamlString(dataDir),
    dbPath: yamlString(dbPath),
    bridgeDir: yamlString(bridgeDir),
    python: yamlString(savedPython),
    autoInterop: 'true',
    intervalSeconds: '60',
  });

  installIntoProfile(target, profile);
  quickVerify(DRY ? PKG_ROOT : target, pythonCommand(savedPython));

  if (!DRY) {
    const state = {
      plugin: PKG_NAME,
      version: VERSION,
      profile,
      packageDir: target,
      dataDir: dataDir || path.join(dshHome(), PKG_NAME),
      bridgeDir: bridgeDir || path.join(dshHome(), 'memory-bridge'),
      python: savedPython || 'auto',
      installedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(target, '.install-state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    // 之前卸载过的话，共享开关里我方那一格是 false——装回来就置回 true
    reviveLinkFlag(state.bridgeDir);
  }

  log('');
  log(DRY ? 'dry-run 结束：以上是它打算做的改动。' : `安装结束（写入 ${changed} 处）。`);
  log('下一步：完整退出 DSH（托盘退出），再重新打开。');
  log('侧栏应出现「小肥鱼鲸鱼娘」；「爱ai」面板里也有同一个自动联通开关。');
}

try {
  main();
} catch (error) {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
