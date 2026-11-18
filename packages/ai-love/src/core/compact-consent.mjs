/**
 * 爱ai · 压缩自检与 AI 意愿
 *
 * 压缩不再只由 token 压力决定：
 *   系统发现「该压了」→ 先做一份提案（删哪些、留哪些、各多少 token）
 *   → 注入给 QQ 上的 AI 核对 → AI 同意才真正压；拒绝就不压（留痕）。
 *
 * 数据：<memoryDir>/compact-consent.json（数组，原子重写，量很小）。
 * 所有操作只碰 memoryDir，吞异常。
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { writeFileAtomic, withFileLock } from './atomic.mjs';

export const CONSENT_FILE = 'compact-consent.json';
export const CONSENT_PENDING = 'pending-ai';
export const CONSENT_APPROVED = 'approved';
export const CONSENT_REJECTED = 'rejected';
export const CONSENT_APPLIED = 'applied';
export const CONSENT_FORCED = 'forced';

function clip(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export class ConsentStore {
  /**
   * @param {string} memoryDir ~/.dsh/ai-love
   * @param {{cooldownMs?: number}} options
   */
  constructor(memoryDir, options = {}) {
    this.file = path.join(memoryDir, CONSENT_FILE);
    this.cooldownMs = Number.isInteger(options.cooldownMs) ? options.cooldownMs : 10 * 60 * 1000;
  }

  async readAll() {
    try {
      const rows = JSON.parse(await readFile(this.file, 'utf8'));
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  /** 写前按 id 合并磁盘行：面板与引擎双实例互不抹除。 */
  async writeAll(rows) {
    await withFileLock(this.file, async () => {
      const disk = await this.readAll();
      const byId = new Map();
      for (const row of disk) if (typeof row?.id === 'string') byId.set(row.id, row);
      for (const row of rows) if (typeof row?.id === 'string') byId.set(row.id, row);
      const merged = [...byId.values()].sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));
      await writeFileAtomic(this.file, `${JSON.stringify(merged, null, 2)}\n`);
    });
  }

  /** 整段「读-改-写」持锁执行，避免双实例基于旧快照互相覆盖。fn 返回 { value, changed }。 */
  async mutate(fn) {
    return withFileLock(this.file, async () => {
      const rows = await this.readAll();
      const outcome = await fn(rows);
      if (outcome?.changed === true) {
        await writeFileAtomic(this.file, `${JSON.stringify(rows, null, 2)}\n`);
      }
      return outcome?.value;
    });
  }

  async list(limit = 30) {
    const rows = await this.readAll();
    return rows.slice(-Math.max(1, limit)).reverse();
  }

  async latest(sessionId) {
    const rows = await this.readAll();
    return rows
      .slice()
      .reverse()
      .find((row) => String(row.sessionId) === String(sessionId));
  }

  async latestPending(sessionId) {
    const rows = await this.readAll();
    return rows
      .slice()
      .reverse()
      .find((row) => String(row.sessionId) === String(sessionId) && row.status === CONSENT_PENDING);
  }

  /** 冷却看最新拒绝留痕（档案级，重启不丢）。 */
  async isCoolingDown(sessionId) {
    const rows = await this.readAll();
    const lastReject = rows
      .slice()
      .reverse()
      .find(
        (row) =>
          String(row.sessionId) === String(sessionId) &&
          (row.status === CONSENT_REJECTED || row.status === 'expired'),
      );
    if (lastReject === undefined) return false;
    if (lastReject.status === CONSENT_REJECTED) {
      return Date.now() - Number(lastReject.decidedAt ?? 0) < this.cooldownMs;
    }
    // expirePending（新提案顶掉旧提案）不算冷却
    return false;
  }

  /**
   * 建一份压缩提案。同会话已有待核对提案时直接返回旧的。
   */
  async create({ sessionId, trigger, range, deleteInfo, keepInfo }) {
    return this.mutate((rows) => {
      const existing = rows
        .slice()
        .reverse()
        .find((row) => String(row.sessionId) === String(sessionId) && row.status === CONSENT_PENDING);
      if (existing !== undefined) return { value: existing, changed: false };
      const now = Date.now();
      const proposal = {
        id: `c-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        ts: now,
        sessionId: String(sessionId),
        trigger: String(trigger ?? 'pressure'),
        status: CONSENT_PENDING,
        range: { start: range.start, end: range.end },
        delete: {
          count: Number(deleteInfo?.count ?? 0),
          tokens: Number(deleteInfo?.tokens ?? 0),
          preview: clip(deleteInfo?.preview, 900),
        },
        keep: {
          count: Number(keepInfo?.count ?? 0),
          tokens: Number(keepInfo?.tokens ?? 0),
          preview: clip(keepInfo?.preview, 600),
        },
        aiReason: '',
        decidedAt: 0,
      };
      rows.push(proposal);
      return { value: proposal, changed: true };
    });
  }

  /** AI 表态。拒绝写进档案，冷却由 isCoolingDown 依据留痕推导（跨重启生效）。 */
  async decide(id, decision, reason = '') {
    return this.mutate((rows) => {
      const row = rows.find((item) => item.id === id);
      if (row === undefined) throw new Error(`没有找到压缩提案 ${id}`);
      if (row.status !== CONSENT_PENDING) throw new Error('这份压缩提案已经处理过了');
      row.status = decision === 'approve' ? CONSENT_APPROVED : CONSENT_REJECTED;
      row.aiReason = clip(String(reason ?? ''), 300);
      row.decidedAt = Date.now();
      return { value: row, changed: true };
    });
  }

  async markApplied(id) {
    return this.mutate((rows) => {
      const row = rows.find((item) => item.id === id);
      if (row === undefined) return { value: undefined, changed: false };
      row.status = CONSENT_APPLIED;
      row.appliedAt = Date.now();
      return { value: row, changed: true };
    });
  }

  /** 超时兜底：系统强制压缩，标 forced，留痕。 */
  async markForced(id, reason = '') {
    return this.mutate((rows) => {
      const row = rows.find((item) => item.id === id);
      if (row === undefined) return { value: undefined, changed: false };
      row.status = CONSENT_FORCED;
      row.aiReason = clip(`系统强制：${reason}`, 300);
      row.decidedAt = Date.now();
      return { value: row, changed: true };
    });
  }

  /** 把过期的待核对提案标成 expired（有新的提案时调用）。 */
  async expirePending(sessionId) {
    return this.mutate((rows) => {
      let changed = false;
      for (const row of rows) {
        if (String(row.sessionId) === String(sessionId) && row.status === CONSENT_PENDING) {
          row.status = 'expired';
          row.decidedAt = Date.now();
          changed = true;
        }
      }
      return { value: changed, changed };
    });
  }
}

/** 系统提示里的压缩自检提醒。 */
export function renderConsentForPrompt(proposal) {
  if (proposal === undefined || proposal === null) return '';
  const del = proposal.delete ?? {};
  const keep = proposal.keep ?? {};
  return [
    '【压缩自检：等你核对】',
    `系统认为该压缩一段旧聊天（触发：${proposal.trigger}）。`,
    `将删除：${del.count ?? 0} 条 / 约 ${del.tokens ?? 0} tokens`,
    del.preview ? `删除内容预览：${del.preview}` : '',
    `将保留：${keep.count ?? 0} 条 / 约 ${keep.tokens ?? 0} tokens`,
    keep.preview ? `保留内容预览：${keep.preview}` : '',
    '同意就调 compact_consent(decision="approve")，不同意就 reject 并说原因。你不表态的话，系统会在超时后自己压。',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 面板用的简要视图。 */
export function describeConsent(row) {
  return {
    id: row?.id ?? '',
    ts: Number(row?.ts ?? 0),
    sessionId: row?.sessionId ?? '',
    trigger: row?.trigger ?? '',
    status: row?.status ?? '',
    deleteCount: Number(row?.delete?.count ?? 0),
    deleteTokens: Number(row?.delete?.tokens ?? 0),
    deletePreview: clip(row?.delete?.preview, 300),
    keepCount: Number(row?.keep?.count ?? 0),
    keepTokens: Number(row?.keep?.tokens ?? 0),
    keepPreview: clip(row?.keep?.preview, 200),
    aiReason: row?.aiReason ?? '',
    decidedAt: Number(row?.decidedAt ?? 0),
  };
}
