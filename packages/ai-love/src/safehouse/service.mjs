/**
 * 安全屋 · 服务层
 *
 * 把「压力 → 密钥 → 状态机 → gate 文件 → 独立通道」串起来。
 * HTTP 路由、AI 工具、系统提示都只调这里，不各自算一套口径。
 *
 * 单写者：只有持 A 半密钥的 ai-love 一侧跑压力采样、写 state/gate、注册工具和路由；
 * ai-companion 侧只持 B 半密钥 + 心跳。两边都写会让 gate 抖动、并撞坏状态文件。
 */

import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import {
  DEFAULTS,
  PLUGIN,
  ROLE,
  SHARED_DIR_POINTER,
  defaultSharedDir,
  dshHomeDir,
} from './constants.mjs';
import { PressureEngine, describePressure } from './pressure.mjs';
import { Keyring } from './keys.mjs';
import { SafehouseStore, renderGate } from './store.mjs';
import {
  evaluateAccept,
  evaluateChannel,
  evaluateEnter,
  evaluateExit,
  evaluateForceExit,
  evaluateTick,
} from './rules.mjs';
import { Channel } from './channel.mjs';
import { renderExt, readSafehouseExt } from './extension.mjs';
import {
  ensureDir,
  fileMtime,
  redactPaths,
  writeJsonAtomic,
  writeTextAtomic,
} from './util.mjs';

/** child 是否在 parent 里面（同目录不算）。 */
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function defaultPluginDir() {
  return path.join(dshHomeDir(), 'safehouse-keys', PLUGIN);
}

/** 桥接目录：配置优先；否则按常见位置找一个像样的（Windows / macOS / Linux 都覆盖）。 */
function detectBridgeDir(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured.trim());
  const home = homedir();
  const candidates = [
    process.env.QQ_BRIDGE_DIR,
    path.join(home, 'Documents', 'deepseek-harness', 'default-workspace', 'qq-bridge-main'),
    path.join(home, 'deepseek-harness', 'default-workspace', 'qq-bridge-main'),
    path.join(dshHomeDir(), 'qq-bridge-main'),
    path.join(process.cwd(), 'qq-bridge-main'),
    path.join(process.cwd(), 'sandbox', 'bridge'),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue;
    const resolved = path.resolve(candidate);
    if (fileMtime(path.join(resolved, 'config.json')) > 0) return resolved;
  }
  return '';
}

export class SafehouseService {
  constructor({ config = {}, logger = null } = {}) {
    this.config = {
      enabled: config.enabled !== false,
      sharedDir: typeof config.sharedDir === 'string' && config.sharedDir.trim() !== ''
        ? path.resolve(config.sharedDir.trim())
        : defaultSharedDir(),
      pluginDir: typeof config.pluginDir === 'string' && config.pluginDir.trim() !== ''
        ? path.resolve(config.pluginDir.trim())
        : defaultPluginDir(),
      memoryDir: typeof config.memoryDir === 'string' && config.memoryDir.trim() !== ''
        ? path.resolve(config.memoryDir.trim())
        : '',
      bridgeDir: config.bridgeDir,
      logger,
    };
    if (this.config.memoryDir === '') {
      // 上下文水位是唯一的「Harness 侧」信号，只读 ai-love 的 tokenwise 档位。
      this.config.memoryDir = path.join(dshHomeDir(), 'ai-love');
    }
    // 半私钥不能落在共享目录里：那样 B 半能直接读走 A 半，两半合一就成了摆设。
    if (
      this.config.pluginDir === this.config.sharedDir
      || isInside(this.config.sharedDir, this.config.pluginDir)
      || isInside(this.config.pluginDir, this.config.sharedDir)
    ) {
      throw new Error('pluginDir 与 sharedDir 不能相同或互相包含（半私钥不能放在共享目录里）');
    }
    this.owner = ROLE === 'a';
    this.bridgeDir = detectBridgeDir(config.bridgeDir);
    this.logger = logger;
    ensureDir(this.config.sharedDir);
    ensureDir(this.config.pluginDir);

    this.store = new SafehouseStore(this.config.sharedDir);
    this.keys = new Keyring({ sharedDir: this.config.sharedDir, pluginDir: this.config.pluginDir });
    this.channel = new Channel(this.config.sharedDir);
    this.pressure = new PressureEngine({
      bridgeDir: this.bridgeDir,
      memoryDir: this.config.memoryDir,
    });
    this._timer = null;
    this._beatTimer = null;
    this._link = null;
    this._snapshot = null;
    this._bootAt = Date.now();
    this._tickets = new Map();
    this._peerOfflineWarned = false;
    this._gateError = '';
  }

