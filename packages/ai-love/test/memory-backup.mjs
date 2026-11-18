// 逐字节记忆备份的单元测试。跑法：node --test test/memory-backup.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveConfig } from '../src/core/config.mjs';
import {
  MemoryBackup,
  acquireBackupLock,
  listMemoryArchiveFiles,
  readMemoryBackupStatus,
  readMemoryManifest,
  resolveMemoryBackupRoot,
  sha256File,
  verifyMemoryBackup,
} from '../src/core/memory-backup.mjs';

const GROUP = '--C-Users-test-qq-bridge-main-state-agents--';
const OTHER_GROUP = '--C-Users-test-web--';

function makeLog() {
  const buffer = Buffer.alloc(256 * 1024);
  for (let i = 0; i < buffer.length; i += 1) buffer[i] = (i * 31) % 251;
  return buffer;
}

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-love-membackup-'));
  const sessions = path.join(root, 'sessions');
  const memory = path.join(root, 'ai-love');
  const backupRoot = path.join(root, 'backup');
  const log = makeLog();
  await fs.mkdir(path.join(sessions, GROUP, 'attachment'), { recursive: true });
  await fs.mkdir(path.join(sessions, OTHER_GROUP), { recursive: true });
  await fs.mkdir(path.join(memory, 'summaries'), { recursive: true });
  await fs.writeFile(path.join(sessions, GROUP, 'session.v4.jsonl.zstd'), log);
  await fs.writeFile(path.join(sessions, GROUP, 'attachment', 'avatar.bin'), Buffer.from([0, 1, 2, 255]));
  await fs.writeFile(path.join(sessions, OTHER_GROUP, 'other.jsonl'), 'NOT-QQ');
  await fs.writeFile(path.join(memory, 'uncertain.jsonl'), '{"what":"x"}\n');
  await fs.writeFile(path.join(memory, 'summaries', 's.jsonl'), 'summary\n');
  await fs.writeFile(path.join(memory, 'tokenwise.jsonl.tmp-1-ab-2'), 'tmp');
  return { root, sessions, memory, backupRoot, log };
}

function exists(target) {
  return fs.stat(target).then(
    () => true,
    () => false,
  );
}

function backupFor(fixture, options = {}) {
  return new MemoryBackup({
    root: fixture.backupRoot,
    sessionsRoot: fixture.sessions,
    memoryDir: fixture.memory,
    watch: false,
    ...options,
  });
}

test('配置：逐字节备份默认开启，目录可显式覆盖', () => {
  const config = resolveConfig({});
  assert.equal(config.memoryBackup, true);
  assert.equal(config.memoryBackupDir, '');
  assert.throws(() => resolveConfig({ memoryBackup: 'yes' }), /memoryBackup/);
  assert.throws(() => resolveConfig({ memoryBackupDir: 1 }), /memoryBackupDir/);
  const base = path.join(os.tmpdir(), 'ai-love-backup-root');
  assert.equal(
    resolveMemoryBackupRoot({ backupDir: base }),
    path.join(path.resolve(base), 'qq-ai-memory-backup'),
  );
  assert.equal(
    resolveMemoryBackupRoot({ backupDir: base, memoryBackupDir: path.join(base, 'custom') }),
    path.resolve(base, 'custom'),
  );
});

