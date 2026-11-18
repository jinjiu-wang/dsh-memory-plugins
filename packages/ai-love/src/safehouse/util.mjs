/**
 * 安全屋 · 小工具
 *
 * 只依赖 node: 内置模块。所有写盘都走原子写；读盘坏掉一律不抛。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export function sleepSync(ms) {
  Atomics.wait(SLEEP_BUFFER, 0, 0, Math.max(1, ms | 0));
}

export function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function clamp01(value) {
  return clamp(Number(value) || 0, 0, 1);
}

export function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 0600（Windows 上 chmod 基本无效，但至少 POSIX 侧不是 644）。 */
export function hardenFile(file) {
  try {
    chmodSync(file, 0o600);
  } catch {
    /* 平台不支持就算了 */
  }
}

export function readTextSafe(file, fallback = '') {
  try {
    // 记事本/某些编辑器会给 UTF-8 加 BOM；JSON.parse 不认，统一剥掉。
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return fallback;
  }
}

/**
 * 和 readTextSafe 一样剥 BOM，但把「文件不存在」和「读不了」分开。
 * 半私钥这类文件不能把 EACCES/EBUSY 当成空文件：误判成空会重新生成密钥，
 * 对端 TOFU 指纹立刻对不上，之后就永久 peer-untrusted。
 */
export function readTextResult(file) {
  try {
    return { ok: true, text: readFileSync(file, 'utf8').replace(/^\uFEFF/, '') };
  } catch (error) {
    return { ok: false, code: String(error?.code ?? 'EUNKNOWN'), error };
  }
}

export function readJsonSafe(file, fallback = null) {
  const text = readTextSafe(file, '');
  if (text.trim() === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * 原子写：tmp + rename。
 *
 * 不再退化成「原地写」：原地截断写会让读侧读到半截 JSON，而读侧对坏文件是
 * fail-open（桥接放行 / 状态归一成 closed），等于把锁悄悄弄丢。写不进去就抛，
 * 让调用方保留旧文件，比写坏更安全。
 */
export function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, text, 'utf8');
    try {
      fsyncSync(fd);
    } catch {
      /* 部分文件系统不支持 fsync；写成功就够了 */
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* 句柄已关 */
    }
  }
  try {
    let lastError = null;
    // Windows 上 Defender / 搜索索引 / OneDrive 会短暂占用目标文件，rename 报
    // EPERM/EACCES/EBUSY。退避总共约 1.2 秒，比只重试 200ms 更抗抖；
    // 仍然失败就抛，让调用方保留旧文件，绝不原地截断写。
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        renameSync(tmp, file);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        sleepSync(attempt < 10 ? 20 : 50);
      }
    }
    if (lastError) throw lastError;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* rename 成功后 tmp 已经不在了 */
    }
  }
  hardenFile(file);
  return file;
}

/**
 * 跨进程互斥：O_EXCL 建锁文件（Windows/POSIX 都支持）。
 * 拿不到锁时短暂退避；锁文件超过 staleMs 没释放按崩溃处理。
 * fn 是同步函数 —— 锁不支持跨 await，安全屋的写操作都是短同步段。
 */
export function withFileLock(lockFile, fn, { timeoutMs = 3000, staleMs = 10_000 } = {}) {
  ensureDir(path.dirname(lockFile));
  const startedAt = Date.now();
  // 用连字符不用冒号：Windows 文件名不允许 ':'，带冒号的 stale 路径 rename 必失败。
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
  let handle = null;
  for (;;) {
    try {
      handle = openSync(lockFile, 'wx', 0o600);
      try {
        writeFileSync(handle, token, 'utf8');
      } catch (error) {
        try {
          closeSync(handle);
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(lockFile);
        } catch {
          /* ignore */
        }
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const mtime = fileMtime(lockFile);
      // mtime 为 0 代表锁文件已经不在了（或 stat 失败），不能当成「无限旧」去 unlink，
      // 否则两个等待者会轮流删掉对方刚建的新锁。
      if (mtime > 0 && Date.now() - mtime > staleMs) {
        // 用唯一改名「认领」过期锁：只有一个等待者能 rename 成功，
        // 避免两个进程同时 unlink 后各自以为清过场。
        const stale = `${lockFile}.stale-${token}`;
        let claimed = false;
        try {
          renameSync(lockFile, stale);
          claimed = true;
          try {
            unlinkSync(stale);
          } catch {
            /* ignore */
          }
        } catch {
          /* 别人抢先认领了 */
        }
        // 认领成功就立刻重试；失败说明别人抢到了，必须继续走超时/退避路径，
        // 否则这里 continue 会让循环空转不退避（Windows 下 rename 失败时会卡死）。
        if (claimed) continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        const timeout = new Error('锁等待超时');
        timeout.code = 'ELOCK';
        throw timeout;
      }
      sleepSync(8);
    }
  }
  try {
    return fn();
  } finally {
    try {
      closeSync(handle);
    } catch {
      /* 句柄已关 */
    }
    try {
      // 只删自己的锁：锁可能已被过期认领者改名，或已被新持有者建立。
      if (readFileSync(lockFile, 'utf8') === token) unlinkSync(lockFile);
    } catch {
      /* 锁文件已被外部清理 */
    }
  }
}

export function writeJsonAtomic(file, value) {
  return writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendLine(file, line) {
  ensureDir(path.dirname(file));
  try {
    writeFileSync(file, `${line}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 });
    hardenFile(file);
  } catch {
    /* 审计写不进去不影响状态机 */
  }
}

export function fileMtime(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export function fileSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** 定长比较，防时序侧信道。 */
export function safeEqualHex(a, b) {
  const left = Buffer.from(String(a), 'hex');
  const right = Buffer.from(String(b), 'hex');
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 输入边界：控制字符压成空格，截断。 */
export function cleanText(value, max) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return '';
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, max)
    .trim();
}

/** 出站/日志里的绝对路径抹掉，别顺着 HTTP 或记忆漏出去（Windows 盘符、UNC、常见 POSIX 根）。 */
export function redactPaths(text) {
  return String(text ?? '')
    .replace(/[A-Za-z]:\\[^\s"'`]*/g, '…')
    .replace(/\\\\[^\s"'`]+/g, '…')
    .replace(/\/(?:Users|home|root|var|tmp|opt|mnt|media|private|etc|usr|Volumes)\/[^\s"'`]*/g, '…')
    .slice(0, 400);
}

export function exists(file) {
  try {
    return existsSync(file);
  } catch {
    return false;
  }
}
