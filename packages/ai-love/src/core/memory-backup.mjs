/**
 * ai-love · QQ AI 运行记忆的逐字节备份
 *
 * 目标不是「搬到 D 盘」，而是：把 QQ 上 AI 到目前为止的全部运行记忆
 * （DSH 里 qq-bridge 的会话日志 + ~/.dsh/ai-love 档案）按原始字节另存一份，
 * 放进非系统盘上的新文件夹；此后 DSH 运行期间持续增量镜像。
 *
 * 硬规矩：
 *   - 源目录只读：备份从不写、不移动、不删除源文件；源文件消失时备份保留。
 *   - 逐字节：先复制到临时文件，比对源/副本的 size + mtime + sha256 后再换入；
 *     源在复制期间还在增长时重试，装不进去也不留半份残文件。
 *   - 快照目录：<根>/<YYYYMMDD-HHmmss>/，manifest.json 记每个文件的 sha256；
 *     .current.json 指向当前实时镜像目录。
 *   - 只备 qq-bridge 会话组；别的 DSH 会话目录一律不碰。
 *   - 跨进程锁（.backup.lock）：CLI 与后台同时在跑时只有一个写者。
 *   - 实时：fs.watch 递归 + 定时全量对账；变化先攒 2 秒再写，避免边聊边抖。
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, watch } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  utimes,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { writeFileAtomic } from './atomic.mjs';
import { detectBackupDir } from './backup.mjs';
import { isQqSessionGroup, isSafeGroupName, resolveDshHome } from './context-link.mjs';

export const MEMORY_BACKUP_VERSION = 1;
export const MEMORY_BACKUP_DIR_NAME = 'qq-ai-memory-backup';
export const BACKUP_POINTER = '.current.json';
export const BACKUP_LOCK = '.backup.lock';
export const BACKUP_MANIFEST = 'manifest.json';

const AREA_SESSIONS = 'sessions';
const AREA_MEMORY = 'ai-love';
const AREAS = [AREA_SESSIONS, AREA_MEMORY];
const IGNORED_NAME = /^(?:\.ai-love-link\.lock|\.ai-love-links\.json|\.ai-love-(?:old|restore)-)/;
const TMP_NAME = /\.tmp-[0-9a-z]+-[0-9a-z]+(?:-[0-9a-z]+)?$/i;
const OLD_NAME = /\.old-[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/i;
const SAFE_SNAPSHOT = /^[0-9A-Za-z._-]+$/;
const HISTORY_DIR = '_history';
const HISTORY_KEEP = 5;

const DEFAULT_POLL_MS = 60_000;
const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_MAX_DELAY_MS = 15_000;
const STALE_LOCK_MS = 30 * 60_000;
const LOCK_HEARTBEAT_MS = 20_000;
const LOCK_LIVE_STALE_MS = 15 * 60_000;
const LEFTOVER_MS = 60 * 60_000;

/** 备份根：显式 memoryBackupDir，否则 <面板备份目录>/qq-ai-memory-backup。 */
export function resolveMemoryBackupRoot(config = {}) {
  const explicit = typeof config?.memoryBackupDir === 'string' ? config.memoryBackupDir.trim() : '';
  if (explicit !== '') return path.resolve(explicit);
  const backupDir = detectBackupDir(typeof config?.backupDir === 'string' ? config.backupDir : '');
  return path.join(backupDir, MEMORY_BACKUP_DIR_NAME);
}

