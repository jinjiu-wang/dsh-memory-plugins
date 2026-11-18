#!/usr/bin/env node
// ai-love · QQ AI 运行记忆的逐字节备份 CLI
//
// 备份内容：
//   - ~/.dsh/sessions 下名字带 qq-bridge 的会话组（原始会话日志，逐字节）
//   - ~/.dsh/ai-love 整个档案目录（记忆卡、待确认、角色卡、隐私、token 统计…）
//
// 命令：
//   node memory-backup.mjs               # 看当前快照状态
//   node memory-backup.mjs --once        # 立刻增量同步一次（没有快照就新建）
//   node memory-backup.mjs --new         # 新建一个 <时间戳> 快照并全量复制
//   node memory-backup.mjs --verify      # 重算备份文件 sha256，校验完整性
//   node memory-backup.mjs --json        # 机器可读输出（配合上面任意命令）
//
// 目录：<备份根>/<YYYYMMDD-HHmmss>/
//   manifest.json          每个文件的 size / mtime / sha256
//   sessions/<组>/...      QQ 会话日志原始字节
//   ai-love/...            爱ai 档案原始字节
//   <备份根>/.current.json 指向当前实时镜像目录
//
// 实时备份由 DSH 启动后的爱ai 后端负责（watch + 定时对账）；这个 CLI 用于
// 首次快照、手动补一次和校验。源目录只读，源文件消失时备份不会被删。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MemoryBackup,
  readMemoryBackupStatus,
  resolveMemoryBackupRoot,
  verifyMemoryBackup,
} from './src/core/memory-backup.mjs';
import { resolveDshHome, samePath } from './src/core/context-link.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
};

