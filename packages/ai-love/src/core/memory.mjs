/**
 * ai-love · 记忆与留痕（纯功能）
 *
 *   <memoryDir>/summaries/<session>.jsonl   压缩记忆卡
 *   <memoryDir>/uncertain.jsonl             拿不准、要找用户确认的记忆
 *   <memoryDir>/facts.jsonl                 长期事实
 *   <memoryDir>/activity.jsonl              工作留痕
 *
 * 原则：
 *  - 写盘永远不挡住聊天（公开方法吞异常，返回可用的空结果）；
 *  - 不碰会话日志，只写自己的档案；
 *  - 坏行跳过，不因为一行脏数据丢整份档案；
 *  - 同一份记忆只存一次：外部 id + 内容哈希做幂等。
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';

import { homedir } from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from './atomic.mjs';

export const UNCERTAIN_FILE = 'uncertain.jsonl';
export const FACTS_FILE = 'facts.jsonl';
export const ACTIVITY_FILE = 'activity.jsonl';
export const SUMMARIES_DIR = 'summaries';

export function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  return path.join(homedir(), '.dsh');
}

export function resolveMemoryDir(config) {
  const explicit = typeof config?.memoryDir === 'string' ? config.memoryDir.trim() : '';
  return explicit !== '' ? path.resolve(explicit) : path.join(dshHome(), 'ai-love');
}

export function contentHash(text) {
  return createHash('sha256').update(String(text ?? '').replace(/\s+/g, ' ').trim(), 'utf8').digest('hex').slice(0, 32);
}

/** 秒/毫秒都接受，统一成毫秒。 */
export function toMs(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.round(number < 1e11 ? number * 1000 : number);
}

/** 秒/毫秒都接受，统一成秒。 */
export function toSeconds(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number <= 0) return Date.now() / 1000;
  return number >= 1e11 ? number / 1000 : number;
}

export function summaryText(record) {
  return String(record?.summary ?? record?.content ?? record?.text ?? '').trim();
}

export function summaryId(record) {
  return String(record?.externalId ?? record?.external_id ?? record?.id ?? '').trim();
}

function legacySessionFile(sessionId) {
  const safe = String(sessionId ?? 'unknown').replace(/[^\w.-]/g, '_').slice(0, 120);
  return `${safe || 'unknown'}.jsonl`;
}

/** 文件名不再依赖可逆/可碰撞的字符替换：base64url + 短哈希。 */
function hashedSessionFile(sessionId) {
  const raw = String(sessionId ?? 'unknown');
  const slug = Buffer.from(raw, 'utf8').toString('base64url').slice(0, 80) || 'unknown';
  const digest = createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 10);
  return `${slug}-${digest}.jsonl`;
}

