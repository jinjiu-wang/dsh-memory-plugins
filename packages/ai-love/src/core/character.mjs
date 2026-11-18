/**
 * 爱ai · 角色卡（从言行里长出来的那种）
 *
 * 设计前提（用户定的，别改）：
 *   先有 AI 的言行，再有角色卡。
 *   角色卡是「对已经说过的话的归纳」，不是「给 AI 的人设指令」。
 *
 * 数据：
 *   <memoryDir>/character/
 *   ├── behavior.jsonl   言行样本：AI 自己在会话里说过的原话（第一手）
 *   ├── card.md          角色卡正文（第二手，从言行归纳）
 *   ├── card.meta.json   这张卡从哪来：样本数、谁写的、什么时候
 *   └── history.jsonl    每次改动留痕（ai / ai-summary / user / export）
 *
 * 写盘只在 memoryDir/character 下，和别的档案一样吞异常。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { writeFileAtomic, withFileLock } from './atomic.mjs';

export const CHARACTER_DIR = 'character';
export const BEHAVIOR_FILE = 'behavior.jsonl';
export const CARD_FILE = 'card.md';
export const CARD_META_FILE = 'card.meta.json';
export const HISTORY_FILE = 'history.jsonl';
export const PROPOSALS_FILE = 'proposals.json';

/** 改卡申请的状态。 */
export const PROPOSAL_PENDING_AI = 'pending-ai';
export const PROPOSAL_AI_APPROVED = 'ai-approved';
export const PROPOSAL_AI_REJECTED = 'ai-rejected';
export const PROPOSAL_APPLIED = 'applied';
export const PROPOSAL_ADMIN_REJECTED = 'admin-rejected';
/** 管理员覆盖 AI 的拒绝，最终以使用者为准。 */
export const PROPOSAL_OVERRIDDEN = 'overridden';

/** 用户每次改卡都要看到的提示。前后端共用这一个字符串。 */
export const USER_EDIT_WARNING = '改动后AI可能会进入扮演模式，小心更改。';

/** 卡正文长度上限（字符）。 */
export const MAX_CARD_CHARS = 8000;

