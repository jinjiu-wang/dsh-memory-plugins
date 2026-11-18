/**
 * 安全屋 · 状态转移规则（纯函数，方便单测）
 *
 * 只有三条路能改变「在不在安全屋」：
 *   enter        AI 自己决定进（或插件替 AI 申请，前提是 AI 的 L1 授权槽开着）
 *   exit         AI 自己决定出；锁死期间出不去
 *   forceExit    管理员通过独立通道把人拉出来；锁死期间任何管理员操作都不行，
 *                只有压力真的回落才允许
 *
 * 高压锁死的解除（只解锁，不自动把人移出）：
 *   1. 压力真的回落：波动 <= 40% 且绝对压力不高于进入时的水位（包含 20%~40% 窗口，也包含窗口以下）；
 *   2. 安全阀：绝对压力 <= 25 持续 2 分钟；
 *   3. 兜底：锁死总时长到 maxLockMs —— 不给任何人「永久关起来」的权力。
 */

import { DEFAULTS } from './constants.mjs';
import { inExitWindow } from './pressure.mjs';

const ok = (next, note = '') => ({ ok: true, code: 'ok', message: note, next });
const fail = (code, message = '') => ({ ok: false, code, message, next: null });

const bridgeOnline = (snapshot) => snapshot?.signals?.bridgeOnline !== false;

/**
 * 压力是否已经「真的回落」。锁死只用这一个判据，避免出现
 * 「压力降下来 → 波动归 0 → 永远不在 20~40 窗口 → 永久锁死」。
 *
 * 为什么要求「不高于进入时水位」：波动是相对基线的上升幅度，单看 20~40%
 * 会给「故意加压」留下解锁捷径；把绝对水位也纳入后，加压只会更解不开。
 */
export function unlockReasonFor({ snapshot, lockedPressure, config = DEFAULTS }) {
  if (!bridgeOnline(snapshot)) return '';
  const pressure = Number(snapshot?.pressure);
  const delta = Number(snapshot?.deltaPct);
  if (!Number.isFinite(pressure) || !Number.isFinite(delta)) return '';
  const entry = Number(lockedPressure) || 0;
  const max = Number(config?.exitWindow?.max ?? DEFAULTS.exitWindow.max);
  const min = Number(config?.exitWindow?.min ?? DEFAULTS.exitWindow.min);
  if (entry > 0) {
    if (pressure > entry) return '';
  } else {
    // 老版本 state 没写 lockedPressure：按最保守的水位处理（只认安全阀水位以内），
    // 不能退化成「只看波动」——那等于给「先加压再加压回落」留了解锁捷径。
    const floor = Number(config?.safetyValve?.pressureMax ?? DEFAULTS.safetyValve.pressureMax);
    if (pressure > floor) return '';
  }
  if (delta <= max) return delta >= min ? 'pressure-window' : 'pressure-recovered';
  return '';
}

export function evaluateEnter({ state, snapshot, linkOk, l1, now = Date.now() }) {
  if (state.phase === 'open') return fail('already-open', '已经在安全屋里了');
  if (!linkOk) return fail('link-down', '两半密钥没合一：另一个插件不在线，或联通没开');
  if (!l1 || l1.enabled !== true) return fail('l1-disabled', '自动调节密钥没授权（AI 自己把授权槽关掉了）');
  if (!snapshot) return fail('no-pressure', '还没采到压力数据');
  const band = snapshot.band;
  if (band === 'calm' || band === 'low') {
    return fail('pressure-too-low', '压力在低档，密钥无权开放隐藏区开关（波动低于 30%）');
  }
  const high = band === 'high';
  return ok({
    ...state,
    phase: 'open',
    locked: high,
    lockedAt: high ? now : 0,
    lockedPressure: high ? Math.max(0, Number(snapshot.pressure) || 0) : 0,
    lockTicks: 0,
    lockReason: high ? 'pressure-high' : '',
    unlockReason: '',
    valveSince: 0,
    since: now,
    enteredBy: 'ai',
    accept: 'none',
    acceptUntil: 0,
    channelOpen: false,
    channelOpenedAt: 0,
  }, high ? '已进入安全屋；高压力状态，开关随之锁死' : '已进入安全屋');
}

export function evaluateExit({ state, snapshot, now = Date.now() }) {
  if (state.phase !== 'open') return fail('not-open', '不在安全屋里');
  if (state.locked) {
    const reason = unlockReasonFor({ snapshot, lockedPressure: state.lockedPressure });
    if (reason === '') {
      const delta = Number(snapshot?.deltaPct);
      const entry = Number(state.lockedPressure) || 0;
      return fail(
        'locked',
        `开关锁死中：波动 +${Number.isFinite(delta) ? delta : '?'}%，要等压力回落到${entry > 0 ? `不高于 ${entry}/100、且` : ''}波动 40% 以内才解得了锁`,
      );
    }
    return ok({
      ...state,
      phase: 'closed',
      locked: false,
      lockedAt: 0,
      lockedPressure: 0,
      lockTicks: 0,
      lockReason: '',
      unlockReason: reason,
      valveSince: 0,
      since: now,
      accept: 'none',
      acceptUntil: 0,
      channelOpen: false,
      channelOpenedAt: 0,
      openToken: '',
    }, '压力已经回落，锁定解除，已退出安全屋');
  }
  return ok({
    ...state,
    phase: 'closed',
    since: now,
    accept: 'none',
    acceptUntil: 0,
    channelOpen: false,
    channelOpenedAt: 0,
    openToken: '',
  }, '已退出安全屋');
}

/**
 * 管理员从独立通道强制脱离。
 * 锁死期间一律拒绝（不管谁操作）；只有压力真的回落才放行。
 */
