/**
 * 爱ai · 与「小肥鱼鲸鱼娘」的自动联通
 *
 * 两份文件各写各的，互不覆盖：
 *   <bridgeDir>/ai-love.jsonl           爱ai → 小肥鱼鲸鱼娘
 *   <bridgeDir>/xiaofeiyu-whale.jsonl   小肥鱼鲸鱼娘 → 爱ai
 *   <bridgeDir>/link.json               两边共享的总开关
 *
 * 自动联通必须两边都开：本地面板开关 + link.json 里 aiLove/xiaofeiyu 都为 true。
 * 任何一边关掉，两边都会停止自动同步；手动「立即同步」仍可强制跑一次。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { dshHome, resolveMemoryDir } from './memory.mjs';
import { exportToFile, importRecords } from './interop.mjs';

export const MEMORY_BRIDGE_DIR_NAME = 'memory-bridge';
export const AI_LOVE_FILE = 'ai-love.jsonl';
export const PEER_FILE = 'xiaofeiyu-whale.jsonl';
export const LINK_FILE = 'link.json';
export const AUTO_FILE = 'auto.json';
export const AUTO_INTERVAL_MS = 60_000;
const MAX_INTEROP_BYTES = 128 * 1024 * 1024;

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
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

export function resolveAutoBridge(config = {}) {
  const memoryDir = resolveMemoryDir(config);
  const explicit =
    typeof config.memoryBridgeDir === 'string' ? config.memoryBridgeDir.trim() : '';
  const bridgeDir = explicit !== '' ? path.resolve(explicit) : path.join(dshHome(), MEMORY_BRIDGE_DIR_NAME);
  return {
    memoryDir,
    bridgeDir,
    aiLoveFile: path.join(bridgeDir, AI_LOVE_FILE),
    peerFile: path.join(bridgeDir, PEER_FILE),
    linkFile: path.join(bridgeDir, LINK_FILE),
    settingsFile: path.join(memoryDir, 'interop', AUTO_FILE),
  };
}

export function readLocalAuto(paths) {
  const raw = readJson(paths.settingsFile, {});
  return raw.auto !== false;
}

export function writeLocalAuto(paths, enabled) {
  const before = readJson(paths.settingsFile, {});
  writeJsonAtomic(paths.settingsFile, { ...before, auto: enabled === true, updatedAt: Date.now() });
  return enabled === true;
}

/** 缺文件时默认两边都开：新装插件也在 DSH 启动后自动联通。 */
export function readLinkState(paths) {
  const raw = readJson(paths.linkFile, {});
  return {
    aiLove: raw.aiLove !== false,
    xiaofeiyu: raw.xiaofeiyu !== false,
    updatedAt: Number(raw.updatedAt ?? 0),
  };
}

export function writeLinkFlag(paths, key, enabled) {
  if (key !== 'aiLove' && key !== 'xiaofeiyu') throw new Error(`未知联通开关：${key}`);
  const value = enabled === true;
  // 两边是不同进程，读-改-写可能互相覆盖；写完自检，丢了就带上对方最新值重写。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const before = readJson(paths.linkFile, {});
    writeJsonAtomic(paths.linkFile, { ...before, [key]: value, updatedAt: Date.now() });
    if (readJson(paths.linkFile, {})[key] === value) break;
  }
  return readLinkState(paths);
}

export function linkEnabled(localAuto, link) {
  return localAuto === true && link.aiLove === true && link.xiaofeiyu === true;
}

export function linkReason(localAuto, link) {
  if (localAuto !== true) return '「爱ai」已关闭自动联通';
  if (link.aiLove !== true) return '「爱ai」已关闭自动联通';
  if (link.xiaofeiyu !== true) return '「小肥鱼鲸鱼娘」已关闭自动联通';
  return '';
}

function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function parseJsonl(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const row = JSON.parse(trimmed);
      if (row !== null && typeof row === 'object') rows.push(row);
    } catch {
      // 坏行跳过，和手动导入保持一致
    }
  }
  return rows;
}