function readText(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function dshHome() {
  const given = opt('dsh-home');
  if (given !== undefined && given.trim() !== '') return path.resolve(given);
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return path.resolve(env.trim());
  return path.join(os.homedir(), '.dsh');
}

function installState(home) {
  try {
    const state = JSON.parse(readText(path.join(home, 'plugins', 'ai-love', '.install-state.json')));
    if (typeof state?.dshHome === 'string' && state.dshHome !== '') {
      if (!samePath(state.dshHome, home)) return {};
    } else if (!samePath(home, path.join(os.homedir(), '.dsh'))) {
      // 旧版 state 没有 dshHome：只认默认 home，别让沙盒误用生产快照根。
      return {};
    }
    return state ?? {};
  } catch {
    return {};
  }
}

function humanBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return String(value);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function printStatus(status) {
  console.log('ai-love 记忆逐字节备份');
  console.log('='.repeat(60));
  console.log(`备份根   : ${status.root}`);
  if (!status.ok) {
    console.log(`状态     : ✘ ${status.error}`);
    if (status.snapshots.length > 0) console.log(`已有快照 : ${status.snapshots.join('、')}`);
    console.log('下一步   : node memory-backup.mjs --once（立刻建首份快照）');
    return;
  }
  console.log(`当前快照 : ${status.folderName}`);
  console.log(`更新时间 : ${status.updatedAt || '（未知）'}`);
  console.log(
    `文件/字节: ${status.files} 个 / ${humanBytes(status.bytes)}` +
      `（会话 ${status.sessions.files} 个 ${humanBytes(status.sessions.bytes)}；` +
      `爱ai ${status.aiLove.files} 个 ${humanBytes(status.aiLove.bytes)}）`,
  );
  console.log(`源已消失 : ${status.missing} 个（备份保留，不删）`);
  console.log(`历史快照 : ${status.snapshots.length} 份${status.snapshots.length > 0 ? `（${status.snapshots.join('、')}）` : ''}`);
  if (status.errors.length > 0) {
    console.log(`最近警告 : ${status.errors.length} 条`);
    for (const line of status.errors.slice(0, 5)) console.log(`  - ${line}`);
  }
  console.log('');
  console.log('实时增量由 DSH 里的爱ai 后端负责；DSH 运行时新写入会自动镜像到这里。');
}

function printSync(result) {
  if (result.busy) {
    console.log(`⏳ ${result.error}`);
    return false;
  }
  console.log(`快照     : ${result.folderName}`);
  console.log(`本次复制 : ${result.copied} 个；跳过未变 ${result.skipped} 个；源已消失保留 ${result.kept} 个`);
  if (Number(result.archived) > 0) {
    console.log(`旧版留档 : ${result.archived} 份（源被截断/原地重写时，旧字节在快照 _history/ 下）`);
  }
  if (Number(result.unstable) > 0) {
    console.log(`⚠️  有 ${result.unstable} 个文件复制时源仍在变化（exact:false），下一轮会继续追`);
  }
  console.log(`当前总计 : ${result.files} 个 / ${humanBytes(result.bytes)}`);
  if (result.errors.length > 0) {
    console.log(`⚠️  警告 ${result.errors.length} 条（源文件可能正在写入，下一轮会再追）：`);
    for (const line of result.errors.slice(0, 8)) console.log(`  - ${line}`);
  }
  console.log(
    `结论     : ${
      result.ok
        ? Number(result.unstable) > 0
          ? '⚠️ 已复制，但有文件仍在变化，下一轮继续追'
          : '✔ 逐字节备份完成'
        : '✘ 有文件本次没备成功'
    }`,
  );
  return result.ok;
}

function printVerify(result) {
  if (result.busy) {
    console.log(`⏳ ${result.error}`);
    return;
  }
  if (typeof result.lockWarning === 'string' && result.lockWarning !== '') {
    console.log(`⚠️  ${result.lockWarning}`);
  }
  console.log(`快照     : ${result.folder}`);
  console.log(`校验文件 : ${result.checked}/${result.files} 个，${humanBytes(result.bytes)}`);
  if (result.mismatches.length > 0) {
    console.log(`✘ 损坏/缺失 ${result.mismatches.length} 个：`);
    for (const row of result.mismatches.slice(0, 20)) {
      console.log(`  - ${row.area}/${row.path}：${row.reason}`);
    }
    if (result.mismatches.length > 20) console.log(`  …还有 ${result.mismatches.length - 20} 个`);
  }
  if (result.lagging.length > 0) {
    console.log(`· 源文件比备份新 ${result.lagging.length} 个（正常，下一轮增量会追上）：`);
    for (const row of result.lagging.slice(0, 8)) {
      console.log(`  - ${row.area}/${row.path}：备份 ${row.backupBytes} / 源 ${row.sourceBytes} 字节`);
    }
  }
  if (result.absentFromSource.length > 0) {
    console.log(`· 源文件已消失但备份仍在 ${result.absentFromSource.length} 个（按设计保留）`);
  }
  console.log(`结论     : ${result.ok ? '✔ 备份文件与 manifest 完全一致' : '✘ 备份完整性校验失败'}`);
}

async function main() {
  if (flag('help') || flag('h')) {
    console.log('用法：node memory-backup.mjs [--once | --new | --verify] [--json]');
    console.log('  --once                立刻增量同步（没有快照就新建）');
    console.log('  --new                 另建一个时间戳快照并全量复制');
    console.log('  --verify              重算快照文件 sha256，校验完整性');
    console.log('  --backup-root <目录>  覆盖备份根（默认 <面板备份目录>/qq-ai-memory-backup）');
    console.log('  --snapshot <名字>     校验指定快照（默认 .current.json 指向的那个）');
    console.log('  --sessions <目录>     覆盖 DSH 会话根');
    console.log('  --memory <目录>       覆盖爱ai 档案目录');
    console.log('  --dsh-home <目录>     覆盖 DSH_HOME；没给 --backup-root 时快照根也放到该目录下');
    console.log('  --json                机器可读输出');
    console.log('');
    console.log('旧版本：源被截断/原地重写时保留下来的字节在 <快照>/_history/<区域>/<路径>/<文件名>/。');
    return 0;
  }

  for (const name of ['backup-root', 'snapshot', 'sessions', 'memory', 'dsh-home']) {
    if (!args.includes(`--${name}`)) continue;
    const value = opt(name);
    if (value === undefined || value.trim() === '') {
      console.error(`✘ --${name} 需要一个非空值`);
      return 1;
    }
  }

  const home = dshHome();
  const state = installState(home);
  const envHome =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '';
  const homeGiven = opt('dsh-home') !== undefined || envHome;
  const root =
    opt('backup-root') !== undefined
      ? path.resolve(opt('backup-root'))
      : typeof process.env.AI_LOVE_MEMORY_BACKUP_DIR === 'string' &&
          process.env.AI_LOVE_MEMORY_BACKUP_DIR.trim() !== ''
        ? path.resolve(process.env.AI_LOVE_MEMORY_BACKUP_DIR.trim())
        : typeof state.memoryBackupRoot === 'string' && state.memoryBackupRoot.trim() !== ''
          ? path.resolve(state.memoryBackupRoot)
          : homeGiven
            ? path.join(home, 'qq-ai-memory-backup')
            : resolveMemoryBackupRoot({ backupDir: typeof state.backupDir === 'string' ? state.backupDir : '' });
  const sessionsRoot =
    opt('sessions') !== undefined
      ? path.resolve(opt('sessions'))
      : opt('dsh-home') !== undefined
        ? path.join(home, 'sessions')
        : typeof state.sessionsRoot === 'string' && state.sessionsRoot.trim() !== ''
          ? path.resolve(state.sessionsRoot)
          : path.join(home, 'sessions');
  const memoryDir =
    opt('memory') !== undefined
      ? path.resolve(opt('memory'))
      : typeof state.dshHome === 'string' && state.dshHome.trim() !== ''
        ? path.join(state.dshHome, 'ai-love')
        : path.join(home, 'ai-love');

  const wantVerify = flag('verify') || opt('snapshot') !== undefined;
  if (wantVerify) {
    // 没显式指定源路径时，让校验按 manifest 里记录的源来比对，避免默认值误报。
    const verifyOptions = { root, snapshot: opt('snapshot') };
    if (opt('sessions') !== undefined) verifyOptions.sessionsRoot = path.resolve(opt('sessions'));
    else if (opt('dsh-home') !== undefined) verifyOptions.sessionsRoot = path.join(home, 'sessions');
    if (opt('memory') !== undefined) verifyOptions.memoryDir = path.resolve(opt('memory'));
    else if (opt('dsh-home') !== undefined) verifyOptions.memoryDir = path.join(home, 'ai-love');
    const result = await verifyMemoryBackup(verifyOptions);
    if (flag('json')) console.log(JSON.stringify({ root, ...result }, null, 2));
    else printVerify(result);
    return result.ok ? 0 : 1;
  }

  if (flag('once') || flag('new')) {
    const backup = new MemoryBackup({ root, sessionsRoot, memoryDir, watch: false });
    const result = await backup.syncOnce({
      reason: flag('new') ? 'cli-new' : 'cli',
      newSnapshot: flag('new'),
    });
    if (flag('json')) console.log(JSON.stringify({ root, sessionsRoot, memoryDir, ...result }, null, 2));
    else {
      console.log('ai-love 记忆逐字节备份');
      console.log('='.repeat(60));
      console.log(`备份根   : ${root}`);
      console.log(`会话根   : ${sessionsRoot}`);
      console.log(`档案目录 : ${memoryDir}`);
      printSync(result);
    }
    return result.busy || !result.ok ? 1 : 0;
  }

  const status = await readMemoryBackupStatus({ root });
  if (flag('json')) console.log(JSON.stringify({ root, sessionsRoot, memoryDir, ...status }, null, 2));
  else printStatus(status);
  return status.ok ? 0 : 1;
}

const code = await main().catch((error) => {
  console.error(`✘ ${error instanceof Error ? error.message : String(error)}`);
  return 1;
});
process.exit(code);
