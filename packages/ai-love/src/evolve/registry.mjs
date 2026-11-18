/**
 * 爱ai · 自进化板块 — 模块注册表
 *
 * 每个"板块"就是一个带 id / provides / requires 的小对象。
 * 规矩：
 *   - id 唯一、能力名唯一（两个模块抢同一个能力直接拒绝，不玩"后者覆盖"）；
 *   - 依赖必须在场，且不许依赖自己提供的能力（自依赖 = 配错了）；
 *   - 整批注册要么全成、要么一个都不动；
 *   - 加载按依赖拓扑序，卸载反序；加载中途失败要把已起来的模块拆干净；
 *   - 任何拒绝都会写进日志，事后能查"为什么这个模块没起来"。
 */
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const CAP_RE = /^[a-z0-9][a-z0-9._:-]*$/;

export class ModuleRegistry {
  constructor({ journal = null } = {}) {
    this.modules = new Map();
    this.instances = new Map();
    this.loaded = [];
    this.loadError = null;
    this.journal = journal;
  }

  validate(mod) {
    const errors = [];
    if (!mod || typeof mod !== 'object') return ['module-not-object'];
    if (typeof mod.id !== 'string' || !ID_RE.test(mod.id)) errors.push('bad-id');
    if (mod.version !== undefined && typeof mod.version !== 'string') errors.push('bad-version');
    for (const key of ['provides', 'requires']) {
      if (mod[key] === undefined) continue;
      if (!Array.isArray(mod[key])) {
        errors.push('bad-' + key);
        continue;
      }
      if (mod[key].length === 0) {
        errors.push('empty-' + key);
        continue;
      }
      if (mod[key].some((v) => typeof v !== 'string' || !CAP_RE.test(v))) errors.push('bad-' + key);
      if (new Set(mod[key]).size !== mod[key].length) errors.push('duplicate-in-' + key);
    }
    for (const key of ['init', 'dispose']) {
      if (mod[key] !== undefined && typeof mod[key] !== 'function') errors.push('bad-' + key);
    }
    return errors;
  }

  providesOf(mod) {
    return mod.provides ?? [mod.id];
  }

  /** 批次注册：要么全成，要么一个都不动；加载开始后不再接受新模块 */
  registerMany(batch) {
    if (this.loaded.length > 0 || this.instances.size > 0) {
      const errors = [{ id: '?', errors: ['registry-already-loaded'] }];
      this.journal?.append('registry.rejected', { errors });
      return { ok: false, errors, added: [] };
    }
    if (!Array.isArray(batch)) {
      const errors = [{ id: '?', errors: ['batch-not-array'] }];
      this.journal?.append('registry.rejected', { errors });
      return { ok: false, errors, added: [] };
    }
    const errors = [];
    const staged = new Map();
    const owner = new Map(); // capability -> module id
    for (const mod of this.modules.values()) {
      for (const cap of this.providesOf(mod)) owner.set(cap, mod.id);
    }
    for (const mod of batch) {
      const local = this.validate(mod);
      if (local.length > 0) {
        errors.push({ id: mod?.id ?? '?', errors: local });
        continue;
      }
      if (this.modules.has(mod.id) || staged.has(mod.id)) {
        errors.push({ id: mod.id, errors: ['duplicate-id'] });
        continue;
      }
      const caps = new Set();
      for (const cap of this.providesOf(mod)) {
        if (owner.has(cap) || caps.has(cap)) {
          errors.push({ id: mod.id, errors: ['duplicate-provider:' + cap] });
          continue;
        }
        caps.add(cap);
      }
      for (const cap of caps) owner.set(cap, mod.id);
      staged.set(mod.id, mod);
    }
    for (const mod of staged.values()) {
      const own = new Set(this.providesOf(mod));
      const problems = [];
      for (const cap of mod.requires ?? []) {
        if (own.has(cap)) problems.push('self-dependency:' + cap);
        else if (!owner.has(cap)) problems.push('missing:' + cap);
      }
      if (problems.length > 0) errors.push({ id: mod.id, errors: problems });
    }
    if (errors.length > 0) {
      this.journal?.append('registry.rejected', { errors });
      return { ok: false, errors, added: [] };
    }
    for (const mod of staged.values()) this.modules.set(mod.id, mod);
    this.journal?.append('registry.accepted', { ids: [...staged.keys()] });
    return { ok: true, errors: [], added: [...staged.keys()] };
  }

