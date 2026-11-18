/**
 * ai-love · QQ 上下文落盘联通
 *
 * 把 DSH 里 qq-bridge 产生的会话日志目录，用 Windows 目录联接（junction）
 * 接到非系统盘的 <备份目录>/sessions/ 下：
 *
 *   ~/.dsh/sessions/<qq-bridge 会话组>/   ← junction →   D:\爱ai\sessions\<同名>/
 *
 * 硬规矩：
 *   - 只在 DSH 完全退出后搬迁；检测失败按“仍在运行”处理，绝不碰正在写的日志。
 *   - 先完整复制并逐文件 sha256 校验，换入 junction 前后都再校验一次；
 *     校验的是 C: 上的原目录（改名后的备份）与 D: 副本，任何一步失败都回滚。
 *   - 复制/校验全程流式读写，不设单文件或总量上限；DSH 的本地会话日志本身没有字节上限。
 *   - 只处理名字里带 qq-bridge 的会话组；别的会话目录一律不碰。
 *   - apply / unlink 全程持有一把跨进程锁，防止两个进程互相删对方的备份。
 *   - 卸载时先完整复制回 C: 并校验，再删 D: 副本；只有确认目标在 linkRoot 内
 *     且确实是爱ai 建的那一个，才会删除；junction 只用 rmdir 摘除，绝不递归。
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream, existsSync } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { detectBackupDir } from './backup.mjs';

export const LINK_MANIFEST = '.ai-love-links.json';
export const LINK_LOCK = '.ai-love-link.lock';
export const LINK_STATE_VERSION = 1;
export const LINK_GROUP_PATTERN = /qq-bridge/i;
export const BACKUP_PREFIX = '.ai-love-old-';
export const RESTORE_PREFIX = '.ai-love-restore-';
const STAMP = /-([0-9a-z]{1,13})-([0-9a-z]{1,13})$/;

/** @param {Record<string, unknown>} [options] */
export function resolveDshHome(options = {}) {
  const given = typeof options.dshHome === 'string' ? options.dshHome.trim() : '';
  if (given !== '') return path.resolve(given);
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return path.resolve(env.trim());
  return path.join(homedir(), '.dsh');
}

/** DSH 的会话根。 */
export function resolveSessionsRoot(options = {}) {
  const given = typeof options.sessionsRoot === 'string' ? options.sessionsRoot.trim() : '';
  if (given !== '') return path.resolve(given);
  return path.join(resolveDshHome(options), 'sessions');
}

/**
 * 联接目标根：默认跟着备份目录走（<非系统盘>:\爱ai\sessions）。
 * 显式 contextLinkDir 优先；显式 backupDir 会让它落在该备份目录下。
 */
export function resolveLinkRoot(config = {}) {
  const explicit = typeof config?.contextLinkDir === 'string' ? config.contextLinkDir.trim() : '';
  if (explicit !== '') return path.resolve(explicit);
  const backupDir = detectBackupDir(typeof config?.backupDir === 'string' ? config.backupDir : '');
  return path.join(backupDir, 'sessions');
}

function resolveRoots(options = {}) {
  const sessionsRoot = resolveSessionsRoot(options);
  const linkRoot =
    typeof options.linkRoot === 'string' && options.linkRoot.trim() !== ''
      ? path.resolve(options.linkRoot)
      : resolveLinkRoot(options.config ?? {});
  return { sessionsRoot, linkRoot };
}

/** 只认名字像 qq-bridge 会话组的目录。 */
export function isQqSessionGroup(name) {
  return LINK_GROUP_PATTERN.test(String(name ?? ''));
}

/** 组名必须是单层目录名，挡住 manifest/CLI 里的 `..\`、盘符与分隔符。 */
export function isSafeGroupName(name) {
  const text = String(name ?? '');
  if (text === '' || text === '.' || text === '..') return false;
  if (text.includes('/') || text.includes('\\') || text.includes(':')) return false;
  return path.basename(text) === text;
}

export function normalizePath(value) {
  let text = String(value ?? '').trim();
  if (text.startsWith('\\\\?\\')) text = text.slice(4);
  else if (text.startsWith('\\??\\')) text = text.slice(4);
  return path.resolve(text);
}