  start() {
    if (!this.config.enabled) return;
    try {
      this.keys.publishPublic();
    } catch (error) {
      // 半私钥读不了时不能连心跳一起停：下一轮还在，权限修好后自动恢复。
      this.logger?.warn?.(`safehouse: 公钥/心跳刷新失败：${redactPaths(error?.message ?? error)}`);
    }
    this._beatTimer = setInterval(() => {
      try {
        this.keys.publishPublic();
        this._peerOfflineWarned = false;
      } catch (error) {
        this.logger?.warn?.(`safehouse: 公钥/心跳刷新失败：${redactPaths(error?.message ?? error)}`);
      }
    }, DEFAULTS.linkRefreshMs);
    this._beatTimer.unref?.();
    if (!this.owner) return;
    this._writeSharedDirPointer();
    this.pressure.start((snapshot) => this.onSample(snapshot));
    this.writeGate();
  }

  /** 自定义 sharedDir 时给桥接留个指针，避免「插件写 A、桥接读 B」的静默失配。 */
  _writeSharedDirPointer() {
    try {
      writeTextAtomic(
        path.join(dshHomeDir(), SHARED_DIR_POINTER),
        `${this.config.sharedDir}\n`,
      );
    } catch (error) {
      this.logger?.warn?.(`safehouse: 共享目录指针写不进去（桥接请改用 DSH_SAFEHOUSE_DIR）：${redactPaths(error?.message ?? error)}`);
    }
  }

  stop() {
    this.pressure.stop();
    if (this._beatTimer) {
      clearInterval(this._beatTimer);
      this._beatTimer = null;
    }
  }

  /** 每轮采样：刷新压力快照，处理锁定自动解除，更新 gate。 */
  onSample(snapshot) {
    this._snapshot = snapshot;
    try {
      const link = this.linkState();
      this._link = link;

      // 另一半不在线只提醒，不改状态：
      //   · 对端插件掉了 gate 会在 45 秒后过期，桥接本来就会 fail-open（不会永久挡消息）；
      //   · 如果这里「自动收起」甚至把 locked 清掉，就等于对端一抖动就把 AI 赶出安全屋、
      //     还替它解了锁 —— 这既是惩罚，也绕过了「锁死只有压力回落才解得开」。
      const current = this.store.readState();
      if (current.phase === 'open' && link.ok !== true) {
        if (!this._peerOfflineWarned && Date.now() - this._bootAt >= DEFAULTS.staleOpenGraceMs) {
          this._peerOfflineWarned = true;
          this.logger?.warn?.(`safehouse: 另一半长时间不在线（${link.reason || 'unknown'}），安全屋状态保持原样：不自动退出，也不自动解锁`);
        }
      } else {
        this._peerOfflineWarned = false;
      }

      this.store.mutate((before) => {
        const ticked = evaluateTick({ state: before, snapshot });
        let next = ticked.next;
        let changed = ticked.changed;
        const now = Date.now();
        // accept 到期自动收紧
        if (next.accept === 'window' && Number(next.acceptUntil) > 0 && Number(next.acceptUntil) <= now) {
          next = { ...next, accept: 'none', acceptUntil: 0 };
          changed = true;
        }
        const prev = before.pressure;
        const pressureSame = !!prev
          && prev.pressure === snapshot.pressure
          && prev.deltaPct === snapshot.deltaPct
          && prev.band === snapshot.band;
        // 没变化就不写盘：减少 revision 抖动，也减少锁竞争。
        if (!changed && pressureSame) return null;
        if (!pressureSame) next = { ...next, pressure: snapshot };
        if (ticked.changed) {
          next = this.store.noteEvent(next, { type: 'unlock', by: 'pressure', note: ticked.note ?? '' });
        }
        return { state: next, result: { changed } };
      });
      // gate 每轮都刷新：桥接 45 秒读不到就 fail-open，不能让门闸因为「没变化」而过期。
      this.writeGate();
    } catch (error) {
      this.logger?.warn?.(`safehouse: 采样后更新状态失败：${redactPaths(error?.message ?? error)}`);
    }
  }

