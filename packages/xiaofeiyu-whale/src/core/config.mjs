/** 小肥鱼鲸鱼娘 · 配置与路径 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const PLUGIN_NAME = 'xiaofeiyu-whale';
export const DISPLAY_NAME = '小肥鱼鲸鱼娘';
export const DEFAULT_INTERVAL_SECONDS = 60;
export const MIN_INTERVAL_SECONDS = 15;

export function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return path.resolve(env.trim());
  return path.join(homedir(), '.dsh');
}

function clampInterval(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_INTERVAL_SECONDS;
  return Math.min(3600, Math.max(MIN_INTERVAL_SECONDS, Math.round(number)));
}

export function normalizeConfig(raw = {}) {
  const home = dshHome();
  const dataDir =
    typeof raw.dataDir === 'string' && raw.dataDir.trim() !== ''
      ? path.resolve(raw.dataDir.trim())
      : path.join(home, PLUGIN_NAME);
  const dbPath =
    typeof raw.dbPath === 'string' && raw.dbPath.trim() !== ''
      ? path.resolve(raw.dbPath.trim())
      : path.join(dataDir, 'memory.db');
  const bridgeDir =
    typeof raw.bridgeDir === 'string' && raw.bridgeDir.trim() !== ''
      ? path.resolve(raw.bridgeDir.trim())
      : path.join(home, 'memory-bridge');
  return Object.freeze({
    dataDir,
    dbPath,
    bridgeDir,
    autoInterop: raw.autoInterop !== false,
    intervalSeconds: clampInterval(raw.intervalSeconds),
    python: typeof raw.python === 'string' ? raw.python.trim() : '',
  });
}

/** 找本机 Python：配置优先，其次 DSH 自带运行时，最后退回 PATH 里的 python。 */
export function detectPython(explicit = '') {
  const given = String(explicit ?? '').trim();
  if (given !== '') {
    // 配置里是路径时要求真实存在；DSH 升级换掉运行时路径后要能自动回退。
    const looksLikePath = given.includes('/') || given.includes('\\');
    if (!looksLikePath || existsSync(given)) return given;
  }
  const env = process.env.XIAOFEIYU_PYTHON;
  if (typeof env === 'string' && env.trim() !== '') {
    // 环境变量和 --python 一样：裸命令名交给 PATH，带分隔符的才当路径校验。
    const value = env.trim();
    const looksLikePath = value.includes('/') || value.includes('\\');
    if (looksLikePath && existsSync(value)) return path.resolve(value);
    if (!looksLikePath) return value;
  }

  const runtimes = path.join(dshHome(), 'dsh-runtimes');
  try {
    for (const name of readdirSync(runtimes, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      for (const rel of [
        ['dependencies', 'python', 'python.exe'],
        ['dependencies', 'python', 'bin', 'python3'],
      ]) {
        const candidate = path.join(runtimes, name.name, ...rel);
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // 没有运行时目录就继续找 PATH
  }
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

export function resolveBridgeFiles(bridgeDir) {
  return {
    aiLoveFile: path.join(bridgeDir, 'ai-love.jsonl'),
    peerFile: path.join(bridgeDir, `${PLUGIN_NAME}.jsonl`),
    linkFile: path.join(bridgeDir, 'link.json'),
  };
}