export function samePath(a, b) {
  const left = normalizePath(a);
  const right = normalizePath(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isInside(parent, child) {
  const rel = path.relative(normalizePath(parent), normalizePath(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function volumeOf(target) {
  const root = path.parse(path.resolve(target)).root;
  return root.replace(/[\\/]+$/, '').toUpperCase();
}

/** 目标是否在系统盘（Windows 的 C:）。非 Windows 返回 false。 */
export function isSystemVolume(target) {
  return process.platform === 'win32' && volumeOf(target) === 'C:';
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** junction 的目标；不是联接返回 null。Node 在 Windows 上把 junction 当符号链接。 */
export async function junctionTarget(target) {
  try {
    const info = await lstat(target);
    if (!info.isSymbolicLink()) return null;
    return normalizePath(await readlink(target));
  } catch {
    return null;
  }
}

async function createJunction(link, target) {
  if (process.platform !== 'win32') throw new Error('目录联接只支持 Windows');
  try {
    await symlink(normalizePath(target), normalizePath(link), 'junction');
  } catch (error) {
    throw new Error(
      `创建目录联接失败：${error instanceof Error ? error.message : String(error)}（${link} → ${target}）`,
    );
  }
}

/** 只摘联接本身；先确认它是联接，绝不对真实目录做 rmdir/rm。 */
async function removeJunction(link) {
  const info = await lstat(link);
  if (!info.isSymbolicLink()) throw new Error(`不是目录联接，拒绝删除：${link}`);
  if (process.platform === 'win32') {
    await rmdir(link);
    return;
  }
  await rm(link, { force: true });
}

/** 目录树内的所有条目（目录本身也回调，dir=true）。 */
async function walkTree(root, onEntry) {
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    const dir = rel === '' ? root : path.join(root, rel);
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : path.join(rel, entry.name);
      const full = path.join(root, childRel);
      if (entry.isDirectory()) {
        await onEntry({ rel: childRel, full, dir: true, link: false });
        stack.push(childRel);
      } else if (entry.isSymbolicLink()) {
        await onEntry({ rel: childRel, full, dir: false, link: true });
      } else if (entry.isFile()) {
        await onEntry({ rel: childRel, full, dir: false, link: false });
      } else {
        throw new Error(`不支持的文件类型：${full}`);
      }
    }
  }
}

async function treeSummary(root) {
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  await walkTree(root, async (entry) => {
    if (entry.dir) {
      dirs += 1;
      return;
    }
    files += 1;
    if (!entry.link) {
      const info = await stat(entry.full);
      bytes += info.size;
    }
  });
  return { files, dirs, bytes };
}

async function hashFile(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

/**
 * 解析真实路径；目标尚不存在时，沿父目录上溯到存在的那一层再拼回来。
 * 用于在复制前识别 junction 别名造成的“目标套在源里”的递归。
 */
async function realpathLoose(target) {
  let current = path.resolve(target);
  const suffix = [];
  for (;;) {
    try {
      const base = await realpath(current);
      return normalizePath(path.join(base, ...suffix));
    } catch (error) {
      // 只有“确实不存在”才能继续上溯；权限/循环联接等异常一律停手，
      // 否则会拿着未解析的路径去判断嵌套关系，可能漏判。
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        throw new Error(`无法解析真实路径（${error?.code ?? '未知'}）：${current}`);
      }
      const parent = path.dirname(current);
      if (parent === current) return normalizePath(target);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** 源和目标（按真实路径）互为祖先时拒绝复制，否则会把目标自己拷进自己。 */
async function assertDisjointTrees(source, target) {
  const [left, right] = await Promise.all([realpathLoose(source), realpathLoose(target)]);
  if (samePath(left, right) || isInside(left, right) || isInside(right, left)) {
    throw new Error(`源和目标互相嵌套，拒绝自动搬迁：${source} ↔ ${target}`);
  }
}

/** 流式复制整棵树，不设大小上限。 */
async function copyTree(source, target) {
  await assertDisjointTrees(source, target);
  await mkdir(target, { recursive: true });
  await walkTree(source, async (entry) => {
    if (entry.link) throw new Error(`会话目录里有符号链接，拒绝自动搬迁：${entry.rel}`);
    const dest = path.join(target, entry.rel);
    if (entry.dir) {
      await mkdir(dest, { recursive: true });
      return;
    }
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(entry.full, dest);
    try {
      const info = await stat(entry.full);
      await utimes(dest, info.atime, info.mtime);
    } catch {
      // 时间戳保留失败不影响内容
    }
  });
}

function keyOf(rel, isDir) {
  const value = rel.split(path.sep).join('/');
  return isDir ? `${value}/` : value;
}

async function buildTree(root, withHash) {
  const rows = new Map();
  let bytes = 0;
  await walkTree(root, async (entry) => {
    if (entry.link) throw new Error(`目录里出现符号链接，拒绝校验：${entry.rel}`);
    const key = keyOf(entry.rel, entry.dir);
    if (entry.dir) {
      rows.set(key, { dir: true, size: 0, hash: '' });
      return;
    }
    const info = await stat(entry.full);
    const digest = withHash ? await hashFile(entry.full) : '';
    bytes += info.size;
    rows.set(key, { dir: false, size: info.size, hash: digest });
  });
  return {
    rows,
    bytes,
    files: [...rows.values()].filter((row) => row.dir !== true).length,
  };
}

/**
 * 比对两棵树：路径集合、文件大小，withHash 时再加 sha256。
 * 返回的 mismatches 最多 20 条，避免报告爆炸。
 */
export async function verifyTrees(source, target, options = {}) {
  const withHash = options.hash !== false;
  const [leftReal, rightReal] = await Promise.all([
    realpath(source).catch(() => normalizePath(source)),
    realpath(target).catch(() => normalizePath(target)),
  ]);
  if (samePath(leftReal, rightReal)) {
    throw new Error(`校验源和目标指向同一目录，拒绝自比：${source}`);
  }
  const [left, right] = await Promise.all([buildTree(source, withHash), buildTree(target, withHash)]);
  const mismatches = [];
  const push = (row) => {
    if (mismatches.length < 20) mismatches.push(row);
  };
  for (const [key, row] of left.rows) {
    const other = right.rows.get(key);
    if (other === undefined) {
      push({ rel: key, reason: '目标缺失' });
      continue;
    }
    if (row.dir === true) continue;
    if (row.size !== other.size) {
      push({ rel: key, reason: `大小不同 ${row.size} ≠ ${other.size}` });
      continue;
    }
    if (withHash && row.hash !== other.hash) push({ rel: key, reason: 'sha256 不同' });
  }
  for (const key of right.rows.keys()) {
    if (!left.rows.has(key)) push({ rel: key, reason: '目标多出文件' });
  }
  return {
    ok: mismatches.length === 0,
    files: left.files,
    bytes: left.bytes,
    mismatches,
  };
}

function describeMismatches(result) {
  return result.mismatches.map((row) => `${row.rel}（${row.reason}）`).join('、');
}

/**
 * 当前是否还有 DSH 主进程在跑（搬迁前必须为 false）。
 * 检测失败时按“在运行 / 未知”处理（fail-closed），由调用方显式放行才继续。
 */
export function detectDshRunning() {
  if (process.platform !== 'win32') return { running: false, processes: [], unknown: false };
  const filtered = spawnSync(
    'tasklist',
    ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'],
    { windowsHide: true, encoding: 'utf8', timeout: 5000 },
  );
  if (filtered.error || filtered.status !== 0) {
    return {
      running: true,
      processes: [],
      unknown: true,
      error: filtered.error?.message ?? (String(filtered.stderr || '').trim() || `tasklist 退出码 ${filtered.status}`),
    };
  }
  const processes = parseTasklist(filtered.stdout, /DeepSeek Harness\.exe/i);
  if (processes.length > 0) return { running: true, processes, unknown: false };

  // 镜像名可能被改名（更新器/自定义构建）。再列全表按 DeepSeek+Harness 模糊匹配；
  // 全表都读不到时仍按“未知/在运行”处理，不 fail-open。
  const all = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 8000,
  });
  if (all.error || all.status !== 0) {
    return {
      running: true,
      processes: [],
      unknown: true,
      error: all.error?.message ?? (String(all.stderr || '').trim() || `tasklist 全表退出码 ${all.status}`),
    };
  }
  const renamed = parseTasklist(all.stdout, /deepseek.*harness|harness.*deepseek/i);
  return { running: renamed.length > 0, processes: renamed, unknown: false };
}

function parseTasklist(stdout, pattern) {
  const processes = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (!pattern.test(line)) continue;
    const match = /"([^"]+)","(\d+)"/.exec(line);
    if (match === null) continue;
    processes.push({ name: match[1], pid: Number(match[2]) });
  }
  return processes;
}

/** 跨进程锁：防止两个 apply/unlink 同时操作同一批会话组。 */
async function acquireLock(sessionsRoot) {
  const file = path.join(sessionsRoot, LINK_LOCK);
  await mkdir(sessionsRoot, { recursive: true });
  const token = randomUUID();
  const payload = `${JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now(), token })}\n`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await writeFile(file, payload, { encoding: 'utf8', flag: 'wx' });
      let released = false;
      const ensure = async () => {
        let raw = null;
        try {
          raw = JSON.parse(await readFile(file, 'utf8'));
        } catch {
          // 读不到锁就当自己已经失去它
        }
        if (raw?.token !== token) {
          throw new Error(`搬迁锁已不在本进程手里（${file}），停止以避免并发删数据`);
        }
      };
      const release = async () => {
        if (released) return;
        released = true;
        // 只删自己那把锁；若锁已被别人接手，不能替对方解锁。
        try {
          const raw = JSON.parse(await readFile(file, 'utf8'));
          if (raw?.token === token) await rm(file, { force: true });
        } catch {
          // 锁文件已不在或不可读，无需处理
        }
      };
      return { ensure, release };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const info = await inspectLock(file);
      if (!info.stale) {
        throw new Error(`另一个爱ai 进程正在搬迁（锁文件：${file}）。确认没有别的进程在跑后，可手动删除该锁。`);
      }
      // 用 rename 原子地摘走观察到的旧锁，再核对内容没变；
      // 直接 rm 会误删别人刚建的新锁（两个进程同时判定 stale 时）。
      if (!(await breakStaleLock(file, info))) {
        // 摘到的不是刚才那把（别人先动了手），重新判断
        const again = await inspectLock(file);
        if (again.exists && !again.stale) {
          throw new Error(`另一个爱ai 进程正在搬迁（锁文件：${file}）。确认没有别的进程在跑后，可手动删除该锁。`);
        }
      }
    }
  }
  throw new Error(`拿不到搬迁锁：${file}`);
}