  /** 依赖拓扑序；有环直接抛错 */
  order() {
    const byCap = new Map();
    for (const mod of this.modules.values()) {
      for (const cap of this.providesOf(mod)) byCap.set(cap, mod.id);
    }
    const pending = new Map();
    for (const mod of this.modules.values()) {
      pending.set(
        mod.id,
        new Set((mod.requires ?? []).map((cap) => byCap.get(cap)).filter((id) => id && id !== mod.id)),
      );
    }
    const ordered = [];
    while (pending.size > 0) {
      const ready = [...pending.keys()].filter((id) => pending.get(id).size === 0);
      if (ready.length === 0) {
        const err = new Error('evolve registry: dependency cycle');
        err.code = 'EVOLVE_REGISTRY_CYCLE';
        err.cycle = [...pending.keys()];
        throw err;
      }
      for (const id of ready.sort()) {
        ordered.push(this.modules.get(id));
        pending.delete(id);
        for (const deps of pending.values()) deps.delete(id);
      }
    }
    return ordered;
  }

  /** 加载（幂等）；中途失败把已加载的反序拆掉，状态回到未加载，允许修好后重试 */
  async loadAll(ctx) {
    if (this.loaded.length > 0) return this.loaded.map((m) => m.id);
    this.loadError = null;
    const ordered = this.order();
    const started = [];
    try {
      for (const mod of ordered) {
        const instance = typeof mod.init === 'function' ? await mod.init(ctx, { journal: this.journal }) : undefined;
        this.instances.set(mod.id, instance);
        started.push(mod);
        this.journal?.append('module.loaded', { id: mod.id, version: mod.version ?? null });
      }
    } catch (error) {
      this.loadError = error;
      this.journal?.append('module.load-failed', {
        id: started.length < ordered.length ? ordered[started.length].id : '?',
        message: String(error?.message ?? error),
      });
      await this.#dispose(started, ctx);
      this.instances.clear();
      throw error;
    }
    this.loaded = ordered;
    return this.loaded.map((m) => m.id);
  }

  async #dispose(mods, ctx) {
    const disposed = [];
    for (const mod of [...mods].reverse()) {
      try {
        if (typeof mod.dispose === 'function') await mod.dispose(ctx, { journal: this.journal, instance: this.instances.get(mod.id) });
        disposed.push(mod.id);
      } catch (error) {
        this.journal?.append('module.dispose-failed', { id: mod.id, message: String(error?.message ?? error) });
      }
    }
    return disposed;
  }

  async disposeAll(ctx) {
    const disposed = await this.#dispose(this.loaded, ctx);
    this.loaded = [];
    this.instances.clear();
    this.loadError = null;
    this.journal?.append('registry.disposed', { ids: disposed });
    return disposed;
  }

  /** 按 id 或能力名取实例 */
  get(idOrCap) {
    if (this.instances.has(idOrCap)) return this.instances.get(idOrCap);
    for (const mod of this.modules.values()) {
      if (this.providesOf(mod).includes(idOrCap)) return this.instances.get(mod.id);
    }
    return undefined;
  }

  has(idOrCap) {
    if (this.modules.has(idOrCap)) return true;
    for (const mod of this.modules.values()) {
      if (this.providesOf(mod).includes(idOrCap)) return true;
    }
    return false;
  }

  list() {
    return [...this.modules.values()]
      .map((mod) => ({
        id: mod.id,
        version: mod.version ?? null,
        provides: this.providesOf(mod),
        requires: mod.requires ?? [],
        loaded: this.loaded.some((m) => m.id === mod.id),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
