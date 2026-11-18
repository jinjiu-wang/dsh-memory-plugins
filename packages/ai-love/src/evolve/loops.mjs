/**
 * 爱ai · 自进化板块 — 闭环调度
 *
 * 一次进化 = 一个环：observe → plan → act → verify → commit。
 * 硬约束：
 *   - 四个阶段缺一不可，缺 handler 直接拒绝，绝不"跳过然后照样提交"；
 *   - verify 必须明确返回 ok === true 才允许 commit；
 *   - 每个阶段跑完先原子落盘（state.json），进程被杀能接着跑；
 *   - 同一时刻只允许一个环（互斥），重入返回 busy；
 *   - 同一条 commit 只记一次（journal 里查过再写）；
 *   - 状态文件坏了就备份 + 从日志/归档恢复高水位，不把计数清零；
 *   - 失败/放弃的环要把它写的产物删掉，不留半成品。
 *
 * 动作预算：handler 通过 context.budget.take(n) 在动手之前扣额度，
 * 超了立即抛 EVOLVE_ACTION_BUDGET；跑完再看 result.actions 长度做二次校验。
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { canonical } from './journal.mjs';

export const PHASES = ['observe', 'plan', 'act', 'verify'];
export const STATE_FILE = 'state.json';
const CYCLE_LOCK = 'cycle.lock';
const CYCLE_LOCK_GRACE_MS = 60000;
const CYCLE_RE = /^c\d{4,}$/;

/** 同机进程是否还活着（EPERM = 在但没权限发信号） */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLockOwner(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function digest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex').slice(0, 16);
}

function makeBudget(max) {
  let used = 0;
  return {
    max,
    take(n = 1) {
      used += n;
      if (used > max) {
        const err = new Error('evolve: action budget exceeded (' + used + ' > ' + max + ')');
        err.code = 'EVOLVE_ACTION_BUDGET';
        throw err;
      }
      return used;
    },
    get used() {
      return used;
    },
  };
}

function emptyState() {
  return { cycleSeq: 0, pending: null, committed: [] };
}

/** 把磁盘上的 state.json 规整成内存视图（读盘与只读窥视共用）。 */
function normalizeState(parsed) {
  return {
    cycleSeq: parsed.cycleSeq,
    pending: parsed.pending
      ? {
          id: parsed.pending.id,
          goal: parsed.pending.goal,
          startedAt: parsed.pending.startedAt ?? new Date().toISOString(),
          nextPhase: parsed.pending.nextPhase,
          results: parsed.pending.results,
          attempts: parsed.pending.attempts ?? 0,
          extras: parsed.pending.extras ?? {},
          verify: parsed.pending.verify ?? null,
        }
      : null,
    committed: parsed.committed.slice(-500),
  };
}

function validState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  if (!Number.isInteger(state.cycleSeq) || state.cycleSeq < 0) return false;
  if (!Array.isArray(state.committed) || state.committed.some((id) => typeof id !== 'string')) return false;
  if (state.pending === null || state.pending === undefined) return true;
  const p = state.pending;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  if (typeof p.id !== 'string' || !CYCLE_RE.test(p.id)) return false;
  if (typeof p.goal !== 'string') return false;
  if (!Number.isInteger(p.nextPhase) || p.nextPhase < 0 || p.nextPhase > PHASES.length) return false;
  if (!p.results || typeof p.results !== 'object' || Array.isArray(p.results)) return false;
  if (p.attempts !== undefined && (!Number.isInteger(p.attempts) || p.attempts < 0)) return false;
  if (p.extras !== undefined && (!p.extras || typeof p.extras !== 'object' || Array.isArray(p.extras))) return false;
  return true;
}

export class LoopEngine {
  constructor({ journal, stateDir, guard, evolveDir, archiveDir, maxActions = 8, maxAttempts = 3 }) {
    this.journal = journal;
    this.guard = guard;
    this.stateDir = stateDir;
    this.stateFile = path.join(stateDir, STATE_FILE);
    this.evolveDir = evolveDir ?? stateDir;
    this.archiveDir = archiveDir ?? path.join(this.evolveDir, 'archive');
    this.maxActions = Number.isInteger(maxActions) && maxActions > 0 ? maxActions : 8;
    this.maxAttempts = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : 3;
    this.running = false;
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    this.state = this.readState();
  }