/** 爱ai 档案目录：与 memory.mjs 的默认值一致。 */
export function resolveMemoryBackupMemoryDir(options = {}) {
  const explicit = typeof options.memoryDir === 'string' ? options.memoryDir.trim() : '';
  if (explicit !== '') return path.resolve(explicit);
  return path.join(resolveDshHome(options), 'ai-love');
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

export function snapshotName(date = new Date()) {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function stamp() {
  return `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function isSafeSnapshotName(name) {
  const text = String(name ?? '');
  if (text === '' || text === '.' || text === '..') return false;
  if (!SAFE_SNAPSHOT.test(text) || text.includes('..')) return false;
  return path.basename(text) === text;
}

function snapshotFolder(root, name) {
  if (!isSafeSnapshotName(name)) return null;
  const full = path.join(path.resolve(root), name);
  const parent = path.dirname(full);
  const same =
    process.platform === 'win32'
      ? parent.toLowerCase() === path.resolve(root).toLowerCase()
      : parent === path.resolve(root);
  return same ? full : null;
}

function keyOf(area, rel) {
  return `${area}\u0000${rel}`;
}

function normalizePath(value) {
  let text = String(value ?? '').trim();
  if (text.startsWith('\\\\?\\')) text = text.slice(4);
  else if (text.startsWith('\\??\\')) text = text.slice(4);
  return path.resolve(text);
}

function samePathLoose(left, right) {
  const a = normalizePath(left);
  const b = normalizePath(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInsidePath(parent, child) {
  const rel = path.relative(normalizePath(parent), normalizePath(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** 解析到真实路径；目标还不存在时，解析最近的已存在祖先再拼回剩余部分。 */
async function realpathLoose(target) {
  const absolute = path.resolve(target);
  let current = absolute;
  const tail = [];
  for (;;) {
    try {
      const resolved = await realpath(current);
      return tail.length === 0 ? resolved : path.join(resolved, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Windows 上 rename 覆盖已存在文件在个别情况下会 EPERM，先让位再换入。 */
async function replaceFile(tmp, dest) {
  try {
    await rename(tmp, dest);
    return;
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
  }
  const aside = `${dest}.old-${stamp()}`;
  let moved = false;
  try {
    await rename(dest, aside);
    moved = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await rename(tmp, dest);
  } catch (error) {
    if (moved) await rename(aside, dest).catch(() => {});
    throw error;
  }
  if (moved) await rm(aside, { force: true }).catch(() => {});
}

function historyStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** 每个文件的历史目录里最多留 HISTORY_KEEP 份，按时间文件名淘汰最旧的。 */
async function pruneHistory(dir) {
  try {
    const names = (await readdir(dir)).sort();
    while (names.length > HISTORY_KEEP) {
      const victim = names.shift();
      await rm(path.join(dir, victim), { force: true }).catch(() => {});
    }
  } catch {
    // 历史目录还没建
  }
}

/**
 * 换入新副本。目标已存在且不比新副本小时，先把旧字节改名放进
 * _history/<区域>/<路径>/<文件名>/，这样源被截断/原地重写时旧版本仍在磁盘上。
 * 归档失败就拒绝覆盖：宁可这一轮报错，也不能把唯一的旧字节冲掉。
 */
async function installCopy(tmp, dest, copiedSize, historyDir, assertOwned, copiedHash = '') {
  let archived = null;
  let fileHistory = '';
  if (typeof historyDir === 'string' && historyDir !== '') {
    let prev = null;
    try {
      prev = await stat(dest);
    } catch {
      prev = null;
    }
    if (prev !== null && prev.isFile() && prev.size >= copiedSize) {
      // 内容完全一样就不归档：只改 mtime 的重拷不能把真正的旧世代挤出 _history。
      if (prev.size === copiedSize && typeof copiedHash === 'string' && copiedHash !== '') {
        let same = false;
        try {
          same = (await sha256File(dest)) === copiedHash;
        } catch {
          same = false;
        }
        if (same) return { archived: null, skipped: true };
      }
      fileHistory = path.join(historyDir, path.basename(dest));
      const target = path.join(
        fileHistory,
        `${historyStamp()}-${prev.size}b-${Math.random().toString(36).slice(2, 6)}`,
      );
      try {
        if (typeof assertOwned === 'function') await assertOwned();
        await mkdir(fileHistory, { recursive: true });
        await rename(dest, target);
        archived = target;
      } catch (error) {
        throw new Error(`旧版本归档失败，拒绝覆盖 ${dest}：${messageOf(error)}`);
      }
    }
  }
  try {
    if (typeof assertOwned === 'function') await assertOwned();
    await replaceFile(tmp, dest);
  } catch (error) {
    if (archived !== null) await rename(archived, dest).catch(() => {});
    throw error;
  }
  // 换入成功后再淘汰旧档：换入失败回滚时，历史目录保持原样。
  if (fileHistory !== '') await pruneHistory(fileHistory);
  return { archived, skipped: false };
}

/**
 * 把 source 逐字节复制到 dest。
 * 复制前后 size/mtime 没变且两侧 sha256 相同才算 exact；源在增长就重试，
 * 最终仍不稳定也装一份「当时读到的字节」并标记 exact:false，下一轮会再追。
 */
async function copyByteExact(source, dest, options = {}) {
  const historyDir = typeof options.historyDir === 'string' ? options.historyDir : '';
  const assertOwned = typeof options.assertOwned === 'function' ? options.assertOwned : null;
  await mkdir(path.dirname(dest), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await stat(source);
    if (!before.isFile()) throw new Error('不是普通文件');
    const tmp = `${dest}.tmp-${stamp()}`;
    try {
      await copyFile(source, tmp);
      const after = await stat(source);
      const copied = await stat(tmp);
      if (
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        copied.size === before.size
      ) {
        const [sourceHash, copiedHash] = await Promise.all([sha256File(source), sha256File(tmp)]);
        if (sourceHash === copiedHash) {
          const result = await installCopy(
            tmp,
            dest,
            copied.size,
            historyDir,
            assertOwned,
            copiedHash,
          );
          return {
            size: copied.size,
            sha256: copiedHash,
            exact: true,
            sourceMtimeMs: before.mtimeMs,
            archived: result.archived,
            skipped: result.skipped,
          };
        }
      }
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
    await delay(120 + attempt * 180);
  }
  const tmp = `${dest}.tmp-${stamp()}`;
  try {
    const before = await stat(source);
    await copyFile(source, tmp);
    const copied = await stat(tmp);
    const digest = await sha256File(tmp);
    const result = await installCopy(tmp, dest, copied.size, historyDir, assertOwned, digest);
    return {
      size: copied.size,
      sha256: digest,
      exact: false,
      sourceMtimeMs: before.mtimeMs,
      archived: result.archived,
      skipped: result.skipped,
    };
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/** 读 .current.json；名字不合法就当作没有。 */
export async function readBackupPointer(root) {
  try {
    const raw = JSON.parse(await readFile(path.join(path.resolve(root), BACKUP_POINTER), 'utf8'));
    if (!isSafeSnapshotName(raw?.folder)) return null;
    if (snapshotFolder(root, raw.folder) === null) return null;
    return {
      version: Number(raw?.version ?? MEMORY_BACKUP_VERSION),
      folder: raw.folder,
      createdAt: typeof raw?.createdAt === 'string' ? raw.createdAt : '',
      updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : '',
      files: Number(raw?.files ?? 0),
      bytes: Number(raw?.bytes ?? 0),
    };
  } catch {
    return null;
  }
}

async function writeBackupPointer(root, pointer) {
  await writeFileAtomic(
    path.join(path.resolve(root), BACKUP_POINTER),
    `${JSON.stringify(pointer, null, 2)}\n`,
  );
}

async function createSnapshotFolder(root) {
  await mkdir(root, { recursive: true });
  const base = snapshotName();
  for (let index = 0; index < 100; index += 1) {
    const name = index === 0 ? base : `${base}-${pad(index + 1)}`;
    const full = path.join(root, name);
    try {
      await mkdir(full);
      return { name, full };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  const name = `${base}-${Math.random().toString(36).slice(2, 8)}`;
  const full = path.join(root, name);
  await mkdir(full);
  return { name, full };
}

function cleanRel(rel) {
  return String(rel ?? '').split(path.sep).join('/');
}

function ignoredName(name) {
  return IGNORED_NAME.test(name) || TMP_NAME.test(name);
}

/**
 * 递归列出目录下的普通文件（rel 用 / 分隔）。
 * 调用方传进来的根目录本身可以是 junction（QQ 会话组就是），readdir 会跟进去；
 * 但树内部的联接一律不下钻，避免把源树之外的数据也复制进来或绕圈。
 */
async function walkTree(dir, relBase, files, warnings) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (ignoredName(entry.name)) continue;
    const rel = relBase === '' ? cleanRel(entry.name) : `${relBase}/${cleanRel(entry.name)}`;
    const abs = path.join(dir, entry.name);
    let info;
    try {
      info = await lstat(abs);
    } catch (error) {
      warnings.push(`${rel}: ${messageOf(error)}`);
      continue;
    }
    if (info.isSymbolicLink()) {
      warnings.push(`${rel}: 内部联接未跟随（避免跟随到源树之外）`);
      continue;
    }
    if (info.isDirectory()) {
      await walkTree(abs, rel, files, warnings);
    } else if (info.isFile()) {
      files.push({ rel, abs, size: info.size, mtimeMs: info.mtimeMs });
    }
  }
}

/** QQ 会话组文件（sessions/<组>/...）。 */
export async function listSessionMemoryFiles(sessionsRoot) {
  const files = [];
  const warnings = [];
  const groups = [];
  let unreadable = 0;
  let entries;
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { files, warnings, groups, unreadable };
    throw new Error(`读不了会话根 ${sessionsRoot}：${messageOf(error)}`);
  }
  for (const entry of entries) {
    const name = entry.name;
    if (!isQqSessionGroup(name) || !isSafeGroupName(name) || ignoredName(name)) continue;
    const abs = path.join(sessionsRoot, name);
    if (!(await isDirectory(abs))) {
      warnings.push(`${name}: 会话组不是可读目录，本轮未备份`);
      unreadable += 1;
      continue;
    }
    groups.push(name);
    try {
      const rows = [];
      await walkTree(abs, name, rows, warnings);
      files.push(...rows);
    } catch (error) {
      warnings.push(`${name}: ${messageOf(error)}`);
      unreadable += 1;
    }
  }
  return { files, warnings, groups, unreadable };
}

/** 爱ai 档案文件（ai-love/...）。目录不存在算空；存在但读不了要计入失败。 */
export async function listMemoryArchiveFiles(memoryDir) {
  const files = [];
  const warnings = [];
  let unreadable = 0;
  let info;
  try {
    info = await stat(memoryDir);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      warnings.push(`${memoryDir}: ${messageOf(error)}`);
      unreadable += 1;
    }
    return { files, warnings, unreadable };
  }
  if (!info.isDirectory()) {
    warnings.push(`${memoryDir}: 不是目录，本轮未备份`);
    unreadable += 1;
    return { files, warnings, unreadable };
  }
  try {
    await walkTree(memoryDir, '', files, warnings);
  } catch (error) {
    warnings.push(`${memoryDir}: ${messageOf(error)}`);
    unreadable += 1;
  }
  return { files, warnings, unreadable };
}

/**
 * 清掉崩溃遗留的 .tmp-* / .old-*（超过 1 小时）。
 * 清单里登记的文件一律不动：源文件本身也可能长成 notes.old-aaa-bbb-ccc。
 */
async function cleanLeftovers(root, dir, manifestPaths, depth = 0) {
  if (depth > 12) return 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (entry.name === HISTORY_DIR) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += await cleanLeftovers(root, abs, manifestPaths, depth + 1);
      continue;
    }
    if (!TMP_NAME.test(entry.name) && !OLD_NAME.test(entry.name)) continue;
    const rel = cleanRel(path.relative(root, abs));
    if (manifestPaths.has(rel)) continue;
    try {
      const info = await stat(abs);
      if (Date.now() - info.mtimeMs < LEFTOVER_MS) continue;
      await rm(abs, { force: true });
      removed += 1;
    } catch {
      // 被占用，下一轮再说
    }
  }
  return removed;
}

export async function readMemoryManifest(folder) {
  try {
    const raw = JSON.parse(await readFile(path.join(folder, BACKUP_MANIFEST), 'utf8'));
    if (Number(raw?.version) !== MEMORY_BACKUP_VERSION || !Array.isArray(raw.files)) return null;
    return raw;
  } catch {
    return null;
  }
}

function emptyManifest(source, folder) {
  const now = new Date().toISOString();
  return {
    version: MEMORY_BACKUP_VERSION,
    createdAt: now,
    updatedAt: now,
    folder,
    source,
    files: [],
    errors: [],
  };
}

function areaStats(records, area) {
  let files = 0;
  let bytes = 0;
  for (const row of records) {
    if (row.area !== area) continue;
    files += 1;
    bytes += Number(row.size ?? 0);
  }
  return { files, bytes };
}

function isPidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function lockIsStale(raw, fileAgeMs) {
  if (raw === null) return fileAgeMs > 60_000;
  if (String(raw.host ?? '') === hostname()) {
    // pid 已死立刻回收；pid 活着但心跳停了（编号被系统/别的进程复用）也回收。
    if (!isPidAlive(raw.pid)) return true;
    return fileAgeMs > LOCK_LIVE_STALE_MS;
  }
  return fileAgeMs > STALE_LOCK_MS;
}

/**
 * 备份写锁。拿不到返回 null（另一个进程正在写）；stale 锁会先挪走再重试。
 * 返回的释放函数带 assertOwned()：锁被接管后，旧写者用它中止本轮，避免双写。
 * @returns {Promise<null | (() => Promise<void>) & { assertOwned: () => Promise<void> }>}
 */
export async function acquireBackupLock(root, options = {}) {
  const dir = path.resolve(root);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, BACKUP_LOCK);
  const token = randomUUID();
  const waitMs = Math.max(0, Number(options.waitMs ?? 0));
  const deadline = Date.now() + waitMs;
  for (;;) {
    let handle = null;
    try {
      handle = await open(file, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let raw = null;
      let age = 0;
      try {
        raw = JSON.parse(await readFile(file, 'utf8'));
      } catch {
        raw = null;
      }
      // 另一个进程刚创建锁、还没写完 JSON 时 age 很小，不能用「读不出」当 stale。
      try {
        age = Date.now() - (await stat(file)).mtimeMs;
      } catch {
        age = 0;
      }
      if (lockIsStale(raw, age)) {
        const aside = `${file}.stale-${stamp()}`;
        try {
          await rename(file, aside);
          await unlink(aside).catch(() => {});
        } catch {
          // 别人先清理了，继续抢
        }
        continue;
      }
      if (Date.now() >= deadline) return null;
      await delay(120);
      continue;
    }
    try {
      await handle.writeFile(
        `${JSON.stringify(
          {
            version: 1,
            token,
            pid: process.pid,
            host: hostname(),
            startedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    } catch (error) {
      try {
        await handle.close();
      } catch {
        // 下面照样清锁
      }
      await unlink(file).catch(() => {});
      throw error;
    }
    try {
      await handle.close();
    } catch {
      // 句柄关不掉不影响后续读写；释放时还会删锁
    }
    // 心跳让「活进程持锁」在 pid 被复用时也能被区分：心跳停了才算死锁。
    const heartbeat = setInterval(() => {
      void utimes(file, new Date(), new Date()).catch(() => {});
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
    const readToken = async () => {
      try {
        const raw = JSON.parse(await readFile(file, 'utf8'));
        return raw?.token;
      } catch {
        return undefined;
      }
    };
    const assertOwned = async () => {
      const current = await readToken();
      if (current !== token) {
        throw new Error('备份锁已失效（另一个进程接管了写锁），停止本轮写入');
      }
    };
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      if ((await readToken()) !== token) return;
      await unlink(file).catch(() => {});
    };
    release.assertOwned = assertOwned;
    return release;
  }
}

function resolveSnapshotDir(root, requested) {
  const base = path.resolve(root);
  if (typeof requested !== 'string' || requested.trim() === '') {
    return null;
  }
  const abs = path.resolve(base, requested);
  const parent = path.dirname(abs);
  const same =
    process.platform === 'win32'
      ? parent.toLowerCase() === base.toLowerCase()
      : parent === base;
  if (!same || !isSafeSnapshotName(path.basename(abs))) {
    throw new Error(`快照必须是 ${base} 下的一层目录名：${requested}`);
  }
  return abs;
}

async function listSnapshotNames(root) {
  const names = [];
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && isSafeSnapshotName(entry.name)) names.push(entry.name);
    }
  } catch {
    // 根还没建
  }
  return names.sort();
}

/** 只读状态：当前快照、文件数、字节数、快照列表。 */
export async function readMemoryBackupStatus(options = {}) {
  const root = path.resolve(options.root);
  const snapshots = await listSnapshotNames(root);
  const pointer = await readBackupPointer(root);
  if (pointer === null) {
    return { root, ok: false, error: '还没有备份快照', snapshots, pointer: null };
  }
  const folder = snapshotFolder(root, pointer.folder);
  if (folder === null || !(await isDirectory(folder))) {
    return { root, ok: false, error: '快照指针指向的目录不存在', snapshots, pointer };
  }
  const manifest = await readMemoryManifest(folder);
  if (manifest === null) {
    return { root, ok: false, error: '快照缺 manifest.json（可能还没首次同步）', snapshots, pointer, folder };
  }
  const records = manifest.files;
  const missing = records.filter((row) => typeof row.missingAt === 'string' && row.missingAt !== '').length;
  return {
    root,
    ok: true,
    folder,
    folderName: path.basename(folder),
    createdAt: manifest.createdAt ?? '',
    updatedAt: manifest.updatedAt ?? '',
    lastReason: manifest.lastReason ?? '',
    files: records.length,
    bytes: records.reduce((sum, row) => sum + Number(row.size ?? 0), 0),
    missing,
    sessions: areaStats(records, AREA_SESSIONS),
    aiLove: areaStats(records, AREA_MEMORY),
    errors: Array.isArray(manifest.errors) ? manifest.errors : [],
    snapshots,
    pointer,
  };
}

/**
 * 校验备份完整性：逐个重算备份文件的 sha256，与 manifest 比对。
 * 源文件后来长了/被删只作为「落后/源已消失」报告，不算备份损坏。
 */
export async function verifyMemoryBackup(options = {}) {
  const root = path.resolve(options.root);
  if (!(await isDirectory(root))) throw new Error(`找不到备份根：${root}`);
  const waitMs = Number.isFinite(Number(options.waitMs)) ? Math.max(0, Number(options.waitMs)) : 20_000;
  let release = null;
  let busy = false;
  let lockWarning = '';
  try {
    release = await acquireBackupLock(root, { waitMs });
    if (release === null) busy = true;
  } catch (error) {
    // 只读校验：加不上锁就照常读，但明确告诉调用方这次没有互斥保护。
    lockWarning = `无法获取备份锁（${messageOf(error)}），本次为无锁只读校验`;
  }
  if (busy) {
    return {
      ok: false,
      busy: true,
      folder: null,
      checked: 0,
      bytes: 0,
      mismatches: [],
      lagging: [],
      absentFromSource: [],
      files: 0,
      error: '另一个备份进程正在写入，请稍后再校验',
    };
  }
  try {
    const result = await verifySnapshot(root, options);
    if (lockWarning !== '') result.lockWarning = lockWarning;
    return result;
  } finally {
    if (release !== null) await release();
  }
}

async function verifySnapshot(root, options) {
  const pointer = await readBackupPointer(root);
  const requested = resolveSnapshotDir(root, options.snapshot);
  const folder = requested ?? (pointer === null ? null : snapshotFolder(root, pointer.folder));
  if (folder === null || !(await isDirectory(folder))) {
    throw new Error(`找不到要校验的快照：${options.snapshot ?? root}`);
  }
  const manifest = await readMemoryManifest(folder);
  if (manifest === null) throw new Error(`快照缺 manifest.json：${folder}`);
  const sources = {
    [AREA_SESSIONS]:
      typeof options.sessionsRoot === 'string' && options.sessionsRoot.trim() !== ''
        ? path.resolve(options.sessionsRoot)
        : typeof manifest.source?.sessionsRoot === 'string'
          ? manifest.source.sessionsRoot
          : '',
    [AREA_MEMORY]:
      typeof options.memoryDir === 'string' && options.memoryDir.trim() !== ''
        ? path.resolve(options.memoryDir)
        : typeof manifest.source?.memoryDir === 'string'
          ? manifest.source.memoryDir
          : '',
  };
  const mismatches = [];
  const lagging = [];
  const absentFromSource = [];
  let checked = 0;
  let bytes = 0;
  for (const row of manifest.files) {
    const rel = String(row.path ?? '');
    const area = String(row.area ?? '');
    const segments = rel.split('/');
    if (
      !AREAS.includes(area) ||
      rel === '' ||
      rel.includes('\\') ||
      path.isAbsolute(rel) ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      mismatches.push({ area, path: rel, reason: 'manifest 条目非法' });
      continue;
    }
    const dest = path.join(folder, area, ...rel.split('/'));
    let info;
    try {
      info = await stat(dest);
    } catch {
      mismatches.push({ area, path: rel, reason: '备份文件不存在' });
      continue;
    }
    if (!info.isFile()) {
      mismatches.push({ area, path: rel, reason: '不是普通文件' });
      continue;
    }
    if (info.size !== Number(row.size ?? -1)) {
      mismatches.push({ area, path: rel, reason: `大小不一致（备份 ${info.size}，清单 ${row.size}）` });
      continue;
    }
    const digest = await sha256File(dest);
    if (digest !== row.sha256) {
      mismatches.push({ area, path: rel, reason: 'sha256 不一致' });
      continue;
    }
    checked += 1;
    bytes += info.size;
    const base = sources[area];
    if (base === '') continue;
    const source = path.join(base, ...rel.split('/'));
    let sourceInfo = null;
    try {
      sourceInfo = await stat(source);
    } catch {
      sourceInfo = null;
    }
    if (sourceInfo === null) {
      if (typeof row.missingAt !== 'string' || row.missingAt === '') {
        absentFromSource.push({ area, path: rel });
      }
      continue;
    }
    if (sourceInfo.size !== info.size || sourceInfo.mtimeMs !== Number(row.mtimeMs ?? -1)) {
      lagging.push({
        area,
        path: rel,
        backupBytes: info.size,
        sourceBytes: sourceInfo.size,
      });
    }
  }
  return {
    ok: mismatches.length === 0,
    folder,
    checked,
    bytes,
    mismatches,
    lagging,
    absentFromSource,
    files: manifest.files.length,
    updatedAt: manifest.updatedAt ?? '',
  };
}

/**
 * 实时备份器：首次同步建快照并全量复制，之后 watch + 轮询增量镜像。
 */
export class MemoryBackup {
  constructor(options = {}) {
    if (typeof options.root !== 'string' || options.root.trim() === '') {
      throw new Error('MemoryBackup 需要 root');
    }
    this.root = path.resolve(options.root);
    this.sessionsRoot =
      typeof options.sessionsRoot === 'string' && options.sessionsRoot.trim() !== ''
        ? path.resolve(options.sessionsRoot)
        : path.join(resolveDshHome(options), 'sessions');
    this.memoryDir = resolveMemoryBackupMemoryDir(options);
    this.pollMs = Number.isFinite(Number(options.pollMs)) && Number(options.pollMs) > 0
      ? Number(options.pollMs)
      : DEFAULT_POLL_MS;
    this.debounceMs = Number.isFinite(Number(options.debounceMs)) && Number(options.debounceMs) >= 0
      ? Number(options.debounceMs)
      : DEFAULT_DEBOUNCE_MS;
    this.maxDelayMs = Number.isFinite(Number(options.maxDelayMs)) && Number(options.maxDelayMs) > 0
      ? Number(options.maxDelayMs)
      : DEFAULT_MAX_DELAY_MS;
    this.watchEnabled = options.watch !== false;
    this.logger = options.logger ?? { info: () => {}, warn: () => {} };

    this.folder = '';
    this.pointer = null;
    this.started = false;
    this.stopped = false;
    this.starting = null;
    this.busy = null;
    this.queued = false;
    this.lastSyncAt = 0;
    this.lastError = '';
    this.noted = new Map();
    this.lastCleanAt = 0;

    this.watchers = [];
    this.dirWatchers = new Map();
    this.groupWatchers = new Map();
    this.watchersStarted = false;
    this.watchRetryAt = 0;
    this.watchFailures = 0;
    this.pollTimer = null;
    this.debounceTimer = null;
    this.firstPendingAt = 0;
    this.pendingReason = '';
  }

  async start() {
    if (this.started) return this.pointer;
    if (this.starting !== null) return this.starting;
    this.stopped = false;
    this.starting = (async () => {
      // watcher 不依赖备份根：根所在盘暂时没挂上、ACL 暂时拒绝时也先监听，
      // 失败交给轮询重试，别让本会话从此静默停摆。
      this._startWatchers();
      try {
        await this._assertDisjoint();
        await mkdir(this.root, { recursive: true });
        if (this.stopped) return this.pointer;
        await this.syncOnce({ reason: 'start' });
      } catch (error) {
        this.lastError = messageOf(error);
        this._note('start', `记忆备份启动失败：${this.lastError}；已转入轮询重试`);
        this._schedule('start-retry');
      }
      this.started = true;
      return this.pointer;
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  _note(key, message) {
    if (key === '') {
      this.noted.clear();
      return;
    }
    const now = Date.now();
    const last = this.noted.get(key) ?? 0;
    if (now - last < 10 * 60_000) return;
    this.noted.set(key, now);
    this.logger.warn(`[ai-love] ${message}`);
  }

  /**
   * 备份根不能落在会话/档案目录或任一 QQ 会话组的目标目录里（反之亦然），
   * 否则会把自己的输出再备一遍。会话组本身是 junction，必须按真实目标比较。
   */
  async _assertDisjoint() {
    const backup = await realpathLoose(this.root);
    const targets = [
      ['QQ 会话根', this.sessionsRoot],
      ['爱ai 档案目录', this.memoryDir],
    ];
    try {
      for (const entry of await readdir(this.sessionsRoot, { withFileTypes: true })) {
        if (!isQqSessionGroup(entry.name) || !isSafeGroupName(entry.name)) continue;
        targets.push([`QQ 会话组 ${entry.name}`, path.join(this.sessionsRoot, entry.name)]);
      }
    } catch {
      // 会话根还没建
    }
    for (const [label, source] of targets) {
      const target = await realpathLoose(source);
      if (samePathLoose(target, backup) || isInsidePath(target, backup) || isInsidePath(backup, target)) {
        throw new Error(`备份根与${label}重叠（${backup} ↔ ${target}），拒绝复制以免自我嵌套`);
      }
    }
  }

  async stop() {
    this.stopped = true;
    this._closeWatchers();
    // 首次同步可能还在创建快照；等它收尾再关一次 watcher。
    if (this.starting !== null) await this.starting.catch(() => {});
    if (this.busy !== null) await this.busy.catch(() => {});
    this._closeWatchers();
    this.started = false;
  }

  _closeWatchers() {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // 已关闭
      }
    }
    this.watchers = [];
    this.dirWatchers.clear();
    for (const watcher of this.groupWatchers.values()) {
      try {
        watcher.close();
      } catch {
        // 已关闭
      }
    }
    this.groupWatchers.clear();
    this.firstPendingAt = 0;
    this.pendingReason = '';
    this.watchersStarted = false;
  }

  /**
   * 选当前快照：优先 .current.json；指针丢了就接管最近一个有清单的快照
   * （崩溃恢复），都没有才新建。新建时先不写指针，等清单写成功再落。
   */
  /** 快照的源必须和当前实例一致，避免把 --dsh-home 覆盖出的快照并进真实根。 */
  _sourceMatches(manifest) {
    const source = manifest?.source;
    if (source === undefined || source === null) return true;
    if (
      typeof source.sessionsRoot === 'string' &&
      source.sessionsRoot !== '' &&
      !samePathLoose(source.sessionsRoot, this.sessionsRoot)
    ) {
      return false;
    }
    if (
      typeof source.memoryDir === 'string' &&
      source.memoryDir !== '' &&
      !samePathLoose(source.memoryDir, this.memoryDir)
    ) {
      return false;
    }
    return true;
  }

  _foreignSourceError(manifest) {
    const source = manifest?.source ?? {};
    return new Error(
      `备份根里已有另一个源的快照（${source.sessionsRoot ?? '?'} / ${source.memoryDir ?? '?'}），` +
        '拒绝改写 .current.json；请用 --backup-root 指定独立目录',
    );
  }

  /**
   * 当前指针指向的快照如果来自另一套源（例如沙盒 DSH_HOME），拒绝改写指针。
   * 指针缺失/清单损坏时也扫一遍既有快照，避免把自己的快照建进别人的根。
   */
  async _assertPointerSource() {
    const pointer = await readBackupPointer(this.root);
    if (pointer !== null) {
      const folder = snapshotFolder(this.root, pointer.folder);
      if (folder !== null) {
        const manifest = await readMemoryManifest(folder);
        if (manifest !== null) {
          if (!this._sourceMatches(manifest)) throw this._foreignSourceError(manifest);
          return;
        }
      }
    }
    for (const name of await listSnapshotNames(this.root)) {
      const folder = snapshotFolder(this.root, name);
      if (folder === null) continue;
      const manifest = await readMemoryManifest(folder);
      if (manifest !== null && !this._sourceMatches(manifest)) {
        throw this._foreignSourceError(manifest);
      }
    }
  }

  async _ensureFolder({ forceNew }) {
    if (!forceNew) {
      const pointer = await readBackupPointer(this.root);
      let pointerFolder = null;
      let pointerAt = 0;
      if (pointer !== null) {
        const folder = snapshotFolder(this.root, pointer.folder);
        if (folder !== null && (await isDirectory(folder))) {
          const manifest = await readMemoryManifest(folder);
          if (manifest === null || this._sourceMatches(manifest)) {
            pointerFolder = folder;
            pointerAt = Date.parse(manifest?.createdAt ?? pointer.createdAt ?? '') || 0;
          }
        }
      }
      // 指针落后时接管更新的、源相同的快照（CLI --new 在写指针前崩溃也能接上）。
      let newest = null;
      let newestAt = -1;
      for (const name of await listSnapshotNames(this.root)) {
        const folder = snapshotFolder(this.root, name);
        if (folder === null || folder === pointerFolder) continue;
        const manifest = await readMemoryManifest(folder);
        if (manifest === null || !this._sourceMatches(manifest)) continue;
        const at = Date.parse(manifest.createdAt ?? '') || 0;
        if (at >= newestAt) {
          newest = folder;
          newestAt = at;
        }
      }
      if (newest !== null && newestAt > pointerAt) {
        this.folder = newest;
        this.pointer = null;
        return newest;
      }
      if (pointerFolder !== null) {
        this.folder = pointerFolder;
        this.pointer = pointer;
        return pointerFolder;
      }
    }
    const created = await createSnapshotFolder(this.root);
    this.folder = created.full;
    this.pointer = null;
    return created.full;
  }

  /** watch 建不起来时按 5s/10s/20s/40s/60s 退避重试，期间靠轮询，避免每次事件都失败刷日志。 */
  _deferWatchRetry(reason) {
    this.watchFailures += 1;
    const wait = Math.min(60_000, 5_000 * 2 ** Math.min(this.watchFailures - 1, 4));
    this.watchRetryAt = Date.now() + wait;
    this._note(
      'watch-retry',
      `记忆备份：watch 暂不可用（${reason}），${Math.round(wait / 1000)} 秒后重试，期间用轮询`,
    );
  }

  _startWatchers() {
    if (!this.watchEnabled || this.stopped) return;
    const sessionsOk = this._watchDir(this.sessionsRoot, AREA_SESSIONS);
    const memoryOk = this._watchDir(this.memoryDir, AREA_MEMORY);
    this.watchersStarted = sessionsOk && memoryOk;
    if (this.watchersStarted) {
      this.watchFailures = 0;
      this.watchRetryAt = 0;
    } else {
      this._deferWatchRetry(this.lastError || '源目录暂不可用');
    }
    if (this.pollTimer === null) {
      this.pollTimer = setInterval(() => this._schedule('poll'), this.pollMs);
      this.pollTimer.unref?.();
    }
  }

  /**
   * 为某个源目录建 watcher；已经建过就直接算成功。
   * 目录暂时不存在（DSH 首次启动还没写 sessions）时不留下永久缺口：
   * 失败返回 false，轮询下一轮会再试。
   */
  _watchDir(dir, area) {
    if (!this.watchEnabled || this.stopped) return false;
    if (this.dirWatchers.has(area)) return true;
    try {
      const watcher = watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
        const rel = filename === null || filename === undefined ? '' : String(filename);
        if (area === AREA_SESSIONS) {
          const top = rel.split(/[\\/]/)[0];
          if (top !== '' && !isQqSessionGroup(top)) return;
        }
        if (rel !== '' && ignoredName(path.basename(rel))) return;
        this._schedule('watch');
      });
      watcher.on('error', (error) => {
        if (this.dirWatchers.get(area) !== watcher) return;
        this.lastError = `watch ${dir}: ${messageOf(error)}`;
        try {
          watcher.close();
        } catch {
          // 已关闭
        }
        this.dirWatchers.delete(area);
        const index = this.watchers.indexOf(watcher);
        if (index >= 0) this.watchers.splice(index, 1);
        this.watchersStarted = false;
        this._deferWatchRetry(this.lastError);
        this._schedule('watch-error');
      });
      this.watchers.push(watcher);
      this.dirWatchers.set(area, watcher);
      return true;
    } catch (error) {
      this.lastError = `watch ${dir}: ${messageOf(error)}`;
      return false;
    }
  }

  _syncGroupWatchers(groups) {
    if (!this.watchEnabled) return;
    const wanted = new Set(groups);
    for (const [name, watcher] of this.groupWatchers) {
      if (wanted.has(name)) continue;
      try {
        watcher.close();
      } catch {
        // 已关闭
      }
      this.groupWatchers.delete(name);
    }
    for (const name of wanted) {
      if (this.groupWatchers.has(name)) continue;
      try {
        const watcher = watch(path.join(this.sessionsRoot, name), { recursive: true, persistent: false }, () => {
          this._schedule('watch-group');
        });
        watcher.on('error', () => {
          try {
            watcher.close();
          } catch {
            // 已关闭
          }
          this.groupWatchers.delete(name);
        });
        this.groupWatchers.set(name, watcher);
      } catch {
        // 该组暂时 watch 不了，轮询会兜住
      }
    }
  }

  _schedule(reason) {
    if (this.stopped) return;
    if (
      this.watchEnabled &&
      !this.watchersStarted &&
      Date.now() >= this.watchRetryAt
    ) {
      this._startWatchers();
    }
    const now = Date.now();
    if (this.firstPendingAt === 0) {
      this.firstPendingAt = now;
      this.pendingReason = reason;
    }
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    const wait = Math.max(0, Math.min(this.debounceMs, this.firstPendingAt + this.maxDelayMs - now));
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.firstPendingAt = 0;
      const why = this.pendingReason || reason;
      this.pendingReason = '';
      void this.syncOnce({ reason: why }).catch((error) => {
        this.lastError = messageOf(error);
        this._note('sync-fail', `记忆备份同步失败：${this.lastError}`);
      });
    }, wait);
    this.debounceTimer.unref?.();
  }

  async syncOnce(options = {}) {
    if (this.busy !== null) {
      this.queued = true;
      return this.busy;
    }
    const task = this._sync(options).finally(() => {
      this.busy = null;
      if (this.queued && !this.stopped) {
        this.queued = false;
        void this.syncOnce({ reason: 'queued' }).catch((error) => {
          this.lastError = messageOf(error);
          this._note('sync-fail', `记忆备份同步失败：${this.lastError}`);
        });
      }
    });
    this.busy = task;
    return task;
  }

  async _sync(options = {}) {
    const reason = typeof options.reason === 'string' ? options.reason : 'manual';
    const full = options.full === true;
    const forceNew = options.newSnapshot === true;
    await this._assertDisjoint();
    await mkdir(this.root, { recursive: true });
    const release = await acquireBackupLock(this.root, { waitMs: 5000 });
    if (release === null) {
      const error = '另一个备份进程正在写入，本次跳过';
      this.lastError = error;
      this._note('busy', error);
      this._schedule('busy-retry');
      return { ok: false, busy: true, folder: this.folder, reason, error, at: new Date().toISOString() };
    }
    try {
      await this._assertPointerSource();
      await this._ensureFolder({ forceNew });
      await mkdir(this.folder, { recursive: true });
      const manifest = (await readMemoryManifest(this.folder)) ?? emptyManifest({}, this.folder);
      const prev = new Map();
      for (const row of manifest.files) {
        if (AREAS.includes(row.area) && typeof row.path === 'string') prev.set(keyOf(row.area, row.path), row);
      }

      const sessionRows = await listSessionMemoryFiles(this.sessionsRoot);
      const archiveRows = await listMemoryArchiveFiles(this.memoryDir);
      this._syncGroupWatchers(sessionRows.groups);

      const errors = [...sessionRows.warnings, ...archiveRows.warnings];
      const sources = [
        ...sessionRows.files.map((row) => ({ ...row, area: AREA_SESSIONS })),
        ...archiveRows.files.map((row) => ({ ...row, area: AREA_MEMORY })),
      ];

      const nowIso = new Date().toISOString();
      const records = [];
      const seen = new Set();
      let copied = 0;
      let skipped = 0;
      let failed = (sessionRows.unreadable ?? 0) + (archiveRows.unreadable ?? 0);
      let archived = 0;
      let unstable = 0;

      for (const row of sources) {
        const key = keyOf(row.area, row.rel);
        seen.add(key);
        const old = prev.get(key);
        const dest = path.join(this.folder, row.area, ...row.rel.split('/'));
        let destInfo = null;
        try {
          destInfo = await stat(dest);
        } catch {
          destInfo = null;
        }
        // 镜像被外部改过（mtime 晚于我们写入的时间）就不跳过，重拷一次自愈。
        const copiedAtMs = old !== undefined ? Date.parse(old.copiedAt ?? '') : NaN;
        const destTampered =
          Number.isFinite(copiedAtMs) &&
          destInfo !== null &&
          destInfo.mtimeMs > copiedAtMs + 5000;
        const canSkip =
          !full &&
          old !== undefined &&
          old.exact !== false &&
          !destTampered &&
          Number(old.size) === row.size &&
          Number(old.mtimeMs) === row.mtimeMs &&
          typeof old.sha256 === 'string' &&
          old.sha256 !== '' &&
          destInfo !== null &&
          destInfo.isFile() &&
          destInfo.size === row.size;
        if (canSkip) {
          records.push(typeof old.missingAt === 'string' ? { ...old, missingAt: undefined } : old);
          skipped += 1;
          continue;
        }
        try {
          const historyDir = path.join(
            this.folder,
            HISTORY_DIR,
            row.area,
            ...row.rel.split('/').slice(0, -1),
          );
          const result = await copyByteExact(row.abs, dest, {
            historyDir,
            assertOwned: release.assertOwned,
          });
          records.push({
            area: row.area,
            path: row.rel,
            size: result.size,
            mtimeMs: result.sourceMtimeMs,
            sha256: result.sha256,
            copiedAt: new Date().toISOString(),
            exact: result.exact,
          });
          if (result.archived !== null) archived += 1;
          if (result.exact === false) unstable += 1;
          if (result.skipped === true) skipped += 1;
          else copied += 1;
        } catch (error) {
          failed += 1;
          errors.push(`${row.area}/${row.rel}: ${messageOf(error)}`);
          if (old !== undefined) records.push(old);
        }
      }

      let kept = 0;
      for (const [key, old] of prev) {
        if (seen.has(key)) continue;
        // 扫描出错时不敢判定源文件真的没了，原样保留条目。
        if (errors.length > 0) {
          records.push(old);
          continue;
        }
        records.push({ ...old, missingAt: typeof old.missingAt === 'string' && old.missingAt !== '' ? old.missingAt : nowIso });
        kept += 1;
      }

      records.sort((left, right) =>
        left.area === right.area ? left.path.localeCompare(right.path) : left.area.localeCompare(right.area),
      );

      const bytes = records.reduce((sum, row) => sum + Number(row.size ?? 0), 0);
      const nextManifest = {
        version: MEMORY_BACKUP_VERSION,
        createdAt: manifest.createdAt ?? nowIso,
        updatedAt: nowIso,
        folder: this.folder,
        source: { sessionsRoot: this.sessionsRoot, memoryDir: this.memoryDir },
        lastReason: reason,
        lastSyncAt: nowIso,
        files: records,
        errors,
      };
      await release.assertOwned();
      await writeFileAtomic(
        path.join(this.folder, BACKUP_MANIFEST),
        `${JSON.stringify(nextManifest, null, 2)}\n`,
      );

      this.pointer = {
        version: MEMORY_BACKUP_VERSION,
        folder: path.basename(this.folder),
        createdAt: nextManifest.createdAt,
        updatedAt: nowIso,
        files: records.length,
        bytes,
      };
      await release.assertOwned();
      await writeBackupPointer(this.root, this.pointer);

      let cleaned = 0;
      if (Date.now() - this.lastCleanAt > 60 * 60_000) {
        this.lastCleanAt = Date.now();
        const manifestPaths = new Set(records.map((row) => `${row.area}/${row.path}`));
        cleaned = await cleanLeftovers(this.folder, this.folder, manifestPaths).catch(() => 0);
      }

      this.lastSyncAt = Date.now();
      this.lastError = errors.length > 0 ? errors[0] : '';
      if (errors.length > 0) {
        this._note('sync-errors', `记忆备份：${errors.length} 个文件本轮未完成（${errors[0]}），会自动重试`);
      } else {
        this.noted.clear();
      }

      return {
        ok: failed === 0,
        busy: false,
        folder: this.folder,
        folderName: path.basename(this.folder),
        reason,
        copied,
        skipped,
        kept,
        failed,
        archived,
        unstable,
        cleaned,
        files: records.length,
        bytes,
        sessions: areaStats(records, AREA_SESSIONS),
        aiLove: areaStats(records, AREA_MEMORY),
        errors,
        at: nowIso,
      };
    } finally {
      await release();
    }
  }
}

const shared = new Map();

/**
 * 同一进程里多个 QQ 会话各有一个后端实例时，共用一套 watch/轮询，
 * 避免 N 份备份器同时扫盘。
 */
export function sharedMemoryBackup(options = {}) {
  const root = path.resolve(options.root);
  const key = [root, path.resolve(options.sessionsRoot ?? ''), path.resolve(options.memoryDir ?? '')]
    .join('\u0000')
    .toLowerCase();
  let entry = shared.get(key);
  if (entry === undefined) {
    entry = { backup: new MemoryBackup(options), refs: 0 };
    shared.set(key, entry);
  }
  entry.refs += 1;
  return {
    backup: entry.backup,
    release: () => {
      entry.refs -= 1;
      if (entry.refs > 0) return;
      shared.delete(key);
      void entry.backup.stop();
    },
  };
}
