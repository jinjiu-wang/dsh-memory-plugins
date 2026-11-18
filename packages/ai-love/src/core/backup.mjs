/**
 * 爱ai · 管理面板备份
 *
 * 使用者装好插件后，在一个非系统盘建 `<盘>:\爱ai`，把面板上体现的东西
 * 按模块 / 职能 / 功能分门别类写成文字文档，随时可翻、可带走。
 *
 * 硬规矩：
 *   - 隐私记录只在 AI「退役（亡语）」且可读时备份正文；在場时即使审批通过、未通过或永恒秘密都只写状态，绝不写内容。
 *   - 备份是单向导出；不反向改插件档案。
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const BACKUP_DIR_NAME = '爱ai';
export const BACKUP_META_FILE = 'backup.json';
/** 原始档案快照目录（一键找回用）。 */
export const RAW_DIR = '_raw';
/** 默认自动同步间隔（分钟）。 */
export const DEFAULT_BACKUP_INTERVAL_MINUTES = 10;

/** Windows 上枚举固定磁盘（DriveType=3，排除系统盘）；拿不到就返回 null 走回退。 */
function fixedDriveLetters() {
  if (process.platform !== 'win32') return null;
  try {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object -ExpandProperty DeviceID",
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    if (result.status !== 0) return null;
    const letters = String(result.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim().slice(0, 1).toUpperCase())
      .filter((letter) => /^[A-Z]$/.test(letter) && letter !== 'C')
      .sort();
    return letters.length === 0 ? null : [...new Set(letters)];
  } catch {
    return null;
  }
}

/** 找一个非系统盘建备份目录；显式给路径就用给的。 */
export function detectBackupDir(explicit) {
  const given = String(explicit ?? '').trim();
  if (given !== '') return path.resolve(given);
  // v0.16.1：优先固定磁盘，避免把 U 盘 / 网络盘 / 光驱选成备份目标。
  const fixed = fixedDriveLetters();
  if (fixed !== null) return path.join(`${fixed[0]}:\\`, BACKUP_DIR_NAME);
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`;
    try {
      if (existsSync(root)) return path.join(root, BACKUP_DIR_NAME);
    } catch {
      // 继续找
    }
  }
  return path.join(os.homedir(), BACKUP_DIR_NAME);
}

function ts(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n).toLocaleString('zh-CN');
}

function heading(text) {
  return `# ${text}`;
}

function section(title) {
  return `\n## ${title}\n`;
}

function listOrEmpty(lines, empty = '（空）') {
  return lines.length === 0 ? empty : lines.join('\n');
}

/**
 * 把面板数据渲染成一组模块文档。
 * @param {any} snapshot 面板数据（见 panel 的 collectSnapshot）
 * @returns {{name: string, content: string}[]}
 */