  readState() {
    if (!existsSync(this.stateFile)) return emptyState();
    let parsed = null;
    let reason = null;
    try {
      parsed = JSON.parse(readFileSync(this.stateFile, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      reason = 'unparsable';
    }
    if (reason === null && !validState(parsed)) reason = 'invalid-shape';
    if (reason !== null) return this.recoverState(reason);
    return normalizeState(parsed);
  }

  /**
   * 只读刷新：别的进程提交后，本进程的面板不该等到下一次循环才看见。
   * 不在只读路径上做修复 —— 文件缺失/正写到一半/坏了都保持内存视图。
   */
  peekState() {
    if (this.running) return this.state;
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(this.stateFile, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      return this.state;
    }
    if (!validState(parsed)) return this.state;
    const next = normalizeState(parsed);
    if (
      next.cycleSeq === this.state.cycleSeq &&
      JSON.stringify(next.pending) === JSON.stringify(this.state.pending) &&
      next.committed.length === this.state.committed.length
    ) {
      return this.state;
    }
    this.state = next;
    return this.state;
  }

  /** 状态坏了：备份原文件，从日志和归档里把高水位与已提交环号捞回来 */
  recoverState(reason) {
    const backup = path.join(this.stateDir, 'state.corrupt-' + Date.now() + '.json');
    try {
      renameSync(this.stateFile, backup);
    } catch {
      // 备份失败也不能让进程起不来，下面继续恢复
    }
    const ids = new Set();
    for (const entry of this.journal?.entries ?? []) {
      const data = entry?.data ?? {};
      if (typeof data.cycle === 'string' && CYCLE_RE.test(data.cycle)) ids.add(data.cycle);
      if (Array.isArray(data.committed)) for (const id of data.committed) if (CYCLE_RE.test(id)) ids.add(id);
      if (entry?.event === 'cycle.committed' && typeof data.cycle === 'string') ids.add(data.cycle);
    }
    try {
      for (const name of readdirSync(this.archiveDir)) {
        const match = /^(c\d{4,})\.json$/.exec(name);
        if (match) ids.add(match[1]);
      }
    } catch {
      // 归档目录还不存在
    }
    const committed = [];
    for (const entry of this.journal?.entries ?? []) {
      if (entry?.event === 'cycle.committed' && typeof entry?.data?.cycle === 'string') committed.push(entry.data.cycle);
    }
    let high = this.state?.cycleSeq ?? 0;
    for (const id of ids) high = Math.max(high, Number(id.slice(1)));
    const state = { cycleSeq: high, pending: null, committed: committed.slice(-500) };
    this.state = state;
    try {
      this.writeState();
    } catch {
      // 写不进去时至少内存里是对的
    }
    try {
      this.journal?.append('state.recovered', {
        reason,
        backup: path.basename(backup),
        cycleSeq: high,
        committed: state.committed.length,
      });
    } catch {
      // 日志暂不可写不该让恢复失败，状态已经落盘
    }
    return state;  }

  writeState() {
    const payload = JSON.stringify(this.state, null, 2);
    if (this.guard) {
      this.guard.assert(this.stateFile);
      mkdirSync(this.stateDir, { recursive: true });
      const tmp = this.stateFile + '.tmp-' + process.pid + '-' + Date.now();
      writeFileSync(tmp, payload, 'utf8');
      renameSync(tmp, this.stateFile);
      return;
    }
    const tmp = this.stateFile + '.tmp-' + process.pid;
    writeFileSync(tmp, payload, 'utf8');
    renameSync(tmp, this.stateFile);
  }

  /** 生成一个没和已提交/归档撞车的环号 */
  freshCycleId() {
    for (let guard = 0; guard < 100000; guard += 1) {
      this.state.cycleSeq += 1;
      const id = 'c' + String(this.state.cycleSeq).padStart(4, '0');
      if (this.state.committed.includes(id)) continue;
      if (existsSync(path.join(this.archiveDir, id + '.json'))) continue;
      return id;
    }
    const err = new Error('evolve: cannot allocate a fresh cycle id');
    err.code = 'EVOLVE_CYCLE_ID_EXHAUSTED';
    throw err;
  }

  removeArtifacts(pending) {
    const items = Array.isArray(pending?.extras?.artifacts) ? pending.extras.artifacts : [];
    for (const rel of items) {
      const abs = path.resolve(this.evolveDir, String(rel));
      try {
        this.guard?.assert(abs);
        if (existsSync(abs)) unlinkSync(abs);
      } catch (error) {
        this.journal?.append('artifact.cleanup-failed', {
          cycle: pending?.id ?? null,
          file: String(rel),
          message: String(error?.message ?? error),
        });
      }
    }
  }

  #discard(pending, { keepArtifacts = false } = {}) {
    if (!keepArtifacts) this.removeArtifacts(pending);
    this.state.pending = null;
    this.writeState();
  }

  /** 收尾记录：日志写不进去时不能反过来吞掉真实执行结果 */
  #log(event, data) {
    try {
      this.journal?.append(event, data);
    } catch {
      // 状态文件才是续跑依据，日志丢一条不改变本次返回
    }
  }