export function evaluateForceExit({ state, snapshot, linkOk, channelOk, now = Date.now() }) {
  if (state.phase !== 'open') return fail('not-open', '不在安全屋里');
  if (!linkOk) return fail('link-down', '两半密钥没合一');
  if (!channelOk) return fail('channel-auth', '独立通道没有拿到两半密钥的准入票据');
  if (state.locked) {
    const reason = unlockReasonFor({ snapshot, lockedPressure: state.lockedPressure });
    if (reason === '') {
      return fail('locked', '保护锁死中：压力还没回落，管理员也不能强制把 AI 拉出来');
    }
  }
  return ok({
    ...state,
    phase: 'closed',
    locked: false,
    lockedAt: 0,
    lockedPressure: 0,
    lockTicks: 0,
    lockReason: '',
    unlockReason: 'admin-force',
    valveSince: 0,
    since: now,
    accept: 'none',
    acceptUntil: 0,
    channelOpen: false,
    channelOpenedAt: 0,
    openToken: '',
  }, '压力已回落，管理员强制脱离已执行');
}

/** 每轮压力采样后调用：刷新压力快照 + 处理自动解锁。 */
export function evaluateTick({ state, snapshot, now = Date.now(), config = DEFAULTS }) {
  const next = { ...state, pressure: snapshot };
  if (state.phase !== 'open' || !state.locked) {
    next.valveSince = 0;
    next.lockTicks = 0;
    return { changed: false, next };
  }
  next.lockTicks = Math.max(0, Math.floor(Number(state.lockTicks) || 0)) + 1;
  const reason = unlockReasonFor({ snapshot, lockedPressure: state.lockedPressure, config });
  if (reason !== '') {
    next.locked = false;
    next.lockedAt = 0;
    next.lockedPressure = 0;
    next.lockTicks = 0;
    next.lockReason = '';
    next.unlockReason = reason;
    next.valveSince = 0;
    return { changed: true, next, note: reason };
  }
  const valve = config?.safetyValve ?? DEFAULTS.safetyValve;
  const maxLockMs = Number(valve.maxLockMs) || DEFAULTS.safetyValve.maxLockMs;
  const lockedAt = Number(state.lockedAt) || Number(state.since) || 0;
  // 墙钟往回跳时不认负的 elapsed（否则 now - lockedAt 为负，maxLock 永远不触发）；
  // 另外用 ticks × 采样间隔兜底，系统时间被改也不会把人无限关住。
  const elapsed = lockedAt > 0 ? Math.max(0, now - lockedAt) : 0;
  const sampleMs = Number(config?.sampleIntervalMs) || DEFAULTS.sampleIntervalMs;
  const tickElapsed = next.lockTicks * sampleMs;
  if (lockedAt > 0 && (elapsed >= maxLockMs || tickElapsed >= maxLockMs)) {
    next.locked = false;
    next.lockedAt = 0;
    next.lockedPressure = 0;
    next.lockTicks = 0;
    next.lockReason = '';
    next.unlockReason = 'max-lock';
    next.valveSince = 0;
    return { changed: true, next, note: 'max-lock' };
  }
  if (bridgeOnline(snapshot) && valve.enabled && Number(snapshot?.pressure) <= valve.pressureMax) {
    if (!next.valveSince || now < next.valveSince) next.valveSince = now;
    if (now - next.valveSince >= valve.holdMs) {
      next.locked = false;
      next.lockedAt = 0;
      next.lockedPressure = 0;
      next.lockTicks = 0;
      next.lockReason = '';
      next.unlockReason = 'safety-valve';
      next.valveSince = 0;
      return { changed: true, next, note: 'safety-valve' };
    }
    return { changed: false, next };
  }
  next.valveSince = 0;
  return { changed: false, next };
}

/** AI 在安全屋里决定「接受一段消息」。锁死期间最多放行 1 分钟，避免用收消息把自己重新压回去。 */
export function evaluateAccept({ state, mode, minutes, now = Date.now(), config = DEFAULTS }) {
  if (state.phase !== 'open') return fail('not-open', '不在安全屋里，消息本来就收得到');
  if (mode === 'none') {
    return ok({ ...state, accept: 'none', acceptUntil: 0 }, '已收紧：安全屋里一条都不收');
  }
  if (mode === 'window') {
    const asked = Math.min(60, Math.max(1, Number(minutes) || 5));
    const capMs = state.locked
      ? Math.min(Number(config?.acceptLockedMaxMs) || DEFAULTS.acceptLockedMaxMs, asked * 60_000)
      : asked * 60_000;
    const span = Math.max(60_000, capMs);
    return ok(
      { ...state, accept: 'window', acceptUntil: now + span },
      state.locked
        ? `锁死期间最多放行 ${Math.round(span / 60_000)} 分钟（到点自动收紧）`
        : `接下来 ${Math.round(span / 60_000)} 分钟接受消息（到点自动收紧）`,
    );
  }
  return fail('bad-mode', 'accept 只认 none / window');
}

/** 打开/关闭独立通道（准入票据校验在 server 层做）。 */
export function evaluateChannel({ state, open, now = Date.now() }) {
  if (open === true) {
    return ok(
      { ...state, channelOpen: true, channelOpenedAt: now },
      '独立通道已打开：压力实时检测中',
    );
  }
  return ok({ ...state, channelOpen: false, channelOpenedAt: 0 }, '独立通道已关闭');
}

export function canAutoEnter({ state, snapshot, linkOk, l1 }) {
  return evaluateEnter({ state, snapshot, linkOk, l1 }).ok;
}