  linkState() {
    try {
      return this.keys.linkState();
    } catch {
      return { ok: false, peer: '', epoch: '', reason: 'link-error', l1: { enabled: true } };
    }
  }

  l1() {
    return this.keys.readL1();
  }

  setL1({ enabled, rotate = false, by = 'ai' } = {}) {
    return this.keys.writeL1({ enabled, rotate, by });
  }

  getState() {
    return this.store.readState();
  }

  /** 当前完整快照（面板、HTTP、AI 工具、提示词都用这一份）。 */
  status() {
    const state = this.store.readState();
    const snapshot = this._snapshot ?? this.pressure.snapshot();
    const link = this.linkState();
    const l1 = link.l1 ?? this.keys.readL1();
    const now = Date.now();
    return {
      ok: true,
      plugin: PLUGIN,
      role: ROLE,
      owner: this.owner,
      config: {
        enabled: this.config.enabled,
        bridgeDirFound: this.bridgeDir !== '',
        sharedDir: undefined, // 绝对路径只留在本机日志，不顺着 HTTP 走
      },
      // 门闸写盘是否健康：写失败时桥接读不到「挡消息」，AI 不能误以为自己在被保护。
      gate: {
        ok: this._gateError === '',
        error: this._gateError === '' ? null : this._gateError,
      },
      phase: state.phase,
      locked: state.locked === true,
      lockedAt: state.lockedAt,
      lockedPressure: state.lockedPressure,
      lockReason: state.lockReason,
      unlockReason: state.unlockReason,
      since: state.since,
      revision: state.revision,
      pressure: snapshot
        ? {
            value: snapshot.pressure,
            deltaPct: snapshot.deltaPct,
            band: snapshot.band,
            baseline: snapshot.baseline,
            at: snapshot.at,
            summary: describePressure(snapshot),
            signals: snapshot.signals,
          }
        : null,
      canEnter: this.canEnter(state, snapshot, link),
      accept: state.accept,
      acceptUntil: state.acceptUntil,
      acceptActive: state.accept === 'window' && state.acceptUntil > now,
      channel: {
        open: state.channelOpen === true,
        openedAt: state.channelOpenedAt,
      },
      link: {
        ok: link.ok === true,
        peer: link.peer,
        epoch: link.epoch,
        peerAgeMs: link.peerAgeMs,
        reason: link.reason,
        fingerprint: this.keys.fingerprint(),
      },
      l1: { enabled: l1.enabled === true, updatedAt: l1.updatedAt, by: l1.by },
      events: state.events.slice(-8),
      updatedAt: state.updatedAt,
    };
  }

  canEnter(state, snapshot, link) {
    const l1 = link?.l1 ?? this.keys.readL1();
    return evaluateEnter({ state, snapshot, linkOk: link?.ok === true, l1 }).ok;
  }

