/**
 * 安全屋 · 压力引擎
 *
 * 「AI 运行压力」不是一个玄学指标：这里只用桥接侧已经落盘的真实信号算，
 * 每一档都能解释为什么。
 *
 *   1. 消息涌入  最近 5 分钟收到多少条（social-v2.json 的 recentMessages）
 *   2. 未读积压  所有会话 unread 条数之和
 *   3. 唤醒频率  最近 10 分钟被叫醒多少次（wakeTimes）
 *   4. 失败/超时 最近 10 分钟工具失败条数（tool-calls.jsonl）
 *   5. 上下文水位 爱ai 的 tokenwise 档位（0~4）
 *
 * 压力值 pressure ∈ [0,100] 是绝对水位；
 * 波动 deltaPct 才是分档依据：相对最近 10 分钟基线「瞬间上升」了多少。
 *
 * 分档（用户定义，照抄不改）：
 *   delta < 10            → calm（比低压力还平静，按 low 处理：禁入）
 *   10 <= delta < 30      → low   （密钥无权开放开关）
 *   30 <= delta < 60      → normal（AI 自主决定）
 *   delta >= 60           → high  （可进；进入即锁死）
 */

import path from 'node:path';
import { closeSync, openSync, readSync } from 'node:fs';
import {
  DEFAULTS,
  MEASURE_CAPS,
  WEIGHTS,
} from './constants.mjs';
import {
  clamp,
  clamp01,
  num,
  readJsonSafe,
  fileSize,
} from './util.mjs';

/** 读文件尾部，避免把几百 KB 的日志整个读进内存。 */
function readTail(file, maxBytes = 256 * 1024) {
  const size = fileSize(file);
  if (size === 0) return '';
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    // 刚装好桥接时 tool-calls.jsonl 可能还没生成；当 0 条，不要让工具调用整个失败。
    return '';
  }
  try {
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

/** 解析 tool-calls.jsonl 尾部，数最近 windowMs 内失败条数。 */
function countRecentToolFailures(file, sinceMs) {
  const text = readTail(file);
  if (text === '') return 0;
  let count = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.type !== 'result' || row.ok !== false) continue;
    const at = Date.parse(String(row.time ?? ''));
    if (Number.isFinite(at) && at >= sinceMs) count += 1;
  }
  return count;
}

/** 从 social-v2.json 取消息/积压/唤醒三类信号。 */
export function readSocialSignals(state, now = Date.now()) {
  const conversations = state?.conversations && typeof state.conversations === 'object'
    ? state.conversations
    : {};
  let messagesLast5m = 0;
  let unreadTotal = 0;
  let wakesLast10m = 0;
  const cutoff5 = now - 5 * 60_000;
  const cutoff10 = now - 10 * 60_000;

  for (const conv of Object.values(conversations)) {
    if (!conv || typeof conv !== 'object') continue;
    const unread = Array.isArray(conv.unread) ? conv.unread.length : 0;
    unreadTotal += unread;
    if (Array.isArray(conv.recentMessages)) {
      for (const msg of conv.recentMessages) {
        if (!msg || msg.isSelf === true) continue;
        if (num(msg.time) >= cutoff5) messagesLast5m += 1;
      }
    }
    if (Array.isArray(conv.wakeTimes)) {
      for (const at of conv.wakeTimes) {
        if (num(at) >= cutoff10) wakesLast10m += 1;
      }
    }
  }
  return { messagesLast5m, unreadTotal, wakesLast10m };
}

/** tokenwise 档位 0~4 映射到 0~1；读不到就当 0（不凭空加压力）。 */
function readContextLoad(memoryDir) {
  if (!memoryDir) return 0;
  const meta = readJsonSafe(path.join(memoryDir, 'tokenwise.json'), null);
  const level = num(meta?.level, 0);
  return clamp01(level / 4);
}

/** 从原始信号算绝对压力值。 */
export function computePressure(signals) {
  const inflow = clamp01(num(signals.messagesLast5m) / MEASURE_CAPS.messagesLast5m);
  const backlog = clamp01(num(signals.unreadTotal) / MEASURE_CAPS.unreadTotal);
  const wake = clamp01(num(signals.wakesLast10m) / MEASURE_CAPS.wakesLast10m);
  const errors = clamp01(num(signals.errorsLast10m) / MEASURE_CAPS.errorsLast10m);
  const context = clamp01(num(signals.contextLoad));
  const score =
    WEIGHTS.inflow * inflow +
    WEIGHTS.backlog * backlog +
    WEIGHTS.wake * wake +
    WEIGHTS.errors * errors +
    WEIGHTS.context * context;
  return clamp(Math.round(score * 100), 0, 100);
}