/**
 * 建一个自动联通器。syncNow 内部串行：同一时间只有一个同步在跑。
 * 返回对象的 status() 可直接塞进面板 /state。
 */
export function createAutoBridge({ config = {}, store, sessionScopes = {}, logger } = {}) {
  const paths = resolveAutoBridge(config);
  let syncing = null;
  let lastPeerHash = '';
  let lastSync = { at: 0, exported: 0, imported: null, error: '', reason: '' };
  let lastLoggedError = '';

  function status() {
    const localAuto = readLocalAuto(paths);
    const link = readLinkState(paths);
    return {
      auto: localAuto,
      peerAuto: link.xiaofeiyu,
      ownLink: link.aiLove,
      enabled: linkEnabled(localAuto, link),
      reason: linkReason(localAuto, link),
      bridgeDir: paths.bridgeDir,
      aiLoveFile: paths.aiLoveFile,
      peerFile: paths.peerFile,
      linkFile: paths.linkFile,
      intervalSeconds: Math.round(AUTO_INTERVAL_MS / 1000),
      syncing: syncing !== null,
      lastSync,
    };
  }

  function logOnce(message) {
    if (message === lastLoggedError) return;
    lastLoggedError = message;
    try {
      logger?.warn?.(`ai-love: ${message}`);
    } catch {
      // 日志失败不影响同步
    }
  }

  async function readPeer() {
    if (!existsSync(paths.peerFile)) return null;
    const info = statSync(paths.peerFile);
    if (!info.isFile()) return null;
    if (info.size > MAX_INTEROP_BYTES) {
      throw new Error(`互通文件太大（${info.size} 字节，上限 ${MAX_INTEROP_BYTES}）`);
    }
    const text = await readFile(paths.peerFile, 'utf8');
    const hash = hashText(text);
    if (hash === lastPeerHash) return null;
    return { text, hash };
  }

  async function runSync() {
    const exported = await exportToFile(store, paths.aiLoveFile, {
      includeNotes: true,
      sessionScopes,
    });
    let imported = null;
    const peer = await readPeer();
    if (peer !== null) {
      const rows = parseJsonl(peer.text);
      imported = await importRecords(store, rows, { sessionScopes });
      lastPeerHash = peer.hash;
    }
    return { exported, imported };
  }

  async function syncNow({ force = false } = {}) {
    if (syncing !== null) return syncing;
    const current = status();
    if (!force && !current.enabled) {
      lastSync = { ...lastSync, reason: current.reason || '自动联通已关闭' };
      return { ok: false, skipped: true, error: lastSync.reason };
    }
    syncing = (async () => {
      try {
        const result = await runSync();
        lastSync = { at: Date.now(), ...result, error: '', reason: '' };
        lastLoggedError = '';
        return { ok: true, ...result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastSync = { ...lastSync, at: Date.now(), error: message, reason: '' };
        logOnce(`自动同步失败：${message}`);
        throw error;
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  }

  function setAuto(enabled) {
    const auto = writeLocalAuto(paths, enabled);
    const link = writeLinkFlag(paths, 'aiLove', auto);
    return { auto, link, enabled: linkEnabled(auto, link) };
  }

  /** 启动后先跑一次，然后按固定间隔跑；返回清理函数。 */
  function start(intervalMs = AUTO_INTERVAL_MS) {
    const kick = setTimeout(() => {
      if (status().enabled) {
        void syncNow().catch(() => {
          // 失败状态在面板显示，不阻塞 DSH 启动
        });
      }
    }, 1500);
    const timer = setInterval(() => {
      if (status().enabled) {
        void syncNow().catch(() => {
          // 同上
        });
      }
    }, intervalMs);
    timer.unref?.();
    return () => {
      clearTimeout(kick);
      clearInterval(timer);
    };
  }

  return { paths, status, syncNow, setAuto, start };
}