/**
 * 只有持锁进程确实不在了才回收。活着的进程不管持锁多久都不抢——
 * 卡住最多需要人工删锁文件，抢锁则可能同时搬迁、互相删数据。
 */
async function inspectLock(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { exists: false, stale: true, text: '' };
  }
  let raw = null;
  try {
    raw = JSON.parse(text);
  } catch {
    // 读不懂：刚创建还没写完时也可能读不懂。只有确认它已经放了足够久
    // （写锁的进程早该写完）才当残留回收，避免抢走别人刚建的活锁。
    try {
      const info = await stat(file);
      return { exists: true, stale: Date.now() - info.mtimeMs > 30_000, text };
    } catch {
      return { exists: true, stale: false, text };
    }
  }
  const pid = Number(raw?.pid);
  if (!Number.isFinite(pid) || pid <= 0) return { exists: true, stale: true, text };
  try {
    process.kill(pid, 0);
    return { exists: true, stale: false, text };
  } catch (error) {
    return { exists: true, stale: error?.code === 'ESRCH', text };
  }
}

/** 把确认残留的锁原子移走；若移到的其实是别人刚建的新锁，再放回去。 */
async function breakStaleLock(file, observed) {
  const moved = `${file}.${randomUUID()}.stale`;
  try {
    await rename(file, moved);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  let movedText = null;
  try {
    movedText = await readFile(moved, 'utf8');
  } catch {
    // 读不到就当没拿到，交给下一轮重试
  }
  if (movedText !== observed.text) {
    try {
      // 排他复制：绝不覆盖路径上别人刚建的新锁。
      await copyFile(moved, file, fsConstants.COPYFILE_EXCL);
      await rm(moved, { force: true });
    } catch {
      await rm(moved, { force: true }).catch(() => {});
    }
    return false;
  }
  await rm(moved, { force: true });
  return true;
}

async function listGroupNames(sessionsRoot) {
  let entries;
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => isQqSessionGroup(name) && !name.startsWith('.ai-love-'))
    .sort();
}

function parseTempName(name) {
  if (name.startsWith(BACKUP_PREFIX)) {
    const rest = name.slice(BACKUP_PREFIX.length);
    const match = STAMP.exec(rest);
    if (match === null) return null;
    return { group: rest.slice(0, match.index), kind: 'backup' };
  }
  if (name.startsWith(RESTORE_PREFIX)) {
    const rest = name.slice(RESTORE_PREFIX.length);
    const match = STAMP.exec(rest);
    if (match === null) return null;
    return { group: rest.slice(0, match.index), kind: 'restore' };
  }
  return null;
}

/** 扫描会话根里所有中断残留（备份 / 回迁临时目录），按组归类。 */
export async function discoverInterrupted(sessionsRoot) {
  const map = new Map();
  const orphans = [];
  let entries = [];
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(BACKUP_PREFIX) && !entry.name.startsWith(RESTORE_PREFIX)) continue;
    const full = path.join(sessionsRoot, entry.name);
    const parsed = parseTempName(entry.name);
    if (parsed === null || !isQqSessionGroup(parsed.group)) {
      orphans.push({ name: entry.name, path: full });
      continue;
    }
    const row = map.get(parsed.group) ?? { group: parsed.group, backups: [], restores: [] };
    if (parsed.kind === 'backup') row.backups.push(full);
    else row.restores.push(full);
    map.set(parsed.group, row);
  }
  for (const row of map.values()) {
    row.backups.sort();
    row.restores.sort();
  }
  return { byGroup: map, orphans };
}

