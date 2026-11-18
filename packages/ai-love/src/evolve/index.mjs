/**
 * 爱ai · 自进化板块
 *
 * 三件事：
 *   1. 闭环调度：observe → plan → act → verify → commit（loops.mjs）
 *   2. 模块化扩展：注册表 + 能力依赖拓扑（registry.mjs）
 *   3. 状态可追溯：哈希链日志 + 状态快照（journal.mjs）
 *
 * 铁律：本板块只写 <memoryDir>/.evolve/，记忆正文一律只读。
 *
 * 四个内置板块通过能力名互相依赖，闭环本身也由注册表驱动：
 *   memory-reader (observe.memory) → candidate-planner (plan.candidates)
 *   → evolution-writer (act.write) → state-verifier (verify.state)
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Journal } from './journal.mjs';
import { WriteGuard } from './guard.mjs';
import { ModuleRegistry } from './registry.mjs';
import { LoopEngine } from './loops.mjs';

export const name = 'ai-love-evolve';
export const EVOLVE_DIRNAME = '.evolve';
export const ROUTE = '/ai-love/evolve/state';
const ARCHIVE_REL_RE = /^archive\/[A-Za-z0-9._-]+\.json$/;
const TMP_SUFFIX_RE = /\.tmp-\d+(-\d+)?$/;
const TMP_STALE_MS = 10 * 60 * 1000;

function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  return path.join(homedir(), '.dsh');
}

/** 与 core/memory.mjs 保持一致：显式路径优先，否则 <DSH_HOME>/ai-love */
export function resolveMemoryDir(config) {
  const explicit = typeof config?.memoryDir === 'string' ? config.memoryDir.trim() : '';
  return explicit !== '' ? path.resolve(explicit) : path.join(dshHome(), 'ai-love');
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** 流式 sha256：记忆目录可能有很大的会话日志，不整文件读进内存 */
function shaFile(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch (error) {
    throw fail('EVOLVE_SNAPSHOT_FAILED', 'evolve: cannot open ' + file + ' (' + error?.code + ')');
  }
  const hash = createHash('sha256');
  const buf = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
    }
  } catch (error) {
    throw fail('EVOLVE_SNAPSHOT_FAILED', 'evolve: cannot read ' + file + ' (' + error?.code + ')');
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** 只清理自己写了一半的临时文件，且至少放 10 分钟，避免误删别的进程正在 rename 的 tmp */
function sweepTmp(dir, removed = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return removed;
  }
  const now = Date.now();
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sweepTmp(abs, removed);
      continue;
    }
    if (!TMP_SUFFIX_RE.test(entry.name)) continue;
    try {
      if (now - statSync(abs).mtimeMs < TMP_STALE_MS) continue;
      unlinkSync(abs);
      removed.push(path.relative(dir, abs));
    } catch {
      // 正在被别人使用就下次再说
    }
  }
  return removed;
}

/**
 * 记忆指纹：只读。遇到读不了的文件直接抛错，不静默跳过——
 * 跳过会让 verify 误以为没事，而这正是最该报警的时候。
 */
export function snapshotMemory(root) {
  const out = {};
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw fail('EVOLVE_SNAPSHOT_FAILED', 'evolve: cannot scan ' + dir + ' (' + error?.code + ')');
    }
    for (const entry of entries) {
      if (entry.name === EVOLVE_DIRNAME) continue;
      const rel = prefix === '' ? entry.name : prefix + '/' + entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          out[rel] = 'symlink:' + readlinkSync(abs);
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            throw fail('EVOLVE_SNAPSHOT_FAILED', 'evolve: cannot read link ' + abs + ' (' + error?.code + ')');
          }
          out[rel] = null;
        }
      } else if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        out[rel] = shaFile(abs);
      }
    }
  };
  walk(root, '');
  return out;
}

/** 对称差：新增、丢失、改动都算数 */
export function diffSnapshots(before = {}, after = {}) {
  const changed = [];
  const added = [];
  const missing = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (!(key in before)) added.push(key);
    else if (!(key in after)) missing.push(key);
    else if (before[key] !== after[key]) changed.push(key);
  }
  return { changed: changed.sort(), added: added.sort(), missing: missing.sort() };
}

