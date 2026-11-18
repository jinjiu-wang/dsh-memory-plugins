/**
 * 爱ai · token 自优化（自更新系统）
 *
 * 唯一目标：在不衰减任何功能与逻辑的前提下，减少注入占用的 token。
 * 手段都发生在「呈现层」：去重、按预算截断、按 section 统计。
 *
 * v0.13：
 *   - 预算改成五档（宽松/标准/收紧/更紧/极限），标准档 = 原来的默认量；
 *   - 自动调档只在档位之间移动，不直接改数字；
 *   - 工具失败率回退：不挂 DSH 工具钩子，改为读 bridge 的 tool-calls.jsonl 采样，
 *     绕开原线路，不碰其他功能。
 *
 * 硬约束：不碰压缩协议、不碰权限、不碰隐私边界、不删任何功能。
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const TOKENWISE_LOG = 'tokenwise.jsonl';
export const TOKENWISE_BUDGET = 'tokenwise.json';

export const DEFAULT_BUDGET = {
  /** 待确认记忆 why 的注入上限（字符）。完整内容仍可用 compact_pending 查。 */
  pendingWhy: 120,
  /** 待确认记忆 ask 的注入上限。 */
  pendingAsk: 100,
  /** 压缩自检预览上限。 */
  approvalPreview: 240,
  /** 单段注入硬上限，防异常膨胀。 */
  hardCap: 4000,
};

/**
 * 五档预算。标准档（索引 1）= 当前默认量；数字越大越紧。
 * 面板上的「放宽 / 收缩」就是在这五档之间移动，不直接改数字。
 */
export const BUDGET_LEVELS = [
  {
    key: 'loose',
    label: '宽松',
    detail: '待确认记得最全，适合刚接手、需要补上下文的时候',
    values: { pendingWhy: 160, pendingAsk: 140, approvalPreview: 320, hardCap: 6000 },
  },
  {
    key: 'standard',
    label: '标准',
    detail: '当前默认量，日常跑这里',
    values: { ...DEFAULT_BUDGET },
  },
  {
    key: 'tight',
    label: '收紧',
    detail: '省一点，关键信息仍完整可查',
    values: { pendingWhy: 100, pendingAsk: 85, approvalPreview: 220, hardCap: 3600 },
  },
  {
    key: 'tighter',
    label: '更紧',
    detail: '只留短摘要，适合长会话省预算',
    values: { pendingWhy: 80, pendingAsk: 70, approvalPreview: 200, hardCap: 3200 },
  },
  {
    key: 'min',
    label: '极限',
    detail: '压到最低档；完整内容仍可用工具查',
    values: { pendingWhy: 60, pendingAsk: 50, approvalPreview: 160, hardCap: 2800 },
  },
];

/** 标准档索引。 */
export const STANDARD_LEVEL = 1;

/** 自动调档的下限：再省也要让模型看得到关键信息（= 极限档）。 */
export const TUNE_FLOOR = { pendingWhy: 60, pendingAsk: 50 };

/** 把任意数字夹到合法档位。 */
export function clampLevel(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return STANDARD_LEVEL;
  return Math.max(0, Math.min(BUDGET_LEVELS.length - 1, Math.floor(num)));
}

/** 从旧的数字预算推断档位（兼容 v0.12 及更早的 tokenwise.json）。 */
export function levelOfBudget(budget) {
  const why = Number(budget?.pendingWhy ?? DEFAULT_BUDGET.pendingWhy);
  if (why <= 60) return 4;
  if (why <= 80) return 3;
  if (why <= 100) return 2;
  if (why <= 120) return 1;
  return 0;
}