  /** 公开只读快照（娱乐插件端口）：读文件，读不到就现算一份。 */
  extSnapshot() {
    const file = readSafehouseExt({ dir: this.config.sharedDir });
    if (file) return file;
    return renderExt({
      state: this.store.readState(),
      snapshot: this._snapshot ?? this.pressure.snapshot(),
      link: this.linkState(),
    });
  }

  _pushGate(state) {
    try {
      const snapshot = this._snapshot;
      const link = this._link ?? this.linkState();
      const gate = renderGate({ state, snapshot, link, config: this.config });
      this.store.writeGate(gate);
      // 娱乐插件端口：同一时刻的公开快照（失败不影响门闸）。
      try {
        writeJsonAtomic(
          path.join(this.config.sharedDir, 'ext', 'state.json'),
          renderExt({ state, snapshot, link }),
        );
      } catch {
        /* 第三方端口写不进去不影响主流程 */
      }
      this._gateError = '';
      return gate;
    } catch (error) {
      this._gateError = redactPaths(error?.message ?? error);
      this.logger?.warn?.(`safehouse: 写 gate 失败：${this._gateError}`);
      return null;
    }
  }

  /** 门闸没写出去时把状态退回原样：宁可没进安全屋，也不能让 AI 以为消息已被挡住。 */
  _rollbackTo(before, note) {
    try {
      this.store.mutate(() => ({
        state: this.store.noteEvent(before, { type: 'rollback', by: 'pressure', note }),
        result: { ok: false },
      }));
    } catch {
      /* 回滚本身失败也只能继续尝试重写 gate */
    }
    this.writeGate();
  }

  /** 每轮采样/状态变化后刷新 gate.json（桥接读它决定挡不挡消息）。 */
  writeGate() {
    return this._pushGate(this.store.readState());
  }

  /* ── 独立通道准入票据（随机、内存、绝对过期） ────────────── */

  issueTicket(now = Date.now()) {
    for (const [token, expiresAt] of this._tickets) {
      if (expiresAt <= now) this._tickets.delete(token);
    }
    const ticket = randomBytes(32).toString('hex');
    this._tickets.set(ticket, now + 5 * 60_000);
    return { ticket, ttlMs: 5 * 60_000 };
  }