export async function readLinkManifest(linkRoot) {
  try {
    const raw = JSON.parse(await readFile(path.join(linkRoot, LINK_MANIFEST), 'utf8'));
    if (!Array.isArray(raw?.links)) return [];
    return raw.links.filter(
      (row) => typeof row?.group === 'string' && isSafeGroupName(row.group) && isQqSessionGroup(row.group),
    );
  } catch {
    return [];
  }
}

async function writeLinkManifest(linkRoot, links) {
  await mkdir(linkRoot, { recursive: true });
  const rows = [...links].sort((a, b) => String(a.group).localeCompare(String(b.group)));
  const file = path.join(linkRoot, LINK_MANIFEST);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(
    temp,
    `${JSON.stringify({ version: LINK_STATE_VERSION, updatedAt: Date.now(), links: rows }, null, 2)}\n`,
    'utf8',
  );
  await rename(temp, file);
}

/** 只读扫描：面板与 CLI 的 --status 都用它。 */
export async function scanContextLinks(options = {}) {
  const { sessionsRoot, linkRoot } = resolveRoots(options);
  const running = detectDshRunning();
  const manifest = await readLinkManifest(linkRoot);
  const manifestGroups = new Set(manifest.map((row) => row.group));
  let interrupted = { byGroup: new Map(), orphans: [] };
  const groups = [];
  let names = [];
  let scanError = '';
  try {
    names = await listGroupNames(sessionsRoot);
    const found = await discoverInterrupted(sessionsRoot);
    interrupted = found;
    for (const name of found.byGroup.keys()) {
      if (!names.includes(name)) names.push(name);
    }
    for (const name of manifestGroups) {
      if (!names.includes(name)) names.push(name);
    }
    names.sort();
  } catch (error) {
    scanError = error instanceof Error ? error.message : String(error);
  }

  for (const name of names) {
    const source = path.join(sessionsRoot, name);
    const expected = path.join(linkRoot, name);
    const leftovers = interrupted.byGroup.get(name) ?? { backups: [], restores: [] };
    const actualTarget = await junctionTarget(source);
    const targetExists = await exists(expected);
    let kind = 'other';
    let state = 'unknown';
    let files = 0;
    let bytes = 0;
    let detail = '';

    try {
      if (actualTarget !== null) {
        kind = 'junction';
        if (!(await exists(actualTarget))) {
          state = 'broken-link';
          detail = `联接目标不存在：${actualTarget}`;
        } else if (samePath(actualTarget, expected)) {
          state = 'linked';
        } else {
          state = 'linked-elsewhere';
          detail = `联接到别处：${actualTarget}`;
        }
      } else if (!(await exists(source))) {
        if (leftovers.backups.length > 0) {
          kind = 'backup';
          state = 'interrupted';
          detail = `源目录不在，存在中断备份：${leftovers.backups[leftovers.backups.length - 1]}`;
          const summary = await treeSummary(leftovers.backups[leftovers.backups.length - 1]);
          files = summary.files;
          bytes = summary.bytes;
        } else if (leftovers.restores.length > 0) {
          kind = 'restore';
          state = 'interrupted';
          detail = `源目录不在，存在回迁临时副本：${leftovers.restores[leftovers.restores.length - 1]}`;
          const summary = await treeSummary(leftovers.restores[leftovers.restores.length - 1]);
          files = summary.files;
          bytes = summary.bytes;
        } else if (targetExists && manifestGroups.has(name)) {
          kind = 'manifest';
          state = 'interrupted';
          detail = `源目录不在，但联通目录里的副本仍在；--apply 可按 manifest 重建联接：${expected}`;
          const summary = await treeSummary(expected);
          files = summary.files;
          bytes = summary.bytes;
        } else {
          state = 'missing';
        }
      } else {
        const info = await lstat(source);
        kind = info.isDirectory() ? 'directory' : 'other';
        if (kind !== 'directory') {
          state = 'unsupported';
        } else if (targetExists) {
          const entries = await readdir(expected);
          state = entries.length === 0 ? 'ready' : 'conflict';
          if (state === 'conflict') detail = `目标已存在且非空：${expected}`;
        } else {
          state = 'ready';
        }
      }
      if (
        state !== 'broken-link' &&
        state !== 'unsupported' &&
        state !== 'interrupted' &&
        state !== 'missing'
      ) {
        const summary = await treeSummary(source);
        files = summary.files;
        bytes = summary.bytes;
      }
      if (leftovers.backups.length > 0 && state !== 'interrupted') {
        detail = `${detail === '' ? '' : `${detail}；`}未清理的旧备份 ${leftovers.backups.length} 个`;
      }
      if (leftovers.restores.length > 0 && state !== 'interrupted') {
        detail = `${detail === '' ? '' : `${detail}；`}未清理的回迁副本 ${leftovers.restores.length} 个`;
      }
    } catch (error) {
      state = 'error';
      detail = error instanceof Error ? error.message : String(error);
    }

    groups.push({
      name,
      source,
      target: expected,
      kind,
      state,
      files,
      bytes,
      targetExists,
      actualTarget: actualTarget ?? '',
      inManifest: manifestGroups.has(name),
      backups: leftovers.backups.length,
      restores: leftovers.restores.length,
      detail,
    });
  }

  const linked = groups.filter((row) => row.state === 'linked');
  const ready = groups.filter((row) => row.state === 'ready');
  const conflicts = groups.filter((row) => row.state === 'conflict');
  const broken = groups.filter((row) => row.state === 'broken-link');
  const interruptedRows = groups.filter((row) => row.state === 'interrupted');
  const errored = groups.filter((row) => row.state === 'error');
  return {
    ok: scanError === '' && errored.length === 0,
    sessionsRoot,
    linkRoot,
    sessionsRootExists: existsSync(sessionsRoot),
    linkRootExists: existsSync(linkRoot),
    linkRootOnSystemDrive: isSystemVolume(linkRoot),
    dshRunning: running,
    error: scanError,
    manifest,
    orphans: interrupted.orphans,
    groups,
    totals: {
      groups: groups.length,
      linked: linked.length,
      ready: ready.length,
      conflicts: conflicts.length,
      broken: broken.length,
      interrupted: interruptedRows.length,
      bytes: groups.reduce((sum, row) => sum + Number(row.bytes ?? 0), 0),
      linkedBytes: linked.reduce((sum, row) => sum + Number(row.bytes ?? 0), 0),
    },
  };
}

