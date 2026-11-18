#!/usr/bin/env node
// 爱ai + 小肥鱼鲸鱼娘 · 组合包一键安装
//
// 用法：
//   node install-all.mjs
//   node install-all.mjs --profile desktop
//   node install-all.mjs --dsh-home "C:\tmp\dsh"
//   node install-all.mjs --repo "D:\qq-bridge"
//   node install-all.mjs --no-preset
//   node install-all.mjs --python "C:\...\python.exe"
//   node install-all.mjs --dry-run
//
// 只负责编排：真正的安装由 packages/<name>/install.mjs 完成。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);

const opt = (name) => {
  const i = ARGS.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = ARGS[i + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
};
const flag = (name) => ARGS.includes(`--${name}`);

const DRY = flag('dry-run');
const NO_PRESET = flag('no-preset');
const SKIP_AI_LOVE = flag('skip-ai-love');
const SKIP_WHALE = flag('skip-whale');

const log = (text) => console.log(text);

function usage() {
  log('爱ai + 小肥鱼鲸鱼娘 · 组合包一键安装');
  log('');
  log('用法：node install-all.mjs [选项]');
  log('  --profile <name|path>   指定 profile（默认 desktop，其次 web）');
  log('  --dsh-home <dir>        自定义 DSH_HOME（默认 ~/.dsh）');
  log('  --repo <dir>            指定 qq-bridge（爱ai 改 QQ preset 用）');
  log('  --no-preset             只装插件本体，不改 QQ preset');
  log('  --python <exe>          指定 Python（小肥鱼鲸鱼娘用）');
  log('  --dry-run               只看计划，不写盘');
  log('  --skip-ai-love          跳过爱ai');
  log('  --skip-whale            跳过小肥鱼鲸鱼娘');
  log('  --help                  显示本帮助');
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
  if (typeof given === 'string' && given.trim() !== '') {
    const candidate = path.isAbsolute(given) ? given : path.join(base, given);
    return fs.existsSync(path.join(candidate, 'package.json')) ? candidate : null;
  }
  for (const name of ['desktop', 'web']) {
    const candidate = path.join(base, name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

function looksLikeRepo(dir) {
  return (
    fs.existsSync(path.join(dir, 'src', 'bridge.js')) &&
    fs.existsSync(path.join(dir, 'config.json')) &&
    fs.existsSync(path.join(dir, 'dsh', 'agent-presets'))
  );
}

function findRepo() {
  if (NO_PRESET) return null;
  const given = opt('repo') ?? process.env.QQ_BRIDGE_DIR;
  const candidates = [];
  if (given !== undefined && String(given).trim() !== '') candidates.push(path.resolve(String(given)));
  // 只从当前 DSH_HOME 的 qq-agent-presets junction 反推 qq-bridge，
  // 不从 cwd 猜：组合包可能被拿来装沙盒，猜错会改到别的 qq-bridge。
  try {
    const presetsDir = fs.realpathSync(path.join(dshHome(), 'plugins', 'qq-agent-presets'));
    candidates.push(path.resolve(presetsDir, '..', '..'));
  } catch {
    // 没装过，不影响
  }
  for (const candidate of candidates) {
    try {
      if (looksLikeRepo(candidate)) return candidate;
    } catch {
      // 权限之类的问题直接跳过
    }
  }
  return null;
}

function findPython() {
  const given = opt('python') ?? process.env.XIAOFEIYU_PYTHON;
  if (typeof given === 'string' && given.trim() !== '') {
    const value = given.trim();
    return value.includes('/') || value.includes('\\') ? path.resolve(value) : value;
  }
  const base = path.join(dshHome(), 'dsh-runtimes');
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const rel of [
        ['dependencies', 'python', 'python.exe'],
        ['dependencies', 'python', 'bin', 'python3'],
      ]) {
        const candidate = path.join(base, entry.name, ...rel);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // 没有 dsh-runtimes 就看 PATH
  }
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

function checkPython(python) {
  const result = spawnSync(python, ['-c', 'import sys, sqlite3; print(sys.version.split()[0])'], {
    encoding: 'utf8',
    timeout: 20000,
  });
  if (result.status !== 0) {
    return { ok: false, detail: String(result.stderr || result.stdout || result.error || '').trim() };
  }
  return { ok: true, detail: String(result.stdout).trim() };
}

function run(label, script, args) {
  log('');
  log('='.repeat(64));
  log(`▶ ${label}`);
  log('='.repeat(64));
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: path.dirname(script),
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    log(`✘ ${label} 启动失败：${result.error.message}`);
    return false;
  }
  return result.status === 0;
}

function main() {
  if (flag('help') || flag('h')) {
    usage();
    return;
  }

  const home = dshHome();
  const profile = findProfile();
  if (profile === null) {
    log(`❌ 找不到 DSH profile（${path.join(home, 'profiles')} 下没有 desktop/web）。`);
    log('   用 --profile 指定，或 --dsh-home 指定 DSH_HOME。');
    process.exitCode = 1;
    return;
  }

  const aiLove = path.join(ROOT, 'packages', 'ai-love', 'install.mjs');
  const whale = path.join(ROOT, 'packages', 'xiaofeiyu-whale', 'install.mjs');
  for (const file of [aiLove, whale]) {
    if (!fs.existsSync(file)) {
      log(`❌ 组合包不完整，缺 ${path.relative(ROOT, file)}。请重新解压。`);
      process.exitCode = 1;
      return;
    }
  }

  const repo = findRepo();
  const python = findPython();
  const pythonCheck = checkPython(python);

  log('爱ai + 小肥鱼鲸鱼娘 · 组合包安装');
  log('='.repeat(64));
  log(`DSH_HOME : ${home}`);
  log(`profile  : ${profile}`);
  log(`qq-bridge: ${repo ?? '未找到（只装插件本体，不改 QQ preset）'}`);
  log(`python   : ${python}${pythonCheck.ok ? `（${pythonCheck.detail}）` : '（不可用）'}`);
  log(`模式     : ${DRY ? 'dry-run（不写盘）' : '正式安装'}`);

  if (!pythonCheck.ok) {
    log('');
    log('⚠️  Python 不可用，小肥鱼鲸鱼娘这一步会失败。');
    log('  用 --python 指定一个带 sqlite3 的 Python 3.10+，或先装 Python。');
    if (!SKIP_WHALE) {
      log('  本次仍会尝试安装；爱ai 不受影响。');
    }
  }
  if (repo === null && !NO_PRESET && !SKIP_AI_LOVE) {
    log('');
    log('· 没找到 qq-bridge：爱ai 会以 --no-preset 安装，只挂面板与记忆本体。');
    log('  之后想接管 QQ 压缩，找到 qq-bridge 后重跑：');
    log(`  node "${path.join(ROOT, 'packages', 'ai-love', 'install.mjs')}" --repo "<qq-bridge>"`);
  }

  const failures = [];

  if (!SKIP_AI_LOVE) {
    const args = ['--dsh-home', home, '--profile', profile];
    if (repo !== null && !NO_PRESET) args.push('--repo', repo);
    else args.push('--no-preset');
    if (DRY) args.push('--dry-run');
    if (!run('爱ai（ai-love）', aiLove, args)) failures.push('爱ai');
  } else {
    log('· 跳过爱ai');
  }

  if (!SKIP_WHALE) {
    const args = [
      '--dsh-home', home,
      '--profile', profile,
      '--python', python,
    ];
    if (DRY) args.push('--dry-run');
    if (!run('小肥鱼鲸鱼娘（xiaofeiyu-whale）', whale, args)) failures.push('小肥鱼鲸鱼娘');
  } else {
    log('· 跳过小肥鱼鲸鱼娘');
  }

  log('');
  log('='.repeat(64));
  if (failures.length === 0) {
    log(`✔ 组合包安装完成${DRY ? '（dry-run）' : ''}`);
    log('');
    log('下一步：');
    log('  1) 完整退出 DSH（托盘图标右键退出，不是关窗口）');
    log('  2) 重新打开 DSH');
    log('  3) 左侧栏应出现「爱ai」和「小肥鱼鲸鱼娘」；两个面板里的自动联通开关都开着即会同步');
    if (repo === null) {
      log('  4) 爱ai 没有改 QQ preset；需要接管 QQ 压缩时用 --repo 重装一次');
    }
  } else {
    log(`✘ 以下组件安装失败：${failures.join('、')}`);
    log('  先看上面的报错；重跑时加 --skip-ai-love / --skip-whale 可只处理一个。');
    process.exitCode = 1;
  }
}

main();