  verifyTicket(token, now = Date.now()) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return false;
    const expiresAt = this._tickets.get(token);
    if (!expiresAt) return false;
    if (expiresAt <= now) {
      this._tickets.delete(token);
      return false;
    }
    return true;
  }

  clearTickets() {
    this._tickets.clear();
  }

  /** AI 自己申请进入。 */
  enter({ by = 'ai' } = {}) {
    const snapshot = this._snapshot ?? this.pressure.sample();
    this._snapshot = snapshot;
    const link = this.linkState();
    const before = this.store.readState();
    const result = this.store.mutate((state) => {
      const decided = evaluateEnter({ state, snapshot, linkOk: link.ok, l1: link.l1 });
      if (!decided.ok) return { state, result: decided };
      const nonce = link.l1?.nonce ?? '';
      const next = {
        ...decided.next,
        openToken: this.keys.openToken(nonce),
      };
      return {
        state: this.store.noteEvent(next, { type: 'enter', by, note: decided.message }),
        result: decided,
      };
    });
    if (result.result?.ok) {
      this.clearTickets();
      if (!this.writeGate()) {
        this._rollbackTo(before, 'enter-gate-failed');
        return {
          ok: false,
          code: 'gate-write-failed',
          message: '安全屋门闸写不进磁盘，已撤回进入：消息没有被挡，不能让你误以为已经在保护里',
          state: this._publicState(),
        };
      }
    }
    return this._outcome(result);
  }

  exit({ by = 'ai' } = {}) {
    const snapshot = this._snapshot ?? this.pressure.sample();
    this._snapshot = snapshot;
    const result = this.store.mutate((state) => {
      const decided = evaluateExit({ state, snapshot });
      if (!decided.ok) return { state, result: decided };
      return {
        state: this.store.noteEvent(decided.next, { type: 'exit', by, note: decided.message }),
        result: decided,
      };
    });
    if (result.result?.ok) {
      this.clearTickets();
      this.writeGate();
    }
    return this._outcome(result);
  }

  /** 管理员从独立通道强制脱离（服务层只校验通道票据，通道是否开由 server 层管）。 */
  forceExit({ token = '', channelOk = false, by = 'admin' } = {}) {
    const snapshot = this._snapshot ?? this.pressure.sample();
    this._snapshot = snapshot;
    const link = this.linkState();
    const ticketOk = channelOk || this.verifyTicket(token);
    const result = this.store.mutate((state) => {
      const decided = evaluateForceExit({
        state,
        snapshot,
        linkOk: link.ok,
        channelOk: ticketOk,
      });
      if (!decided.ok) return { state, result: decided };
      return {
        state: this.store.noteEvent(decided.next, { type: 'force-exit', by, note: decided.message }),
        result: decided,
      };
    });
    if (result.result?.ok) {
      this.clearTickets();
      this.writeGate();
    }
    return this._outcome(result);
  }

  /** AI 在安全屋里决定接受一段消息。 */
  accept({ mode = 'none', minutes = 5 } = {}) {
    const before = this.store.readState();
    const result = this.store.mutate((state) => {
      const decided = evaluateAccept({ state, mode, minutes });
      if (!decided.ok) return { state, result: decided };
      return {
        state: this.store.noteEvent(decided.next, { type: 'accept', by: 'ai', note: decided.message }),
        result: decided,
      };
    });
    if (result.result?.ok && !this.writeGate()) {
      // 放行窗口没写进 gate：桥接仍然按旧的 hold 挡消息，不能让 AI 以为已经放行。
      this._rollbackTo(before, 'accept-gate-failed');
      return {
        ok: false,
        code: 'gate-write-failed',
        message: '门闸没写出去，这次放行没有生效（消息仍然收不到）',
        state: this._publicState(),
      };
    }
    return this._outcome(result);
  }

  openChannel({ open = true, by = 'admin' } = {}) {
    const result = this.store.mutate((state) => {
      const decided = evaluateChannel({ state, open });
      if (!decided.ok) return { state, result: decided };
      return {
        state: this.store.noteEvent(decided.next, {
          type: open ? 'channel-open' : 'channel-close',
          by,
          note: decided.message,
        }),
        result: decided,
      };
    });
    if (!open) this.clearTickets();
    this.writeGate();
    return this._outcome(result);
  }

  /** 通道消息：管理员写 / AI 读与回。 */
  channelSend({ from = 'admin', text = '' } = {}) {
    if (this.getState().phase !== 'open') {
      throw new Error('不在安全屋里，独立通道不能写入');
    }
    const snapshot = this._snapshot ?? this.pressure.snapshot();
    const row = this.channel.append({
      from,
      text,
      pressure: snapshot?.pressure ?? null,
      deltaPct: snapshot?.deltaPct ?? null,
      band: snapshot?.band ?? '',
    });
    return { ok: true, id: row.id, row: { id: row.id, at: row.at, from: row.from, pressure: row.pressure, deltaPct: row.deltaPct, band: row.band } };
  }

  channelRead({ after = 0, limit = 40 } = {}) {
    return this.channel.list({ after, limit });
  }

  _publicState() {
    const state = this.store.readState();
    return {
      phase: state.phase,
      locked: state.locked,
      revision: state.revision,
      accept: state.accept,
      acceptUntil: state.acceptUntil,
    };
  }

  _outcome(result) {
    const decided = result.result ?? { ok: false, code: 'busy', message: '状态写入撞车，再试一次' };
    return {
      ok: decided.ok === true,
      code: decided.code,
      message: decided.message ?? '',
      state: this._publicState(),
    };
  }
}