function stamp() {
  return `${Date.now().toString(36)}-${process.pid.toString(36)}`;
}

async function hasEntries(dir) {
  try {
    return (await readdir(dir)).length > 0;
  } catch {
    return false;
  }
}

/** 安全判断用：读不了就报错，不能把“读不了”当成“没有数据”。 */
async function hasEntriesStrict(dir) {
  try {
    return (await readdir(dir)).length > 0;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw new Error(`读不了 ${dir}（${error?.code ?? '未知'}），无法判断里面有没有数据，未继续`);
  }
}

/** 目标是否是源的一份“子集副本”（上次复制中断留下的半成品），可安全删掉重拷。 */
async function isPartialCopy(source, target) {
  const [left, right] = await Promise.all([buildTree(source, true), buildTree(target, true)]);
  if (right.rows.size === 0) return false;
  for (const [key, row] of right.rows) {
    const other = left.rows.get(key);
    if (other === undefined) return false;
    if (row.dir === true) {
      if (other.dir !== true) return false;
      continue;
    }
    if (other.dir === true || other.size !== row.size || other.hash !== row.hash) return false;
  }
  return true;
}

/**
 * 上次搬迁中断（源被改名、junction 没建 / 回迁临时目录没换入）：
 * 把原目录或副本恢复回 source，再走正常流程重新评估。
 *
 * 有 D: 目标时，只有与目标逐文件 sha256 完全一致的候选才允许恢复；
 * 找不到一致候选就停手报错——宁可等人工确认，也不能把旧数据盖到新数据上。
 */
async function recoverInterrupted(sessionsRoot, group, source, target, warnings) {
  const leftovers = (await discoverInterrupted(sessionsRoot)).byGroup.get(group);
  if (leftovers === undefined) return false;
  if (await exists(source)) {
    if (leftovers.backups.length > 0) {
      warnings.push(`${group}: 源目录正常，但还有 ${leftovers.backups.length} 个旧备份没清理`);
    }
    if (leftovers.restores.length > 0) {
      warnings.push(`${group}: 源目录正常，但还有 ${leftovers.restores.length} 个回迁副本没清理`);
    }
    return false;
  }
  // 回迁副本是较新的数据，优先与 D: 目标比对。
  const candidates = [...leftovers.restores, ...leftovers.backups];
  if (candidates.length === 0) return false;

  let chosen = null;
  if (await hasEntriesStrict(target)) {
    for (const candidate of candidates) {
      try {
        const same = await verifyTrees(candidate, target, { hash: true });
        if (same.ok) {
          chosen = candidate;
          break;
        }
      } catch {
        // 单个候选读不了就继续看下一个
      }
    }
    if (chosen === null) {
      throw new Error(
        `${group}: 中断残留与 D: 副本不一致，拒绝自动恢复（保留：${candidates
          .map((row) => path.basename(row))
          .join('、')}；目标：${target}）。` +
          '确认 D: 副本权威时，删除这些残留后重跑 --apply；否则把要保留的目录改名回源目录。',
      );
    }
  } else if (candidates.length === 1) {
    chosen = candidates[0];
  } else {
    // 目标为空：有多个残留时先确认它们内容一致。半成品副本不能因为
    // mtime 更新就被当成完整数据换入，否则会静默丢掉旧备份里的内容。
    const [first, ...rest] = candidates;
    let agree = true;
    for (const other of rest) {
      try {
        const same = await verifyTrees(first, other, { hash: true });
        if (!same.ok) {
          agree = false;
          break;
        }
      } catch {
        agree = false;
        break;
      }
    }
    if (!agree) {
      throw new Error(
        `${group}: 多个中断残留内容不一致，拒绝自动恢复（保留：${candidates
          .map((row) => path.basename(row))
          .join('、')}）。` +
          '确认后把要保留的目录改名回源目录，或删除多余残留再重跑 --apply。',
      );
    }
    chosen = first;
  }
  if (chosen === null) return false;
  await rename(chosen, source);
  warnings.push(`${group}: 已从上次中断的残留恢复源目录（${path.basename(chosen)}）`);
  return true;
}

async function upsertManifest(linkRoot, entry) {
  const links = (await readLinkManifest(linkRoot)).filter((row) => row.group !== entry.group);
  links.push(entry);
  await writeLinkManifest(linkRoot, links);
}

async function removeManifest(linkRoot, groups) {
  if (!(await exists(path.join(linkRoot, LINK_MANIFEST)))) return;
  const links = (await readLinkManifest(linkRoot)).filter((row) => !groups.has(row.group));
  await writeLinkManifest(linkRoot, links);
}

