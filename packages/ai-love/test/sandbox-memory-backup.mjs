#!/usr/bin/env node
// 爱ai · 逐字节记忆备份预加热沙盒
//
// 不碰真实 ~/.dsh 与真实会话：
//   1. 在临时目录造 DSH_HOME、qq-bridge 会话组（9MiB 日志）、非 QQ 会话组、爱ai 档案；
//   2. 启动真实 MemoryBackup（watch + 轮询），验证首份快照逐字节一致；
//   3. 模拟聊天持续追加（512KiB × 3）与档案更新，验证实时增量自动追上；
//   4. 验证非 QQ 会话组不被复制；校验 manifest sha256；
//   5. 删源文件后备份保留；另建时间戳快照；篡改后 verify 必须失败。
//
// 用法：
//   node test/sandbox-memory-backup.mjs
//   AI_LOVE_PKG_ROOT=~/.dsh/plugins/ai-love node test/sandbox-memory-backup.mjs
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_ROOT = process.env.AI_LOVE_PKG_ROOT
  ? path.resolve(process.env.AI_LOVE_PKG_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(pathToFileURL(path.join(PKG_ROOT, 'src', 'core', 'memory-backup.mjs')).href);

const results = [];
function expect(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `　— ${detail}` : ''}`);
}

function sha(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

function makeRoots() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-love-membackup-sandbox-'));
  let backupBase = base;
  let cleanup = '';
  for (const letter of ['D:', 'E:', 'F:']) {
    const drive = `${letter}\\`;
    if (!fs.existsSync(drive)) continue;
    try {
      const dir = fs.mkdtempSync(path.join(drive, 'ai-love-sandbox-membackup-'));
      backupBase = dir;
      cleanup = dir;
      break;
    } catch {
      // 该盘不可写，继续
    }
  }
  return { base, backupRoot: path.join(backupBase, 'qq-ai-memory-backup'), cleanup };
}

async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}

const GROUP = '--C-Users-sandbox-documents-qq-bridge-main-state-agents--';
const OTHER = '--C-Users-sandbox-documents-web--';
const roots = makeRoots();
const sessions = path.join(roots.base, 'dsh', 'sessions');
const memory = path.join(roots.base, 'dsh', 'ai-love');
const sourceLog = path.join(sessions, GROUP, 'session.v4.jsonl.zstd');
const sourceLogOther = path.join(sessions, OTHER, 'other.jsonl');
const sourceUncertain = path.join(memory, 'uncertain.jsonl');
const sourceSummary = path.join(memory, 'summaries', 's1.jsonl');

fs.mkdirSync(path.join(sessions, GROUP, 'nested'), { recursive: true });
fs.mkdirSync(path.join(sessions, OTHER), { recursive: true });
fs.mkdirSync(path.join(memory, 'summaries'), { recursive: true });
fs.mkdirSync(path.join(memory, 'misc'), { recursive: true });

const big = Buffer.alloc(9 * 1024 * 1024);
for (let i = 0; i < big.length; i += 1) big[i] = (i * 17 + 11) % 253;
fs.writeFileSync(sourceLog, big);
fs.writeFileSync(path.join(sessions, GROUP, 'nested', 'attachment.bin'), Buffer.from([0, 255, 0, 255, 1]));
fs.writeFileSync(sourceLogOther, 'NOT-QQ-SESSION');
fs.writeFileSync(sourceUncertain, '{"what":"她提过周末","why":"没说哪天"}\n');
fs.writeFileSync(sourceSummary, '第一张记忆卡\n');
fs.writeFileSync(path.join(memory, 'misc', 'extra.txt'), '额外文件\n');

console.log('爱ai 逐字节记忆备份预加热沙盒');
console.log('='.repeat(60));
console.log(`临时源：${roots.base}`);
console.log(`备份根：${roots.backupRoot}`);
console.log('');

const backup = new mod.MemoryBackup({
  root: roots.backupRoot,
  sessionsRoot: sessions,
  memoryDir: memory,
  watch: true,
  debounceMs: 80,
  maxDelayMs: 600,
  pollMs: 300,
});

try {
  /* ── 1. 首份快照 ─────────────────────────────────── */
  await backup.start();
  const folder = backup.folder;
  const destLog = path.join(folder, 'sessions', GROUP, 'session.v4.jsonl.zstd');
  expect('首份快照：创建时间戳目录', /^\d{8}-\d{6}/.test(path.basename(folder)), path.basename(folder));
  expect('首份快照：9MiB 会话日志逐字节一致', sha(fs.readFileSync(destLog)) === sha(big), bytes(big.length));
  expect(
    '首份快照：嵌套附件逐字节一致',
    fs.readFileSync(path.join(folder, 'sessions', GROUP, 'nested', 'attachment.bin')).equals(
      Buffer.from([0, 255, 0, 255, 1]),
    ),
  );
  expect('隔离：非 QQ 会话组没有复制', !fs.existsSync(path.join(folder, 'sessions', OTHER)));
  expect('首份快照：爱ai 档案已复制', fs.existsSync(path.join(folder, 'ai-love', 'uncertain.jsonl')));
  expect('首份快照：manifest 已写入', fs.existsSync(path.join(folder, 'manifest.json')));
  const pointer = JSON.parse(fs.readFileSync(path.join(roots.backupRoot, '.current.json'), 'utf8'));
  expect('快照指针：指向当前目录', pointer.folder === path.basename(folder));

  /* ── 2. 实时增量：模拟聊天追加 ───────────────────── */
  let expected = big;
  for (let round = 1; round <= 3; round += 1) {
    const extra = Buffer.alloc(512 * 1024);
    for (let i = 0; i < extra.length; i += 1) extra[i] = (round * 29 + i * 7) % 256;
    fs.appendFileSync(sourceLog, extra);
    expected = Buffer.concat([expected, extra]);
    const caught = await waitFor(() => {
      try {
        return fs.readFileSync(destLog).equals(expected);
      } catch {
        return false;
      }
    });
    expect(`实时增量：第 ${round} 次追加 512KiB 自动追上`, Boolean(caught), bytes(expected.length));
  }

  /* ── 3. 实时增量：档案更新 ───────────────────────── */
  fs.appendFileSync(sourceUncertain, '{"what":"反摸是不是梗","why":"只出现一次"}\n');
  fs.writeFileSync(sourceSummary, '第一张记忆卡\n第二段记忆\n');
  const archiveCaught = await waitFor(() => {
    try {
      return (
        fs.readFileSync(path.join(folder, 'ai-love', 'uncertain.jsonl')).equals(fs.readFileSync(sourceUncertain)) &&
        fs.readFileSync(path.join(folder, 'ai-love', 'summaries', 's1.jsonl')).equals(fs.readFileSync(sourceSummary))
      );
    } catch {
      return false;
    }
  });
  expect('实时增量：爱ai 档案更新自动追上', Boolean(archiveCaught));

  /* ── 3.5 源被截断：旧字节进 _history ─────────────── */
  const beforeTruncate = fs.readFileSync(sourceSummary);
  fs.writeFileSync(sourceSummary, '短');
  const truncated = await waitFor(() => {
    try {
      return fs.readFileSync(path.join(folder, 'ai-love', 'summaries', 's1.jsonl'), 'utf8') === '短';
    } catch {
      return false;
    }
  });
  const historyDir = path.join(folder, '_history', 'ai-love', 'summaries', 's1.jsonl');
  const historyNames = fs.existsSync(historyDir) ? fs.readdirSync(historyDir) : [];
  const historyKept = historyNames.some((name) =>
    fs.readFileSync(path.join(historyDir, name)).equals(beforeTruncate),
  );
  expect(
    '截断留档：镜像更新且旧字节在 _history',
    Boolean(truncated) && historyKept,
    `${historyNames.length} 份旧版`,
  );

  /* ── 4. 完整性校验 ───────────────────────────────── */
  const clean = await mod.verifyMemoryBackup({ root: roots.backupRoot, sessionsRoot: sessions, memoryDir: memory });
  expect('校验：sha256 全部一致', clean.ok && clean.mismatches.length === 0, `${clean.checked} 个文件`);

  /* ── 5. 源文件消失：备份保留 ─────────────────────── */
  fs.rmSync(sourceUncertain);
  const kept = await waitFor(() => {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
      const row = manifest.files.find((item) => item.area === 'ai-love' && item.path === 'uncertain.jsonl');
      return row && typeof row.missingAt === 'string' && fs.existsSync(path.join(folder, 'ai-love', 'uncertain.jsonl'));
    } catch {
      return false;
    }
  });
  expect('源文件消失：备份保留并记 missingAt', Boolean(kept));

  await backup.stop();

  /* ── 6. 另建快照 ─────────────────────────────────── */
  const second = await backup.syncOnce({ reason: 'sandbox-new', newSnapshot: true });
  expect('--new：新建第二份快照', second.ok && second.folder !== folder, path.basename(second.folder));
  expect('--new：旧快照仍在', fs.existsSync(folder));
  expect(
    '--new：新快照 9MiB 日志一致',
    sha(fs.readFileSync(path.join(second.folder, 'sessions', GROUP, 'session.v4.jsonl.zstd'))) === sha(expected),
    bytes(expected.length),
  );

  /* ── 7. 篡改检测 ─────────────────────────────────── */
  const tamper = path.join(second.folder, 'ai-love', 'summaries', 's1.jsonl');
  fs.writeFileSync(tamper, 'TAMPERED');
  const broken = await mod.verifyMemoryBackup({ root: roots.backupRoot, sessionsRoot: sessions, memoryDir: memory });
  expect(
    '篡改：verify 明确失败并指出文件',
    !broken.ok && broken.mismatches.some((row) => row.path === 'summaries/s1.jsonl'),
    `${broken.mismatches.length} 处`,
  );
} catch (error) {
  expect('沙盒执行未抛异常', false, error instanceof Error ? error.message : String(error));
} finally {
  try {
    await backup.stop();
  } catch {
    // 已停止
  }
  try {
    fs.rmSync(roots.base, { recursive: true, force: true });
  } catch {
    // 临时目录
  }
  if (roots.cleanup !== '') {
    try {
      fs.rmSync(roots.cleanup, { recursive: true, force: true });
    } catch {
      // 目标盘清理失败不影响结论
    }
  }
}

const failed = results.filter((row) => !row.ok);
console.log(`\n预加热沙盒：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  for (const row of failed) console.log(`  ✘ ${row.name}　${row.detail}`);
  process.exitCode = 1;
}