export function renderBackupFiles(snapshot = {}) {
  const generatedAt = Number(snapshot.generatedAt ?? Date.now());
  const version = String(snapshot.version ?? '');
  const stats = snapshot.stats ?? {};
  const files = [];

  files.push({
    name: 'README.md',
    content: [
      heading('爱ai · 管理面板备份'),
      '',
      `生成时间：${ts(generatedAt)}`,
      `插件版本：v${version}`,
      '',
      '这个文件夹是「爱ai」面板的模块化文字备份。面板上能看到的区块，这里各有一份对应文档：',
      '',
      '| 文档 | 对应面板模块 |',
      '|---|---|',
      '| `01-概览.md` | 数字统计 |',
      '| `02-逻辑痕迹.md` | 逻辑痕迹 |',
      '| `03-记忆卡.md` | 记忆卡 |',
      '| `04-拿不准的记忆.md` | 拿不准的记忆 |',
      '| `05-压缩自检.md` | 压缩自检 |',
      '| `06-角色卡/` | 角色卡、言行记录、改卡申请、变更历史 |',
      '| `07-隐私记录/` | 隐私记录（只备份退役亡语的正文，其余只写状态） |',
      '| `08-配置与版本.md` | 配置与版本 |',
      '| `09-上下文联通.md` | 上下文联通（QQ 会话日志 → 非系统盘） |',
      '',
      '> 隐私记录里未通过审批的内容只记录状态，不记录正文。',
      '',
    ].join('\n'),
  });

  files.push({
    name: '01-概览.md',
    content: [
      heading('01 · 概览'),
      '',
      `- 最近压缩：${Number(stats.compactions ?? 0)} 次`,
      `- 记忆卡：${Number(stats.memoryCards ?? 0)} 份`,
      `- 待确认记忆：${Number(stats.openUncertain ?? 0)} 条`,
      `- 已确认事实：${Number(stats.facts ?? 0)} 条`,
      `- 档案目录：${snapshot.memoryDir ?? ''}`,
      `- 生成时间：${ts(generatedAt)}`,
      '',
    ].join('\n'),
  });

  const activity = Array.isArray(snapshot.activity) ? snapshot.activity : [];
  files.push({
    name: '02-逻辑痕迹.md',
    content: [
      heading('02 · 逻辑痕迹'),
      '',
      ...activity.map((row) => {
        const kind =
          row?.type === 'compacted'
            ? '压缩'
            : row?.type === 'pressure-error'
              ? '自动压缩失败'
              : row?.type === 'overflow-error'
                ? '溢出恢复失败'
                : row?.type === 'uncertain-note'
                  ? '用户回答'
                  : String(row?.type ?? '事件');
        const detail =
          row?.type === 'compacted'
            ? `释放 ~${row.shadowedTokens ?? 0} tokens · 记忆卡 ${row.summaryChars ?? 0} 字 · 拿不准 ${row.uncertainCount ?? 0} 条`
            : String(row?.message ?? '');
        return `- ${ts(row?.ts)} · ${kind} · ${detail}`;
      }),
      '',
    ].join('\n'),
  });

  const summaries = Array.isArray(snapshot.summaries) ? snapshot.summaries : [];
  files.push({
    name: '03-记忆卡.md',
    content: [
      heading('03 · 记忆卡'),
      '',
      ...summaries.flatMap((row, index) => [
        `## 记忆卡 ${index + 1} · ${ts(row?.ts)}`,
        '',
        `- 触发：${row?.trigger ?? ''} · 释放 ~${row?.shadowedTokens ?? 0} tokens · 拿不准 ${row?.uncertainCount ?? 0} 条`,
        '',
        String(row?.summary ?? '（空）'),
        '',
        '---',
        '',
      ]),
    ].join('\n'),
  });

  const uncertain = Array.isArray(snapshot.uncertain) ? snapshot.uncertain : [];
  files.push({
    name: '04-拿不准的记忆.md',
    content: [
      heading('04 · 拿不准的记忆'),
      '',
      ...uncertain.map((row) => {
        const status = row?.status === 'open' ? '待确认' : row?.status === 'resolved' ? '已确认' : '已丢弃';
        const parts = [`- [${status}] ${row?.what ?? ''}`];
        if (row?.why) parts.push(`  - 线索：${row.why}`);
        if (row?.ask) parts.push(`  - 可以问：${row.ask}`);
        if (row?.adminReply) {
          const replyState =
            row?.replyState === 'pending-ai'
              ? '等 AI 确认'
              : row?.replyState === 'acknowledged'
                ? 'AI 已确认'
                : row?.replyState === 'disputed'
                  ? 'AI 有异议'
                  : '';
          parts.push(`  - 管理员回复：${row.adminReply}${replyState ? `（${replyState}）` : ''}`);
        }
        if (row?.aiNote) parts.push(`  - AI：${row.aiNote}`);
        return parts.join('\n');
      }),
      '',
    ].join('\n'),
  });

  const consents = Array.isArray(snapshot.consents) ? snapshot.consents : [];
  files.push({
    name: '05-压缩自检.md',
    content: [
      heading('05 · 压缩自检'),
      '',
      ...consents.map((row) => {
        const status =
          row?.status === 'pending-ai'
            ? '等 AI 核对'
            : row?.status === 'approved'
              ? 'AI 同意'
              : row?.status === 'applied'
                ? '已压缩'
                : row?.status === 'rejected'
                  ? 'AI 拒绝'
                  : row?.status === 'forced'
                    ? '系统强制'
                    : String(row?.status ?? '');
        return [
          `- ${ts(row?.ts)} · ${status} · 删 ${row?.deleteCount ?? 0} 条 / 留 ${row?.keepCount ?? 0} 条`,
          row?.deletePreview ? `  - 删除预览：${row.deletePreview}` : '',
          row?.aiReason ? `  - AI：${row.aiReason}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      }),
      '',
    ].join('\n'),
  });

  const character = snapshot.character ?? {};
  files.push({
    name: '06-角色卡/卡.md',
    content: [
      heading('06 · 角色卡'),
      '',
      `- 版本：v${character?.meta?.version ?? 0}`,
      `- 来源：${character?.meta?.byLabel ?? '还没写过'}`,
      `- 言行样本：${character?.meta?.samples ?? 0} 条`,
      '',
      String(character?.card ?? '').trim() || '（还没有角色卡）',
      '',
    ].join('\n'),
  });
  const behavior = Array.isArray(character?.behavior) ? character.behavior : [];
  files.push({
    name: '06-角色卡/言行记录.md',
    content: [
      heading('06 · 言行记录（最近 20 条）'),
      '',
      ...behavior.map((row) => `- ${ts(row?.ts)} · ${String(row?.text ?? '')}`),
      '',
    ].join('\n'),
  });
  const proposals = Array.isArray(character?.proposals) ? character.proposals : [];
  files.push({
    name: '06-角色卡/改卡申请.md',
    content: [
      heading('06 · 改卡申请'),
      '',
      ...proposals.map((row) => {
        const status =
          row?.status === 'pending-ai'
            ? '等 AI 表态'
            : row?.status === 'ai-approved'
              ? 'AI 已同意，等放行'
              : row?.status === 'ai-rejected'
                ? 'AI 拒绝'
                : row?.status === 'applied'
                  ? '已生效'
                  : row?.status === 'overridden'
                    ? '管理员覆盖'
                    : String(row?.status ?? '');
        return [
          `- ${ts(row?.ts)} · ${row?.level === 3 ? '三级' : '二级'} · ${status}`,
          row?.aiReason ? `  - AI：${row.aiReason}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      }),
      '',
    ].join('\n'),
  });
  const history = Array.isArray(character?.history) ? character.history : [];
  files.push({
    name: '06-角色卡/变更历史.md',
    content: [
      heading('06 · 角色卡变更历史'),
      '',
      ...history.map((row) => `- ${ts(row?.ts)} · ${row?.by ?? ''} · v${row?.version ?? ''} · ${row?.chars ?? 0} 字`),
      '',
    ].join('\n'),
  });

  const legacy = Array.isArray(snapshot.legacy) ? snapshot.legacy : [];
  files.push({
    name: '07-隐私记录/索引.md',
    content: [
      heading('07 · 隐私记录'),
      '',
      '只有 AI **退役（死亡）**后的记录才备份正文；AI 还活着时，即使申请通过，也只备份状态，不落盘正文。',
      '未通过审批的记录只写状态。',
      '',
      ...legacy.map((row) => {
        const state = row?.state ?? {};
        const items = [`- ${row?.label ?? row?.aiId ?? ''} · ${state.label ?? ''} · ${ts(row?.updatedAt)}`];
        if (state.retired === true && state.canView === true && row?.content) {
          items.push(`  - 正文见同目录下的记录文档`);
        }
        return items.join('\n');
      }),
      '',
    ].join('\n'),
  });
  for (const row of legacy) {
    if (row?.state?.retired !== true || row?.state?.canView !== true || !row?.content) continue;
    files.push({
      name: `07-隐私记录/${safeFile(String(row.aiId ?? '记录'))}.md`,
      content: [
        heading(`隐私记录 · ${row.label ?? row.aiId}`),
        '',
        `- 状态：${row.state.label ?? ''}`,
        `- 更新时间：${ts(row.updatedAt)}`,
        '',
        String(row.content),
        '',
      ].join('\n'),
    });
  }

  const configRows = snapshot.config ?? {};
  const link = snapshot.contextLink ?? null;
  // 读取失败时 totals 会被兜底成 0，不能再当成真实统计展示。
  const linkUnknown = link === null || Boolean(link?.error);
  const linkText = (value) => (typeof value === 'string' && value !== '' ? value : '未知（本次未能读取）');
  const linkStateLabel = (state) =>
    ({
      linked: '已联通',
      ready: '待激活（退出 DSH 后运行 link-context.mjs --apply）',
      conflict: '目标已存在且非空',
      'broken-link': '联接目标丢失',
      'linked-elsewhere': '已联接到别处',
      unsupported: '不支持的类型',
      interrupted: '上次搬迁中断（运行 link-context.mjs --apply 恢复）',
      missing: '源目录缺失',
      error: '读取失败',
    })[state] ?? String(state ?? '');
  files.push({
    name: '08-配置与版本.md',
    content: [
      heading('08 · 配置与版本'),
      '',
      `- 插件版本：v${version}`,
      `- 记忆目录：${snapshot.memoryDir ?? ''}`,
      `- 备份目录：${snapshot.backupDir ?? ''}`,
      `- 生成时间：${ts(generatedAt)}`,
      '',
      '主要配置：',
      '',
      ...Object.entries(configRows).map(([key, value]) => `- \`${key}\`：${String(value)}`),
      '',
    ].join('\n'),
  });

  files.push({
    name: '09-上下文联通.md',
    content: [
      heading('09 · 上下文联通'),
      '',
      `- DSH 会话根：${linkText(link?.sessionsRoot)}`,
      `- 联通目标：${linkText(link?.linkRoot)}`,
      `- 目标在系统盘：${
        linkUnknown ? '未知' : link.linkRootOnSystemDrive === true ? '是（建议换非系统盘）' : '否'
      }`,
      `- QQ 会话组：${
        linkUnknown
          ? '未知'
          : `${Number(link.totals?.groups ?? 0)} 个（已联通 ${Number(link.totals?.linked ?? 0)}，待激活 ${Number(link.totals?.ready ?? 0)}，中断 ${Number(link.totals?.interrupted ?? 0)}）`
      }`,
      `- 会话日志总量：${linkUnknown ? '未知' : `${Number(link.totals?.bytes ?? 0)} 字节`}`,
      ...(link?.error ? [`- 读取错误：${String(link.error)}`] : []),
      '- 落盘不设字节上限；模型可见的注入仍由压缩与上下文窗口控制。',
      '',
      '| 会话组 | 状态 | 文件 | 字节 | 实际目标 |',
      '|---|---|---|---|---|',
      ...(Array.isArray(link?.groups) ? link.groups : []).map(
        (row) =>
          `| \`${String(row.name).replace(/\|/g, '\\|')}\` | ${linkStateLabel(row.state)} | ${Number(row.files ?? 0)} | ${Number(row.bytes ?? 0)} | \`${String(row.actualTarget || row.target || '').replace(/\|/g, '\\|')}\` |`,
      ),
      '',
      '> 搬迁必须在 DSH 完全退出后进行；运行中只读展示，不碰正在写的日志。',
      '',
    ].join('\n'),
  });

  return files;
}

function safeFile(value) {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\.+$/, '').slice(0, 80) || '记录';
}

