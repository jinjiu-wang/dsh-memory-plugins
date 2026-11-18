/**
 * ai-love · 跨插件记忆互通（规范记录 v1）
 *
 * 交换文件是 JSONL，一行一条：
 *   {schema_version, source, external_id, ts_ms, chat_type, group_id, peer,
 *    session_id, kind, text, status, importance, subject, category, ask, why,
 *    content_hash}
 *
 * 只交换记忆本身：不包含角色、人设、语气、情绪等任何设定。
 * 导入按 source+external_id / 内容哈希去重，重复跑不会膨胀。
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { contentHash, summaryId, summaryText, toMs } from './memory.mjs';

export const SCHEMA_VERSION = 1;
export const SOURCE_AILOVE = 'ai-love';
const MAX_INTEROP_BYTES = 128 * 1024 * 1024; // 单个互通文件上限，防止整文件读入撑爆内存

/** 目标不存在时沿父目录逐级 realpath，把 junction/符号链接解成真实位置。 */
function realpathLoose(target) {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      const resolved = realpathSync.native(current);
      return tail.length === 0 ? resolved : path.join(resolved, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function inside(root, candidate) {
  const a = path.resolve(root);
  const b = path.resolve(candidate);
  if (process.platform === 'win32') {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    return lb === la || lb.startsWith(`${la}${path.sep}`);
  }
  return b === a || b.startsWith(`${a}${path.sep}`);
}

/** 互通文件的路径检查：词法在根内、真实路径也在根内（挡住根内软链接越界）。 */
export function resolveInteropPath(requested, roots, options = {}) {
  const allowed = roots
    .filter((root) => typeof root === 'string' && root.trim() !== '')
    .map((root) => path.resolve(root));
  if (allowed.length === 0) throw new Error('没有可用的互通目录');
  const raw = String(requested ?? '').trim();
  if (raw === '') throw new Error('路径不能为空');
  const candidates = [];
  if (path.isAbsolute(raw)) candidates.push(path.resolve(raw));
  else for (const root of allowed) candidates.push(path.resolve(root, raw));
  const realAllowed = allowed.map(realpathLoose);
  const picked = candidates.find((candidate) => {
    if (!allowed.some((root) => inside(root, candidate))) return false;
    if (options.mustExist === true && !existsSync(candidate)) return false;
    const real = realpathLoose(candidate);
    return realAllowed.some((root) => inside(root, real));
  });
  if (picked === undefined) {
    throw new Error(`路径必须位于 ${allowed.join(' 或 ')} 内${options.mustExist ? '且文件存在' : ''}`);
  }
  return picked;
}

function assertInteropSize(file) {
  const info = statSync(file);
  if (!info.isFile()) throw new Error('互通路径不是普通文件');
  if (info.size > MAX_INTEROP_BYTES) {
    throw new Error(`互通文件太大（${info.size} 字节，上限 ${MAX_INTEROP_BYTES}）`);
  }
}

const PERSONA_HEADING_MARKS = [
  '管理员', '情感', '人格', '语气', '人设', '角色设定',
  '性格', '口癖', '口头禅', '说话风格', '情绪轨迹', '未说出口',
];
const HEADING_RE = /^(#{1,6})\s*(.+?)\s*$/;
const TAG_BLOCK_RE = /<protocol-conflict>[\s\S]*?<\/protocol-conflict>/gi;
const TAG_RE = /<\/?(?:uncertain|protocol-conflict)>/gi;

function headingIsPersona(heading) {
  const plain = String(heading ?? '').replace(/[\s/／、，,。:：()（）\-—_]+/g, '');
  return PERSONA_HEADING_MARKS.some((mark) => plain.includes(mark));
}

/** 去掉记忆卡里的人设/语气小节，只留事实性内容。 */
export function sanitizeSummaryText(text) {
  const raw = String(text ?? '');
  if (raw.trim() === '') return '';
  const cleaned = raw.replace(TAG_BLOCK_RE, '').replace(TAG_RE, '');
  const kept = [{ heading: null, lines: [] }];
  let keep = true;
  for (const line of cleaned.split(/\r?\n/)) {
    const match = HEADING_RE.exec(line.trim());
    if (match !== null) {
      keep = !headingIsPersona(match[2]);
      if (keep) kept.push({ heading: match[2].trim(), lines: [] });
      continue;
    }
    if (keep) kept[kept.length - 1].lines.push(line);
  }
  const blocks = [];
  for (const block of kept) {
    const body = block.lines.join('\n').trim();
    if (body === '') continue;
    blocks.push(block.heading === null ? body : `## ${block.heading}\n${body}`);
  }
  const result = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return result.replace(/^[-•\s]+$/, '').trim() === '' ? '' : result;
}

export function makeRecord({
  source = SOURCE_AILOVE,
  externalId = '',
  ts = 0,
  chatType = 'private',
  groupId = '',
  peer = '',
  sessionId = '',
  kind = 'summary',
  text = '',
  status = '',
  importance = 0.5,
  subject = '',
  category = '',
  ask = '',
  why = '',
} = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    source: String(source),
    external_id: String(externalId),
    ts_ms: toMs(ts) || Date.now(),
    chat_type: chatType === 'group' ? 'group' : 'private',
    group_id: String(groupId),
    peer: String(peer),
    session_id: String(sessionId),
    kind: String(kind),
    text: String(text),
    status: String(status),
    importance: Number(importance ?? 0.5),
    subject: String(subject),
    category: String(category),
    ask: String(ask),
    why: String(why),
    content_hash: contentHash(text),
  };
}

export function normalizeRecord(record) {
  if (record === null || typeof record !== 'object') throw new Error('record must be an object');
  const version = Number(record.schema_version ?? SCHEMA_VERSION);
  if (version !== SCHEMA_VERSION) throw new Error(`unsupported schema_version: ${version}`);
  const kind = String(record.kind ?? 'summary').trim().toLowerCase();
  if (!['summary', 'fact', 'note', 'uncertain'].includes(kind)) throw new Error(`unsupported kind: ${kind}`);
  let chatType = String(record.chat_type ?? '').trim().toLowerCase();
  const groupId = String(record.group_id ?? '').trim();
  const peer = String(record.peer ?? '').trim();
  if (chatType === '') chatType = groupId !== '' ? 'group' : 'private';
  if (chatType === 'group' && groupId === '') throw new Error('group record requires group_id');
  if (chatType === 'private' && peer === '') throw new Error('private record requires peer');
  const text = String(record.text ?? record.content ?? record.summary ?? '');
  let status = String(record.status ?? '').trim().toLowerCase();
  if (status === 'dropped') status = 'rejected';
  if (kind === 'uncertain' && status === '') status = 'open';
  const externalId = String(record.external_id ?? externalIdOf(record) ?? '');
  return {
    schema_version: SCHEMA_VERSION,
    source: String(record.source ?? SOURCE_AILOVE),
    external_id: externalId,
    ts_ms: toMs(record.ts_ms ?? record.ts) || Date.now(),
    chat_type: chatType,
    group_id: groupId,
    peer,
    session_id: String(record.session_id ?? record.sessionId ?? ''),
    kind,
    text,
    status,
    importance: Number(record.importance ?? 0.5),
    subject: String(record.subject ?? ''),
    category: String(record.category ?? ''),
    ask: String(record.ask ?? ''),
    why: String(record.why ?? ''),
    content_hash: String(record.content_hash ?? contentHash(text)),
  };
}

function externalIdOf(record) {
  return summaryId(record);
}

function uncertainId(externalId, fallback) {
  const text = String(externalId ?? '');
  const prefix = 'ai-love:uncertain:';
  return text.startsWith(prefix) ? text.slice(prefix.length) : text || fallback;
}

async function readJsonl(file) {
  try {
    const text = await readFile(file, 'utf8');
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const row = JSON.parse(trimmed);
        if (row !== null && typeof row === 'object') rows.push(row);
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
  // 自动联通时对方可能正好在读：先写临时文件再原子替换，避免读到半个 JSONL。
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(tmp, body + (rows.length > 0 ? '\n' : ''), { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
}

function sessionOf(record) {
  const sid = String(record?.session_id ?? record?.sessionId ?? '').trim();
  if (sid !== '') return sid;
  if (String(record?.chat_type ?? '').toLowerCase() === 'group' && String(record?.group_id ?? '').trim() !== '') {
    return `group:${String(record.group_id).trim()}`;
  }
  const peer = String(record?.peer ?? '').trim();
  return peer !== '' ? `private:${peer}` : 'unknown';
}

/**
 * 会话 → QQ 作用域。优先级与 Python 侧一致：
 *   1. sessionScopes[session_id] 显式映射（DSH 会话归属哪个私聊/群）
 *   2. 记录自带 chat_type/group_id/peer
 *   3. 没登记就各自隔离成 private + session_id，绝不并进真实私聊
 */
export function resolveScope(record, sessionScopes = {}) {
  const sessionId = String(record?.session_id ?? record?.sessionId ?? '').trim();
  if (sessionId !== '') {
    const spec = sessionScopes?.[sessionId];
    if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
      const chatType = String(spec.chat_type ?? '').trim().toLowerCase() === 'group' ? 'group' : 'private';
      const groupId = String(spec.group_id ?? '').trim();
      const peer = String(spec.peer ?? '').trim();
      if (chatType === 'group' && groupId !== '') return { chatType, groupId, peer };
      if (chatType === 'private') {
        return { chatType, groupId: '', peer: peer !== '' ? peer : sessionId };
      }
    }
  }
  const chatType = String(record?.chat_type ?? record?.chatType ?? '').trim().toLowerCase() === 'group'
    ? 'group'
    : 'private';
  const groupId = String(record?.group_id ?? record?.groupId ?? '').trim();
  const peer = String(record?.peer ?? '').trim();
  if (chatType === 'group' && groupId !== '') return { chatType, groupId, peer };
  return { chatType: 'private', groupId: '', peer: peer !== '' ? peer : sessionId || 'unknown' };
}

/** 导入时落到 ai-love 的会话键：显式 session_id 优先，其次按作用域反查 DSH 会话。 */
function sessionKeyOf(record, sessionScopes = {}) {
  const sid = String(record?.session_id ?? record?.sessionId ?? '').trim();
  if (sid !== '') return sid;
  const scope = resolveScope(record, sessionScopes);
  for (const [sessionId, spec] of Object.entries(sessionScopes ?? {})) {
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) continue;
    const chatType = String(spec.chat_type ?? 'private').trim().toLowerCase() === 'group' ? 'group' : 'private';
    if (chatType !== scope.chatType) continue;
    if (chatType === 'group' && String(spec.group_id ?? '').trim() === scope.groupId) return sessionId;
    if (chatType === 'private' && String(spec.peer ?? '').trim() === scope.peer) return sessionId;
  }
  return sessionOf(record);
}

function factStatus(status) {
  const value = String(status ?? '').trim().toLowerCase();
  // resolved / dropped 都是「已作废」，不能重新变成 confirmed 再进提示。
  if (value === 'resolved' || value === 'dropped') return 'resolved';
  if (value === 'confirmed') return 'confirmed';
  if (value === 'rejected') return 'rejected';
  return 'open';
}

function uncertainStatus(status) {
  const value = String(status ?? '').trim().toLowerCase();
  if (value === 'resolved' || value === 'dropped' || value === 'confirmed') return 'resolved';
  if (value === 'rejected') return 'dropped';
  return 'open';
}

/** 导出 ai-love 的全部记忆（摘要、事实、待确认、陪伴备注）。 */
export async function exportRecords(store, options = {}) {
  const source = String(options.source ?? SOURCE_AILOVE);
  const records = [];
  for (const row of await store.allSummaries()) {
    const text = sanitizeSummaryText(summaryText(row));
    if (text === '') continue;
    const sessionId = String(row.sessionId ?? row.session_id ?? 'unknown');
    const kind = String(row.kind ?? 'summary') === 'note' ? 'note' : 'summary';
    const externalId = summaryId(row) || `ai-love:${kind}:${sessionId}:${toMs(row.ts)}:${contentHash(text).slice(0, 12)}`;
    const scope = resolveScope({ ...row, session_id: sessionId }, options.sessionScopes);
    records.push(makeRecord({
      source: row.source ?? source,
      externalId,
      ts: row.ts,
      chatType: scope.chatType,
      groupId: scope.groupId,
      peer: scope.peer,
      sessionId,
      kind,
      text,
      importance: 0.5,
    }));
  }
  for (const row of await store.allFacts()) {
    const text = String(row.text ?? row.fact ?? '').trim();
    if (text === '') continue;
    const sessionId = String(row.sessionId ?? row.session_id ?? 'unknown');
    const kind = String(row.kind ?? '') === 'uncertain' ||
      String(row.category ?? '') === '待确认' ||
      String(row.externalId ?? row.external_id ?? '').startsWith('ai-love:uncertain:')
      ? 'uncertain'
      : 'fact';
    const scope = resolveScope({ ...row, session_id: sessionId }, options.sessionScopes);
    records.push(makeRecord({
      source: row.source ?? source,
      externalId: row.externalId ?? row.external_id ?? '',
      ts: row.ts,
      chatType: scope.chatType,
      groupId: scope.groupId,
      peer: scope.peer,
      sessionId,
      kind,
      text,
      status: row.status ?? '',
      importance: row.importance ?? 0.5,
      subject: row.subject ?? '',
      category: row.category ?? '',
      ask: row.ask ?? '',
      why: row.why ?? '',
    }));
  }
  for (const row of await store.allUncertain()) {
    const what = String(row.what ?? '').trim();
    if (what === '') continue;
    const sessionId = String(row.sessionId ?? 'unknown');
    const scope = resolveScope({ ...row, session_id: sessionId }, options.sessionScopes);
    records.push(makeRecord({
      source,
      externalId: String(row.id ?? ''),
      ts: row.ts,
      chatType: scope.chatType,
      groupId: scope.groupId,
      peer: scope.peer,
      sessionId,
      kind: 'uncertain',
      text: what,
      status: row.status ?? 'open',
      importance: 0.6,
      category: '待确认',
      ask: row.ask ?? '',
      why: row.why ?? '',
    }));
  }
  if (options.includeNotes !== false) {
    for (const row of await readJsonl(path.join(store.dir, 'companion-notes.jsonl'))) {
      const text = String(row.text ?? '').trim();
      if (text === '') continue;
      const title = String(row.title ?? '').trim();
      const body = title !== '' && !text.includes(title) ? `${title}：${text}` : text;
      const ts = toMs(row.ts);
      records.push(makeRecord({
        source,
        externalId: String(row.id ?? `ai-love:note:${ts}:${contentHash(body).slice(0, 16)}`),
        ts,
        chatType: 'private',
        peer: '__companion__',
        sessionId: 'companion',
        kind: 'note',
        text: body,
      }));
    }
  }
  records.sort((a, b) => a.ts_ms - b.ts_ms || String(a.external_id).localeCompare(String(b.external_id)));
  return records;
}

/** 导入规范记录；按外部 id / 内容哈希幂等写入。 */
export async function importRecords(store, records, options = {}) {
  const result = {
    summary: 0, summary_updated: 0,
    note: 0, note_updated: 0,
    fact: 0, fact_updated: 0,
    uncertain: 0, uncertain_updated: 0,
    skipped: 0,
  };
  for (const raw of records ?? []) {
    let row;
    try {
      row = normalizeRecord(raw);
    } catch {
      result.skipped += 1;
      continue;
    }
    const text = row.kind === 'summary' || row.kind === 'note'
      ? sanitizeSummaryText(row.text)
      : row.text.trim();
    if (text === '') {
      result.skipped += 1;
      continue;
    }
    const sessionId = sessionKeyOf(row, options.sessionScopes);
    const scope = resolveScope(row, options.sessionScopes);
    if (row.kind === 'summary' || row.kind === 'note') {
      const saved = await store.upsertSummary(sessionId, {
        ts: row.ts_ms,
        sessionId,
        summary: text,
        externalId: row.external_id,
        contentHash: contentHash(text),
        kind: row.kind,
        source: row.source,
        chat_type: scope.chatType,
        group_id: scope.groupId,
        peer: scope.peer,
      });
      result[row.kind === 'note' ? 'note' : 'summary'] += saved?.created ? 1 : 0;
      if (saved !== null && saved.created === false) {
        result[row.kind === 'note' ? 'note_updated' : 'summary_updated'] += 1;
      }
      continue;
    }
    if (row.kind === 'uncertain') {
      const id = uncertainId(row.external_id, `interop-${row.ts_ms}-${row.content_hash.slice(0, 10)}`);
      const saved = await store.upsertUncertain({
        id,
        ts: row.ts_ms,
        sessionId,
        what: text,
        why: row.why,
        ask: row.ask,
        status: uncertainStatus(row.status),
        chat_type: scope.chatType,
        group_id: scope.groupId,
        peer: scope.peer,
      });
      result.uncertain += saved?.created ? 1 : 0;
      if (saved !== null && saved.created === false) result.uncertain_updated += 1;
      continue;
    }
    const saved = await store.upsertFact({
      ts: row.ts_ms,
      sessionId,
      text,
      subject: row.subject,
      category: row.category,
      importance: row.importance,
      status: factStatus(row.status),
      ask: row.ask,
      why: row.why,
      externalId: row.external_id,
      contentHash: row.content_hash,
      kind: 'fact',
      source: row.source,
      chat_type: scope.chatType,
      group_id: scope.groupId,
      peer: scope.peer,
    });
    result.fact += saved?.created ? 1 : 0;
    if (saved !== null && saved.created === false) result.fact_updated += 1;
  }
  return result;
}

export async function exportToFile(store, file, options = {}) {
  const records = await exportRecords(store, options);
  await writeJsonl(file, records);
  return records.length;
}

export async function importFromFile(store, file, options = {}) {
  assertInteropSize(file);
  return importRecords(store, await readJsonl(file), options);
}

export { sessionOf };
