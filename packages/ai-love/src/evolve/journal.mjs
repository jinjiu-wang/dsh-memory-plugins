/**
 * 爱ai · 自进化板块 — 可追溯日志
 *
 * 追加写 JSONL，每行带 seq / prev / hash，形成哈希链：
 *   改一行 → 后面所有 hash 对不上；删一行 → seq 断档。
 *
 * 崩溃一致性：
 *   - 进程被杀留下的半行只可能出现在文件末尾；下一次 append 先把它截掉，
 *     再记一条 journal.repair，绝不让新行粘在半行后面。
 *   - 文件中间的坏行 = 真损坏：直接判定链坏并拒绝继续追加，不静默跳过。
 *   - 追加前按文件大小/时间戳检测外部写入并重新加载，避免两个实例各写各的 seq。
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const JOURNAL_FILE = 'journal.jsonl';
export const ZERO_HASH = '0'.repeat(64);

/** 同步小睡（主线程也能用），只在抢锁时用 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 同机进程是否还活着；EPERM 说明进程在，只是没权限发信号 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** 读锁文件里的持有者信息；刚创建还没写完时返回 null */
function readLockOwner(lock) {
  try {
    const parsed = JSON.parse(readFileSync(lock, 'utf8'));
    return { pid: Number(parsed?.pid) };
  } catch {
    return null;
  }
}

/** 稳定序列化：对象键排序，保证同一内容永远同一 hash */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function entryHash(prev, body) {
  return createHash('sha256').update(prev).update('\n').update(canonical(body)).digest('hex');
}

export class Journal {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, JOURNAL_FILE);
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    this.entries = [];
    this.broken = null;
    this.tailPartial = false;
    this.validBytes = 0;
    this.diskSize = -1;
    this.diskMtime = -1;
    this.load();
  }

  /** 从磁盘重建内存视图；中间坏行只记录，不假装没看见。 */
  load() {
    this.entries = [];
    this.broken = null;
    this.tailPartial = false;
    this.validBytes = 0;
    this.diskSize = -1;
    this.diskMtime = -1;
    if (!existsSync(this.file)) return this;

    const buf = readFileSync(this.file);
    this.diskSize = buf.length;
    this.diskMtime = statSync(this.file).mtimeMs;
    const text = buf.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    const complete = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1);
    this.tailPartial = complete.length < text.length;
    this.validBytes = Buffer.byteLength(complete, 'utf8');

    const lines = complete.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].replace(/\r$/, '').trim();
      if (line === '') continue;
      try {
        this.entries.push(JSON.parse(line));
      } catch {
        this.broken = { at: this.entries.length + 1, reason: 'unparsable-line' };
      }
    }
    return this;
  }

  /** 外部实例追写过就重新加载，保证 seq/prev 接在磁盘真实尾部。 */
  syncFromDisk() {
    try {
      const st = statSync(this.file);
      if (st.size !== this.diskSize || st.mtimeMs !== this.diskMtime) this.load();
    } catch {
      // 文件刚被删：内存视图也清空
      this.load();
    }
    return this;
  }

  /** 截掉崩溃留下的半行；只在文件末尾且没有换行时才会发生。 */
  repairTail() {
    if (!this.tailPartial) return null;
    truncateSync(this.file, this.validBytes);
    const dropped = this.diskSize - this.validBytes;
    this.tailPartial = false;
    this.load();
    return dropped;
  }

  get last() {
    return this.entries.length === 0 ? null : this.entries[this.entries.length - 1];
  }

  /** 跨进程追加锁：同一台机器上两个实例不会各写各的 seq */
  #withLock(fn) {
    const lock = this.file + '.lock';
    const started = Date.now();
    let fd = null;
    for (;;) {
      try {
        fd = openSync(lock, 'wx');
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      // 活着的持有者绝不抢：抢了会让两边同时拿到 seq
      const owner = readLockOwner(lock);
      let age = Infinity;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      const dead = owner !== null && !pidAlive(owner.pid);
      const abandoned = owner === null && age > 60000;
      if (dead || abandoned) {
        try {
          unlinkSync(lock);
        } catch {
          // 别人先清了，下一圈继续
        }
        continue;
      }
      if (Date.now() - started > 3000) {
        const err = new Error('evolve journal is locked by another process');
        err.code = 'EVOLVE_JOURNAL_LOCKED';
        throw err;
      }
      sleepSync(5);
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
    } finally {
      try {
        closeSync(fd);
      } catch {
        // fd 已经关了也无所谓
      }
    }
    try {
      return fn();
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        // 锁文件已经不在了
      }
    }
  }

  append(event, data = {}) {
    return this.#withLock(() => {
      this.syncFromDisk();
      const repaired = this.repairTail();
      if (this.broken) {
        const err = new Error(`evolve journal broken at seq ${this.broken.at}: ${this.broken.reason}`);
        err.code = 'EVOLVE_JOURNAL_BROKEN';
        err.brokenAt = this.broken.at;
        throw err;
      }
      const chain = this.verify();
      if (!chain.ok) {
        const err = new Error(`evolve journal chain broken at seq ${chain.brokenAt}: ${chain.reason}`);
        err.code = 'EVOLVE_JOURNAL_BROKEN';
        err.brokenAt = chain.brokenAt;
        throw err;
      }
      if (repaired !== null) {
        this.#write({ seq: this.entries.length + 1, at: new Date().toISOString(), event: 'journal.repair', data: { droppedBytes: repaired } });
      }
      return this.#write({ seq: this.entries.length + 1, at: new Date().toISOString(), event, data });
    });
  }

  #write(body) {
    const prev = this.last?.hash ?? ZERO_HASH;
    const entry = { ...body, prev, hash: entryHash(prev, body) };
    appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf8');
    this.entries.push(entry);
    this.diskSize = statSync(this.file).size;
    this.diskMtime = statSync(this.file).mtimeMs;
    return entry;
  }

  /** 校验整条链；任何一处被改都会定位到具体 seq */
  verify() {
    if (this.broken) return { ok: false, brokenAt: this.broken.at, reason: this.broken.reason };
    let prev = ZERO_HASH;
    for (let i = 0; i < this.entries.length; i += 1) {
      const entry = this.entries[i];
      if (!entry || typeof entry !== 'object') return { ok: false, brokenAt: i + 1, reason: 'bad-entry' };
      if (entry.seq !== i + 1) return { ok: false, brokenAt: i + 1, reason: 'seq-gap' };
      if (entry.prev !== prev) return { ok: false, brokenAt: i + 1, reason: 'prev-mismatch' };
      const { hash, prev: _prev, ...body } = entry;
      if (entryHash(prev, body) !== hash) return { ok: false, brokenAt: i + 1, reason: 'hash-mismatch' };
      prev = hash;
    }
    return { ok: true, count: this.entries.length, head: prev, tailPartial: this.tailPartial };
  }

  tail(n = 20) {
    return this.entries.slice(-n);
  }
}
