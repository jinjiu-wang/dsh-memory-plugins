#!/usr/bin/env node
// 小肥鱼鲸鱼娘 卸载器
//
// 默认只移除插件代码与 profile 注册，记忆数据库和共享互通目录原样保留。
//   node uninstall.mjs
//   node uninstall.mjs --dry-run
//   node uninstall.mjs --dsh-home "C:\tmp\dsh"
//   node uninstall.mjs --purge   # 连同 <DSH_HOME>/xiaofeiyu-whale 一起删（谨慎）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
const PURGE = flag('purge');

const log = (text) => console.log(text);
const act = (text) => log(DRY ? `  (dry) ${text}` : `  ✔ ${text}`);

function readText(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
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

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(readText(file));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** 卸载时把共享开关里我方那一格置成 false：我走了，别让「爱ai」一直往空处同步。
 *
 * 注意：这是**我方自己的键**（xiaofeiyu），不是对方的总开关；对方的总开关一个字节都不动。
 * 重新安装时 install.mjs 会把它置回 true，所以"卸载→再装"不会把自己锁死。
 */
function retireLinkFlag(bridgeDir) {
  const file = path.join(bridgeDir, 'link.json');
  if (!fs.existsSync(file)) return;
  const before = readJson(file, null);
  if (before === null || before.xiaofeiyu === false) return;
  if (DRY) {
    log('  (dry) 把 link.json 里 xiaofeiyu 置为 false');
    return;
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...before, xiaofeiyu: false, updatedAt: Date.now() }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  log('  ✔ 已把共享开关里 xiaofeiyu 置为 false（对方不会再尝试同步到已卸载的插件）');
}

function main() {
  const home = dshHome();
  const profile = findProfile();
  const packageDir = path.join(home, 'plugins', PKG_NAME);
  const state = readJson(path.join(packageDir, '.install-state.json'), {});
  const dataDir =
    typeof state.dataDir === 'string' && state.dataDir.trim() !== ''
      ? path.resolve(state.dataDir.trim())
      : path.join(home, PKG_NAME);
  const bridgeDir =
    typeof state.bridgeDir === 'string' && state.bridgeDir.trim() !== ''
      ? path.resolve(state.bridgeDir.trim())
      : path.join(home, 'memory-bridge');
  log('小肥鱼鲸鱼娘 · 卸载器');
  log(`DSH_HOME : ${home}`);
  log(`profile  : ${profile ?? '未找到（跳过 profile 清理）'}`);
  log(`模式     : ${DRY ? 'dry-run（不写盘）' : '正式卸载'}${PURGE ? ' / 连同数据目录' : ''}`);

  retireLinkFlag(bridgeDir);

  if (profile !== null) {
    const file = path.join(profile, 'package.json');
    const pkg = JSON.parse(readText(file));
    let dirty = false;
    if (pkg.dependencies && pkg.dependencies[PKG_NAME] !== undefined) {
      delete pkg.dependencies[PKG_NAME];
      dirty = true;
    }
    if (Array.isArray(pkg.dsh?.profile?.bundles)) {
      const next = pkg.dsh.profile.bundles.filter((name) => name !== PKG_NAME);
      if (next.length !== pkg.dsh.profile.bundles.length) {
        pkg.dsh.profile.bundles = next;
        dirty = true;
      }
    }
    if (dirty) {
      if (!DRY) {
        const bak = `${file}.${PKG_NAME}.bak`;
        if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
        fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
      }
      act('profile 依赖与 bundle 已移除');
    } else {
      log('  · profile 里没有注册');
    }
    const link = path.join(profile, 'node_modules', PKG_NAME);
    if (fs.existsSync(link)) {
      if (!DRY) fs.rmSync(link, { recursive: true, force: true });
      act(`移除 ${link}`);
    }
  }

  if (fs.existsSync(packageDir)) {
    if (!DRY) fs.rmSync(packageDir, { recursive: true, force: true });
    act(`移除 ${packageDir}`);
  } else {
    log('  · 插件目录不存在');
  }

  if (PURGE) {
    if (fs.existsSync(dataDir)) {
      if (!DRY) fs.rmSync(dataDir, { recursive: true, force: true });
      act(`移除数据目录 ${dataDir}`);
    }
    if (fs.existsSync(bridgeDir)) {
      log(`  · 共享互通目录保留：${bridgeDir}（爱ai 也在用，手动确认后再删）`);
    }
  } else {
    log(`  · 记忆数据库保留：${dataDir}`);
    log(`  · 共享互通目录保留：${bridgeDir}`);
  }

  log('');
  log(DRY ? 'dry-run 结束。' : '卸载完成。建议完整退出 DSH 再打开。');
}

try {
  main();
} catch (error) {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
