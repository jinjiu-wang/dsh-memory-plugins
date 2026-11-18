/**
 * 安全屋 · 娱乐/第三方插件接入端口（只读）
 *
 * 目的：让别的插件（桌宠、小游戏、放歌、场景动画…）知道「AI 现在是不是在休息」，
 * 从而自己决定要不要开口、要不要弹东西、要不要静音。端口本身不提供任何
 * 「改安全屋状态」的能力 —— 能改状态的口子只给 AI 自己（工具）和持两半密钥的管理员。
 *
 * 三件东西，全部只读：
 *   1. <sharedDir>/ext/state.json   公开快照（带 schema 版本，不含票据/私钥/聊天正文）
 *   2. <sharedDir>/ext/events.jsonl 事件流（enter/exit/unlock/channel-open…，只有类型与时间）
 *   3. GET /ai-love/safehouse/ext   同一份快照的 HTTP 版本（要过 DSH 登录态）
 *
 * 第三方插件**可以**：
 *   - 轮询/订阅这个快照，在 phase=open 时暂停自己的主动消息、气泡、音效；
 *   - 自己注册工具（如 game_* / music_*），在 execute 里先读这个快照。
 * 第三方插件**不能**：
 *   - 往安全屋里写事件或压力信号（否则等于给第三方一个「锁死 AI」的开关）；
 *   - 复用 safehouse_* 工具名（命名空间留给安全屋自己）。
 */

import path from 'node:path';
import { DEFAULTS, EXT_SCHEMA } from './constants.mjs';
import { fileMtime, readJsonSafe, readTextSafe } from './util.mjs';

/** 由服务层在每次写 gate 时一起写；字段只增不改，版本号变了再谈兼容。 */
export function renderExt({ state, snapshot, link, now = Date.now() }) {
  const accepting = state?.accept === 'window' && Number(state?.acceptUntil) > now;
  const phase = state?.phase === 'open' ? 'open' : 'closed';
  return {
    v: 1,
    schema: EXT_SCHEMA,
    at: now,
    phase,
    locked: state?.locked === true,
    accepting,
    accept: state?.accept === 'none' ? 'none' : 'window',
    acceptUntil: Number(state?.acceptUntil) || 0,
    hold: phase === 'open' && !accepting,
    pressure: Number.isFinite(Number(snapshot?.pressure)) ? Number(snapshot.pressure) : null,
    deltaPct: Number.isFinite(Number(snapshot?.deltaPct)) ? Number(snapshot.deltaPct) : null,
    band: typeof snapshot?.band === 'string' ? snapshot.band : '',
    channelOpen: state?.channelOpen === true,
    linkOk: link?.ok === true,
    lockReason: typeof state?.lockReason === 'string' ? state.lockReason : '',
    unlockReason: typeof state?.unlockReason === 'string' ? state.unlockReason : '',
    since: Number(state?.since) || 0,
    revision: Number(state?.revision) || 0,
  };
}

export function extStateFile(sharedDir) {
  return path.join(path.resolve(sharedDir), 'ext', 'state.json');
}

export function extEventsFile(sharedDir) {
  return path.join(path.resolve(sharedDir), 'ext', 'events.jsonl');
}

/**
 * 给第三方插件读的入口：读不到 / 版本不认识 / 文件坏了就返回 null（当作「不知道」，别拦自己的功能）。
 * @returns {null | ReturnType<typeof renderExt>}
 */
export function readSafehouseExt({ dir, now = Date.now(), staleMs = DEFAULTS.extStaleMs } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') return null;
  const file = extStateFile(dir);
  if (fileMtime(file) === 0) return null;
  const raw = readJsonSafe(file, null);
  if (!raw || typeof raw !== 'object') return null;
  if (raw.schema !== EXT_SCHEMA) return null;
  // 快照过期（插件崩了/采样停了）不能继续告诉第三方「AI 在休息」：
  // 那会让桌宠、放歌之类的插件被永久静音，等于把故障惩罚转嫁给 AI。
  const at = Number(raw.at) || 0;
  if (at <= 0 || now - at > staleMs) return null;
  return raw;
}

/** 读事件流（只读；最多返回最后 limit 条）。 */
export function readSafehouseExtEvents({ dir, limit = 50 } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') return [];
  const text = readTextSafe(extEventsFile(dir), '');
  const rows = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && row.v === 1) rows.push(row);
    } catch {
      /* 半截行忽略 */
    }
  }
  return rows.slice(-Math.max(1, Math.min(500, Number(limit) || 50)));
}

/** 一句话摘要，给第三方插件的日志用。 */
export function describeExt(ext) {
  if (!ext) return '安全屋：没有公开快照（插件没装/没跑）。';
  if (ext.phase !== 'open') return '安全屋：关着。';
  return ext.hold
    ? `安全屋：AI 在休息（${ext.locked ? '锁死' : '未锁'}，压力 ${ext.pressure ?? '?'}/100）`
    : `安全屋：AI 在休息，但正放行消息（到 ${new Date(ext.acceptUntil).toLocaleTimeString('zh-CN')}）`;
}