test('首次同步：QQ 会话与爱ai 档案逐字节复制，manifest 记 sha256', async () => {
  const fixture = await makeFixture();
  try {
    const result = await backupFor(fixture).syncOnce({ reason: 'test' });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.busy, false);
    assert.match(result.folderName, /^\d{8}-\d{6}/);
    assert.deepEqual(
      await fs.readFile(path.join(result.folder, 'sessions', GROUP, 'session.v4.jsonl.zstd')),
      fixture.log,
    );
    assert.deepEqual(
      await fs.readFile(path.join(result.folder, 'sessions', GROUP, 'attachment', 'avatar.bin')),
      Buffer.from([0, 1, 2, 255]),
    );
    assert.equal(await exists(path.join(result.folder, 'sessions', OTHER_GROUP)), false);
    assert.equal(await exists(path.join(result.folder, 'ai-love', 'tokenwise.jsonl.tmp-1-ab-2')), false);

    const manifest = await readMemoryManifest(result.folder);
    assert.equal(manifest.files.length, 4);
    const rows = new Map(manifest.files.map((row) => [`${row.area}/${row.path}`, row]));
    const sessionRow = rows.get(`sessions/${GROUP}/session.v4.jsonl.zstd`);
    assert.equal(
      sessionRow.sha256,
      await sha256File(path.join(fixture.sessions, GROUP, 'session.v4.jsonl.zstd')),
    );
    assert.equal(sessionRow.size, fixture.log.length);
    assert.equal(sessionRow.exact, true);
    assert.equal(
      rows.get('ai-love/uncertain.jsonl').sha256,
      await sha256File(path.join(fixture.memory, 'uncertain.jsonl')),
    );

    const pointer = JSON.parse(await fs.readFile(path.join(fixture.backupRoot, '.current.json'), 'utf8'));
    assert.equal(pointer.folder, result.folderName);
    const status = await readMemoryBackupStatus({ root: fixture.backupRoot });
    assert.equal(status.ok, true);
    assert.equal(status.files, 4);
    assert.equal(status.bytes, result.bytes);
    assert.deepEqual(status.snapshots, [result.folderName]);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('增量同步：只追变化的文件，未变文件不重写', async () => {
  const fixture = await makeFixture();
  try {
    const backup = backupFor(fixture);
    const first = await backup.syncOnce({ reason: 'test' });
    const summaryDest = path.join(first.folder, 'ai-love', 'summaries', 's.jsonl');
    const summaryStat = await fs.stat(summaryDest);
    const extra = Buffer.from([9, 8, 7, 6]);
    await fs.appendFile(path.join(fixture.sessions, GROUP, 'session.v4.jsonl.zstd'), extra);
    await fs.writeFile(path.join(fixture.memory, 'uncertain.jsonl'), '{"what":"y"}\n');

    const second = await backup.syncOnce({ reason: 'test' });
    assert.equal(second.ok, true, JSON.stringify(second.errors));
    assert.equal(second.copied, 2);
    assert.equal(second.skipped, 2);
    assert.equal(second.folder, first.folder);
    assert.deepEqual(
      await fs.readFile(path.join(first.folder, 'sessions', GROUP, 'session.v4.jsonl.zstd')),
      Buffer.concat([fixture.log, extra]),
    );
    assert.equal(await fs.readFile(path.join(first.folder, 'ai-love', 'uncertain.jsonl'), 'utf8'), '{"what":"y"}\n');
    const afterSummary = await fs.stat(summaryDest);
    assert.equal(afterSummary.mtimeMs, summaryStat.mtimeMs);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('源文件消失：备份保留，manifest 标记 missingAt', async () => {
  const fixture = await makeFixture();
  try {
    const backup = backupFor(fixture);
    const first = await backup.syncOnce({ reason: 'test' });
    const dest = path.join(first.folder, 'ai-love', 'uncertain.jsonl');
    await fs.rm(path.join(fixture.memory, 'uncertain.jsonl'));
    const second = await backup.syncOnce({ reason: 'test' });
    assert.equal(second.ok, true, JSON.stringify(second.errors));
    assert.equal(second.kept, 1);
    assert.equal(await fs.readFile(dest, 'utf8'), '{"what":"x"}\n');
    const manifest = await readMemoryManifest(first.folder);
    const row = manifest.files.find((item) => item.area === 'ai-love' && item.path === 'uncertain.jsonl');
    assert.equal(typeof row.missingAt, 'string');
    const status = await readMemoryBackupStatus({ root: fixture.backupRoot });
    assert.equal(status.missing, 1);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('--new：另建时间戳快照，旧快照保留', async () => {
  const fixture = await makeFixture();
  try {
    const backup = backupFor(fixture);
    const first = await backup.syncOnce({ reason: 'test' });
    const second = await backup.syncOnce({ reason: 'test-new', newSnapshot: true });
    assert.notEqual(second.folder, first.folder);
    assert.equal(await exists(first.folder), true);
    assert.equal(second.copied, 4);
    assert.deepEqual(
      await fs.readFile(path.join(second.folder, 'sessions', GROUP, 'session.v4.jsonl.zstd')),
      fixture.log,
    );
    const pointer = JSON.parse(await fs.readFile(path.join(fixture.backupRoot, '.current.json'), 'utf8'));
    assert.equal(pointer.folder, second.folderName);
    const status = await readMemoryBackupStatus({ root: fixture.backupRoot });
    assert.equal(status.snapshots.length, 2);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('校验：sha256 一致才算通过，篡改会被发现', async () => {
  const fixture = await makeFixture();
  try {
    const backup = backupFor(fixture);
    const result = await backup.syncOnce({ reason: 'test' });
    const clean = await verifyMemoryBackup({
      root: fixture.backupRoot,
      sessionsRoot: fixture.sessions,
      memoryDir: fixture.memory,
    });
    assert.equal(clean.ok, true, JSON.stringify(clean.mismatches));
    assert.equal(clean.checked, 4);
    assert.equal(clean.mismatches.length, 0);

    const dest = path.join(result.folder, 'sessions', GROUP, 'session.v4.jsonl.zstd');
    await fs.writeFile(dest, Buffer.from('tampered'));
    const broken = await verifyMemoryBackup({
      root: fixture.backupRoot,
      sessionsRoot: fixture.sessions,
      memoryDir: fixture.memory,
    });
    assert.equal(broken.ok, false);
    assert.ok(
      broken.mismatches.some(
        (row) => row.area === 'sessions' && row.path.endsWith('session.v4.jsonl.zstd'),
      ),
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('跨进程锁：第二个写者拿不到锁，释放后可再拿', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-love-membackup-lock-'));
  try {
    const release = await acquireBackupLock(root);
    assert.equal(typeof release, 'function');
    assert.equal(await acquireBackupLock(root, { waitMs: 0 }), null);
    await release();
    const again = await acquireBackupLock(root, { waitMs: 0 });
    assert.equal(typeof again, 'function');
    await again();
    assert.equal(await exists(path.join(root, '.backup.lock')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('拒绝把备份根放进会话/档案目录（防自我嵌套）', async () => {
  const fixture = await makeFixture();
  try {
    const inside = new MemoryBackup({
      root: path.join(fixture.memory, 'snapshots'),
      sessionsRoot: fixture.sessions,
      memoryDir: fixture.memory,
      watch: false,
    });
    await assert.rejects(() => inside.syncOnce({ reason: 'bad' }), /重叠/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

async function makeJunction(t, target, link) {
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    await fs.symlink(target, link, type);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'ENOTSUP') {
      t.skip(`当前系统不允许创建目录联接：${error.code}`);
      return false;
    }
    throw error;
  }
}

test('树内联接不下钻：会话组里指向外面的联接不会被复制', async (t) => {
  const fixture = await makeFixture();
  try {
    const outside = path.join(fixture.root, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.txt'), 'OUTSIDE');
    if (!(await makeJunction(t, outside, path.join(fixture.sessions, GROUP, 'linked-out')))) return;
    const backup = backupFor(fixture);
    const result = await backup.syncOnce({ reason: 'test' });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(await exists(path.join(result.folder, 'sessions', GROUP, 'linked-out')), false);
    const manifest = await readMemoryManifest(result.folder);
    assert.equal(manifest.files.some((row) => row.path.includes('linked-out')), false);
    assert.ok(result.errors.some((line) => line.includes('内部联接未跟随')));
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('拒绝把备份根放进 QQ 会话组的联接目标里', async (t) => {
  const fixture = await makeFixture();
  try {
    const target = path.join(fixture.root, 'qq-target');
    await fs.rename(path.join(fixture.sessions, GROUP), target);
    if (!(await makeJunction(t, target, path.join(fixture.sessions, GROUP)))) return;
    const backup = new MemoryBackup({
      root: path.join(target, 'backup'),
      sessionsRoot: fixture.sessions,
      memoryDir: fixture.memory,
      watch: false,
    });
    await assert.rejects(() => backup.syncOnce({ reason: 'bad' }), /重叠/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('源被截断：旧字节留在 _history，镜像保留最新字节', async () => {
  const fixture = await makeFixture();
  try {
    const backup = backupFor(fixture);
    const first = await backup.syncOnce({ reason: 'test' });
    const source = path.join(fixture.sessions, GROUP, 'session.v4.jsonl.zstd');
    const original = await fs.readFile(source);
    await fs.writeFile(source, Buffer.from('truncated'));
    const second = await backup.syncOnce({ reason: 'test' });
    assert.equal(second.ok, true, JSON.stringify(second.errors));
    assert.equal(second.archived, 1);
    assert.equal(
      await fs.readFile(path.join(first.folder, 'sessions', GROUP, 'session.v4.jsonl.zstd'), 'utf8'),
      'truncated',
    );
    const historyDir = path.join(
      first.folder,
      '_history',
      'sessions',
      GROUP,
      'session.v4.jsonl.zstd',
    );
    const names = await fs.readdir(historyDir);
    assert.equal(names.length, 1);
    assert.deepEqual(await fs.readFile(path.join(historyDir, names[0])), original);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('后台实例会接管 CLI --new 新建的快照', async () => {
  const fixture = await makeFixture();
  try {
    const background = backupFor(fixture);
    const first = await background.syncOnce({ reason: 'bg' });
    const cli = backupFor(fixture);
    const second = await cli.syncOnce({ reason: 'cli', newSnapshot: true });
    assert.notEqual(first.folder, second.folder);
    const third = await background.syncOnce({ reason: 'bg-again' });
    assert.equal(third.folder, second.folder);
    assert.equal(third.busy, false);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('启动过程中 stop：watcher 全部关闭', async () => {
  const fixture = await makeFixture();
  const backup = backupFor(fixture, { watch: true, debounceMs: 20, maxDelayMs: 200, pollMs: 100 });
  try {
    const starting = backup.start();
    await backup.stop();
    await starting.catch(() => {});
    assert.equal(backup.watchers.length, 0);
    assert.equal(backup.groupWatchers.size, 0);
    assert.equal(backup.pollTimer, null);
    assert.equal(backup.watchersStarted, false);
  } finally {
    await backup.stop();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('锁心跳过期：活 pid 但心跳停了会被回收', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-love-membackup-stale-'));
  try {
    const file = path.join(root, '.backup.lock');
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        token: 'stale',
        pid: process.pid,
        host: os.hostname(),
        startedAt: new Date().toISOString(),
      }),
    );
    const old = new Date(Date.now() - 20 * 60_000);
    await fs.utimes(file, old, old);
    const release = await acquireBackupLock(root, { waitMs: 0 });
    assert.equal(typeof release, 'function');
    await release();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('校验遇到写入锁：报 busy，不误报损坏；释放后照常通过', async () => {
  const fixture = await makeFixture();
  try {
    const backup = backupFor(fixture);
    await backup.syncOnce({ reason: 'test' });
    const release = await acquireBackupLock(fixture.backupRoot);
    try {
      const busy = await verifyMemoryBackup({ root: fixture.backupRoot, waitMs: 0 });
      assert.equal(busy.busy, true);
      assert.equal(busy.ok, false);
      assert.equal(busy.mismatches.length, 0);
    } finally {
      await release();
    }
    const clean = await verifyMemoryBackup({ root: fixture.backupRoot, waitMs: 0 });
    assert.equal(clean.ok, true, JSON.stringify(clean.mismatches));
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('锁被接管：旧写者的 assertOwned 拒绝继续，释放也不删新锁', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-love-membackup-takeover-'));
  try {
    const release = await acquireBackupLock(root);
    const file = path.join(root, '.backup.lock');
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, token: 'new-owner', pid: process.pid, host: os.hostname() }),
    );
    await assert.rejects(() => release.assertOwned(), /备份锁已失效/);
    await release();
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(raw.token, 'new-owner');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('旧版归档失败：拒绝覆盖镜像，旧字节保留并报错', async () => {
  const fixture = await makeFixture();
  try {
    const backup = backupFor(fixture);
    const first = await backup.syncOnce({ reason: 'test' });
    const historyFile = path.join(
      first.folder,
      '_history',
      'sessions',
      GROUP,
      'session.v4.jsonl.zstd',
    );
    await fs.mkdir(path.dirname(historyFile), { recursive: true });
    await fs.writeFile(historyFile, 'blocker');
    await fs.writeFile(path.join(fixture.sessions, GROUP, 'session.v4.jsonl.zstd'), 'truncated');
    const second = await backup.syncOnce({ reason: 'test' });
    assert.equal(second.ok, false);
    assert.ok(second.errors.some((line) => line.includes('旧版本归档失败')));
    assert.deepEqual(
      await fs.readFile(path.join(first.folder, 'sessions', GROUP, 'session.v4.jsonl.zstd')),
      fixture.log,
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('遗留清理：清单内的 .old-* 文件不删，清单外的过期残留才删', async () => {
  const fixture = await makeFixture();
  try {
    await fs.writeFile(path.join(fixture.memory, 'notes.old-aaa-bbb-ccc'), 'legit');
    const backup = backupFor(fixture);
    const first = await backup.syncOnce({ reason: 'test' });
    const mirror = path.join(first.folder, 'ai-love', 'notes.old-aaa-bbb-ccc');
    const stray = path.join(first.folder, 'ai-love', 'stray.old-aaa-bbb-ccc');
    await fs.writeFile(stray, 'stale');
    const old = new Date(Date.now() - 2 * 3600_000);
    await fs.utimes(mirror, old, old);
    await fs.utimes(stray, old, old);
    backup.lastCleanAt = 0;
    const second = await backup.syncOnce({ reason: 'test-clean' });
    assert.equal(second.ok, true, JSON.stringify(second.errors));
    assert.equal(await fs.readFile(mirror, 'utf8'), 'legit');
    assert.equal(await exists(stray), false);
    assert.ok(second.cleaned >= 1);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('镜像被外部改写：下一轮自愈重拷', async () => {
  const fixture = await makeFixture();
  try {
    const backup = backupFor(fixture);
    const first = await backup.syncOnce({ reason: 'test' });
    const dest = path.join(first.folder, 'ai-love', 'uncertain.jsonl');
    const manifest = await readMemoryManifest(first.folder);
    const row = manifest.files.find((item) => item.area === 'ai-love' && item.path === 'uncertain.jsonl');
    await fs.writeFile(dest, '{"what":"y"}\n');
    const future = new Date(Date.parse(row.copiedAt) + 10 * 60_000);
    await fs.utimes(dest, future, future);
    const second = await backup.syncOnce({ reason: 'heal' });
    assert.equal(second.ok, true, JSON.stringify(second.errors));
    assert.equal(second.copied, 1);
    assert.equal(await fs.readFile(dest, 'utf8'), '{"what":"x"}\n');
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('快照指针丢失：接管源相同的最近快照，不新建', async () => {
  const fixture = await makeFixture();
  try {
    const first = await backupFor(fixture).syncOnce({ reason: 'cli', newSnapshot: true });
    await fs.rm(path.join(fixture.backupRoot, '.current.json'));
    const second = await backupFor(fixture).syncOnce({ reason: 'bg' });
    assert.equal(second.folder, first.folder);
    const status = await readMemoryBackupStatus({ root: fixture.backupRoot });
    assert.equal(status.snapshots.length, 1);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('启动预检失败：不抛异常，watcher 仍开并转入轮询重试', async () => {
  const fixture = await makeFixture();
  const backup = new MemoryBackup({
    root: path.join(fixture.memory, 'nested-backup'),
    sessionsRoot: fixture.sessions,
    memoryDir: fixture.memory,
    watch: true,
    debounceMs: 20,
    pollMs: 100,
  });
  try {
    await backup.start();
    assert.equal(backup.started, true);
    assert.equal(backup.watchersStarted, true);
    assert.ok(backup.watchers.length > 0);
    assert.match(backup.lastError, /重叠/);
    assert.ok(backup.debounceTimer !== null || backup.pollTimer !== null);
  } finally {
    await backup.stop();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('QQ 会话组不可读：计入失败，不静默当成功', async () => {
  const fixture = await makeFixture();
  try {
    await fs.rm(path.join(fixture.sessions, GROUP), { recursive: true, force: true });
    await fs.writeFile(path.join(fixture.sessions, GROUP), 'not-a-dir');
    const result = await backupFor(fixture).syncOnce({ reason: 'test' });
    assert.equal(result.ok, false);
    assert.ok(result.failed >= 1);
    assert.ok(result.errors.some((line) => line.includes('会话组不是可读目录')));
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('备份根属于另一个源：拒绝改写指针，不把快照并进来', async () => {
  const first = await makeFixture();
  const second = await makeFixture();
  try {
    const owned = await backupFor(first).syncOnce({ reason: 'first' });
    const foreign = new MemoryBackup({
      root: first.backupRoot,
      sessionsRoot: second.sessions,
      memoryDir: second.memory,
      watch: false,
    });
    await assert.rejects(() => foreign.syncOnce({ reason: 'foreign' }), /另一个源/);
    const pointer = JSON.parse(await fs.readFile(path.join(first.backupRoot, '.current.json'), 'utf8'));
    assert.equal(pointer.folder, owned.folderName);
  } finally {
    await fs.rm(first.root, { recursive: true, force: true });
    await fs.rm(second.root, { recursive: true, force: true });
  }
});

test('指针丢失也不把新快照建进另一个源的根', async () => {
  const first = await makeFixture();
  const second = await makeFixture();
  try {
    await backupFor(first).syncOnce({ reason: 'first' });
    await fs.rm(path.join(first.backupRoot, '.current.json'));
    const foreign = new MemoryBackup({
      root: first.backupRoot,
      sessionsRoot: second.sessions,
      memoryDir: second.memory,
      watch: false,
    });
    await assert.rejects(() => foreign.syncOnce({ reason: 'foreign' }), /另一个源/);
    const names = await fs.readdir(first.backupRoot);
    assert.equal(names.filter((name) => /^\d{8}-\d{6}$/.test(name)).length, 1);
  } finally {
    await fs.rm(first.root, { recursive: true, force: true });
    await fs.rm(second.root, { recursive: true, force: true });
  }
});

test('_history：同内容重拷不会挤掉真正的旧世代', async () => {
  const fixture = await makeFixture();
  try {
    const first = await backupFor(fixture).syncOnce({ reason: 'first' });
    const file = path.join(fixture.memory, 'summaries', 's.jsonl');
    await fs.writeFile(file, 'other!!\n'); // 与 'summary\n' 同长度，不同内容
    const second = await backupFor(fixture).syncOnce({ reason: 'changed' });
    const historyDir = path.join(second.folder, '_history', 'ai-love', 'summaries', 's.jsonl');
    assert.equal((await fs.readdir(historyDir)).length, 1);
    // 源内容不再变，只把 mtime 往前推，模拟“同字节重保存/时间戳被改”。
    const base = Date.now() / 1000 + 30;
    for (let i = 0; i < 6; i += 1) {
      await fs.utimes(file, base + i, base + i);
      const result = await backupFor(fixture).syncOnce({ reason: 'touch' });
      assert.equal(result.ok, true, JSON.stringify(result.errors));
    }
    const names = await fs.readdir(historyDir);
    assert.equal(names.length, 1);
    assert.equal(await fs.readFile(path.join(historyDir, names[0]), 'utf8'), 'summary\n');
    assert.equal(first.folder, second.folder);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('档案根不可读：计入失败，不把全部档案标 missingAt', async () => {
  const fixture = await makeFixture();
  try {
    const first = await backupFor(fixture).syncOnce({ reason: 'first' });
    await fs.rm(fixture.memory, { recursive: true, force: true });
    await fs.writeFile(fixture.memory, 'not-a-dir');
    const result = await backupFor(fixture).syncOnce({ reason: 'unreadable' });
    assert.equal(result.ok, false);
    assert.ok(result.failed >= 1);
    assert.ok(result.errors.some((line) => line.includes('不是目录')));
    const manifest = await readMemoryManifest(first.folder);
    const row = manifest.files.find((entry) => entry.area === 'ai-love' && entry.path === 'summaries/s.jsonl');
    assert.ok(row, '扫描失败时应保留原条目');
    assert.equal(row.missingAt, undefined);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('档案目录不存在：算空，不算失败', async () => {
  const fixture = await makeFixture();
  try {
    await fs.rm(fixture.memory, { recursive: true, force: true });
    const listed = await listMemoryArchiveFiles(fixture.memory);
    assert.equal(listed.unreadable, 0);
    assert.deepEqual(listed.files, []);
    const result = await backupFor(fixture).syncOnce({ reason: 'empty' });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('watch 建立失败：按退避重试，不随每个事件反复重建', async () => {
  const fixture = await makeFixture();
  await fs.rm(fixture.memory, { recursive: true, force: true });
  const backup = backupFor(fixture, { watch: true, debounceMs: 10, pollMs: 100 });
  try {
    await backup.start();
    assert.equal(backup.watchersStarted, false);
    assert.ok(backup.watchFailures >= 1);
    const retryAt = backup.watchRetryAt;
    const failures = backup.watchFailures;
    assert.ok(retryAt > Date.now());
    backup._schedule('watch');
    backup._schedule('watch');
    backup._schedule('poll');
    assert.equal(backup.watchRetryAt, retryAt);
    assert.equal(backup.watchFailures, failures);
  } finally {
    await backup.stop();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('实时镜像：启动后追加的字节自动追上', async () => {
  const fixture = await makeFixture();
  const backup = backupFor(fixture, { watch: true, debounceMs: 40, maxDelayMs: 400, pollMs: 120 });
  try {
    await backup.start();
    const dest = path.join(backup.folder, 'sessions', GROUP, 'session.v4.jsonl.zstd');
    assert.deepEqual(await fs.readFile(dest), fixture.log);
    const extra = Buffer.from('新的一轮对话\n');
    await fs.appendFile(path.join(fixture.sessions, GROUP, 'session.v4.jsonl.zstd'), extra);
    const expected = Buffer.concat([fixture.log, extra]);
    const deadline = Date.now() + 8000;
    let actual = null;
    while (Date.now() < deadline) {
      actual = await fs.readFile(dest).catch(() => null);
      if (actual !== null && actual.equals(expected)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(actual !== null && actual.equals(expected), '实时镜像没有追上追加内容');
  } finally {
    await backup.stop();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