/** 波动分档。delta 已保证 >= 0。 */
export function bandOf(deltaPct) {
  const t = DEFAULTS.bandThresholds;
  if (deltaPct >= t.high) return 'high';
  if (deltaPct >= t.normal) return 'normal';
  if (deltaPct >= t.low) return 'low';
  return 'calm';
}

/** 是否落在「退出/解锁窗口」。 */
export function inExitWindow(deltaPct) {
  const w = DEFAULTS.exitWindow;
  return deltaPct >= w.min && deltaPct <= w.max;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export class PressureEngine {
  constructor({ bridgeDir = '', memoryDir = '' } = {}) {
    this.bridgeDir = bridgeDir ? path.resolve(bridgeDir) : '';
    this.memoryDir = memoryDir ? path.resolve(memoryDir) : '';
    this.history = [];
    this.latest = null;
    this._timer = null;
  }

  setDirs({ bridgeDir, memoryDir } = {}) {
    if (typeof bridgeDir === 'string' && bridgeDir.trim() !== '') this.bridgeDir = path.resolve(bridgeDir);
    if (typeof memoryDir === 'string' && memoryDir.trim() !== '') this.memoryDir = path.resolve(memoryDir);
  }

  socialFile() {
    return this.bridgeDir ? path.join(this.bridgeDir, 'state', 'social-v2.json') : '';
  }

  /** 采一次样，返回 { pressure, deltaPct, band, signals, baseline }。 */
  sample(now = Date.now()) {
    const social = this.socialFile() ? readJsonSafe(this.socialFile(), null) : null;
    const socialSignals = readSocialSignals(social, now);
    const toolCalls = this.bridgeDir ? path.join(this.bridgeDir, 'state', 'tool-calls.jsonl') : '';
    const signals = {
      ...socialSignals,
      errorsLast10m: toolCalls ? countRecentToolFailures(toolCalls, now - 10 * 60_000) : 0,
      contextLoad: readContextLoad(this.memoryDir),
      bridgeOnline: social !== null,
    };
    const pressure = computePressure(signals);

    this.history.push({ at: now, pressure });
    if (this.history.length > DEFAULTS.pressureHistoryMax) {
      this.history.splice(0, this.history.length - DEFAULTS.pressureHistoryMax);
    }
    const windowStart = now - DEFAULTS.baselineWindowMs;
    // 基线只取「本次之前」的样本：把当前样本算进去会让刚重启时 baseline=当前值，
    // 波动恒为 0，锁死状态永远等不到窗口。
    const baselineSamples = this.history
      .slice(0, -1)
      .filter((item) => item.at >= windowStart)
      .map((item) => item.pressure);
    // 样本不足时用「本次之前的最小值」当基线，避免刚启动的插件把基线钉在当前值。
    const baselineRaw = baselineSamples.length >= DEFAULTS.baselineMinSamples
      ? median(baselineSamples)
      : baselineSamples.length >= 1
        ? Math.min(...baselineSamples)
        : pressure;
    const baseline = Math.max(DEFAULTS.baselineFloor, baselineRaw);
    const rise = pressure - baseline;
    const deltaPct = rise <= 0 ? 0 : (rise / baseline) * 100;
    const band = bandOf(deltaPct);
    this.latest = {
      at: now,
      pressure,
      baseline: Math.round(baseline * 10) / 10,
      deltaPct: Math.round(deltaPct * 10) / 10,
      band,
      signals,
      historySize: this.history.length,
    };
    return this.latest;
  }

  start(onSample) {
    if (this._timer) return;
    const tick = () => {
      try {
        const snapshot = this.sample();
        onSample?.(snapshot);
      } catch {
        /* 采样失败不动状态机，等下一轮 */
      }
    };
    tick();
    this._timer = setInterval(tick, DEFAULTS.sampleIntervalMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  snapshot() {
    return this.latest;
  }
}

export const PRESSURE_TEXT = Object.freeze({
  calm: '平静（波动 <10%，密钥无权开开关）',
  low: '低压力（波动 10%~30%，密钥无权开开关）',
  normal: '正常（波动 30%~60%，AI 可自行决定）',
  high: '高压力（波动 ≥60%，进入即锁死）',
});

/** 给提示词/通道用的一句话摘要。 */
export function describePressure(snapshot) {
  if (!snapshot) return '压力：还没采到数据。';
  const signals = snapshot.signals ?? {};
  return [
    `压力 ${snapshot.pressure}/100，波动 +${snapshot.deltaPct}% → ${PRESSURE_TEXT[snapshot.band] ?? snapshot.band}`,
    `（近5分钟消息 ${num(signals.messagesLast5m)} 条、未读积压 ${num(signals.unreadTotal)} 条、近10分钟唤醒 ${num(signals.wakesLast10m)} 次、工具失败 ${num(signals.errorsLast10m)} 次、上下文档 ${num(signals.contextLoad) * 4}/4）`,
  ].join('');
}
