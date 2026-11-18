/**
 * 爱ai · 原子写与文件锁
 *
 * 面板与压缩引擎在同进程里各持有 store 实例，历史上出现过
 * 「同 pid 临时文件名撞车 → 交错写坏」与「read-modify-write 后写者覆盖先写者」。
 * 这里提供两件事：
 *   - writeFileAtomic：临时文件名带 pid + 时间 + 序号，同文件写入按序排队；
 *   - withFileLock：把整个「读-改-写」事务按文件串行化。
 */
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 文件名序列号，防同进程同毫秒撞名。 */
let tmpSeq = 0;
/** 文件路径 → 写链尾部 promise。 */
const writeChains = new Map();
/** 文件路径 → 事务锁尾部 promise。 */
const lockChains = new Map();

export async function writeFileAtomic(file, text) {
  const prev = writeChains.get(file) ?? Promise.resolve();
  const task = prev.then(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    tmpSeq += 1;
    const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${tmpSeq.toString(36)}`;
    try {
      await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, file);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  });
  writeChains.set(
    file,
    task.catch(() => {}),
  );
  return task;
}

/**
 * 按文件串行化一段「读-改-写」：fn 内部的读取一定能看到上一个持锁者的完整写入。
 * @param {string} file 要保护的数据文件路径
 * @param {() => Promise<any>} fn
 */
export async function withFileLock(file, fn) {
  const prev = lockChains.get(file) ?? Promise.resolve();
  const task = prev.then(() => fn());
  const guard = task.catch(() => {});
  lockChains.set(file, guard);
  try {
    return await task;
  } finally {
    if (lockChains.get(file) === guard) lockChains.delete(file);
  }
}
