/** 小肥鱼鲸鱼娘 · 本地开关 + 两插件共享联通开关 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SETTINGS_FILE = 'settings.json';
export const LINK_FILE = 'link.json';

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

export function readLocalSettings(dataDir) {
  const raw = readJson(path.join(dataDir, SETTINGS_FILE), {});
  return { autoInterop: raw.autoInterop !== false };
}

export function writeLocalSettings(dataDir, patch) {
  const file = path.join(dataDir, SETTINGS_FILE);
  const before = readJson(file, {});
  const next = { ...before, ...patch };
  writeJsonAtomic(file, next);
  return { autoInterop: next.autoInterop !== false };
}

/** 缺文件时默认两边都开：新装插件也在 DSH 启动后自动联通。 */
export function readLinkState(bridgeDir) {
  const raw = readJson(path.join(bridgeDir, LINK_FILE), {});
  return {
    aiLove: raw.aiLove !== false,
    xiaofeiyu: raw.xiaofeiyu !== false,
    updatedAt: Number(raw.updatedAt ?? 0),
  };
}

export function writeLinkFlag(bridgeDir, key, enabled) {
  if (key !== 'aiLove' && key !== 'xiaofeiyu') throw new Error(`未知联通开关：${key}`);
  const file = path.join(bridgeDir, LINK_FILE);
  const value = enabled === true;
  // 两边是不同进程，读-改-写可能互相覆盖；写完自检，丢了就带上对方最新值重写。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const before = readJson(file, {});
    writeJsonAtomic(file, { ...before, [key]: value, updatedAt: Date.now() });
    if (readJson(file, {})[key] === value) break;
  }
  return readLinkState(bridgeDir);
}

/** 自动联通必须两边都开；任何一边关掉都停。 */
export function linkEnabled(localAuto, link) {
  return localAuto === true && link.aiLove === true && link.xiaofeiyu === true;
}

export function linkReason(localAuto, link) {
  if (localAuto !== true) return '本插件已关闭自动联通';
  if (link.aiLove !== true) return '「爱ai」已关闭自动联通';
  if (link.xiaofeiyu !== true) return '「小肥鱼鲸鱼娘」已关闭自动联通';
  return '';
}
