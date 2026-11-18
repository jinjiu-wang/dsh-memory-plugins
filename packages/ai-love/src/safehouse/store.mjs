/**
 * 安全屋 · 共享状态（两侧读写同一份）
 *
 * 落盘位置：<sharedDir>/state.json（默认 ~/.dsh/safehouse/state.json）
 * 所有写都是「锁文件 + 原子写」；读-改-写在同一把锁里完成，撞车会重试而不是静默丢写。
 */

import path from 'node:path';
import {
  appendLine,
  cleanText,
  ensureDir,
  fileMtime,
  fileSize,
  nowIso,
  readJsonSafe,
  readTextSafe,
  withFileLock,
  writeJsonAtomic,
  writeTextAtomic,
} from './util.mjs';
import { DEFAULTS } from './constants.mjs';

export const ACCEPT_MODES = Object.freeze(['none', 'window']);

export function emptyState() {
  return {
    v: 1,
    phase: 'closed',
    locked: false,
    lockedAt: 0,
    /** 进入锁死时的绝对压力水位：解锁必须低于它，防止「越加压越能解锁」。 */
    lockedPressure: 0,
    /** 锁死期间采到的样本数：系统时钟乱跳时用 ticks×采样间隔兜底 maxLock。 */
    lockTicks: 0,
    lockReason: '',
    unlockReason: '',
    since: 0,
    enteredBy: '',
    revision: 0,
    updatedAt: 0,
    pressure: null,
    accept: 'none',
    acceptUntil: 0,
    openToken: '',
    channelOpen: false,
    channelOpenedAt: 0,
    valveSince: 0,
    events: [],
  };
}

export function normalizeState(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const events = Array.isArray(value.events)
    ? value.events
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          at: Number(item.at) || 0,
          type: cleanText(item.type, 40),
          by: cleanText(item.by, 40),
          note: cleanText(item.note, 200),
        }))
        .slice(-60)
    : [];
  return {
    ...emptyState(),
    phase: value.phase === 'open' ? 'open' : 'closed',
    locked: value.locked === true,
    lockedAt: Number(value.lockedAt) || 0,
    lockedPressure: Number(value.lockedPressure) || 0,
    lockTicks: Math.max(0, Math.floor(Number(value.lockTicks) || 0)),
    lockReason: cleanText(value.lockReason, 60),
    unlockReason: cleanText(value.unlockReason, 60),
    since: Number(value.since) || 0,
    enteredBy: cleanText(value.enteredBy, 40),
    revision: Number(value.revision) || 0,
    updatedAt: Number(value.updatedAt) || 0,
    pressure: value.pressure && typeof value.pressure === 'object' ? value.pressure : null,
    accept: ACCEPT_MODES.includes(value.accept) ? value.accept : 'none',
    acceptUntil: Number(value.acceptUntil) || 0,
    openToken: typeof value.openToken === 'string' ? value.openToken.slice(0, 128) : '',
    channelOpen: value.channelOpen === true,
    channelOpenedAt: Number(value.channelOpenedAt) || 0,
    valveSince: Number(value.valveSince) || 0,
    events,
  };
}

/** 行数型日志裁剪：只在超限时重写一次，避免无限增长。 */
function trimLines(file, maxLines) {
  const text = readTextSafe(file, '');
  if (text === '') return;
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length <= maxLines) return;
  writeTextAtomic(file, `${lines.slice(-maxLines).join('\n')}\n`);
}

export class SafehouseStore {
  constructor(sharedDir) {
    this.dir = path.resolve(sharedDir);
    this.stateFile = path.join(this.dir, 'state.json');
    this.gateFile = path.join(this.dir, 'gate.json');
    this.auditFile = path.join(this.dir, 'audit.jsonl');
    this.extDir = path.join(this.dir, 'ext');
    this.extEventFile = path.join(this.extDir, 'events.jsonl');
    this.stateLock = path.join(this.dir, 'state.lock');
    this.gateLock = path.join(this.dir, 'gate.lock');
    this.auditLock = path.join(this.dir, 'audit.lock');
    ensureDir(this.dir);
  }