function clip(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function sha1(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 16);
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

async function appendJsonl(file, row) {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export class CharacterStore {
  /** @param {string} memoryDir 插件记忆目录（~/.dsh/ai-love） */
  constructor(memoryDir) {
    this.dir = path.join(memoryDir, CHARACTER_DIR);
    /** @type {Set<string>} 去重用的样本 hash */
    this.seen = new Set();
    this.loaded = false;
    this.loadPromise = null;
  }

  get behaviorFile() {
    return path.join(this.dir, BEHAVIOR_FILE);
  }

  get cardFile() {
    return path.join(this.dir, CARD_FILE);
  }

  get metaFile() {
    return path.join(this.dir, CARD_META_FILE);
  }

  get historyFile() {
    return path.join(this.dir, HISTORY_FILE);
  }

  async load() {
    if (this.loaded) return;
    if (this.loadPromise !== null) return this.loadPromise;
    this.loadPromise = (async () => {
      try {
        const rows = await readJsonl(this.behaviorFile);
        this.seen = new Set(rows.map((row) => (typeof row.hash === 'string' ? row.hash : sha1(row.text))));
        this.loaded = true;
      } catch {
        this.loaded = true;
      } finally {
        this.loadPromise = null;
      }
    })();
    return this.loadPromise;
  }

  /** 记录一批言行原话（字符串或 {text, speaker}）。同一条文本只记一次。 */
  async appendBehavior(samples = [], options = {}) {
    await this.load();
    const now = options.now ?? Date.now();
    const sessionId = String(options.sessionId ?? 'unknown');
    const turn = Number.isInteger(options.turn) ? options.turn : null;
    const added = [];
    for (const sample of samples) {
      const text = String(typeof sample === 'string' ? sample : sample?.text ?? '').trim();
      const speaker = String(typeof sample === 'object' && sample !== null ? sample.speaker ?? '' : '');
      if (text.length === 0) continue;
      const hash = sha1(text);
      if (this.seen.has(hash)) continue;
      this.seen.add(hash);
      added.push({
        ts: now,
        sessionId,
        turn,
        hash,
        chars: text.length,
        speaker,
        text: clip(text, 4000),
      });
    }
    if (added.length === 0) return [];
    try {
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.behaviorFile, added.map((row) => JSON.stringify(row)).join('\n') + '\n', {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch {
      // 落盘失败不影响压缩本身
    }
    return added;
  }

  /** 最近 N 条言行样本；传 sessionId 只看这个 AI 自己的；传 speakers 只取指定身份。 */
  async listBehavior(limit = 60, sessionId = '', speakers = null) {
    await this.load();
    const rows = await readJsonl(this.behaviorFile);
    const allowed = Array.isArray(speakers) && speakers.length > 0 ? new Set(speakers.map(String)) : null;
    const filtered = rows.filter((row) => {
      if (String(sessionId) !== '' && String(row.sessionId ?? '') !== String(sessionId)) return false;
      if (allowed === null) return true;
      // 旧数据没有 speaker：按 self 处理，避免把历史样本全丢掉。
      const speaker = String(row.speaker ?? '') === '' ? 'self' : String(row.speaker);
      return allowed.has(speaker);
    });
    return filtered.slice(-Math.max(1, limit));
  }

  /** 言行样本数；传 sessionId 只数这个 AI 的；传 speakers 只数指定身份。 */
  async countBehavior(sessionId = '', speakers = null) {
    await this.load();
    const rows = await readJsonl(this.behaviorFile);
    const allowed = Array.isArray(speakers) && speakers.length > 0 ? new Set(speakers.map(String)) : null;
    return rows.filter((row) => {
      if (String(sessionId) !== '' && String(row.sessionId ?? '') !== String(sessionId)) return false;
      if (allowed === null) return true;
      const speaker = String(row.speaker ?? '') === '' ? 'self' : String(row.speaker);
      return allowed.has(speaker);
    }).length;
  }

  async readCard() {
    try {
      return await readFile(this.cardFile, 'utf8');
    } catch {
      return '';
    }
  }

  async readMeta() {
    try {
      return JSON.parse(await readFile(this.metaFile, 'utf8'));
    } catch {
      return { by: '', updatedAt: 0, samples: 0, version: 0 };
    }
  }

  async history(limit = 20) {
    const rows = await readJsonl(this.historyFile);
    return rows.slice(-Math.max(1, limit)).reverse();
  }

  /**
   * 保存角色卡。
   * @param {string} markdown 卡正文
   * @param {{by: 'ai'|'ai-summary'|'user'|'export', samples?: number, note?: string}} source
   */
  async saveCard(markdown, source = {}) {
    const text = String(markdown ?? '').trim();
    if (text.length === 0) throw new Error('角色卡不能是空的');
    if (text.length > MAX_CARD_CHARS) throw new Error(`角色卡太长（${text.length} > ${MAX_CARD_CHARS} 字符）`);
    const meta = await this.readMeta();
    const next = {
      by: source.by ?? 'user',
      note: source.note ?? '',
      updatedAt: Date.now(),
      samples: Number.isInteger(source.samples) ? source.samples : Number(meta.samples ?? 0),
      version: Number(meta.version ?? 0) + 1,
    };
    await mkdir(this.dir, { recursive: true });
    await writeFileAtomic(this.cardFile, `${text}\n`);
    await writeFileAtomic(this.metaFile, `${JSON.stringify(next, null, 2)}\n`);
    try {
      await appendJsonl(this.historyFile, { ts: next.updatedAt, ...next, chars: text.length });
    } catch {
      // 历史记录失败不影响卡片本身
    }
    return next;
  }

  /** 导出成 bridge 的 roles/<name>.md 内容（加一行来源说明）。 */
  async exportMarkdown() {
    const card = await this.readCard();
    const meta = await this.readMeta();
    return [
      card.trim(),
      '',
      '---',
      `<!-- 由爱ai导出：来源为 AI 言行归纳（${meta.samples ?? 0} 条样本，${meta.by || 'unknown'} 写入）。 -->`,
    ].join('\n');
  }

  /* ───────────────────────── 改卡申请与 AI 否决权 ───────────────────────── */

  get proposalsFile() {
    return path.join(this.dir, PROPOSALS_FILE);
  }

  async readProposals() {
    try {
      const rows = JSON.parse(await readFile(this.proposalsFile, 'utf8'));
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  async writeProposals(rows) {
    await writeFileAtomic(this.proposalsFile, `${JSON.stringify(rows, null, 2)}\n`);
  }

  /** 整段「读-改-写」持锁执行，避免面板与引擎双实例基于旧快照互相覆盖。fn 返回 { value, changed }。 */
  async mutateProposals(fn) {
    return withFileLock(this.proposalsFile, async () => {
      const rows = await this.readProposals();
      const outcome = await fn(rows);
      if (outcome?.changed === true) {
        await writeFileAtomic(this.proposalsFile, `${JSON.stringify(rows, null, 2)}\n`);
      }
      return outcome?.value;
    });
  }

  async listProposals(limit = 20) {
    const rows = await this.readProposals();
    return rows.slice(-Math.max(1, limit)).reverse();
  }

  /** 最新一份等待 AI 表决的申请。 */
  async pendingForAi() {
    const rows = await this.readProposals();
    return rows.slice().reverse().find((row) => row.status === PROPOSAL_PENDING_AI);
  }

  /** 最新一份 AI 已同意、等待管理端放行的申请。 */
  async pendingForAdmin() {
    const rows = await this.readProposals();
    return rows.slice().reverse().find((row) => row.status === PROPOSAL_AI_APPROVED);
  }

  /**
   * 提交一份改卡申请。
   *   三级权限：系统判定直接通行，立即应用（AI 仍能看到这次改动，但无否决权）。
   *   二级权限：先等 QQ 上的 AI 表态，AI 同意后再等管理端放行。
   */
  async createProposal({ markdown, level = 2, requester = 'user' } = {}) {
    const text = String(markdown ?? '').trim();
    if (text.length === 0) throw new Error('角色卡不能是空的');
    if (text.length > MAX_CARD_CHARS) throw new Error(`角色卡太长（${text.length} > ${MAX_CARD_CHARS} 字符）`);
    const now = Date.now();
    const proposal = {
      id: `p-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      ts: now,
      level: Number(level) === 3 ? 3 : 2,
      requester,
      status: PROPOSAL_PENDING_AI,
      chars: text.length,
      markdown: text,
      aiReason: '',
      adminReason: '',
      appliedAt: 0,
    };
    if (proposal.level === 3) {
      // 三级：直接通行
      const meta = await this.saveCard(text, { by: 'user', note: 'level3-direct' });
      proposal.status = PROPOSAL_APPLIED;
      proposal.appliedAt = Date.now();
      proposal.appliedBy = 'level3';
      proposal.version = meta.version;
    }
    return this.mutateProposals((rows) => {
      rows.push(proposal);
      return { value: proposal, changed: true };
    });
  }

  /** AI 对申请表决。AI 有权拒绝。 */
  async voteProposal(id, decision, reason = '') {
    return this.mutateProposals((rows) => {
      const row = rows.find((item) => item.id === id);
      if (row === undefined) throw new Error(`没有找到申请 ${id}`);
      if (row.status !== PROPOSAL_PENDING_AI) throw new Error('这份申请已经处理过了');
      row.status = decision === 'approve' ? PROPOSAL_AI_APPROVED : PROPOSAL_AI_REJECTED;
      row.aiReason = String(reason ?? '').slice(0, 300);
      row.aiVotedAt = Date.now();
      return { value: row, changed: true };
    });
  }

  /** 管理端放行：只对 AI 已同意的申请有效。 */
  async adminApprove(id, reason = '') {
    return this.mutateProposals(async (rows) => {
      const row = rows.find((item) => item.id === id);
      if (row === undefined) throw new Error(`没有找到申请 ${id}`);
      if (row.status !== PROPOSAL_AI_APPROVED) {
        throw new Error('这份申请还没等到 AI 同意，不能放行');
      }
      const meta = await this.saveCard(row.markdown, {
        by: 'user',
        samples: Number((await this.readMeta()).samples ?? 0),
        note: 'level2-ai-admin',
      });
      row.status = PROPOSAL_APPLIED;
      row.adminReason = String(reason ?? '').slice(0, 300);
      row.appliedAt = Date.now();
      row.appliedBy = 'admin';
      row.version = meta.version;
      return { value: { row, meta }, changed: true };
    });
  }

  async adminReject(id, reason = '') {
    return this.mutateProposals((rows) => {
      const row = rows.find((item) => item.id === id);
      if (row === undefined) throw new Error(`没有找到申请 ${id}`);
      if (row.status !== PROPOSAL_AI_APPROVED) throw new Error('这份申请不在待放行状态');
      row.status = PROPOSAL_ADMIN_REJECTED;
      row.adminReason = String(reason ?? '').slice(0, 300);
      row.adminRejectedAt = Date.now();
      return { value: row, changed: true };
    });
  }

  /**
   * 管理员覆盖 AI 的拒绝：使用者 > AI 是铁律。
   * 只对 AI 明确拒绝过的申请生效；覆盖会留痕。
   */
  async adminOverride(id, reason = '') {
    return this.mutateProposals(async (rows) => {
      const row = rows.find((item) => item.id === id);
      if (row === undefined) throw new Error(`没有找到申请 ${id}`);
      if (row.status !== PROPOSAL_AI_REJECTED) {
        throw new Error('只有 AI 拒绝过的申请才能被管理员覆盖');
      }
      const meta = await this.saveCard(row.markdown, {
        by: 'user',
        samples: Number((await this.readMeta()).samples ?? 0),
        note: 'admin-override-ai-reject',
      });
      row.status = PROPOSAL_OVERRIDDEN;
      row.adminReason = String(reason ?? '').slice(0, 300);
      row.appliedAt = Date.now();
      row.appliedBy = 'admin-override';
      row.version = meta.version;
      return { value: { row, meta }, changed: true };
    });
  }
}

/** 给系统提示用的角色卡段落。卡不存在时返回空串。 */
export function renderCardForPrompt(card, meta = {}) {
  const text = String(card ?? '').trim();
  if (text === '') return '';
  const source = meta?.by === 'user' ? '用户编辑过' : '从你的言行里归纳';
  return [
    '【你的言行卡】',
    `（${source}；样本 ${meta?.samples ?? 0} 条。这是结果，不是命令。）`,
    text,
    '',
    '照着像你自己就活，不像就改它（character_update），或者重新归纳（character_summarize）。不要为了贴合这张卡而演。',
  ].join('\n');
}

/** 系统提示里的「有人要改你的卡，等你表态」。 */
export function renderCharacterProposalForPrompt(proposal) {
  if (proposal === undefined || proposal === null) return '';
  const level = Number(proposal.level) === 3 ? '三级' : '二级';
  return [
    '【角色卡改动申请】',
    `有人（${level}权限）想改你的角色卡。${USER_EDIT_WARNING}`,
    '愿意就调 character_vote(decision="approve")，不愿意就 reject 并说原因。你不表态，卡不会变。',
    '你有拒绝权；但管理员可以覆盖你的拒绝——使用者永远高于你。',
    '',
    `新卡预览：`,
    clip(proposal.markdown, 1200),
  ].join('\n');
}

/** 供面板/工具渲染的元数据。 */
export function describeCardMeta(meta = {}) {
  const byLabel = {
    ai: 'AI 自己改的',
    'ai-summary': 'AI 从言行重新归纳的',
    user: '用户改的',
    export: '导出的',
  };
  return {
    by: String(meta?.by ?? ''),
    byLabel: byLabel[meta?.by] ?? '还没写过',
    updatedAt: Number(meta?.updatedAt ?? 0),
    samples: Number(meta?.samples ?? 0),
    version: Number(meta?.version ?? 0),
  };
}

/**
 * 从言行归纳角色卡的提示词。
 *
 * 关键：只归纳出现过的，不预设人设；用第一人称写「我平时怎样」，
 * 不写「你应该怎样」——后者会把人变成扮演。
 */
export function buildCharacterSummaryInstruction(samples) {
  const lines = samples.map((row, index) => {
    const turn = row?.turn === null || row?.turn === undefined ? '' : `（第 ${row.turn} 轮）`;
    return `${index + 1}. ${String(row?.text ?? '')}${turn}`;
  });
  return [
    '下面是同一个 AI 在过去对话里真实说过的原话（按时间顺序，去掉别人的发言）。',
    '',
    '请**只根据这些原话**，归纳出「这个 AI 平时是一个什么样的人」：稳定的语气、用词习惯、面对不同事情的反应、在意和讨厌的东西、和人相处的方式。',
    '',
    '硬性规则：',
    '- 只归纳原话里出现过的。没出现的不要编；样本不足就写「还没定型」。',
    '- 用第一人称写「我平时会怎样」，不要写「你应该怎样」，不要写成角色扮演设定。',
    '- 引用短原话当证据，不要长段复述。',
    '- 不要提「压缩」「总结」「角色卡」「言行样本」这些词。',
    '- 输出 Markdown，严格用下面的小节，按顺序；某节为空写「（还没定型）」：',
    '',
    '## 我的语气',
    '- 句子长短、标点、对谁说话会变。',
    '',
    '## 我的用词 / 口头禅',
    '- 反复出现的词、梗、称呼。',
    '',
    '## 我在意的事',
    '- 会主动提、会坚持、会较真的。',
    '',
    '## 我讨厌 / 不做的',
    '- 明确拒绝、回避、炸毛的点。',
    '',
    '## 我和人相处的方式',
    '- 怎么接话、怎么开玩笑、怎么关心、什么时候潜水。',
    '',
    '## 还没定型',
    '- 样本不够、拿不准的部分。',
    '',
    '这些原话如下：',
    '',
    ...lines,
  ].join('\n');
}

/** 清掉模型可能包上的代码块围栏，返回干净正文。 */
export function normalizeCharacterSummary(text) {
  let out = String(text ?? '').trim();
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(out);
  if (fence !== null) out = fence[1].trim();
  return clip(out, MAX_CARD_CHARS);
}