function countLines(file) {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '').length;
  } catch {
    return 0;
  }
}

export function createRuntime({ memoryDir, maxActions = 8, maxAttempts = 3 } = {}) {
  const root = path.resolve(memoryDir);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const evolveDir = path.join(root, EVOLVE_DIRNAME);
  if (!existsSync(evolveDir)) mkdirSync(evolveDir, { recursive: true });
  const archiveDir = path.join(evolveDir, 'archive');
  if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });

  const journal = new Journal(evolveDir);
  const guard = new WriteGuard({ root: evolveDir });
  const registry = new ModuleRegistry({ journal });
  const loops = new LoopEngine({ journal, stateDir: evolveDir, guard, evolveDir, archiveDir, maxActions, maxAttempts });
  const swept = sweepTmp(evolveDir);
  if (swept.length > 0) {
    try {
      journal.append('evolve.tmp-swept', { files: swept.slice(0, 50), count: swept.length });
    } catch {
      // 日志坏了也不能因此让插件起不来
    }
  }

  let loadFailure = null;

  /** 日志坏了/被占时，记录失败不能反过来把调用方/调度器带崩 */
  const safeAppend = (event, data) => {
    try {
      journal.append(event, data);
    } catch {
      // 日志不可写就只保留返回值
    }
  };

  const observation = () => ({
    at: new Date().toISOString(),
    counts: {
      activity: countLines(path.join(root, 'activity.jsonl')),
      uncertain: countLines(path.join(root, 'uncertain.jsonl')),
      companion: countLines(path.join(root, 'companion-notes.jsonl')),
    },
  });

  const uniqueArchiveRel = (cycle) => {
    let name = cycle + '.json';
    let n = 2;
    while (existsSync(path.join(archiveDir, name))) name = cycle + '-' + n++ + '.json';
    return path.posix.join('archive', name);
  };

  const modules = [
    {
      id: 'memory-reader',
      version: '1.0.0',
      provides: ['observe.memory'],
      init: () => ({
        snapshot: () => snapshotMemory(root),
        counts: observation,
      }),
    },
    {
      id: 'candidate-planner',
      version: '1.0.0',
      requires: ['observe.memory'],
      provides: ['plan.candidates'],
      init: () => ({
        plan(obs) {
          const counts = obs?.counts ?? {};
          const candidates = [];
          if ((counts.uncertain ?? 0) > 0) candidates.push({ kind: 'review-uncertain', weight: counts.uncertain });
          if ((counts.activity ?? 0) > 0) candidates.push({ kind: 'summarize-activity', weight: counts.activity });
          return candidates;
        },
      }),
    },
    {
      id: 'evolution-writer',
      version: '1.0.0',
      requires: ['plan.candidates'],
      provides: ['act.write'],
      init: (ctx) => ({
        reserve: (cycle) => uniqueArchiveRel(cycle),
        write(cycle, rel, payload) {
          const abs = path.join(ctx.evolveDir, rel);
          ctx.guard.writeJson(abs, { cycle, ...payload, at: new Date().toISOString() });
          const buf = readFileSync(abs);
          return { rel, sha: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
        },
      }),
    },
    {
      id: 'state-verifier',
      version: '1.0.0',
      requires: ['act.write'],
      provides: ['verify.state'],
      init: (ctx) => ({
        verify({ journal: j, before, after, archive, cycle, goal, mode = 'full' }) {
          const chain = j.verify();
          if (!chain.ok) return { ok: false, reason: 'journal-chain-broken', brokenAt: chain.brokenAt };
          if (!archive || typeof archive.rel !== 'string') return { ok: false, reason: 'archive-not-recorded' };
          if (!ARCHIVE_REL_RE.test(archive.rel)) return { ok: false, reason: 'archive-path-invalid', rel: archive.rel };
          const abs = path.join(ctx.evolveDir, archive.rel);
          const verdict = ctx.guard.check(abs);
          if (!verdict.ok) return { ok: false, reason: 'archive-path-denied', detail: verdict.reason };
          if (!existsSync(abs)) return { ok: false, reason: 'archive-missing' };
          let actual;
          try {
            actual = shaFile(abs);
          } catch {
            return { ok: false, reason: 'archive-unreadable' };
          }
          if (actual !== archive.sha) return { ok: false, reason: 'archive-tampered' };
          let parsed;
          try {
            parsed = JSON.parse(readFileSync(abs, 'utf8'));
          } catch {
            return { ok: false, reason: 'archive-unparsable' };
          }
          if (parsed?.cycle !== cycle) return { ok: false, reason: 'archive-cycle-mismatch' };
          if (parsed?.goal !== goal) return { ok: false, reason: 'archive-goal-mismatch' };
          // commit 重试只复核产物完整性：等待期间用户自己写记忆不该把已验证的环判死
          if (mode === 'archive') return { ok: true, chain: chain.count, archive: archive.rel, rechecked: true };
          if (!before || typeof before !== 'object') return { ok: false, reason: 'baseline-missing' };
          const diff = diffSnapshots(before, after ?? {});
          if (diff.changed.length + diff.added.length + diff.missing.length > 0) {
            return { ok: false, reason: 'memory-touched', changed: diff.changed, added: diff.added, missing: diff.missing };
          }
          return { ok: true, chain: chain.count, archive: archive.rel };
        },
      }),
    },
  ];

  const registered = registry.registerMany(modules);
  const loadCtx = { memoryDir: root, evolveDir, archiveDir, guard, journal };
  const ready = registry.loadAll(loadCtx).catch((error) => {
    loadFailure = error;
    return [];
  });

  async function ensureReady() {
    await ready;
    if (!loadFailure) return true;
    // 上一次可能是瞬时 IO 出错；给一次重试机会，而不是整个生命周期都判死
    loadFailure = null;
    try {
      await registry.loadAll(loadCtx);
      return true;
    } catch (error) {
      loadFailure = error;
      return false;
    }
  }

  async function cycle(goal = 'self-evolution') {
    if (!(await ensureReady())) {
      safeAppend('cycle.rejected', { goal, reason: 'modules-unavailable', message: String(loadFailure?.message ?? loadFailure) });
      return { status: 'rejected', reason: 'modules-unavailable', message: String(loadFailure?.message ?? loadFailure) };
    }
    const observer = registry.get('observe.memory');
    const planner = registry.get('plan.candidates');
    const writer = registry.get('act.write');
    const verifier = registry.get('verify.state');
    if (!observer || !planner || !writer || !verifier) {
      safeAppend('cycle.rejected', { goal, reason: 'modules-unavailable' });
      return { status: 'rejected', reason: 'modules-unavailable' };
    }
    return loops.run({
      goal,
      context: { runtime: { memoryDir: root, evolveDir } },
      handlers: {
        observe: () => {
          const snapshot = observer.snapshot();
          const obs = observer.counts();
          return { ...obs, memoryFiles: Object.keys(snapshot).length, persist: { observation: obs } };
        },
        plan: (ctx) => {
          const candidates = planner.plan(ctx.pending.extras.observation ?? observation());
          return { candidates: candidates.length, items: candidates, persist: { plan: candidates } };
        },
        act: (ctx) => {
          ctx.budget.take(1);
          // 崩溃后重跑 act 时复用已预留的路径（tmp+rename 保证原子），不留孤儿归档
          const reserved = Array.isArray(ctx.pending.extras.artifacts) ? ctx.pending.extras.artifacts[0] : null;
          const rel = typeof reserved === 'string' ? reserved : writer.reserve(ctx.cycle);
          // 基线贴着写之前取：观察和动手之间隔多久（含崩溃续跑）都不会把这段时间的改动算成自己写的
          const before = observer.snapshot();
          ctx.save({ before, baselineAt: new Date().toISOString(), artifacts: [rel], archive: { rel } });
          const info = writer.write(ctx.cycle, rel, { goal: ctx.goal, plan: ctx.pending.extras.plan ?? [] });
          ctx.save({ archive: info });
          return { actions: [rel], persist: { archive: info } };
        },
        verify: (ctx) => {
          const after = observer.snapshot();
          const extras = ctx.pending.extras;
          return verifier.verify({
            journal,
            before: extras.before,
            after,
            archive: extras.archive,
            cycle: ctx.cycle,
            goal: ctx.goal,
            mode: ctx.reverify === true ? 'archive' : 'full',
          });
        },
      },
    });
  }

  function status() {
    try {
      journal.syncFromDisk();
    } catch {
      // 读盘失败就报内存里的视图，至少面板不会 500
    }
    try {
      loops.peekState();
    } catch {
      // 状态文件不可读时保持内存视图
    }
    const pending = loops.state.pending;
    return {
      ok: registered.ok && loadFailure === null,
      modules: registry.list(),
      chain: journal.verify(),
      state: {
        cycleSeq: loops.state.cycleSeq,
        committed: loops.state.committed.slice(-50),
        pending: pending
          ? {
              id: pending.id,
              goal: pending.goal,
              startedAt: pending.startedAt,
              nextPhase: pending.nextPhase,
              attempts: pending.attempts,
              verify: pending.verify
                ? { ok: pending.verify.ok === true, reason: pending.verify.reason ?? null }
                : null,
              archive: typeof pending.extras?.archive?.rel === 'string' ? pending.extras.archive.rel : null,
            }
          : null,
      },
      last: journal.tail(5).map((entry) => ({ seq: entry.seq, event: entry.event, at: entry.at })),
    };
  }

  async function dispose() {
    return registry.disposeAll(loadCtx);
  }

  return { root, evolveDir, archiveDir, journal, guard, registry, loops, ready, cycle, status, observation, dispose };
}

function replyJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

export function apply(ctx, config = {}) {
  const runtime = createRuntime({
    memoryDir: resolveMemoryDir(config),
    maxActions: config.maxActions,
    maxAttempts: config.maxAttempts,
  });

  const intervalSeconds = Number(config.intervalSeconds);
  const scheduler = {
    enabled: Number.isFinite(intervalSeconds) && intervalSeconds > 0,
    registered: false,
    intervalSeconds: Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : 0,
    lastRun: null,
    starts: 0,
  };

  async function tick(goal) {
    try {
      const result = await runtime.cycle(goal);
      scheduler.lastRun = { at: new Date().toISOString(), status: result.status, cycle: result.cycle ?? null };
    } catch (error) {
      scheduler.lastRun = { at: new Date().toISOString(), status: 'error', message: String(error?.message ?? error) };
      try {
        runtime.journal.append('scheduler.error', { message: String(error?.message ?? error) });
      } catch {
        // tick 绝不能以 rejection 结束，否则 void tick() 会变成未处理 rejection 拖垮进程
      }
    }
  }

  try {
    ctx?.inject?.(['webServer'], (scope) => {
      scope.effect(() => {
        const disposeRoute = scope.webServer.register({
          kind: 'exact',
          path: ROUTE,
          handler: async (req, res) => {
            try {
              if (req.method !== 'GET') {
                replyJson(res, 405, { ok: false, error: 'method' });
                return;
              }
              replyJson(res, 200, { ...runtime.status(), scheduler: { ...scheduler }, readOnly: true });
            } catch (error) {
              try {
                replyJson(res, 500, { ok: false, error: String(error?.message ?? error) });
              } catch {
                // 响应已经发出去/连接断了：不能再抛，路由层会当未处理 rejection
              }
            }
          },
        });
        return () => {
          try {
            disposeRoute?.();
          } catch {
            // 路由已经没了就算了
          }
        };
      });
    });
  } catch (error) {
    try {
      runtime.journal.append('route.unavailable', { message: String(error?.message ?? error) });
    } catch {
      // 日志也不可用时就只在内存里记不着了，不能让 apply 抛出去
    }
  }

  if (scheduler.enabled && typeof ctx?.effect === 'function') {
    scheduler.registered = true;
    ctx.effect(() => {
      const fire = () => {
        scheduler.starts += 1;
        void tick('scheduled-evolution');
      };
      const timer = setInterval(fire, scheduler.intervalSeconds * 1000);
      timer.unref?.();
      if (config.runOnStart === true) queueMicrotask(fire);
      return () => clearInterval(timer);
    });
  }

  if (typeof ctx?.on === 'function') {
    ctx.on('dispose', () => {
      void runtime.dispose().catch(() => {
        // 卸载失败不该冒成未处理 rejection
      });
    });
  }

  runtime.scheduler = scheduler;
  return runtime;
}