  readState() {
    const raw = readJsonSafe(this.stateFile, null);
    return normalizeState(raw);
  }

  writeState(state) {
    const next = normalizeState(state);
    next.updatedAt = Date.now();
    writeJsonAtomic(this.stateFile, next);
    return next;
  }

  /**
   * 读-改-写：整段在文件锁里完成。
   * fn 收到当前 state，返回 { state, result } 或 null（不改，不写盘）。
   * 拿不到锁 / 写盘失败时返回 result:null（上层按 busy 处理），不会「假成功」。
   */
  mutate(fn) {
    try {
      return withFileLock(this.stateLock, () => {
        const before = this.readState();
        const outcome = fn(before);
        if (!outcome) return { state: before, result: null };
        const next = {
          ...outcome.state,
          revision: before.revision + 1,
        };
        const written = this.writeState(next);
        return { state: written, result: outcome.result };
      });
    } catch {
      return { state: this.readState(), result: null };
    }
  }

  readGate() {
    return readJsonSafe(this.gateFile, null);
  }

  writeGate(gate) {
    withFileLock(this.gateLock, () => writeJsonAtomic(this.gateFile, gate));
    return gate;
  }

  gateAgeMs() {
    const at = fileMtime(this.gateFile);
    return at === 0 ? Infinity : Math.max(0, Date.now() - at);
  }

  /** 审计：只记状态转移和通道开关，不记聊天正文。 */
  audit(event) {
    const row = {
      at: Date.now(),
      time: nowIso(),
      type: cleanText(event?.type, 40),
      by: cleanText(event?.by, 40),
      note: cleanText(event?.note, 200),
    };
    try {
      withFileLock(this.auditLock, () => {
        appendLine(this.auditFile, JSON.stringify(row));
        if (fileSize(this.auditFile) > 512 * 1024) trimLines(this.auditFile, DEFAULTS.auditMaxLines);
        // 公开事件流：只留「发生了什么」，不带 note/by 的正文，给娱乐插件等第三方订阅。
        ensureDir(this.extDir);
        appendLine(
          this.extEventFile,
          JSON.stringify({ v: 1, at: row.at, type: row.type, by: row.by }),
        );
        if (fileSize(this.extEventFile) > 128 * 1024) trimLines(this.extEventFile, DEFAULTS.extEventMax);
      });
    } catch {
      /* 审计写不进去不影响状态机 */
    }
    return row;
  }

  /** 事件同时留在 state.events（给面板/提示词看最近几条）。 */
  noteEvent(state, { type, by, note }) {
    const stateNext = { ...state };
    stateNext.events = [...(state.events ?? []), {
      at: Date.now(),
      type: cleanText(type, 40),
      by: cleanText(by, 40),
      note: cleanText(note, 200),
    }].slice(-60);
    this.audit({ type, by, note });
    return stateNext;
  }
}

export function renderGate({ state, snapshot, link, config }) {
  const now = Date.now();
  const accepting = state.accept === 'window' && state.acceptUntil > now;
  const hold = state.phase === 'open' && !accepting;
  return {
    v: 1,
    updatedAt: now,
    expiresAt: now + (config?.gateStaleMs ?? DEFAULTS.gateStaleMs),
    hold,
    reason: hold
      ? (state.locked ? 'safehouse-locked' : 'safehouse-open')
      : accepting
        ? 'accepting'
        : 'not-in-safehouse',
    phase: state.phase,
    locked: state.locked === true,
    accept: state.accept,
    acceptUntil: state.acceptUntil,
    pressure: snapshot?.pressure ?? null,
    deltaPct: snapshot?.deltaPct ?? null,
    band: snapshot?.band ?? '',
    link: {
      ok: link?.ok === true,
      peer: link?.peer ?? '',
      epoch: link?.epoch ?? '',
    },
    revision: state.revision,
  };
}