/** 去重：保留第一次出现的非空行；连续空行压成一个。 */
export function dedupeLines(text) {
  const seen = new Set();
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed.trim() === '') {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      continue;
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/** 截断到 maxChars（0 = 不截）。 */
export function trimTail(text, maxChars = 0) {
  const value = String(text ?? '');
  if (!Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** 注入文本优化：去重 + 可选截断。 */
export function optimizePromptText(text, options = {}) {
  return trimTail(dedupeLines(text), Number(options.maxChars ?? 0));
}

/** 粗估 token：中文约 3 字符/token。 */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 3);
}

/** 失败率采样：只看 ai-love 自己的工具调用。 */
function isAiLoveTool(name) {
  return /^(compact_|memory_)/.test(String(name ?? ''));
}

export class TokenWise {
  /** @param {string} memoryDir @param {{toolLogPath?: string}} options */
  constructor(memoryDir, options = {}) {
    this.dir = memoryDir;
    this.level = STANDARD_LEVEL;
    this.budget = { ...BUDGET_LEVELS[STANDARD_LEVEL].values };
    this.tuneLog = [];
    this.records = [];
    this.loaded = false;
    this.dirty = false;
    this.toolLogPath = typeof options.toolLogPath === 'string' ? options.toolLogPath : '';
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(path.join(this.dir, TOKENWISE_BUDGET), 'utf8'));
      const { tuneLog, level, budget } = raw ?? {};
      this.level = clampLevel(level ?? levelOfBudget(budget));
      this.budget = { ...BUDGET_LEVELS[this.level].values };
      this.tuneLog = Array.isArray(tuneLog) ? tuneLog.slice(-20) : [];
    } catch {
      this.level = STANDARD_LEVEL;
      this.budget = { ...BUDGET_LEVELS[STANDARD_LEVEL].values };
      this.tuneLog = [];
    }
    try {
      const text = await readFile(path.join(this.dir, TOKENWISE_LOG), 'utf8');
      this.records = text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .slice(-300);
    } catch {
      this.records = [];
    }
  }

  async saveBudget() {
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(
        path.join(this.dir, TOKENWISE_BUDGET),
        `${JSON.stringify({ level: this.level, budget: this.budget, tuneLog: this.tuneLog.slice(-20) }, null, 2)}\n`,
        'utf8',
      );
      this.dirty = false;
    } catch {
      // 写不了也不影响功能
    }
  }

  /** 手动切档（面板「放宽 / 收缩」）。 */
  async setLevel(level, reason = '手动切档') {
    await this.load();
    const next = clampLevel(level);
    const before = this.level;
    this.level = next;
    this.budget = { ...BUDGET_LEVELS[next].values };
    if (next !== before) {
      this.tuneLog = [...this.tuneLog, { ts: Date.now(), from: before, to: next, reason }].slice(-20);
      await this.saveBudget();
    }
    return { ok: true, level: this.level, budget: this.budget, changed: next !== before };
  }

  /** 恢复标准档（手动回退）。 */
  async resetBudget() {
    await this.load();
    const before = this.level;
    this.level = STANDARD_LEVEL;
    this.budget = { ...BUDGET_LEVELS[STANDARD_LEVEL].values };
    this.tuneLog = [...this.tuneLog, { ts: Date.now(), from: before, to: STANDARD_LEVEL, reason: '恢复标准档' }].slice(-20);
    await this.saveBudget();
    return { ...this.budget, level: this.level };
  }

  /**
   * 绕开 DSH 工具钩子：读 bridge 的 tool-calls.jsonl，采样 ai-love 工具结果。
   * 只读文件，不改任何其他线路。
   */
  async sampleToolFailures(max = 300) {
    if (this.toolLogPath === '') return { sampled: 0, failed: 0, rate: 0 };
    try {
      const text = await readFile(this.toolLogPath, 'utf8');
      const lines = text.split('\n').filter((line) => line.trim() !== '').slice(-max);
      let sampled = 0;
      let failed = 0;
      for (const line of lines) {
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (row?.type !== 'result' || !isAiLoveTool(row?.tool)) continue;
        sampled += 1;
        if (row.ok === false) failed += 1;
      }
      const rate = sampled === 0 ? 0 : failed / sampled;
      return { sampled, failed, rate };
    } catch {
      return { sampled: 0, failed: 0, rate: 0 };
    }
  }

  /**
   * 自动调档：档位之间移动。
   * 1) 工具失败率高 → 先放宽一档（功能优先）；
   * 2) 否则 pending 占比高且长 → 收紧一档；占比低且短 → 放宽一档。
   */
  async autoTune(options = {}) {
    await this.load();
    const now = Date.now();
    const windowMs = Number(options.windowMs ?? 24 * 60 * 60 * 1000);
    const minSamples = Number(options.minSamples ?? 10);
    const failures = await this.sampleToolFailures();
    const before = this.level;
    let next = before;
    let reason = '';
    if (failures.sampled >= 5 && failures.rate >= 0.2) {
      next = Math.max(0, before - 1);
      reason = `工具失败率 ${(failures.rate * 100).toFixed(0)}%（${failures.failed}/${failures.sampled}），回退一档`;
    } else {
      const recent = this.records.filter((row) => now - Number(row.ts ?? 0) <= windowMs);
      if (recent.length < minSamples) {
        return {
          ok: true,
          changed: false,
          skipped: true,
          reason: `样本不足（${recent.length}/${minSamples}）`,
          level: this.level,
          budget: this.budget,
          failures,
        };
      }
      const pending = recent.filter((row) => row.section === 'pending');
      const totalTokens = recent.reduce((sum, row) => sum + Number(row.tokens ?? 0), 0);
      const pendingTokens = pending.reduce((sum, row) => sum + Number(row.tokens ?? 0), 0);
      if (totalTokens === 0) {
        return { ok: true, changed: false, skipped: true, reason: '没有 token 统计', level: this.level, budget: this.budget, failures };
      }
      const share = pendingTokens / totalTokens;
      const avgChars = pending.length === 0 ? 0 : pending.reduce((sum, row) => sum + Number(row.chars ?? 0), 0) / pending.length;
      if (share >= 0.5 && avgChars >= 500) {
        next = Math.min(BUDGET_LEVELS.length - 1, before + 1);
        reason = `pending 占比 ${(share * 100).toFixed(0)}%、均长 ${Math.round(avgChars)}，收紧一档`;
      } else if (share < 0.2 && avgChars < 300) {
        next = Math.max(0, before - 1);
        reason = `pending 占比 ${(share * 100).toFixed(0)}%、均长 ${Math.round(avgChars)}，放宽一档`;
      } else {
        reason = '当前档位合适';
      }
      if (next === before) {
        return { ok: true, changed: false, reason, level: this.level, budget: this.budget, failures };
      }
    }
    if (next === before) {
      return { ok: true, changed: false, reason, level: this.level, budget: this.budget, failures };
    }
    const from = this.level;
    this.level = next;
    this.budget = { ...BUDGET_LEVELS[next].values };
    this.tuneLog = [...this.tuneLog, { ts: now, from, to: next, reason }].slice(-20);
    await this.saveBudget();
    return { ok: true, changed: true, reason, from, to: next, level: this.level, budget: this.budget, failures };
  }

  /**
   * 对一段注入文本做呈现层优化，并记录用量。
   * @param {string} section 段名（pending / approval / summary / facts）
   * @param {string} text 原文
   * @param {number} maxChars 覆盖硬上限
   */
  optimize(section, text, maxChars = 0) {
    const source = String(text ?? '');
    if (source.trim() === '') return '';
    const limit = maxChars > 0 ? maxChars : Number(this.budget.hardCap ?? 0);
    const optimized = optimizePromptText(source, { maxChars: limit });
    if (optimized !== source) {
      void this.record({ section, text: optimized, chars: optimized.length, before: source.length, saved: source.length - optimized.length });
    } else {
      void this.record({ section, text: optimized, chars: optimized.length, before: source.length, saved: 0 });
    }
    return optimized;
  }

  async record(entry) {
    const row = {
      ts: Date.now(),
      section: String(entry.section ?? 'other'),
      chars: Number(entry.chars ?? 0),
      // v0.16.1：token 从真实文本估，不再拿字符数本身当 token（原先会把用量夸大 3 倍）
      tokens: estimateTokens(String(entry.text ?? '')),
      saved: Number(entry.saved ?? 0),
      before: Number(entry.before ?? 0),
    };
    this.records.push(row);
    this.records = this.records.slice(-300);
    try {
      await appendFile(path.join(this.dir, TOKENWISE_LOG), `${JSON.stringify(row)}\n`, 'utf8');
    } catch {
      // 统计失败不影响注入
    }
  }

  summary() {
    const bySection = new Map();
    for (const row of this.records) {
      const key = String(row.section ?? 'other');
      const item = bySection.get(key) ?? { chars: 0, tokens: 0, saved: 0, count: 0 };
      item.chars += Number(row.chars ?? 0);
      item.tokens += Number(row.tokens ?? 0);
      item.saved += Number(row.saved ?? 0);
      item.count += 1;
      bySection.set(key, item);
    }
    const sections = [...bySection.entries()]
      .map(([name, item]) => ({ name, ...item }))
      .sort((a, b) => b.tokens - a.tokens);
    const total = sections.reduce((sum, item) => sum + item.tokens, 0);
    return {
      level: this.level,
      levels: BUDGET_LEVELS.map((item, index) => ({ index, key: item.key, label: item.label, detail: item.detail })),
      budget: this.budget,
      entries: this.records.length,
      totalTokens: total,
      sections: sections.slice(0, 8),
      tuneLog: this.tuneLog.slice(-5),
    };
  }
}