async function readJsonl(file) {
  try {
    const text = await readFile(file, 'utf8');
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        // 坏行跳过
      }
    }
    return rows;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeJsonl(file, rows) {
  await mkdir(path.dirname(file), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  await writeFileAtomic(file, body + (rows.length > 0 ? '\n' : ''));
}

async function appendJsonl(file, row) {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function rowBelongsTo(row, sessionId) {
  const sid = String(sessionId ?? '');
  const stored = String(row?.sessionId ?? row?.session_id ?? '');
  return stored === '' || stored === sid;
}

export class CompactStore {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = dir;
    /** @type {Map<string, any[]>} sessionId → uncertain entries */
    this.uncertainBySession = new Map();
    /** @type {Map<string, {open: number, resolved: number, dropped: number}>} */
    this.counters = new Map();
    this.loaded = false;
    this.loadPromise = null;
  }

  get uncertainFile() {
    return path.join(this.dir, UNCERTAIN_FILE);
  }

  get factsFile() {
    return path.join(this.dir, FACTS_FILE);
  }

  get summariesDir() {
    return path.join(this.dir, SUMMARIES_DIR);
  }

  /**
   * 每次都从磁盘重建内存档案（面板与引擎各有实例，读一次缓存会互踩）。
   * 读失败时保留旧的内存数据并允许下次重试 —— 绝不把「读不出来」当「档案是空的」。
   */
  async load() {
    if (this.loadPromise !== null) return this.loadPromise;
    this.loadPromise = (async () => {
      try {
        const rows = await readJsonl(this.uncertainFile);
        const byId = new Map();
        for (const row of rows) {
          if (row === null || typeof row !== 'object') continue;
          const id = typeof row.id === 'string' ? row.id : '';
          if (id === '') continue;
          byId.set(id, row);
        }
        const nextBySession = new Map();
        for (const row of byId.values()) {
          const sessionId = typeof row.sessionId === 'string' ? row.sessionId : 'unknown';
          const list = nextBySession.get(sessionId) ?? [];
          list.push(row);
          nextBySession.set(sessionId, list);
        }
        this.uncertainBySession = nextBySession;
        this._recount();
        this.loaded = true;
      } catch {
        // 保持旧内存状态；下一次调用还会重试
      } finally {
        this.loadPromise = null;
      }
    })();
    return this.loadPromise;
  }

  _recount() {
    const counters = new Map();
    for (const [sessionId, list] of this.uncertainBySession) {
      const counter = { open: 0, resolved: 0, dropped: 0 };
      for (const row of list) {
        if (row.status === 'open') counter.open += 1;
        else if (row.status === 'resolved') counter.resolved += 1;
        else if (row.status === 'dropped' || row.status === 'rejected') counter.dropped += 1;
      }
      counters.set(sessionId, counter);
    }
    this.counters = counters;
  }

  openItems(sessionId) {
    const list = this.uncertainBySession.get(String(sessionId)) ?? [];
    return list.filter((row) => row.status === 'open');
  }

  countOpen(sessionId) {
    return this.countOpenAndResolved(sessionId).open;
  }

  countOpenAndResolved(sessionId) {
    const counter = this.counters.get(String(sessionId)) ?? { open: 0, resolved: 0, dropped: 0 };
    return { open: counter.open, resolved: counter.resolved, dropped: counter.dropped };
  }

  /** 记录一批新的「拿不准」。有外部 id 按 id 去重，否则同 session 内 what 相同视为重复。 */
  async addUncertain(sessionId, items, options = {}) {
    if (!Array.isArray(items) || items.length === 0) return [];
    await this.load();
    const sid = String(sessionId ?? 'unknown');
    const list = this.uncertainBySession.get(sid) ?? [];
    const knownIds = new Set(list.map((row) => String(row.id ?? '')));
    const knownWhat = new Set(list.map((row) => String(row.what ?? '').trim()));
    const added = [];
    const now = options.now ?? Date.now();
    let index = 0;
    for (const item of items) {
      const what = String(item?.what ?? '').trim();
      if (what === '') continue;
      const externalId = String(item?.externalId ?? item?.external_id ?? item?.id ?? '').trim();
      const id = externalId || `${now.toString(36)}-${process.pid.toString(36)}-${index}-${Math.random().toString(36).slice(2, 6)}`;
      if (knownIds.has(id) || (externalId === '' && knownWhat.has(what))) continue;
      const row = {
        id,
        ts: toMs(item?.ts ?? item?.ts_ms) || now,
        sessionId: sid,
        what,
        why: String(item?.why ?? '').trim(),
        ask: String(item?.ask ?? '').trim(),
        status: String(item?.status ?? 'open').trim().toLowerCase() || 'open',
        mentions: Number(item?.mentions ?? 0),
        adminReply: String(item?.adminReply ?? ''),
        repliedAt: Number(item?.repliedAt ?? 0),
        replyState: String(item?.replyState ?? ''),
        aiNote: String(item?.aiNote ?? ''),
      };
      if (row.status === 'dropped') row.status = 'dropped';
      index += 1;
      knownIds.add(id);
      knownWhat.add(what);
      list.push(row);
      added.push(row);
    }
    if (added.length === 0) return [];
    this.uncertainBySession.set(sid, list);
    this._recount();
    try {
      await mkdir(this.dir, { recursive: true });
      const lines = added.map((row) => JSON.stringify(row)).join('\n');
      await appendFile(this.uncertainFile, `${lines}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // 落盘失败：内存里仍有，下一次压缩/工具还能看到
    }
    return added;
  }

  /** 按 id 幂等写入一条待确认记忆（跨会话可更新）。 */
  async upsertUncertain(record) {
    await this.load();
    const id = String(record?.id ?? '').trim();
    if (id === '') return null;
    const found = this.findUncertain(id);
    const sid = String(record?.sessionId ?? found?.sid ?? 'unknown');
    const list = this.uncertainBySession.get(sid) ?? [];
    let row = found?.row;
    const created = row === undefined;
    if (row === undefined) {
      row = {
        id,
        ts: toMs(record?.ts ?? record?.ts_ms) || Date.now(),
        sessionId: sid,
        what: '',
        why: '',
        ask: '',
        status: 'open',
        mentions: 0,
        adminReply: '',
        repliedAt: 0,
        replyState: '',
        aiNote: '',
      };
      list.push(row);
      this.uncertainBySession.set(sid, list);
    }
    if (record?.what !== undefined) row.what = String(record.what);
    if (record?.why !== undefined) row.why = String(record.why);
    if (record?.ask !== undefined) row.ask = String(record.ask);
    if (record?.status !== undefined) {
      const next = String(record.status);
      const old = String(row.status ?? 'open');
      // 已结案的不被迟到的 open 记录改回去。
      row.status = ['resolved', 'dropped', 'rejected'].includes(old) && ['open', 'confirmed'].includes(next)
        ? old
        : next;
    }
    if (record?.chat_type !== undefined) row.chat_type = String(record.chat_type);
    if (record?.group_id !== undefined) row.group_id = String(record.group_id);
    if (record?.peer !== undefined) row.peer = String(record.peer);
    if (record?.ts !== undefined || record?.ts_ms !== undefined) row.ts = toMs(record.ts ?? record.ts_ms);
    if (record?.adminReply !== undefined) row.adminReply = String(record.adminReply);
    if (record?.replyState !== undefined) row.replyState = String(record.replyState);
    if (record?.aiNote !== undefined) row.aiNote = String(record.aiNote);
    this._recount();
    await this.persistUncertain();
    return { row, created };
  }

  /** 改写一条状态（resolved/dropped），整份档案原子重写。 */
  async setUncertainStatus(sessionId, id, status) {
    await this.load();
    const sid = String(sessionId ?? 'unknown');
    const list = this.uncertainBySession.get(sid) ?? [];
    const target = list.find((row) => row.id === id);
    if (target === undefined) return null;
    if (target.status === status) return target;
    target.status = status;
    target.resolvedAt = Date.now();
    this._recount();
    await this.persistUncertain();
    return target;
  }

  async noteMention(sessionId, id) {
    await this.load();
    const sid = String(sessionId ?? 'unknown');
    const list = this.uncertainBySession.get(sid) ?? [];
    const target = list.find((row) => row.id === id);
    if (target === undefined) return;
    target.mentions = Number(target.mentions ?? 0) + 1;
    target.lastMentionedAt = Date.now();
    await this.persistUncertain();
  }

  /** 跨会话找一条。 */
  findUncertain(id) {
    const key = String(id ?? '');
    for (const [sid, list] of this.uncertainBySession) {
      const row = list.find((item) => String(item.id) === key);
      if (row !== undefined) return { sid, row };
    }
    return null;
  }

  /**
   * 用户在面板回复一条拿不准的记忆。
   * 回复先落盘，状态 pending-ai；等 QQ 上的 AI 确认/不认同。
   */
  async replyUncertain(id, reply) {
    await this.load();
    const text = String(reply ?? '').trim();
    if (text === '') throw new Error('回复不能为空');
    const found = this.findUncertain(id);
    if (found === null) return null;
    found.row.adminReply = text.slice(0, 1000);
    found.row.repliedAt = Date.now();
    found.row.replyState = 'pending-ai';
    await this.persistUncertain();
    return found.row;
  }

  /**
   * AI 确认用户的回复：accept = 接受并标记已确认；dispute = 不认同，保持待确认。
   */
  async ackUncertain(id, decision, note = '') {
    await this.load();
    const found = this.findUncertain(id);
    if (found === null) return null;
    const { row } = found;
    const verdict = decision === 'dispute' ? 'disputed' : decision === 'accept' ? 'acknowledged' : null;
    if (verdict === null) throw new Error('decision 只能是 accept / dispute');
    row.replyState = verdict;
    row.aiNote = String(note ?? '').trim().slice(0, 500);
    row.ackedAt = Date.now();
    if (verdict === 'acknowledged') {
      row.status = 'resolved';
      row.resolvedAt = Date.now();
    }
    this._recount();
    await this.persistUncertain();
    return row;
  }

  /** 已收到用户回复、等 AI 确认的条目（按会话）。 */
  pendingReplies(sessionId) {
    const sid = String(sessionId ?? 'unknown');
    const list = this.uncertainBySession.get(sid) ?? [];
    return list.filter((row) => row.replyState === 'pending-ai');
  }

  /**
   * 全量重写前先把磁盘行合并进来（按 id，内存行代表本次改动、优先）：
   * 面板与引擎双实例交错写时，任何一方都不许把对方的行抹掉。
   */
  async persistUncertain() {
    const memRows = [];
    for (const list of this.uncertainBySession.values()) memRows.push(...list);
    const byId = new Map();
    try {
      for (const row of await readJsonl(this.uncertainFile)) {
        if (row !== null && typeof row === 'object' && typeof row.id === 'string') byId.set(row.id, row);
      }
    } catch {
      // 磁盘读不动时只写内存行
    }
    for (const row of memRows) byId.set(row.id, row);
    const rows = [...byId.values()];
    rows.sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));
    try {
      await writeJsonl(this.uncertainFile, rows);
    } catch {
      // 保持内存状态
    }
  }

  /** 会话对应的记忆卡文件；旧文件名如属于别的会话，就改用哈希名，避免串档。 */
  async summaryFileFor(sessionId) {
    const sid = String(sessionId ?? 'unknown');
    const legacy = path.join(this.summariesDir, legacySessionFile(sid));
    try {
      const rows = await readJsonl(legacy);
      if (rows.length === 0 || rows.every((row) => rowBelongsTo(row, sid))) return legacy;
    } catch {
      // 读不动就用新文件名
    }
    return path.join(this.summariesDir, hashedSessionFile(sid));
  }

  async summaryFilesFor(sessionId) {
    const sid = String(sessionId ?? 'unknown');
    const legacy = path.join(this.summariesDir, legacySessionFile(sid));
    const hashed = path.join(this.summariesDir, hashedSessionFile(sid));
    const files = [legacy];
    if (hashed !== legacy) files.push(hashed);
    return files;
  }

  async readSessionSummaries(sessionId) {
    const sid = String(sessionId ?? 'unknown');
    const rows = [];
    for (const file of await this.summaryFilesFor(sid)) {
      for (const row of await readJsonl(file)) {
        if (row !== null && typeof row === 'object' && rowBelongsTo(row, sid)) rows.push(row);
      }
    }
    return rows;
  }

  /** 追加一份压缩记忆卡；没有外部 id 时生成稳定 id，方便互通去重。 */
  async appendSummary(sessionId, record) {
    const sid = String(sessionId ?? 'unknown');
    const text = summaryText(record);
    if (text === '') return null;
    const now = toMs(record?.ts) || Date.now();
    const row = {
      ...record,
      ts: now,
      sessionId: sid,
      externalId: summaryId(record) || `ai-love:summary:${sid}:${now}:${contentHash(text).slice(0, 12)}`,
      contentHash: String(record?.contentHash ?? record?.content_hash ?? contentHash(text)),
    };
    try {
      await appendJsonl(await this.summaryFileFor(sid), row);
      return row;
    } catch {
      // 摘要落盘失败不影响压缩本身
      return row;
    }
  }

  /** 按外部 id 或内容哈希幂等写入记忆卡。 */
  async upsertSummary(sessionId, record) {
    const sid = String(sessionId ?? 'unknown');
    const text = summaryText(record);
    if (text === '') return null;
    const file = await this.summaryFileFor(sid);
    const rows = await readJsonl(file);
    const externalId = summaryId(record);
    const hash = String(record?.contentHash ?? record?.content_hash ?? contentHash(text));
    let index = externalId === ''
      ? -1
      : rows.findIndex((row) => summaryId(row) !== '' && summaryId(row) === externalId);
    if (index < 0) {
      index = rows.findIndex(
        (row) => contentHash(summaryText(row)) === hash && rowBelongsTo(row, sid),
      );
    }
    const now = toMs(record?.ts) || Date.now();
    if (index >= 0) {
      rows[index] = {
        ...rows[index],
        ...record,
        ts: now,
        sessionId: sid,
        externalId: externalId || summaryId(rows[index]),
        contentHash: hash,
      };
      await writeJsonl(file, rows);
      return { row: rows[index], created: false };
    }
    const row = {
      ...record,
      ts: now,
      sessionId: sid,
      externalId: externalId || `ai-love:summary:${sid}:${now}:${hash.slice(0, 12)}`,
      contentHash: hash,
    };
    await writeJsonl(file, [...rows, row]);
    return { row, created: true };
  }

  /** 读最近 N 份记忆卡；query 在所有可能的正文字段里过滤。 */
  async recallSummaries(sessionId, limit = 3, query = '') {
    let rows = await this.readSessionSummaries(sessionId);
    const needle = String(query ?? '').trim().toLowerCase();
    if (needle !== '') {
      rows = rows.filter((row) => summaryText(row).toLowerCase().includes(needle));
    }
    rows.sort((a, b) => toMs(a?.ts) - toMs(b?.ts));
    return rows.slice(-Math.max(1, limit)).reverse();
  }

  /** 当前会话最近一份记忆卡。 */
  async latestSummary(sessionId) {
    const rows = await this.recallSummaries(sessionId, 1, '');
    return rows[0];
  }

  /** 全部会话的记忆卡数量（安装检查/统计用）。 */
  async summaryStats() {
    try {
      const files = (await readdir(this.summariesDir)).filter((file) => file.endsWith('.jsonl'));
      return { files: files.length };
    } catch {
      return { files: 0 };
    }
  }

  /** 全部会话最多 N 份记忆卡（倒序）。 */
  async listRecentSummaries(limit = 5) {
    const rows = await this.allSummaries();
    return rows.slice(0, Math.max(1, limit));
  }

  /** 全部记忆卡（按 ts 倒序；导出用）。 */
  async allSummaries() {
    try {
      const files = (await readdir(this.summariesDir)).filter((file) => file.endsWith('.jsonl'));
      const rows = [];
      for (const file of files) {
        for (const entry of await readJsonl(path.join(this.summariesDir, file))) {
          if (entry !== null && typeof entry === 'object' && summaryText(entry) !== '') rows.push(entry);
        }
      }
      rows.sort((a, b) => toMs(b?.ts) - toMs(a?.ts));
      return rows;
    } catch {
      return [];
    }
  }

  /** 全部记忆卡条数。 */
  async countSummaries() {
    return (await this.allSummaries()).length;
  }

  /* ───────────── 长期事实 ───────────── */

  async allFacts() {
    try {
      return (await readJsonl(this.factsFile)).filter(
        (row) => row !== null && typeof row === 'object' && String(row.text ?? row.fact ?? '').trim() !== '',
      );
    } catch {
      return [];
    }
  }

  async upsertFact(record) {
    const rows = await this.allFacts();
    const externalId = String(record?.externalId ?? record?.external_id ?? '').trim();
    const text = String(record?.text ?? record?.fact ?? '').trim();
    if (text === '') return null;
    const hash = String(record?.contentHash ?? record?.content_hash ?? contentHash(text));
    let index = externalId === ''
      ? -1
      : rows.findIndex((row) => String(row.externalId ?? row.external_id ?? '') === externalId);
    if (index < 0) {
      index = rows.findIndex(
        (row) => String(row.sessionId ?? '') === String(record?.sessionId ?? '') &&
          contentHash(String(row.text ?? row.fact ?? '')) === hash,
      );
    }
    const row = {
      ...record,
      ts: toMs(record?.ts ?? record?.ts_ms) || Date.now(),
      externalId: externalId || `ai-love:fact:${record?.sessionId ?? 'unknown'}:${hash.slice(0, 12)}`,
      contentHash: hash,
      text,
      status: String(record?.status ?? 'open') || 'open',
    };
    if (index >= 0) {
      const existing = rows[index];
      const oldStatus = String(existing.status ?? 'open');
      const nextStatus = String(row.status ?? 'open');
      // 状态不倒退、重要度不缩水：迟到的旧记录不能把已确认/已否掉的事实改回去。
      const status = (['rejected', 'resolved'].includes(oldStatus) && ['open', 'confirmed'].includes(nextStatus)) ||
        (oldStatus === 'confirmed' && nextStatus === 'open')
        ? oldStatus
        : nextStatus;
      rows[index] = {
        ...existing,
        ...row,
        status,
        importance: Math.max(Number(existing.importance ?? 0), Number(row.importance ?? 0)),
      };
      await writeJsonl(this.factsFile, rows);
      return { row: rows[index], created: false };
    }
    rows.push(row);
    rows.sort((a, b) => toMs(a?.ts) - toMs(b?.ts));
    await writeJsonl(this.factsFile, rows);
    return { row, created: true };
  }

  async factsFor(sessionId, limit = 20) {
    const sid = String(sessionId ?? '');
    const rows = (await this.allFacts()).filter(
      (row) =>
        String(row.sessionId ?? row.session_id ?? '') === sid &&
        ['open', 'confirmed'].includes(String(row.status ?? 'open')),
    );
    rows.sort((a, b) => toMs(b?.ts) - toMs(a?.ts));
    return rows.slice(0, Math.max(1, limit));
  }

  async listFactsAll(limit = 1000) {
    const rows = await this.allFacts();
    rows.sort((a, b) => toMs(b?.ts) - toMs(a?.ts));
    return rows.slice(0, Math.max(1, limit));
  }

  /* ───────────── 留痕与待确认列表 ───────────── */

  async listRecentActivity(limit = 30) {
    try {
      const rows = await readJsonl(path.join(this.dir, ACTIVITY_FILE));
      return rows.slice(-Math.max(1, limit)).reverse();
    } catch {
      return [];
    }
  }

  async listUncertainAll(limit = 30) {
    await this.load();
    const rows = [];
    for (const list of this.uncertainBySession.values()) rows.push(...list);
    rows.sort((a, b) => Number(b.ts ?? 0) - Number(a.ts ?? 0));
    return rows.slice(0, Math.max(1, limit));
  }

  async allUncertain() {
    await this.load();
    const rows = [];
    for (const list of this.uncertainBySession.values()) rows.push(...list);
    rows.sort((a, b) => toMs(a?.ts) - toMs(b?.ts));
    return rows;
  }

  /** 留痕：一次压缩的成功/失败。 */
  async logActivity(record) {
    try {
      await appendJsonl(path.join(this.dir, ACTIVITY_FILE), record);
    } catch {
      // 留痕失败不挡聊天
    }
  }
}

/**
 * 把「拿不准」渲染成一段给模型看的提醒。
 * 只给最需要确认的一两条，不要变成待办列表。
 */
export function renderPending(store, sessionId, options = {}) {
  const limit = Math.max(0, options.limit ?? 1);
  if (limit === 0) return '';
  const maxMentions = Math.max(1, options.maxMentions ?? 2);
  const replies = typeof store.pendingReplies === 'function' ? store.pendingReplies(sessionId) : [];
  const replyBlock =
    replies.length === 0
      ? ''
      : [
          '【用户回复了你的拿不准】',
          ...replies.slice(0, 2).map((row) => {
            const what = String(row.what ?? '').trim();
            const reply = String(row.adminReply ?? '').trim();
            return `- 「${what}」：用户说「${reply}」（id=${row.id}）`;
          }),
          '用 compact_pending(action="ack", id="...") 表示接受，这条会标成已确认；',
          '不认同就用 compact_pending(action="dispute", id="...", note="原因")，它会继续留在待确认里。',
        ].join('\n');
  const items = store
    .openItems(sessionId)
    .filter((row) => Number(row.mentions ?? 0) < maxMentions)
    .filter((row) => row.replyState !== 'pending-ai');
  if (items.length === 0) return replyBlock;
  const picked = items.slice(0, limit);
  const lines = picked.map((row) => {
    const what = String(row.what ?? '').trim();
    const why = String(row.why ?? '').trim();
    const ask = String(row.ask ?? '').trim();
    const parts = [`- 「${what}」`];
    if (why !== '') parts.push(`线索：${why}`);
    if (ask !== '') parts.push(`可以问：「${ask}」`);
    return parts.join(' · ');
  });
  const remind = [
    '【有拿不准的记忆】',
    ...lines,
    '这些是之前聊天里没确认的事。合适的时候自然问一句确认；不要为了确认而打断正在聊的话题，也别反复提。',
  ].join('\n');
  return [replyBlock, remind].filter(Boolean).join('\n\n');
}

/** 长期事实的提示段落（按会话隔离）。 */
export function renderFacts(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const limit = Math.max(1, Number(options.limit ?? 20));
  const lines = rows.slice(0, limit).map((row) => {
    const subject = String(row.subject ?? '').trim();
    const text = String(row.text ?? row.fact ?? '').trim();
    return `- ${subject === '' ? '' : `${subject}：`}${text}`;
  });
  return ['【确定事实】', ...lines].join('\n');
}

/** 供工具渲染的记忆卡文本。 */
export function renderSummary(record, index = 1) {
  const ts = toMs(record?.ts);
  const when = ts > 0 ? new Date(ts).toLocaleString('zh-CN') : '';
  const head = `#${index}${when === '' ? '' : ` · ${when}`}`;
  return `${head}\n${summaryText(record)}`;
}