/** 备份管理器：按间隔自动同步，也支持手动同步。 */
export class BackupManager {
  /** @param {{dir: string, intervalMs: number}} options */
  constructor(options) {
    this.dir = String(options.dir);
    this.intervalMs = Number(options.intervalMs ?? DEFAULT_BACKUP_INTERVAL_MINUTES * 60_000);
    this.lastSyncAt = 0;
    this.syncing = null;
    this.metaLoaded = null;
  }

  async loadMeta() {
    if (this.metaLoaded !== null) return this.metaLoaded;
    this.metaLoaded = (async () => {
      try {
        const raw = JSON.parse(await readFile(path.join(this.dir, BACKUP_META_FILE), 'utf8'));
        this.lastSyncAt = Number(raw?.lastSyncAt ?? 0);
      } catch {
        this.lastSyncAt = 0;
      }
      return this.lastSyncAt;
    })();
    return this.metaLoaded;
  }

  shouldSync(now = Date.now()) {
    return this.intervalMs > 0 && now - this.lastSyncAt >= this.intervalMs;
  }

  async sync(snapshot) {
    if (this.syncing !== null) return this.syncing;
    this.syncing = (async () => {
      const generatedAt = Date.now();
      const files = renderBackupFiles({ ...snapshot, generatedAt, backupDir: this.dir });
      await mkdir(this.dir, { recursive: true });
      for (const file of files) {
        const target = path.join(this.dir, file.name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content, 'utf8');
      }
      // 清掉旧版本可能留在隐私目录里的正文（AI 还活着时不该有正文文件）。
      try {
        const legacyDir = path.join(this.dir, '07-隐私记录');
        const keep = new Set(
          files
            .filter((file) => file.name.startsWith('07-隐私记录/'))
            .map((file) => path.basename(file.name)),
        );
        for (const name of await readdir(legacyDir)) {
          if (!name.endsWith('.md') || keep.has(name)) continue;
          await unlink(path.join(legacyDir, name));
        }
      } catch {
        // 目录还不存在
      }
      await writeFile(
        path.join(this.dir, BACKUP_META_FILE),
        `${JSON.stringify({ dir: this.dir, lastSyncAt: generatedAt, files: files.map((file) => file.name) }, null, 2)}\n`,
        'utf8',
      );
      this.lastSyncAt = generatedAt;
      // 原始档案快照：找回用。只备份非隐私档案与「退役亡语」的隐私记录。
      try {
        await this.snapshotRaw(snapshot.memoryDir, Array.isArray(snapshot.legacyFiles) ? snapshot.legacyFiles : []);
      } catch {
        // 快照失败不影响模块文档
      }
      return { dir: this.dir, lastSyncAt: generatedAt, files: files.map((file) => file.name) };
    })().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  /**
   * 原始档案快照（找回用）：
   *   _raw/memory/     facts.jsonl、uncertain.jsonl、activity.jsonl、compact-consent.json、summaries/
   *   _raw/character/  card.md、card.meta.json、behavior.jsonl、history.jsonl、proposals.json
   *   _raw/legacy/     只放「亡语」记录的原始 JSON，其余不落盘（沿用隐私边界）
   */
  async snapshotRaw(memoryDir, legacyFiles = []) {
    if (typeof memoryDir !== 'string' || memoryDir.trim() === '') return false;
    const rawRoot = path.join(this.dir, RAW_DIR);
    // v0.16.1：先建完整新快照再整体换入。旧实现「先删后写」，中途失败会把唯一找回源掏空。
    const tmpRoot = `${rawRoot}.new-${Date.now().toString(36)}-${process.pid.toString(36)}`;
    await mkdir(path.join(tmpRoot, 'memory', 'summaries'), { recursive: true });
    await mkdir(path.join(tmpRoot, 'character'), { recursive: true });
    // 旧实现漏建 legacy/，导致亡语原始档案 cp 静默失败、快照里永远没有隐私档案。
    await mkdir(path.join(tmpRoot, 'legacy'), { recursive: true });
    const copyIfExists = async (from, to) => {
      try {
        await cp(from, to, { force: true });
      } catch {
        // 文件不存在就跳过
      }
    };
    await copyIfExists(path.join(memoryDir, 'uncertain.jsonl'), path.join(tmpRoot, 'memory', 'uncertain.jsonl'));
    await copyIfExists(path.join(memoryDir, 'facts.jsonl'), path.join(tmpRoot, 'memory', 'facts.jsonl'));
    await copyIfExists(path.join(memoryDir, 'activity.jsonl'), path.join(tmpRoot, 'memory', 'activity.jsonl'));
    await copyIfExists(path.join(memoryDir, 'compact-consent.json'), path.join(tmpRoot, 'memory', 'compact-consent.json'));
    try {
      for (const file of await readdir(path.join(memoryDir, 'summaries'))) {
        if (!file.endsWith('.jsonl')) continue;
        await copyIfExists(path.join(memoryDir, 'summaries', file), path.join(tmpRoot, 'memory', 'summaries', file));
      }
    } catch {
      // 还没有记忆卡
    }
    for (const file of ['card.md', 'card.meta.json', 'behavior.jsonl', 'history.jsonl', 'proposals.json']) {
      await copyIfExists(path.join(memoryDir, 'character', file), path.join(tmpRoot, 'character', file));
    }
    for (const source of legacyFiles) {
      if (typeof source !== 'string') continue;
      await copyIfExists(source, path.join(tmpRoot, 'legacy', path.basename(source)));
    }
    // 换入新快照：先把旧 _raw 改名留底，新快照就位后再删旧目录。
    // 直接 rm 旧目录再 rename，一旦 rm/rename 中途失败，唯一找回源就没了。
    const oldRoot = `${rawRoot}.old-${Date.now().toString(36)}-${process.pid.toString(36)}`;
    let oldMoved = false;
    try {
      if (existsSync(rawRoot)) {
        await rename(rawRoot, oldRoot);
        oldMoved = true;
      }
      try {
        await rename(tmpRoot, rawRoot);
      } catch (error) {
        if (oldMoved) await rename(oldRoot, rawRoot).catch(() => {});
        throw error;
      }
    } catch (error) {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    if (oldMoved) await rm(oldRoot, { recursive: true, force: true }).catch(() => {});
    return true;
  }

  /**
   * 一键找回：用 _raw 快照覆盖回 memoryDir。
   * 覆盖前先把当前档案整份另存到 _restore-<时间>/，防止误伤。
   */
  async restore(memoryDir) {
    if (typeof memoryDir !== 'string' || memoryDir.trim() === '') {
      throw new Error('没有可恢复的档案目录');
    }
    const rawRoot = path.join(this.dir, RAW_DIR);
    if (!existsSync(rawRoot)) {
      throw new Error('还没有可用的备份快照；先在面板点「立即同步」。');
    }
    const safetyDir = path.join(this.dir, `_restore-${Date.now()}`);
    try {
      await cp(memoryDir, safetyDir, { recursive: true, force: true });
    } catch {
      // 当前档案不存在或读不了：安全网跳过
    }
    await mkdir(memoryDir, { recursive: true });
    let restored = 0;
    const copyTree = async (from, to) => {
      try {
        await cp(from, to, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    };
    if (await copyTree(path.join(rawRoot, 'memory'), memoryDir)) restored += 1;
    if (await copyTree(path.join(rawRoot, 'character'), path.join(memoryDir, 'character'))) restored += 1;
    const legacy = path.join(rawRoot, 'legacy');
    if (existsSync(legacy)) {
      if (await copyTree(legacy, path.join(memoryDir, 'legacy'))) restored += 1;
    }
    return { safetyDir, restored, restoredAt: Date.now() };
  }
}