  /** verify 已经通过的环，产物可以留，失败清理只针对半成品 */
  #keepArtifacts(pending) {
    return pending?.verify?.ok === true;
  }

  #fail(pending, reason, extra) {
    this.#log('cycle.failed', { cycle: pending.id, reason, ...(extra ? { changed: extra } : {}) });
    this.#discard(pending, { keepArtifacts: this.#keepArtifacts(pending) });
    return { status: 'failed', cycle: pending.id, reason, ...(extra ? { changed: extra } : {}) };
  }

  #abandon(pending, reason) {
    this.#log('cycle.abandoned', { cycle: pending.id, reason, attempts: pending.attempts });
    this.#discard(pending, { keepArtifacts: this.#keepArtifacts(pending) });
    return { status: 'abandoned', cycle: pending.id, reason, attempts: pending.attempts };
  }

  /** 跨进程环锁：同一个 stateDir 只允许一个进程推进环；活进程的锁绝不强抢 */
  #acquireCycleLock() {
    const file = path.join(this.stateDir, CYCLE_LOCK);
    const token = process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const fd = openSync(file, 'wx');
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() }));
        } finally {
          closeSync(fd);
        }
        return {
          file,
          release: () => {
            const held = readLockOwner(file);
            if (held?.token !== token) return; // 已经不是自己的锁，不能动
            try {
              unlinkSync(file);
            } catch {
              // 已经被清掉也算释放
            }
          },
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      const owner = readLockOwner(file);
      let age = Infinity;
      try {
        age = Date.now() - statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (owner !== null && pidAlive(Number(owner.pid))) return null;
      if (owner === null && age < CYCLE_LOCK_GRACE_MS) return null; // 正在创建，别踩
      try {
        unlinkSync(file);
      } catch {
        // 别人清过就继续试
      }
    }
    return null;
  }

  async run({ goal, handlers, context = {} }) {
    if (this.running) {
      this.#log('cycle.busy', { goal: String(goal ?? ''), cycle: this.state.pending?.id ?? null });
      return { status: 'busy', cycle: this.state.pending?.id ?? null };
    }
    const missing = PHASES.filter((phase) => typeof handlers?.[phase] !== 'function');
    if (missing.length > 0) {
      this.#log('cycle.rejected', { goal: String(goal ?? ''), missing });
      return { status: 'rejected', missing };
    }
    const lock = this.#acquireCycleLock();
    if (!lock) {
      const cycle = this.state.pending?.id ?? null;
      try {
        this.journal?.append('cycle.busy', { goal: String(goal ?? ''), cycle, reason: 'locked' });
      } catch {
        // 日志锁被别的进程占着也不能因此让调用方拿到假的成功
      }
      return { status: 'busy', cycle, reason: 'locked' };
    }
    this.running = true;
    try {
      // 拿到锁之后重新读盘，别用上个进程留下的内存状态
      this.state = this.readState();
      return await this.#loop({ goal, handlers, context });
    } finally {
      this.running = false;
      lock.release();
    }
  }

  async #loop({ goal, handlers, context }) {
    let pending = this.state.pending;
    let recheckOnly = false;
    if (pending) {
      if (pending.nextPhase >= PHASES.length) {
        // 上一轮已经走到 commit 但没落盘：重跑 verify 复核产物，不能盲信 pending.verify
        pending.nextPhase = PHASES.indexOf('verify');
        recheckOnly = true;
        this.journal.append('cycle.reverify', { cycle: pending.id });
        this.writeState();
      }
      this.journal.append('cycle.resume', { cycle: pending.id, from: pending.nextPhase, attempt: pending.attempts ?? 0 });
    } else {
      pending = {
        id: this.freshCycleId(),
        goal: String(goal ?? 'self-evolution'),
        startedAt: new Date().toISOString(),
        nextPhase: 0,
        results: {},
        attempts: 0,
        extras: {},
        verify: null,
      };
      this.state.pending = pending;
      this.writeState();
      this.journal.append('cycle.begin', { cycle: pending.id, goal: pending.goal });
    }
    pending.attempts = (pending.attempts ?? 0) + 1;
    if (pending.attempts > this.maxAttempts) return this.#abandon(pending, 'max-attempts');
    this.writeState();

    for (let i = pending.nextPhase; i < PHASES.length; i += 1) {
      const phase = PHASES[i];
      const budget = makeBudget(this.maxActions);
      try {
        const result = await handlers[phase]({
          ...context,
          cycle: pending.id,
          goal: pending.goal,
          state: this.state,
          pending,
          budget,
          attempt: pending.attempts,
          /** 提交重试时只复核产物，不重算记忆差 */
          reverify: recheckOnly && phase === 'verify',
          /** 立刻把中间产物记进 state.json，崩溃后知道要清理什么 */
          save: (patch) => {
            if (patch && typeof patch === 'object') Object.assign(pending.extras, patch);
            this.writeState();
          },
        });
        const actions = Array.isArray(result?.actions) ? result.actions : [];
        if (actions.length > this.maxActions) {
          const err = new Error('evolve: too many actions in one phase (' + actions.length + ' > ' + this.maxActions + ')');
          err.code = 'EVOLVE_ACTION_BUDGET';
          throw err;
        }
        if (budget.used > this.maxActions) {
          const err = new Error('evolve: action budget exceeded (' + budget.used + ' > ' + this.maxActions + ')');
          err.code = 'EVOLVE_ACTION_BUDGET';
          throw err;
        }
        if (result && typeof result.persist === 'object' && result.persist !== null) {
          Object.assign(pending.extras, result.persist);
        }
        pending.results[phase] = {
          digest: digest(result ?? null),
          actions: actions.length,
          at: new Date().toISOString(),
        };
        if (phase === 'verify') {
          pending.verify = {
            ok: result?.ok === true,
            reason: result?.ok === true ? null : String(result?.reason ?? 'verify-not-ok'),
          };
        }
        pending.nextPhase = i + 1;
        this.writeState();
        this.journal.append('phase.ok', {
          cycle: pending.id,
          phase,
          digest: pending.results[phase].digest,
          actions: actions.length,
        });
        if (phase === 'verify' && result?.ok !== true) {
          const detail = [
            ...(Array.isArray(result?.changed) ? result.changed : []),
            ...(Array.isArray(result?.added) ? result.added.map((rel) => 'added:' + rel) : []),
            ...(Array.isArray(result?.missing) ? result.missing.map((rel) => 'missing:' + rel) : []),
          ];
          return this.#fail(pending, result?.reason ?? 'verify-not-ok', detail.length > 0 ? detail : null);
        }
      } catch (error) {
        this.#log('cycle.error', {
          cycle: pending.id,
          phase,
          code: error?.code ?? 'EVOLVE_PHASE_ERROR',
          message: String(error?.message ?? error),
        });
        this.writeState();
        return { status: 'error', cycle: pending.id, phase, code: error?.code ?? 'EVOLVE_PHASE_ERROR', message: String(error?.message ?? error) };
      }
    }

    if (!pending.verify || pending.verify.ok !== true) {
      return this.#fail(pending, pending.verify?.reason ?? 'verify-not-recorded');
    }

    const already = (this.journal?.entries ?? []).some(
      (entry) => entry?.event === 'cycle.committed' && entry?.data?.cycle === pending.id,
    );
    if (!already) {
      try {
        this.journal.append('cycle.committed', {
          cycle: pending.id,
          goal: pending.goal,
          phases: Object.keys(pending.results),
        });
      } catch (error) {
        // 归档已经验证过，不能因为日志写不进去就清 pending 删产物；留着下轮重试提交
        this.writeState();
        return {
          status: 'error',
          cycle: pending.id,
          phase: 'commit',
          code: error?.code ?? 'EVOLVE_COMMIT_ERROR',
          message: String(error?.message ?? error),
        };
      }
    }
    if (!this.state.committed.includes(pending.id)) {
      this.state.committed.push(pending.id);
      if (this.state.committed.length > 500) this.state.committed = this.state.committed.slice(-500);
    }
    this.state.pending = null;
    this.writeState();
    return { status: 'committed', cycle: pending.id, results: pending.results };
  }
}
