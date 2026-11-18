/**
 * 爱ai · 自进化板块 — 写入闸门
 *
 * 规矩只有一条：这个板块只准写自己那一格（<memoryDir>/.evolve/）。
 * 记忆文件（activity.jsonl / uncertain.jsonl / summaries/ / character/ …）一律只读。
 *
 * 光比字符串不够：`mklink /J` 造一个目录联接就能让 C:\...\.evolve\link\x
 * 落到 C:\...\activity.jsonl 上。所以这里做两层：
 *   1) 用 realpath 把路径还原成真实位置，再判断是否仍在 .evolve 里；
 *   2) 从 .evolve 到目标逐级 lstat，任何一级是重解析点（junction / 符号链接）直接拒绝。
 * 另外 .evolve 自己如果是联接，整个板块拒绝启动。
 */
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const WIN = process.platform === 'win32';

function isMissing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function samePath(a, b) {
  return WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** 目标是否落在 base 内（rel 的第一段是 '..' 才算越界，'.foo' / '..foo' 不算） */
function inside(target, base) {
  const rel = path.relative(base, target);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel.split(path.sep)[0] !== '..';
}

/** 把不存在的尾部拼到最近一个存在祖先的 realpath 后面 */
function resolveReal(target) {
  const abs = path.resolve(target);
  const tail = [];
  let probe = abs;
  for (;;) {
    try {
      const real = realpathSync.native(probe);
      return tail.length === 0 ? real : path.join(real, ...tail.slice().reverse());
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(probe);
      if (parent === probe) return abs;
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
}

function isReparse(file) {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export class WriteGuard {
  constructor({ root, protectedRoots = [] }) {
    this.plannedRoot = path.resolve(root);
    try {
      this.root = resolveReal(this.plannedRoot);
    } catch (error) {
      const err = new Error('evolve guard: cannot resolve root ' + root + ' (' + error?.code + ')');
      err.code = 'EVOLVE_WRITE_DENIED';
      err.reason = 'unresolvable';
      throw err;
    }
    this.rootIsReparse = isReparse(this.plannedRoot);
    this.protectedRoots = protectedRoots.map((p) => {
      try {
        return resolveReal(path.resolve(p));
      } catch {
        return path.resolve(p);
      }
    });
  }

  /** 从目标逐级向上（到 .evolve 为止）找重解析点 */
  findReparse(target) {
    let cur = path.resolve(target);
    for (;;) {
      if (isReparse(cur)) return cur;
      if (samePath(cur, this.plannedRoot)) return null;
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }

  check(target) {
    if (this.rootIsReparse) return { ok: false, reason: 'evolve-root-is-reparse', at: this.plannedRoot };
    let real;
    try {
      real = resolveReal(target);
    } catch (error) {
      return { ok: false, reason: 'unresolvable', code: error?.code ?? null };
    }
    if (!inside(real, this.root)) return { ok: false, reason: 'outside-evolve-root', real };
    for (const p of this.protectedRoots) {
      if (inside(real, p)) return { ok: false, reason: 'protected-path', real };
    }
    const reparse = this.findReparse(target);
    if (reparse) return { ok: false, reason: 'reparse-point', at: reparse };
    return { ok: true, real };
  }

  assert(target) {
    const res = this.check(target);
    if (!res.ok) {
      const err = new Error('evolve write denied: ' + res.reason + ' → ' + target);
      err.code = 'EVOLVE_WRITE_DENIED';
      err.reason = res.reason;
      throw err;
    }
    return res;
  }

  /** 原子写：先写同目录临时文件再 rename，断电最多留个 .tmp */
  writeJson(target, value) {
    const abs = path.resolve(target);
    this.assert(abs);
    mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = abs + '.tmp-' + process.pid + '-' + Date.now();
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    renameSync(tmp, abs);
    return abs;
  }
}