async function linkOne(sessionsRoot, linkRoot, name, warnings, ensure = async () => {}) {
  if (!isSafeGroupName(name) || !isQqSessionGroup(name)) throw new Error('不安全的会话组名，跳过');
  const source = path.join(sessionsRoot, name);
  const target = path.join(linkRoot, name);
  const actualTarget = await junctionTarget(source);
  if (actualTarget !== null) {
    if (!(await exists(actualTarget))) throw new Error(`联接目标不存在（${actualTarget}），先人工恢复数据`);
    if (!samePath(actualTarget, target)) {
      throw new Error(`已经联接到别处（${actualTarget}），不覆盖`);
    }
    // 上次在“已建联接、未删备份”处中断：备份与目标逐文件一致才清掉。
    const leftovers = (await discoverInterrupted(sessionsRoot)).byGroup.get(name);
    for (const backup of leftovers?.backups ?? []) {
      try {
        const same = await verifyTrees(backup, actualTarget, { hash: true });
        if (!same.ok) {
          warnings.push(`${name}: 旧备份与目标不一致，保留待查：${backup}`);
          continue;
        }
        await ensure();
        await rm(backup, { recursive: true, force: true });
        warnings.push(`${name}: 已清理上次中断留下的旧备份（${path.basename(backup)}）`);
      } catch (error) {
        warnings.push(`${name}: 旧备份清理失败：${backup}（${error instanceof Error ? error.message : String(error)}）`);
      }
    }
    const summary = await treeSummary(source);
    await upsertManifest(linkRoot, {
      group: name,
      source,
      target,
      linkedAt: Date.now(),
      bytes: summary.bytes,
      files: summary.files,
      adopted: true,
    });
    return { group: name, status: 'already-linked', source, target, ...summary };
  }

  // 源目录整个不见了，但 manifest 与 D: 目标都还在：数据没丢，直接重建联接。
  const manifestRow = (await readLinkManifest(linkRoot)).find((row) => row.group === name);
  const leftovers = (await discoverInterrupted(sessionsRoot)).byGroup.get(name);
  if (
    !(await exists(source)) &&
    leftovers === undefined &&
    manifestRow !== undefined &&
    samePath(manifestRow.target, target) &&
    (await exists(target))
  ) {
    await ensure();
    await createJunction(source, target);
    const rebuilt = await junctionTarget(source);
    if (rebuilt === null || !samePath(rebuilt, target)) throw new Error('按 manifest 重建联接后目标不一致');
    const summary = await treeSummary(target);
    warnings.push(`${name}: 源目录缺失，已按 manifest 与原目标重建联接`);
    await upsertManifest(linkRoot, {
      group: name,
      source,
      target,
      linkedAt: Date.now(),
      bytes: summary.bytes,
      files: summary.files,
      rebuilt: true,
    });
    return { group: name, status: 'relinked', source, target, ...summary };
  }

  await ensure();
  await recoverInterrupted(sessionsRoot, name, source, target, warnings);
  if (!(await exists(source))) throw new Error('源目录不存在，也没有联接，未动');
  const info = await lstat(source);
  if (!info.isDirectory()) throw new Error('不是目录，跳过');

  // 目标已存在时：空目录收掉；非空目录只有和源逐文件 sha256 完全一致才复用
  // （上次复制完成但 junction 没建的中断现场），半成品副本可安全重拷。
  let reuseTarget = false;
  if (await exists(target)) {
    const targetInfo = await lstat(target);
    if (!targetInfo.isDirectory()) throw new Error(`目标已存在且不是目录：${target}`);
    const entries = await readdir(target);
    if (entries.length === 0) {
      await rmdir(target);
    } else {
      const same = await verifyTrees(source, target, { hash: true });
      if (same.ok) {
        reuseTarget = true;
        warnings.push(`${name}: 目标已有一份校验一致的副本，直接复用`);
      } else if (await isPartialCopy(source, target)) {
        await ensure();
        await rm(target, { recursive: true, force: true });
        warnings.push(`${name}: 清理上次中断留下的半成品副本后重新复制`);
      } else {
        throw new Error(`目标已存在且内容不同：${target}（${describeMismatches(same)}）`);
      }
    }
  }

  const before = await treeSummary(source);
  if (!reuseTarget) {
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await copyTree(source, target);
      const copied = await verifyTrees(source, target, { hash: true });
      if (!copied.ok) throw new Error(`复制后完整性校验失败：${describeMismatches(copied)}`);
    } catch (error) {
      await rm(target, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  // 换入前最后再核一次（防复制期间源被改动）。此刻不能只是相信前一次结果。
  const preSwap = await verifyTrees(source, target, { hash: true });
  if (!preSwap.ok) {
    if (!reuseTarget) await rm(target, { recursive: true, force: true }).catch(() => {});
    throw new Error(`换入前复核失败，源可能在变化：${describeMismatches(preSwap)}`);
  }

  const backup = path.join(sessionsRoot, `${BACKUP_PREFIX}${name}-${stamp()}`);
  await ensure();
  await rename(source, backup);
  try {
    await createJunction(source, target);
    const checkedTarget = await junctionTarget(source);
    if (checkedTarget === null || !samePath(checkedTarget, target)) {
      throw new Error('目录联接创建后目标不一致');
    }
    // 关键：校验 C: 上的原目录（备份）与 D: 副本，而不是拿联接去比自己。
    const after = await verifyTrees(backup, target, { hash: true });
    if (!after.ok) throw new Error(`联通后完整性校验失败：${describeMismatches(after)}`);
  } catch (error) {
    await removeJunction(source).catch(() => {});
    let rollback = '已回滚';
    let rolledBack = true;
    try {
      await rename(backup, source);
    } catch (renameError) {
      rolledBack = false;
      rollback = `回滚失败，备份保留在 ${backup}（${renameError instanceof Error ? renameError.message : String(renameError)}）`;
    }
    // 回滚成功才删这次新复制的目标；回滚失败时目标可能是唯一可读副本，必须留下。
    if (rolledBack && !reuseTarget) await rm(target, { recursive: true, force: true }).catch(() => {});
    throw new Error(`${error instanceof Error ? error.message : String(error)}（${rollback}）`);
  }

  // 删除 C: 旧副本前再确认一次锁还在自己手里。
  await ensure();
  try {
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    warnings.push(`${name}: 联接已生效，但 C: 上的旧副本没删掉：${backup}（${error instanceof Error ? error.message : String(error)}）`);
  }

  await upsertManifest(linkRoot, {
    group: name,
    source,
    target,
    linkedAt: Date.now(),
    bytes: before.bytes,
    files: before.files,
  });
  return { group: name, status: 'linked', source, target, bytes: before.bytes, files: before.files };
}

function runningError(running, action) {
  if (running.unknown) {
    return `无法确认 DSH 是否已退出（${running.error ?? 'tasklist 失败'}）。为保护正在写的日志，默认拒绝 ${action}；确认已退出后可加 --allow-running。`;
  }
  return `DSH 还在运行（${running.processes.map((row) => row.pid).join(', ')}）。请先从托盘完全退出 DSH，再运行 ${action}。`;
}

/**
 * 建立联接。要求 DSH 完全退出；沙盒可显式 allowWhileRunning。
 * @param {{sessionsRoot?: string, linkRoot?: string, dshHome?: string, groups?: string[], allowWhileRunning?: boolean, config?: Record<string, unknown>}} [options]
 */
export async function applyContextLinks(options = {}) {
  const { sessionsRoot, linkRoot } = resolveRoots(options);
  if (samePath(sessionsRoot, linkRoot) || isInside(sessionsRoot, linkRoot) || isInside(linkRoot, sessionsRoot)) {
    throw new Error('联接目标不能和 DSH 会话根互相嵌套');
  }

  const running = detectDshRunning();
  if (running.running && options.allowWhileRunning !== true) {
    throw new Error(runningError(running, '--apply'));
  }

  if (!existsSync(sessionsRoot)) {
    // manifest 里还有记录时不能直接当“无事可做”：源目录可能丢了，
    // 但 D: 副本还在，linkOne 会用 manifest 把联接重建回来。
    if ((await readLinkManifest(linkRoot)).length === 0) {
      return {
        ok: true,
        sessionsRoot,
        linkRoot,
        dshRunning: running,
        results: [],
        warnings: [],
        errors: [],
        status: await scanContextLinks({ sessionsRoot, linkRoot, config: options.config }),
      };
    }
    await mkdir(sessionsRoot, { recursive: true });
  }

  const lock = await acquireLock(sessionsRoot);
  try {
    const only =
      Array.isArray(options.groups) && options.groups.length > 0 ? new Set(options.groups.map(String)) : null;
    const interrupted = await discoverInterrupted(sessionsRoot);
    const manifestGroups = (await readLinkManifest(linkRoot)).map((row) => row.group);
    const names = [
      ...new Set([...(await listGroupNames(sessionsRoot)), ...interrupted.byGroup.keys(), ...manifestGroups]),
    ]
      .filter((name) => isSafeGroupName(name) && isQqSessionGroup(name))
      .filter((name) => only === null || only.has(name))
      .sort();
    const results = [];
    const warnings = [];
    const errors = [];
    for (const name of names) {
      try {
        results.push(await linkOne(sessionsRoot, linkRoot, name, warnings, lock.ensure));
      } catch (error) {
        errors.push({ group: name, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return {
      ok: errors.length === 0,
      sessionsRoot,
      linkRoot,
      dshRunning: running,
      results,
      warnings,
      errors,
      status: await scanContextLinks({ sessionsRoot, linkRoot, config: options.config }),
    };
  } finally {
    await lock.release();
  }
}

/**
 * 只有“本来就是预期路径 linkRoot/<组名>”的联接才算爱ai 的。
 * manifest 只用于提示，不参与删除授权：即使被篡改也删不到别的目录。
 */
function ownsTarget(linkRoot, expected, actualTarget) {
  return isInside(linkRoot, expected) && samePath(actualTarget, expected);
}

/**
 * 源目录没了、只剩联通目录副本时，先确认这份数据没被别的组认领。
 * 否则一条被篡改的 manifest 就能把别的组的数据搬走。
 */
async function claimedByOtherGroup(sessionsRoot, linkRoot, name, expected) {
  const expectedReal = await realpathLoose(expected);
  const overlaps = async (target) => {
    let targetReal;
    try {
      targetReal = await realpathLoose(target);
    } catch {
      // 解析不了就当作被占用，宁可停下让用户确认。
      return true;
    }
    return (
      samePath(targetReal, expectedReal) ||
      isInside(expectedReal, targetReal) ||
      isInside(targetReal, expectedReal)
    );
  };
  for (const row of await readLinkManifest(linkRoot)) {
    if (row.group === name || typeof row.target !== 'string') continue;
    if (await overlaps(normalizePath(row.target))) return row.group;
  }
  for (const other of await listGroupNames(sessionsRoot)) {
    if (other === name) continue;
    const target = await junctionTarget(path.join(sessionsRoot, other));
    if (target !== null && (await overlaps(target))) return other;
  }
  return null;
}

async function unlinkOne(sessionsRoot, linkRoot, name, warnings, ensure = async () => {}) {
  if (!isSafeGroupName(name) || !isQqSessionGroup(name)) throw new Error('不安全的会话组名，跳过');
  const source = path.join(sessionsRoot, name);
  const expected = path.join(linkRoot, name);
  let actualTarget = await junctionTarget(source);
  let hasJunction = actualTarget !== null;

  if (actualTarget === null && !(await exists(source))) {
    // 源不在时优先用联通目录里的副本（通常是最新数据），不要先恢复本地旧残留。
    if (await hasEntriesStrict(expected)) {
      const claimed = await claimedByOtherGroup(sessionsRoot, linkRoot, name, expected);
      if (claimed !== null) {
        throw new Error(`联通目录里的 ${expected} 已被 ${claimed} 认领，不会当作本组数据回迁`);
      }
      actualTarget = normalizePath(expected);
      hasJunction = false;
      warnings.push(`${name}: 源目录缺失，按联通目录里的副本回迁`);
    } else {
      await ensure();
      await recoverInterrupted(sessionsRoot, name, source, expected, warnings);
      actualTarget = await junctionTarget(source);
      hasJunction = actualTarget !== null;
    }
  }

  if (actualTarget === null) {
    if (await exists(source)) {
      // 源是普通目录、没有联接：如果联通目录里还有同组数据、且 manifest 记录过本组，
      // 不能报“没联通”然后把 manifest 抹掉、让卸载删掉唯一能恢复的 CLI。
      if (await hasEntriesStrict(expected)) {
        const manifested = (await readLinkManifest(linkRoot)).some((row) => row.group === name);
        if (manifested) {
          throw new Error(`源目录不是联接，但 ${expected} 里还有数据（manifest 记录过本组）；未动，先确认哪份最新`);
        }
        // 没记录过本组：这是别人的/历史冲突目录，不碰也不当作回迁成功。
        warnings.push(`${name}: 源目录不是联接，${expected} 里另有数据，未动`);
      }
      return { group: name, status: 'not-linked' };
    }
    throw new Error('源目录不存在，也没有联接，未动');
  }
  // 断链没有数据可回迁，摘掉联接本身是安全的；先处理，避免被“所有权”判断挡住。
  if (!(await exists(actualTarget))) {
    if (hasJunction) {
      const root = path.parse(actualTarget).root;
      if (!(await exists(root))) {
        throw new Error(`目标所在盘不可用（${root}），联接保留未动；接回磁盘后再运行 --unlink`);
      }
      await ensure();
      await removeJunction(source);
      if (await hasEntriesStrict(expected)) {
        // 目标路径另有数据：manifest 记录留着，之后还能找回这组数据在哪。
        warnings.push(`${name}: 联接目标缺失，但 ${expected} 里还有数据；manifest 记录保留，方便之后恢复`);
        return { group: name, status: 'broken-link-removed', target: actualTarget, keptManifest: true };
      }
      return { group: name, status: 'broken-link-removed', target: actualTarget };
    }
    throw new Error(`联接目标不存在（${actualTarget}），数据可能已丢失，未动`);
  }

  if (!ownsTarget(linkRoot, expected, actualTarget)) {
    throw new Error(`联接到 ${actualTarget}，不是预期路径 ${expected}，跳过`);
  }

  const before = await treeSummary(actualTarget);
  const temp = path.join(sessionsRoot, `${RESTORE_PREFIX}${name}-${stamp()}`);
  let copied;
  try {
    await copyTree(actualTarget, temp);
    copied = await verifyTrees(actualTarget, temp, { hash: true });
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  if (!copied.ok) {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
    throw new Error(`回迁复制完整性校验失败：${describeMismatches(copied)}`);
  }

  if (hasJunction) {
    await ensure();
    await removeJunction(source);
  }
  await ensure();
  try {
    await rename(temp, source);
  } catch (error) {
    await createJunction(source, actualTarget).catch(() => {});
    throw new Error(
      `回迁替换失败：${error instanceof Error ? error.message : String(error)}（数据仍在 ${actualTarget}，临时副本 ${temp}）`,
    );
  }

  const restored = await verifyTrees(source, actualTarget, { hash: true });
  if (!restored.ok) {
    throw new Error(`回迁后完整性校验失败：${describeMismatches(restored)}（D: 副本仍在 ${actualTarget}，未删除）`);
  }

  await ensure();
  try {
    await rm(actualTarget, { recursive: true, force: true });
  } catch (error) {
    warnings.push(`${name}: 已回迁到 C:，但 D: 副本没删掉：${actualTarget}（${error instanceof Error ? error.message : String(error)}）`);
  }
  return { group: name, status: 'restored', source, target: actualTarget, bytes: before.bytes, files: before.files };
}

/**
 * 把联接回迁到 C:。同样要求 DSH 退出。
 */
export async function unlinkContextLinks(options = {}) {
  const { sessionsRoot, linkRoot } = resolveRoots(options);
  if (samePath(sessionsRoot, linkRoot) || isInside(sessionsRoot, linkRoot) || isInside(linkRoot, sessionsRoot)) {
    throw new Error('联接目标不能和 DSH 会话根互相嵌套');
  }
  const running = detectDshRunning();
  if (running.running && options.allowWhileRunning !== true) {
    throw new Error(runningError(running, '--unlink'));
  }

  if (!existsSync(sessionsRoot)) {
    const pending = [...(await readLinkManifest(linkRoot)), ...(await listGroupNames(linkRoot))];
    // 会话根不在、但联通目录里还有组：不能报成功，否则卸载会删掉唯一能回迁的 CLI。
    if (pending.length > 0) {
      const error = `DSH 会话根不存在（${sessionsRoot}），联通目录里仍有待回迁数据；请用 --sessions 指定正确路径`;
      return {
        ok: false,
        sessionsRoot,
        linkRoot,
        dshRunning: running,
        results: [],
        warnings: [],
        errors: [{ group: '(sessions)', error }],
        status: await scanContextLinks({ sessionsRoot, linkRoot, config: options.config }),
      };
    }
    return {
      ok: true,
      sessionsRoot,
      linkRoot,
      dshRunning: running,
      results: [],
      warnings: [],
      errors: [],
      status: await scanContextLinks({ sessionsRoot, linkRoot, config: options.config }),
    };
  }

  const lock = await acquireLock(sessionsRoot);
  try {
    const manifest = await readLinkManifest(linkRoot);
    const manifestGroups = new Set(manifest.map((row) => row.group));
    const only =
      Array.isArray(options.groups) && options.groups.length > 0 ? new Set(options.groups.map(String)) : null;
    const discovered = await listGroupNames(sessionsRoot);
    const interrupted = await discoverInterrupted(sessionsRoot);
    // 只有 D: 副本、C: 源已不在的组也要回迁，否则卸载会删掉唯一的恢复工具。
    const names = [
      ...new Set([...discovered, ...manifestGroups, ...interrupted.byGroup.keys(), ...(await listGroupNames(linkRoot))]),
    ]
      .filter((name) => isSafeGroupName(name) && isQqSessionGroup(name))
      .filter((name) => only === null || only.has(name))
      .sort();

    const results = [];
    const warnings = [];
    const errors = [];
    const restored = new Set();
    for (const name of names) {
      try {
        const result = await unlinkOne(sessionsRoot, linkRoot, name, warnings, lock.ensure);
        results.push(result);
        if (
          result.status === 'restored' ||
          (result.status === 'broken-link-removed' && result.keptManifest !== true)
        ) {
          restored.add(name);
        } else if (result.status === 'not-linked' && manifestGroups.has(name)) restored.add(name);
      } catch (error) {
        errors.push({ group: name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (restored.size > 0) await removeManifest(linkRoot, restored);

    return {
      ok: errors.length === 0,
      sessionsRoot,
      linkRoot,
      dshRunning: running,
      results,
      warnings,
      errors,
      status: await scanContextLinks({ sessionsRoot, linkRoot, config: options.config }),
    };
  } finally {
    await lock.release();
  }
}
