#!/usr/bin/env node
// 爱ai + 小肥鱼鲸鱼娘 · 组合包一键卸载
//
// 默认保留记忆数据；只有显式加 --purge-memory / --purge 才会删。
//   node uninstall-all.mjs
//   node uninstall-all.mjs --dry-run
//   node uninstall-all.mjs --purge-all
//   node uninstall-all.mjs --skip-ai-love
//   node uninstall-all.mjs --skip-whale
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
const PURGE_ALL = flag('purge-all');
const PURGE_MEMORY = PURGE_ALL || flag('purge-memory');
const PURGE_WHALE = PURGE_ALL || flag('purge');
const SKIP_AI_LOVE = flag('skip-ai-love');
const SKIP_WHALE = flag('skip-whale');

const log = (text) => console.log(text);

function usage() {
  log('爱ai + 小肥鱼鲸鱼娘 · 组合包一键卸载');
  log('');
  log('用法：node uninstall-all.mjs [选项]');
  log('  --profile <name|path>   指定 profile（默认 desktop，其次 web）');
  log('  --dsh-home <dir>        自定义 DSH_HOME（默认 ~/.dsh）');
  log('  --repo <dir>            指定 qq-bridge（还原 QQ preset 用）');
  log('  --dry-run               只看计划，不写盘');
  log('  --purge-memory          连爱ai 记忆档案一起删');
  log('  --purge                 连鲸鱼娘记忆库一起删');
  log('  --purge-all             两个都连数据一起删');
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
  const given = opt('repo') ?? process.env.QQ_BRIDGE_DIR;
  const candidates = [];
  if (given !== undefined && String(given).trim() !== '') candidates.push(path.resolve(String(given)));
  // 只从当前 DSH_HOME 的 qq-agent-presets junction 反推 qq-bridge，
  // 不从 cwd 猜：卸载沙盒时猜错会改到真实 qq-bridge 的 preset。
  try {
    const presetsDir = fs.realpathSync(path.join(dshHome(), 'plugins', 'qq-agent-presets'));
    candidates.push(path.resolve(presetsDir, '..', '..'));
  } catch {
    // 没装过
  }
  for (const candidate of candidates) {
    try {
      if (looksLikeRepo(candidate)) return candidate;
    } catch {
      // 跳过
    }
  }
  return null;
}

function run(label, script, args, env = process.env) {
  log('');
  log('='.repeat(64));
  log(`▶ ${label}`);
  log('='.repeat(64));
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: path.dirname(script),
    stdio: 'inherit',
    env,
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
    process.exitCode = 1;
    return;
  }

  const aiLove = path.join(ROOT, 'packages', 'ai-love', 'uninstall.mjs');
  const whale = path.join(ROOT, 'packages', 'xiaofeiyu-whale', 'uninstall.mjs');
  for (const file of [aiLove, whale]) {
    if (!fs.existsSync(file)) {
      log(`❌ 组合包不完整，缺 ${path.relative(ROOT, file)}。请重新解压。`);
      process.exitCode = 1;
      return;
    }
  }

  const repo = findRepo();
  log('爱ai + 小肥鱼鲸鱼娘 · 组合包卸载');
  log('='.repeat(64));
  log(`DSH_HOME : ${home}`);
  log(`profile  : ${profile}`);
  log(`qq-bridge: ${repo ?? '未找到（只移除插件本体）'}`);
  log(`模式     : ${DRY ? 'dry-run（不写盘）' : '正式卸载'}`);
  log(`数据     : ${PURGE_ALL ? '连记忆一起删' : '保留'}`);

  const failures = [];

  if (!SKIP_WHALE) {
    const args = ['--dsh-home', home, '--profile', profile];
    if (DRY) args.push('--dry-run');
    if (PURGE_WHALE) args.push('--purge');
    if (!run('小肥鱼鲸鱼娘（xiaofeiyu-whale）', whale, args)) failures.push('小肥鱼鲸鱼娘');
  } else {
    log('· 跳过小肥鱼鲸鱼娘');
  }

  if (!SKIP_AI_LOVE) {
    const args = ['--profile', profile];
    if (repo !== null) args.push('--repo', repo);
    if (DRY) args.push('--dry-run');
    if (PURGE_MEMORY) args.push('--purge-memory');
    // ai-love 的卸载器读环境变量 DSH_HOME，不认 --dsh-home。
    const env = { ...process.env, DSH_HOME: home };
    if (!run('爱ai（ai-love）', aiLove, args, env)) failures.push('爱ai');
  } else {
    log('· 跳过爱ai');
  }

  log('');
  log('='.repeat(64));
  if (failures.length === 0) {
    log(`✔ 组合包卸载完成${DRY ? '（dry-run）' : ''}`);
    if (!PURGE_ALL) log('  记忆数据保留在各插件的数据目录里。');
    log('  完整退出 DSH 再打开，侧栏图标才会消失。');
  } else {
    log(`✘ 以下组件卸载失败：${failures.join('、')}`);
    log('  先看上面的报错；必要时进对应 packages/<name> 目录单独跑 uninstall.mjs。');
    process.exitCode = 1;
  }
}

main();
