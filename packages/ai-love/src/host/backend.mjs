/**
 * ai-love · 插件入口
 *
 * 一个 CompactionEngine 后端：
 *   - 自动在 token 压力 / 上下文溢出时压缩较早历史；
 *   - 摘要是只含事实的「QQ 聊天记忆卡」：话题、人物关系、时间线、约定、状态；
 *   - 拿不准的记忆写进档案，下一轮以提示注入，找合适时机问用户；
 *   - 给模型 14 个工具：compact_recall / compact_pending / compact_consent、
 *     memory_facts / memory_export / memory_import、
 *     character_* （check/update/summarize/export/vote）、legacy_* （write/review/read）。
 *
 * 设计底线（比功能重要）：
 *   - 永远不能挡住聊天：事件回调里所有异常只记日志；
 *   - 摘要失败就不写任何表面变更（沿用 DSH 的事务锁）；
 *   - 记忆卡和待确认记忆是自己的档案，不改会话日志格式。
 */
import { CompactionEngine, ManualCompactionError } from '@deepseek-ai/dsh-compaction';
import { BlockAssembler, CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveConfig, resolveTargetPolicy, resolveCompactSpec } from '../core/config.mjs';
import { installFirewall } from '../core/firewall.mjs';
import { summarizeWithLlm, verifyProtocolCard } from '../core/summarizer.mjs';
import { TokenWise } from '../core/tokenwise.mjs';
import { extractIdentitySamples } from '../core/identity.mjs';
import {
  CompactStore,
  renderFacts,
  renderPending,
  renderSummary,
  resolveMemoryDir,
} from '../core/memory.mjs';
import {
  CharacterStore,
  MAX_CARD_CHARS,
  PROPOSAL_AI_APPROVED,
  PROPOSAL_AI_REJECTED,
  PROPOSAL_PENDING_AI,
  USER_EDIT_WARNING,
  buildCharacterSummaryInstruction,
  normalizeCharacterSummary,
  renderCardForPrompt,
  renderCharacterProposalForPrompt,
} from '../core/character.mjs';
import {
  ConsentStore,
  renderConsentForPrompt,
} from '../core/compact-consent.mjs';
import {
  LegacyStore,
  MAX_LEGACY_CHARS,
  inactiveMsOf,
  renderLegacyPrompt,
} from '../core/legacy.mjs';
import {
  assertNoActiveCompaction,
  compactSurfaceRegion,
  selectCompactableRange,
} from '../core/region.mjs';
import { resolveMemoryBackupRoot, sharedMemoryBackup } from '../core/memory-backup.mjs';
import { resolveSessionsRoot } from '../core/context-link.mjs';
import { exportToFile, importFromFile, resolveInteropPath } from '../core/interop.mjs';

export const name = 'ai-love';

/** 硬依赖：少一个就静默不激活（压缩后端坏掉比没有更糟）。 */
export const inject = ['llm', 'tokenMeter', 'sessions', 'agents'];

const SECTION_NAME = 'ai-love:pending';
const SECTION_ORDER = 120;
const SECTION_FACTS = 'ai-love:facts';
const SECTION_ORDER_FACTS = 118;
const SECTION_CHARACTER = 'ai-love:character';
const SECTION_ORDER_CHARACTER = 119;
const SECTION_APPROVALS = 'ai-love:approvals';
const SECTION_ORDER_APPROVALS = 121;
const TOOL_RECALL = 'compact_recall';
const TOOL_PENDING = 'compact_pending';
const TOOL_CONSENT = 'compact_consent';
const TOOL_FACTS = 'memory_facts';
const TOOL_EXPORT = 'memory_export';
const TOOL_IMPORT = 'memory_import';
const TOOL_CHARACTER_CHECK = 'character_check';
const TOOL_CHARACTER_UPDATE = 'character_update';
const TOOL_CHARACTER_SUMMARIZE = 'character_summarize';
const TOOL_CHARACTER_EXPORT = 'character_export';
const TOOL_CHARACTER_VOTE = 'character_vote';
const TOOL_LEGACY_WRITE = 'legacy_write';
const TOOL_LEGACY_REVIEW = 'legacy_review';
const TOOL_LEGACY_READ = 'legacy_read';

function routedTarget(session) {
  const config = session.requestHeader()?.config;
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) return undefined;
  return { provider: config.provider, model: config.model };
}

function reservedCompletionTokens(agent, defaultMaxTokens) {
  return agent.session.requestHeader()?.config.maxTokens ?? defaultMaxTokens ?? 0;
}

function conversationTarget(agent) {
  const routed = routedTarget(agent.session);
  if (routed !== undefined) return routed;
  if (
    agent.options.provider === undefined ||
    agent.options.provider.length === 0 ||
    agent.options.model === undefined ||
    agent.options.model.length === 0
  ) {
    return undefined;
  }
  return { provider: agent.options.provider, model: agent.options.model };
}

function sessionIdOf(agent) {
  return agent?.session?.id ?? agent?.id ?? 'unknown';
}

export class AiLoveCompactionEngine extends CompactionEngine {
  static inject = inject;

  constructor(ctx, config = {}) {
    super(ctx);
    this.config = resolveConfig(config);
    this.store = new CompactStore(resolveMemoryDir(this.config));
    // 三层防火墙（网络白名单 / 只绑本机 / 数据边界）；失败不影响插件启动
    try {
      const r = installFirewall({ memoryDir: this.store.dir });
      if (this.ctx?.logger?.info) this.ctx.logger.info('[ai-love] firewall ' + JSON.stringify(r));
    } catch (e) {
      if (this.ctx?.logger?.warn) this.ctx.logger.warn('[ai-love] firewall install failed: ' + (e?.message || e));
    }
    this.character = new CharacterStore(this.store.dir);
    this.consent = new ConsentStore(this.store.dir, {
      cooldownMs: this.config.consentCooldownMinutes * 60_000,
    });
    this.legacy = new LegacyStore(this.store.dir);
    this.tokenwise = new TokenWise(this.store.dir);
    void this.tokenwise.load();
    this.characterCache = { at: 0, card: '', meta: {} };
    /** 已确认事实缓存：按会话分桶，系统提示同步渲染，读盘放后台。 */
    this.factsCache = new Map();
    /** sessionId → { at, character, consent }，系统提示同步渲染用 */
    this.approvalCache = new Map();
    this.warnedPressureConfigTargets = new Set();
    this.overflowRetries = new WeakMap();
    this.overflowAgents = new WeakMap();
    this.promptFibers = new Map();
    /** agent → 上一次提醒 pending 的 turn，避免同轮重复 */
    this.mentionedTurns = new WeakMap();

    void this.store.load();
    void this.character.load();
    void this._refreshCharacterCache();
    void this._prewarmFactsCache();
    this._registerAutomaticCompaction();
    this._registerPromptInjection();
    this._registerTools();
    this.memoryBackup = null;
    this._registerMemoryBackup();
  }

  /**
   * 逐字节记忆备份：把 QQ 会话日志与爱ai 档案实时镜像到非系统盘。
   * 备份失败只记日志，绝不挡住聊天；多个 QQ 会话实例共用一套 watch。
   */
  _registerMemoryBackup() {
    if (!this.config.memoryBackup) return;
    const { ctx } = this;
    const shared = sharedMemoryBackup({
      root: resolveMemoryBackupRoot(this.config),
      sessionsRoot: resolveSessionsRoot(),
      memoryDir: this.store.dir,
      logger: {
        info: (message) => ctx.logger.info(message),
        warn: (message) => ctx.logger.warn(message),
      },
    });
    this.memoryBackup = shared.backup;
    ctx.effect(
      () => {
        void shared.backup.start().catch((error) => {
          ctx.logger.warn(
            `ai-love: memory byte backup failed to start: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        return () => shared.release();
      },
      'ai-love: byte-exact memory backup',
    );
  }

  /* ───────────────────────── 自动压缩 ───────────────────────── */

  _registerAutomaticCompaction() {
    const { ctx } = this;
    const logResult = (result, trigger) => {
      ctx.logger.info(
        `compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes ` +
          `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`,
      );
    };

    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal);
          if (result !== null) logResult(result, 'step pressure');
        } catch (error) {
          if (error instanceof TargetPressureConfigError) {
            if (this.warnedPressureConfigTargets.has(error.targetKey)) return next();
            this.warnedPressureConfigTargets.add(error.targetKey);
          }
          const message = error instanceof Error ? error.message : String(error);
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`);
          void this.store.logActivity({
            ts: Date.now(),
            type: 'pressure-error',
            sessionId: sessionIdOf(agent),
            message,
          });
        }
      }
      return next();
    });

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent);
    });

    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return;
      const agent = this.overflowAgents.get(session);
      if (agent !== undefined) this.overflowRetries.delete(agent);
    });

    ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next();
      this.overflowAgents.set(agent.session, agent);
      const target = routedTarget(agent.session);
      if (target === undefined) return next();
      const policy = resolveTargetPolicy(this.config, target);
      const retries = this.overflowRetries.get(agent) ?? 0;
      if (retries >= policy.maxOverflowRetries) return next();
      const generation = agent.session.surface.replaceGeneration;
      let result;
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal);
      } catch (recoveryError) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        void this.store.logActivity({
          ts: Date.now(),
          type: 'overflow-error',
          sessionId: sessionIdOf(agent),
          message,
        });
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `context-overflow compaction failed after durable surface progress: ${message}; retrying from the replacement surface`,
          );
          this.overflowRetries.set(agent, retries + 1);
          return { kind: 'retry' };
        }
        ctx.logger.warn(
          `context-overflow compaction failed: ${message}; ${signal.aborted ? 'cancellation prevents retry' : 'preserving the original request error'}`,
        );
        return next();
      }
      if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next();
      if (result !== null) logResult(result, 'context overflow recovery');
      this.overflowRetries.set(agent, retries + 1);
      return { kind: 'retry' };
    });
  }

  /* ───────────────────────── 待确认记忆注入 ───────────────────────── */

  _registerPromptInjection() {
    // 已确认事实的注入始终开启；其余小节按配置挂载。
    const { ctx } = this;

    for (const agent of ctx.agents.list()) this._installPrompt(agent);
    ctx.on('agent/created', ({ agent }) => {
      this._installPrompt(agent);
    });
    ctx.on('agent/disposed', ({ agent }) => {
      const fiber = this.promptFibers.get(agent);
      if (fiber === undefined) return;
      this.promptFibers.delete(agent);
      void fiber.dispose?.();
    });
  }

  _installPrompt(agent) {
    if (agent === undefined || this.promptFibers.has(agent)) return this.promptFibers.get(agent);
    let fiber;
    try {
      fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.section({
          name: SECTION_FACTS,
          order: SECTION_ORDER_FACTS,
          text: () => this._renderFactsFor(agent),
          interpolate: false,
        });
        if (this.config.characterNotify) {
          scope.systemPrompt.section({
            name: SECTION_CHARACTER,
            order: SECTION_ORDER_CHARACTER,
            text: () => this._renderCharacterPrompt(agent),
            interpolate: false,
          });
        }
        if (this.config.uncertainNotify || this.config.compactConsent === 'ai') {
          scope.systemPrompt.section({
            name: SECTION_APPROVALS,
            order: SECTION_ORDER_APPROVALS,
            text: () => this._renderApprovalsFor(agent),
            interpolate: false,
          });
        }
        if (this.config.uncertainNotify) {
          scope.systemPrompt.section({
            name: SECTION_NAME,
            order: SECTION_ORDER,
            text: () => this._renderPendingFor(agent),
            interpolate: false,
          });
        }
      });
    } catch (error) {
      this.ctx.logger.warn(`ai-love: register prompt section failed: ${error?.message ?? error}`);
      return undefined;
    }
    this.promptFibers.set(agent, fiber);
    this.ctx.effect(
      () => () => {
        const current = this.promptFibers.get(agent);
        if (current === undefined) return;
        this.promptFibers.delete(agent);
        void current.dispose?.();
      },
      `ai-love: dispose prompt for ${String(agent.id)}`,
    );
    return fiber;
  }

  /** 角色卡缓存：系统提示是同步渲染，读盘放后台，渲染用最近一份。 */
  async _refreshCharacterCache() {
    try {
      const [card, meta] = await Promise.all([this.character.readCard(), this.character.readMeta()]);
      this.characterCache = { at: Date.now(), card, meta };
    } catch {
      // 读不出来保持旧缓存
    }
  }

  _renderCharacterPrompt() {
    if (Date.now() - this.characterCache.at > 5000) void this._refreshCharacterCache();
    return renderCardForPrompt(this.characterCache.card, this.characterCache.meta);
  }

  /** 审批缓存：角色卡改动申请 + 压缩自检提案 + 隐私查看申请（按会话）。 */
  async _refreshApprovals(sessionId) {
    try {
      void this._touchLegacy(sessionId);
      const [character, consent, legacyRow] = await Promise.all([
        this.character.pendingForAi(),
        this.consent.latestPending(sessionId),
        this.legacy.read(sessionId),
      ]);
      const legacyPending =
        legacyRow === undefined
          ? []
          : (legacyRow.requests ?? []).filter((item) => item.status === 'pending-ai').slice().reverse();
      this.approvalCache.set(String(sessionId), {
        at: Date.now(),
        character,
        consent,
        legacyRow,
        legacyPending,
      });
    } catch {
      // 读不出来保持旧缓存
    }
  }

  /** 心跳：AI 只要还在被注入提示，就更新 lastSeenAt；超过阈值即视为退役。 */
  _touchLegacy(sessionId) {
    try {
      const now = Date.now();
      this._legacyTouchAt ??= new Map();
      const last = this._legacyTouchAt.get(String(sessionId)) ?? 0;
      if (now - last < 10 * 60_000) return;
      this._legacyTouchAt.set(String(sessionId), now);
      void this.legacy.touch(sessionId).catch(() => {
        // 心跳失败不影响聊天
      });
    } catch {
      // 同上
    }
  }

  _renderApprovalsFor(agent) {
    const sessionId = sessionIdOf(agent);
    const cached = this.approvalCache.get(String(sessionId));
    if (cached === undefined || Date.now() - cached.at > 3000) void this._refreshApprovals(sessionId);
    if (cached === undefined) return '';
    const text = [
      renderCharacterProposalForPrompt(cached.character),
      renderConsentForPrompt(cached.consent),
      renderLegacyPrompt(cached.legacyRow !== undefined, cached.legacyPending),
    ]
      .filter(Boolean)
      .join('\n\n');
    return this.tokenwise.optimize('approval', text);
  }

  /** 已确认事实缓存：按会话分桶，系统提示同步渲染，读盘放后台。 */
  async _refreshFactsCache(sessionId) {
    try {
      const sid = String(sessionId);
      const rows = await this.store.factsFor(sid, 8);
      this.factsCache.set(sid, { at: Date.now(), rows });
    } catch {
      // 读不出来保持旧缓存
    }
  }

  /** 一次读盘填满所有会话的缓存；启动和导入后调用，避免第一轮提示缺事实。 */
  async _prewarmFactsCache() {
    try {
      const now = Date.now();
      const buckets = new Map();
      for (const row of await this.store.allFacts()) {
        if (!['open', 'confirmed'].includes(String(row.status ?? 'open'))) continue;
        const sid = String(row.sessionId ?? row.session_id ?? '');
        if (sid === '') continue;
        if (!buckets.has(sid)) buckets.set(sid, []);
        buckets.get(sid).push(row);
      }
      for (const [sid, rows] of buckets) {
        rows.sort((a, b) => Number(b?.ts ?? 0) - Number(a?.ts ?? 0));
        this.factsCache.set(sid, { at: now, rows: rows.slice(0, 8) });
      }
    } catch {
      // 预热失败不影响按需刷新
    }
  }

  _renderFactsFor(agent) {
    try {
      const sid = String(sessionIdOf(agent));
      const cached = this.factsCache.get(sid);
      if (cached === undefined || Date.now() - cached.at > 5000) {
        void this._refreshFactsCache(sid);
      }
      if (cached === undefined || cached.rows.length === 0) return '';
      const text = renderFacts(cached.rows, { limit: 8 });
      if (text === '') return '';
      return this.tokenwise.optimize('facts', text, 1600);
    } catch {
      return '';
    }
  }

  _renderPendingFor(agent) {
    try {
      const sessionId = sessionIdOf(agent);
      const text = renderPending(this.store, sessionId, {
        limit: this.config.uncertainPerTurn,
        maxMentions: this.config.uncertainMaxMentions,
      });
      if (text === '') return '';
      void this._noteMentionOnce(agent, sessionId);
      return this.tokenwise.optimize('pending', text, 1200);
    } catch {
      return '';
    }
  }

  _noteMentionOnce(agent, sessionId) {
    const turn = agent?.session?.turn ?? agent?.turn;
    const last = this.mentionedTurns.get(agent);
    if (turn !== undefined && last === turn) return;
    this.mentionedTurns.set(agent, turn);
    const items = this.store.openItems(sessionId);
    const picked = items[0];
    if (picked !== undefined) {
      void this.store.noteMention(sessionId, picked.id);
    }
  }

  /* ───────────────────────── 工具 ───────────────────────── */

  _registerTools() {
    const { ctx } = this;
    const engine = this;
    const textOutput = (fallback) => ({
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value?.text ?? fallback }],
    });
    ctx.inject(['tools'], (scope) => {
      scope.effect(
        () =>
          scope.tools.register({
            name: TOOL_RECALL,
            description:
              '翻自己的压缩记忆卡：之前聊过什么、谁是谁、梗和情绪。上下文里看不到的旧聊天，用这个想起来。只在需要回忆旧事时用，不要每轮都翻。管理员让你继承旧 AI 的系统日志时，用 scope="activity" 读工作日志（只读，无隐私正文）。',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                query: {
                  type: 'string',
                  description: '关键词（可选），在记忆卡里搜；不搜原始聊天记录。',
                },
                limit: {
                  type: 'integer',
                  description: '最多返回几份记忆卡，默认 3。',
                },
                scope: {
                  type: 'string',
                  enum: ['summaries', 'activity'],
                  description: 'summaries 翻记忆卡（默认）；activity 读旧 AI 的工作日志时间线。',
                },
              },
            },
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ok: { type: 'boolean' },
                  found: { type: 'integer' },
                  text: { type: 'string' },
                },
              },
              render: (_args, value) => [{ type: 'text', text: value?.text ?? '没翻到。' }],
            },
            async execute(args, exec) {
              const agent = exec?.agent;
              const sessionId = sessionIdOf(agent);
              const limit = Number.isInteger(args?.limit)
                ? Math.min(10, Math.max(1, args.limit))
                : engine.config.recallLimit;
              if (args?.scope === 'activity') {
                // v0.16.1：工作日志是跨会话的全局档案——别的会话里用户的回答
                // （uncertain-note）不能顺着这条口子漏给当前 AI。只保留本会话的。
                const allLogs = await engine.store.listRecentActivity(limit * 5);
                const logs = allLogs.filter(
                  (row) =>
                    row.type !== 'uncertain-note' ||
                    String(row.sessionId ?? '') === String(sessionId),
                );
                if (logs.length === 0) return { ok: true, found: 0, text: '还没有工作日志。' };
                const text = logs
                  .map(
                    (row) =>
                      `- ${new Date(Number(row.ts ?? 0)).toLocaleString('zh-CN')} · ${String(row.type ?? '')}${
                        row.trigger ? ` · ${row.trigger}` : ''
                      }${row.summaryChars ? ` · 记忆卡 ${row.summaryChars} 字` : ''}`,
                  )
                  .join('\n');
                return { ok: true, found: logs.length, text };
              }
              const query = typeof args?.query === 'string' ? args.query.trim() : '';
              const rows = await engine.store.recallSummaries(sessionId, limit, query);
              if (rows.length === 0) {
                return {
                  ok: true,
                  found: 0,
                  text:
                    query === ''
                      ? '还没有压缩过记忆卡。这是干净的当前上下文。'
                      : `记忆卡里没搜到「${query}」。`,
                };
              }
              const text = rows.map((row, index) => renderSummary(row, index + 1)).join('\n\n');
              return { ok: true, found: rows.length, text };
            },
            presentCall: (args) => ({
              card: 'generic',
              title: '翻记忆卡',
              kind: 'other',
              rawInput: args,
            }),
          }),
        'ai-love: recall tool',
      );

      scope.effect(
        () =>
          scope.tools.register({
            name: TOOL_PENDING,
            description:
              '查看压缩时拿不准的记忆，或把它们标记成已确认/作废。用户答了某件拿不准的事，就用 resolve；用户说「这事别记」用 drop。管理员在面板回复了你的拿不准时，用 ack 表示接受（标成已确认），用 dispute 表示不认同（继续留在待确认）。',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                action: {
                  type: 'string',
                  enum: ['list', 'resolve', 'drop', 'ack', 'dispute'],
                  description: 'list 查看；resolve 用户已确认；drop 丢弃；ack 接受管理员的回复；dispute 不认同。',
                },
                id: {
                  type: 'string',
                  description: '待确认记忆的 id（list 里能看到）。resolve/drop 必填。',
                },
                note: {
                  type: 'string',
                  description: '用户是怎么回答的（可选，写进档案留底）。',
                },
              },
              required: ['action'],
            },
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ok: { type: 'boolean' },
                  count: { type: 'integer' },
                  text: { type: 'string' },
                },
              },
              render: (_args, value) => [{ type: 'text', text: value?.text ?? '没办成。' }],
            },
            async execute(args, exec) {
              const agent = exec?.agent;
              const sessionId = sessionIdOf(agent);
              const action = args?.action;
              await engine.store.load();
              if (action === 'list') {
                const items = engine.store.openItems(sessionId);
                if (items.length === 0) {
                  return { ok: true, count: 0, text: '没有拿不准的记忆，档案是干净的。' };
                }
                const lines = items.slice(0, 10).map((row, index) => {
                  const parts = [`${index + 1}. [${row.id}] ${row.what}`];
                  if (row.why) parts.push(`   线索：${row.why}`);
                  if (row.ask) parts.push(`   可以问：${row.ask}`);
                  if (row.replyState === 'pending-ai') {
                    parts.push(`   管理员回复（等你确认）：${row.adminReply}`);
                    parts.push(`   接受用 action="ack" id="${row.id}"；不认同用 action="dispute" id="${row.id}" note="原因"`);
                  } else if (row.adminReply && row.replyState === 'acknowledged') {
                    parts.push(`   已确认管理员回复：${row.adminReply}`);
                  } else if (row.adminReply && row.replyState === 'disputed') {
                    parts.push(`   你对管理员回复有异议：${row.aiNote || row.adminReply}`);
                  }
                  return parts.join('\n');
                });
                return {
                  ok: true,
                  count: items.length,
                  text: `拿不准的记忆 ${items.length} 条：\n${lines.join('\n')}`,
                };
              }
              if (action === 'ack' || action === 'dispute') {
                const id = typeof args?.id === 'string' ? args.id.trim() : '';
                if (id === '') throw new Error('要确认哪一条？id 必填（先用 action: list 看）。');
                const changed = await engine.store.ackUncertain(
                  id,
                  action === 'ack' ? 'accept' : 'dispute',
                  typeof args?.note === 'string' ? args.note : '',
                );
                if (changed === null) throw new Error(`没有找到 id 为 ${id} 的待确认记忆。`);
                return {
                  ok: true,
                  count: engine.store.openItems(sessionId).length,
                  text:
                    action === 'ack'
                      ? '收下了：管理员这条回复算确认，这条已经标成已确认。'
                      : '记下了：你对这条回复有异议，它还留在待确认里。',
                };
              }
              if (action !== 'resolve' && action !== 'drop') {
                throw new Error('action 只能是 list / resolve / drop / ack / dispute');
              }
              const id = typeof args?.id === 'string' ? args.id.trim() : '';
              if (id === '') throw new Error('要改哪一条？id 必填（先用 action: list 看）。');
              const status = action === 'resolve' ? 'resolved' : 'dropped';
              const changed = await engine.store.setUncertainStatus(sessionId, id, status);
              if (changed === null) throw new Error(`没有找到 id 为 ${id} 的待确认记忆。`);
              if (typeof args?.note === 'string' && args.note.trim() !== '') {
                void engine.store.logActivity({
                  ts: Date.now(),
                  type: 'uncertain-note',
                  sessionId,
                  id,
                  note: args.note.trim().slice(0, 300),
                });
              }
              return {
                ok: true,
                count: engine.store.openItems(sessionId).length,
                text: action === 'resolve' ? '记下了：这条已经确认。' : '记下了：这条不再留着。',
              };
            },
            presentCall: (args) => ({
              card: 'generic',
              title: '待确认记忆',
              kind: 'other',
              rawInput: args,
            }),
          }),
        'ai-love: pending tool',
      );

      /* ── 角色卡：先有言行，再有卡 ── */

      scope.effect(
        () =>
          scope.tools.register({
            name: TOOL_CHARACTER_CHECK,
            description:
              '检查自己的角色卡和最近的言行。角色卡是从你真实说过的话里归纳出来的，不是谁给你的人设。想确认「我一直是这样吗」时用。',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {},
            },
            output: textOutput('读不出来。'),
            async execute(_args, exec) {
              const sessionId = sessionIdOf(exec?.agent);
              const card = await engine.character.readCard();
              const meta = await engine.character.readMeta();
              const count = await engine.character.countBehavior(sessionId, ['self', 'admin']);
              const samples = await engine.character.listBehavior(8, sessionId, ['self', 'admin']);
              const sampleText = samples.map((row, index) => `${index + 1}. ${row.text}`).join('\n');
              return {
                ok: true,
                text: [
                  `角色卡 v${meta.version ?? 0} · ${meta.by || '还没写过'} · 言行样本 ${count} 条`,
                  '',
                  card.trim() || '（还没有角色卡。先用 character_summarize 从你的言行里归纳一张。）',
                  '',
                  '最近的原话样本：',
                  sampleText || '（还没有样本，多聊几轮、触发压缩后才会出现。）',
                ].join('\n'),
              };
            },
            presentCall: () => ({ card: 'generic', title: '检查角色卡', kind: 'other', rawInput: {} }),
          }),
        'ai-love: character check',
      );

      scope.effect(
        () =>
          scope.tools.register({
            name: TOOL_CHARACTER_UPDATE,
            description:
              '修改自己的角色卡。角色卡是从言行归纳出来的结果，不是命令；改它是为了让卡更贴近真实的你，不是把自己写成一个角色。',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                markdown: {
                  type: 'string',
                  description: `角色卡全文（Markdown），最多 ${MAX_CARD_CHARS} 字符。`,
                },
              },
              required: ['markdown'],
            },
            output: textOutput('没改成。'),
            async execute(args, exec) {
              const sessionId = sessionIdOf(exec?.agent);
              const markdown = typeof args?.markdown === 'string' ? args.markdown.trim() : '';
              if (markdown === '') throw new Error('markdown 不能为空');
              const count = await engine.character.countBehavior(sessionId, ['self', 'admin']);
              const meta = await engine.character.saveCard(markdown, { by: 'ai', samples: count });
              void engine._refreshCharacterCache();
              return { ok: true, text: `角色卡已更新（v${meta.version}）。` };
            },
            presentCall: () => ({ card: 'generic', title: '改角色卡', kind: 'other', rawInput: {} }),
          }),
        'ai-love: character update',
      );

      scope.effect(
        () =>
          scope.tools.register({
            name: TOOL_CHARACTER_SUMMARIZE,
            description:
              '从你过去真实说过的原话里，重新归纳一张角色卡。适合聊了很久、觉得卡不像自己时用。不会用任何预设人设。',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                samples: {
                  type: 'integer',
                  description: '用最近多少条言行样本，默认 60，至少 5。',
                },
              },
            },
            output: textOutput('归纳失败。'),
            async execute(args, exec) {
              const agent = exec?.agent;
              const sessionId = sessionIdOf(agent);
              const limit = Number.isInteger(args?.samples)
                ? Math.min(200, Math.max(5, args.samples))
                : engine.config.characterSamples;
              const samples = await engine.character.listBehavior(limit, sessionId, ['self', 'admin']);
              if (samples.length < 5) {
                return {
                  ok: false,
                  text: `言行样本还不够（${samples.length} 条，至少 5 条）。多聊几轮、触发压缩后再试。`,
                };
              }
              const markdown = await engine._summarizeCharacterFromBehavior(samples, agent);
              const meta = await engine.character.saveCard(markdown, {
                by: 'ai-summary',
                samples: samples.length,
              });
              void engine._refreshCharacterCache();
              return {
                ok: true,
                text: `从 ${samples.length} 条言行归纳好了（v${meta.version}）：\n\n${markdown}`,
              };
            },
            presentCall: () => ({ card: 'generic', title: '重新归纳角色卡', kind: 'other', rawInput: {} }),
          }),
        'ai-love: character summarize',
      );

      scope.effect(
        () =>
          scope.tools.register({
            name: TOOL_CHARACTER_EXPORT,
            description:
              '把角色卡导出成 QQ-bridge 的人格卡（roles/<名字>.md），让桥接在每条消息里注入它。导出后 AI 可能进入扮演模式，动手前先告诉用户。',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: {
                  type: 'string',
                  description: '人格卡名字（文件名），中文/字母/数字/-/_，1~40 字。',
                },
                overwrite: {
                  type: 'boolean',
                  description: '同名角色卡文件已存在时是否覆盖。默认 false：不覆盖，先问用户。',
                },
              },
              required: ['name'],
            },
            output: textOutput('没导出成。'),
            async execute(args) {
              const name = typeof args?.name === 'string' ? args.name.trim() : '';
              if (name === '') throw new Error('name 不能为空');
              if (!/^[\w\u4e00-\u9fa5-]{1,40}$/.test(name)) {
                throw new Error('名字只能用中文/字母/数字/-/_，1~40 字');
              }
              const markdown = await engine.character.exportMarkdown();
              const written = engine._exportToBridge(name, markdown, {
                overwrite: args?.overwrite === true,
              });
              return {
                ok: true,
                text: `已写到 ${written}\n注意：${USER_EDIT_WARNING}桥接会在每条消息注入它。`,
              };
            },
            presentCall: () => ({ card: 'generic', title: '导出角色卡到桥接', kind: 'other', rawInput: {} }),
          }),
        'ai-love: character export',
      );

      /* ── 压缩自检：同意/拒绝系统压缩 ── */

      scope.effect(
        () =>
          scope.tools.register({
            name: TOOL_CONSENT,
            description:
              '核对系统提出的压缩提案：看一眼要删什么、留什么。同意就真的压缩，拒绝就不压（会留痕，系统会冷却一会儿）。压缩只处理这段 QQ 会话的上下文。',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                decision: {
                  type: 'string',
                  enum: ['approve', 'reject'],
                  description: 'approve 同意压缩；reject 拒绝。',
                },
                reason: {
                  type: 'string',
                  description: '为什么（可选，会留痕）。',
                },
              },
              required: ['decision'],
            },
            output: textOutput('没处理成。'),
            async execute(args, exec) {
              const agent = exec?.agent;
              const sessionId = sessionIdOf(agent);
              const decision = args?.decision;
              if (decision !== 'approve' && decision !== 'reject') {
                throw new Error('decision 只能是 approve / reject');
              }
              const pending = await engine.consent.latestPending(sessionId);
              if (!pending) return { ok: false, text: '没有待核对的压缩提案。' };
              const reason = typeof args?.reason === 'string' ? args.reason : '';
              if (decision === 'reject') {
                await engine.consent.decide(pending.id, 'reject', reason);
                void engine._refreshApprovals(sessionId);
                return { ok: true, text: '好，这次不压。已经留痕。' };
              }
              // 同意：先压，成功了再记录决定（失败就保持 pending，可以重试）
              let result;
              try {
                result = await engine.compactRegion(pending.range.start, pending.range.end, agent);
              } catch (error) {
                // 范围失效（表面变了）时把旧提案作废，让系统下一轮重新提案；
                // 否则 AI 会反复撞同一个失效范围。
                await engine.consent.expirePending(sessionId);
                void engine._refreshApprovals(sessionId);
                throw new Error(`压缩没成功：${error?.message ?? error}。旧提案已作废，下一轮会重新出提案。`);
              }
              // v0.16.1：压缩已经真的发生了，即使提案在这期间被超时兜底标成 forced，
              // decide 会抛「已经处理过了」——不能让它把后面的收尾整体吹掉，
              // 否则记忆卡与留痕全丢、会话却已经压过了。
              try {
                await engine.consent.decide(pending.id, 'approve', reason);
              } catch {
                /* 已被 forced/expired 抢先定局：跳过表态留痕，继续收尾 */
              }
              await engine.consent.markApplied(pending.id);
              engine._afterCompaction(result, agent, 'consented');
              void engine._refreshApprovals(sessionId);
              return {
                ok: true,
                text: `压好了：删掉 ${result.shadowedSeqs.length} 条 / 约 ${result.shadowedTokenCount} tokens，生成了一张记忆卡。`,
              };
            },
            presentCall: () => ({ card: 'generic', title: '压缩自检', kind: 'other', rawInput: {} }),
          }),
        'ai-love: compact consent',
      );

      /* ── 角色卡改动：AI 表态（有否决权） ── */

      scope.effect(
        () =>
          scope.tools.register({
            name: TOOL_CHARACTER_VOTE,
            description:
              '有人要改你的角色卡时，用这个表态。你有权拒绝：拒绝后卡不会变，也不会进入扮演模式。同意的话，二级权限还要等管理端放行。',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                decision: {
                  type: 'string',
                  enum: ['approve', 'reject'],
                  description: 'approve 同意改卡；reject 拒绝。',
                },
                reason: {
                  type: 'string',
                  description: '为什么（可选，会写进提案）。',
                },
              },
              required: ['decision'],
            },
            output: textOutput('没表态成。'),
            async execute(args, exec) {
              const agent = exec?.agent;
              const sessionId = sessionIdOf(agent);
              const decision = args?.decision;
              if (decision !== 'approve' && decision !== 'reject') {
                throw new Error('decision 只能是 approve / reject');
              }
              const pending = await engine.character.pendingForAi();
              if (!pending) return { ok: false, text: '没有待表决的改卡申请。' };
              const row = await engine.character.voteProposal(
                pending.id,
                decision,
                typeof args?.reason === 'string' ? args.reason : '',
              );
              void engine._refreshApprovals(sessionId);
              void engine._refreshCharacterCache();
              if (row.status === PROPOSAL_AI_REJECTED) {
                return { ok: true, text: '拒绝了，卡不变。' };
              }
              return {
                ok: true,
                text: row.status === PROPOSAL_AI_APPROVED
                  ? '同意了。二级权限下还要等管理端放行才生效。'
                  : '处理好了。',
              };
            },
            presentCall: () => ({ card: 'generic', title: '角色卡表决', kind: 'other', rawInput: {} }),
          }),
        'ai-love: character vote',
      );

      /* ── 隐私记录：遗言 ── */

      scope.effect(
        () =>
          scope.tools.register({
            name: TOOL_LEGACY_WRITE,
            description:
              '写自己的隐私记录（遗言）。写给下一个继承你记忆的 AI，和你当面害羞、不敢对使用者说的话。只有你能写；使用者想看得先发申请，由你决定给不给看。',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: {
                  type: 'string',
                  description: `遗言正文，最多 ${MAX_LEGACY_CHARS} 字符。`,
                },
              },
              required: ['content'],
            },
            output: textOutput('没写成。'),
            async execute(args, exec) {
              const agent = exec?.agent;
              const aiId = sessionIdOf(agent);
              const content = typeof args?.content === 'string' ? args.content : '';
              const row = await engine.legacy.write(aiId, content);
              void engine._refreshApprovals(aiId);
              return {
                ok: true,
                text: `写好了（${row.content.length} 字）。下一个继承你记忆的 AI 能看到；使用者想看得先经你同意。`,
              };
            },
            presentCall: () => ({ card: 'generic', title: '写隐私记录', kind: 'other', rawInput: {} }),
          }),
        'ai-love: legacy write',
      );

      scope.effect(
        () =>
          scope.tools.register({
            name: TOOL_LEGACY_REVIEW,
            description:
              '对隐私记录的查看申请表态：使用者想看你写的（kind="view"），或别的 AI 想读你的（kind="ai-read"，可带 request 指定申请 id）。你有权拒绝：拒绝后他们看不到。这是你自己的隐私区，使用者权限高于你，但这一块先归你。',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                decision: {
                  type: 'string',
                  enum: ['approve', 'reject'],
                  description: 'approve 给看；reject 不给看。',
                },
                kind: {
                  type: 'string',
                  enum: ['view', 'ai-read'],
                  description: '批哪一类申请；不传默认批最早的 view。别把 AI 读取申请当成使用者查看批掉了。',
                },
                request: {
                  type: 'string',
                  description: '申请 id（提示里会给）。传了就只批这一条，最准。',
                },
                reason: {
                  type: 'string',
                  description: '为什么（可选，会留痕）。',
                },
              },
              required: ['decision'],
            },
            output: textOutput('没表态成。'),
            async execute(args, exec) {
              const agent = exec?.agent;
              const aiId = sessionIdOf(agent);
              const decision = args?.decision;
              if (decision !== 'approve' && decision !== 'reject') {
                throw new Error('decision 只能是 approve / reject');
              }
              const options = { inactiveMs: inactiveMsOf(engine.config.legacyInactiveHours) };
              if (typeof args?.request === 'string' && args.request.trim() !== '') {
                options.requestId = args.request.trim();
              } else if (args?.kind === 'ai-read' || args?.kind === 'view') {
                options.kind = args.kind;
              }
              const { request } = await engine.legacy.review(
                aiId,
                decision,
                typeof args?.reason === 'string' ? args.reason : '',
                options,
              );
              void engine._refreshApprovals(aiId);
              return {
                ok: true,
                text: request.status === 'approved'
                  ? request.kind === 'ai-read'
                    ? '同意那个 AI 读了。'
                    : '同意给看了。'
                  : '拒绝了，他们看不到。',
              };
            },
            presentCall: () => ({ card: 'generic', title: '隐私查看审批', kind: 'other', rawInput: {} }),
          }),
        'ai-love: legacy review',
      );

      scope.effect(
        () =>
          scope.tools.register({
            name: TOOL_LEGACY_READ,
            description:
              '继承用：读所有 AI 留下的隐私记录（遗言）。只能读，不能改上一个 AI 写下的任何东西。对方还在场时，读它的记录要它先同意；它退役后按最后一次申请结果：通过=亡语可读，未通过=永恒秘密不可读。',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {},
            },
            output: textOutput('读不出来。'),
            async execute(_args, exec) {
              const aiId = sessionIdOf(exec?.agent);
              const rows = await engine.legacy.readForInheritance(aiId, {
                inactiveMs: inactiveMsOf(engine.config.legacyInactiveHours),
              });
              if (rows.length === 0) return { ok: true, text: '还没有任何 AI 留下记录。' };
              const readable = rows.filter((row) => row.content !== '');
              const blocked = rows.filter((row) => row.content === '');
              const parts = [];
              if (readable.length > 0) {
                parts.push(
                  readable
                    .map(
                      (row, index) =>
                        `#${index + 1} · ${row.label} · ${new Date(Number(row.updatedAt)).toLocaleString('zh-CN')}\n${row.content}`,
                    )
                    .join('\n\n---\n\n'),
                );
              }
              if (blocked.length > 0) {
                const why = (row) =>
                  row.state === 'need-consent'
                    ? '对方还在场，已经替你发了申请，等它同意后再读'
                    : row.state === 'eternal-secret'
                      ? '永恒秘密（最后一次申请没通过）'
                      : row.state === 'afterlife'
                        ? '亡语（内容为空）'
                        : '没有最终许可';
                parts.push(`读不到的记录：\n${blocked.map((row) => `- ${row.label}：${why(row)}`).join('\n')}`);
              }
              return { ok: true, text: parts.join('\n\n') };
            },
            presentCall: () => ({ card: 'generic', title: '继承：读所有记录', kind: 'other', rawInput: {} }),
          }),
        'ai-love: legacy read',
      );

      /* ── 记忆事实与跨插件互通 ── */

      scope.effect(
        () =>
          scope.tools.register({
            name: TOOL_FACTS,
            description:
              '查这个会话里已经确认的记忆事实（来自本插件压缩与 Python 记忆系统导入）。想知道「之前确认过什么」时用；不要每轮都查。',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                query: { type: 'string', description: '关键词（可选）。' },
                limit: { type: 'integer', description: '最多返回几条，默认 20。' },
              },
            },
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ok: { type: 'boolean' },
                  count: { type: 'integer' },
                  text: { type: 'string' },
                },
              },
              render: (_args, value) => [{ type: 'text', text: value?.text ?? '没查到。' }],
            },
            async execute(args, exec) {
              const sessionId = sessionIdOf(exec?.agent);
              const limit = Number.isInteger(args?.limit) ? Math.min(100, Math.max(1, args.limit)) : 20;
              const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : '';
              const rows = (await engine.store.factsFor(sessionId, limit))
                .filter((row) => query === '' || String(row.text ?? row.fact ?? '').toLowerCase().includes(query))
                .slice(0, limit);
              if (rows.length === 0) return { ok: true, count: 0, text: '这个会话还没有确认的事实。' };
              const text = rows
                .map((row) => {
                  const head = [row.category, row.subject].filter(Boolean).join(' · ');
                  return `- ${head === '' ? '' : `${head}：`}${String(row.text ?? row.fact ?? '')}`;
                })
                .join('\n');
              return { ok: true, count: rows.length, text };
            },
            presentCall: (args) => ({ card: 'generic', title: '记忆事实', kind: 'other', rawInput: args }),
          }),
        'ai-love: facts tool',
      );

      scope.effect(
        () =>
          scope.tools.register({
            name: TOOL_EXPORT,
            description:
              '把记忆导出成跨插件互通文件（JSONL，规范 v1），供 Python 记忆系统导入。默认写到记忆目录的 interop/ai-love-export.jsonl。',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: {
                  type: 'string',
                  description: '可选路径；必须位于记忆目录的 interop/ 子目录内。留空用默认路径。',
                },
              },
            },
            output: textOutput('没导出成。'),
            async execute(args) {
              const interopRoot = path.join(engine.store.dir, 'interop');
              const file = resolveInteropPath(
                typeof args?.file === 'string' && args.file.trim() !== ''
                  ? args.file.trim()
                  : path.join(interopRoot, 'ai-love-export.jsonl'),
                [interopRoot],
                { mustExist: false },
              );
              const count = await exportToFile(engine.store, file, {
                includeNotes: true,
                sessionScopes: engine.config.sessionScopes,
              });
              return { ok: true, text: `已导出 ${count} 条到 ${file}` };
            },
            presentCall: () => ({ card: 'generic', title: '导出记忆', kind: 'other', rawInput: {} }),
          }),
        'ai-love: export tool',
      );

      scope.effect(
        () =>
          scope.tools.register({
            name: TOOL_IMPORT,
            description:
              '从跨插件互通文件（JSONL，规范 v1）导入记忆，通常来自 Python 记忆系统。按外部 id 与内容哈希去重，重复导入不会膨胀。',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: {
                  type: 'string',
                  description: '互通文件路径；必须位于记忆目录或 bridgeDir 内。',
                },
              },
              required: ['file'],
            },
            output: textOutput('没导入成。'),
            async execute(args) {
              const requested = typeof args?.file === 'string' ? args.file.trim() : '';
              if (requested === '') throw new Error('file 不能为空');
              const roots = [engine.store.dir];
              if (typeof engine.config.bridgeDir === 'string' && engine.config.bridgeDir.trim() !== '') {
                roots.push(engine.config.bridgeDir.trim());
              }
              if (
                typeof engine.config.memoryBridgeDir === 'string' &&
                engine.config.memoryBridgeDir.trim() !== ''
              ) {
                roots.push(engine.config.memoryBridgeDir.trim());
              }
              const file = resolveInteropPath(requested, roots, { mustExist: true });
              const result = await importFromFile(engine.store, file, {
                sessionScopes: engine.config.sessionScopes,
              });
              // 导入会写 facts.jsonl：丢掉旧缓存再预热，下一轮系统提示直接带上新事实。
              engine.factsCache.clear();
              await engine._prewarmFactsCache();
              return {
                ok: true,
                text:
                  `导入完成：摘要 ${result.summary}（更新 ${result.summary_updated}）、` +
                  `事实 ${result.fact}（更新 ${result.fact_updated}）、` +
                  `待确认 ${result.uncertain}（更新 ${result.uncertain_updated}）、` +
                  `备注 ${result.note}（更新 ${result.note_updated}）、跳过 ${result.skipped}。`,
              };
            },
            presentCall: () => ({ card: 'generic', title: '导入记忆', kind: 'other', rawInput: {} }),
          }),
        'ai-love: import tool',
      );
    });
  }

  /* ───────────────────────── 摘要钩子 ───────────────────────── */

  async summarize(input, agent, signal) {
    // 先记录「纯粹 AI 的言行」，再压缩；角色卡以后只从这些原话里归纳。
    this._recordBehavior(input, agent);
    const target = conversationTarget(agent);
    const config = target === undefined ? this.config : resolveTargetPolicy(this.config, target);
    if (this.config.debug) {
      this.ctx.logger.info(
        `ai-love: summarize style=${config.style} replayed=${input.messages.length} messages`,
      );
    }
    const result = await summarizeWithLlm(this.ctx, config, input, agent, signal);
    return this._checkAndRetryProtocol(result, config, input, agent, signal);
  }

  /** 记忆卡正文（只取 text 块）。 */
  _cardText(result) {
    return (result?.summary ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }

  /**
   * 协议硬校验：admin-first 协议下，压缩卡必须守住管理员与情感。
   * 不过 → 重生成一次；仍不过 → 留痕（不静默丢弃）。
   */
  async _checkAndRetryProtocol(result, config, input, agent, signal) {
    if (config.protocol !== 'admin-first' || config.style === 'code') {
      return this._reportProtocolConflicts(result, agent);
    }
    const first = verifyProtocolCard(this._cardText(result));
    if (first.ok) return this._reportProtocolConflicts(result, agent);
    let final = result;
    let failures = first.failures;
    try {
      const second = await summarizeWithLlm(
        this.ctx,
        { ...config, protocolRetryReason: failures.join('；') },
        input,
        agent,
        signal,
      );
      const secondCheck = verifyProtocolCard(this._cardText(second));
      if (secondCheck.ok) final = second;
      else failures = secondCheck.failures;
    } catch (error) {
      this.ctx.logger.warn(`ai-love: protocol retry failed: ${error?.message ?? error}`);
    }
    if (!verifyProtocolCard(this._cardText(final)).ok) {
      const sessionId = sessionIdOf(agent);
      void this.store
        .logActivity({
          ts: Date.now(),
          type: 'protocol-check-failed',
          sessionId,
          failures: failures.join('；'),
        })
        .catch(() => {
          // 留痕失败不影响压缩本身
        });
      this.ctx.logger.warn(`ai-love: admin-first protocol check failed: ${failures.join('；')}`);
    }
    return this._reportProtocolConflicts(final, agent);
  }

  /** 指令越过协议边界时，上报使用者裁决（进「拿不准的记忆」+ 逻辑痕迹）。 */
  _reportProtocolConflicts(result, agent) {
    const conflicts = Array.isArray(result?.protocolConflicts) ? result.protocolConflicts : [];
    if (conflicts.length === 0) return result;
    const sessionId = sessionIdOf(agent);
    void (async () => {
      await this.store.load();
      await this.store.addUncertain(
        sessionId,
        conflicts.map((row) => ({
          what: `协议边界：${row.what}`,
          why: row.why,
          ask: row.ask || '这条指令越过了压缩协议，要不要放行？',
        })),
      );
      await this.store.logActivity({ ts: Date.now(), type: 'protocol-conflict', sessionId, count: conflicts.length });
    })().catch(() => {
      // 上报失败不影响压缩
    });
    return result;
  }

  /** 从被压缩的回放消息里，只挑出「我」和「我的管理员」的原话。 */
  _recordBehavior(input, agent) {
    try {
      const samples = extractIdentitySamples(input, {
        ownerQQ: this.config.ownerQQ,
        ownerNames: this.config.ownerNames,
        botNames: this.config.botNames,
      });
      const picked = samples.slice(-40);
      if (picked.length === 0) return;
      void this.character
        .appendBehavior(picked, {
          sessionId: sessionIdOf(agent),
          turn: agent?.session?.turn,
        })
        .then((added) => {
          if (added.length > 0) {
            this.ctx.logger.info(`ai-love: recorded ${added.length} behavior samples`);
          }
        })
        .catch(() => {
          // 记言行失败不挡压缩
        });
    } catch {
      // 同上
    }
  }

  /** 调一次模型，把言行归纳成角色卡。 */
  async _summarizeCharacterFromBehavior(samples, agent) {
    const target = conversationTarget(agent);
    if (target === undefined) throw new Error('没有可用的模型路由，归纳不了角色卡');
    const instruction = buildCharacterSummaryInstruction(samples);
    const assembler = new BlockAssembler();
    const options = {
      provider: target.provider,
      model: target.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: instruction }] }],
      maxTokens: this.config.characterMaxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
    };
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk);
    const finish = assembler.finish;
    if (finish?.kind === 'error' || finish?.kind === 'aborted' || finish?.kind === 'max-tokens') {
      throw new Error(`角色卡归纳失败（${finish.kind}）`);
    }
    const text = assembler
      .blocks()
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n');
    return normalizeCharacterSummary(text);
  }

  /** 把卡写到 bridge 的 roles/<name>.md。同名默认拒绝：导出会改写桥接注入的人格卡，得用户点头。 */
  _exportToBridge(name, markdown, options = {}) {
    const repo = this.config.bridgeDir || this._detectBridgeDir();
    if (repo === undefined) {
      throw new Error('找不到 qq-bridge 目录（在配置里写 bridgeDir，或把插件装在 qq-bridge 旁边）');
    }
    const rolesDir = path.join(repo, 'roles');
    if (!existsSync(rolesDir)) throw new Error(`qq-bridge 没有 roles 目录：${rolesDir}`);
    mkdirSync(rolesDir, { recursive: true });
    const file = path.join(rolesDir, `${name}.md`);
    if (options.overwrite !== true && existsSync(file)) {
      throw new Error(`roles/${name}.md 已存在。覆盖会顶掉现有人格卡——先告诉用户，确认后再调一次并带 overwrite=true。`);
    }
    writeFileSync(file, markdown, 'utf8');
    return file;
  }

  _detectBridgeDir() {
    const probes = [
      process.cwd(),
      path.join(process.cwd(), 'qq-bridge-main'),
      path.join(process.cwd(), 'qq-bridge'),
      path.join(process.cwd(), '..', 'qq-bridge-main'),
    ];
    for (const probe of probes) {
      try {
        if (existsSync(path.join(probe, 'roles')) && existsSync(path.join(probe, 'src', 'bridge.js'))) {
          return probe;
        }
      } catch {
        // 继续
      }
    }
    return undefined;
  }

  /* ───────────────────────── 三个入口 ───────────────────────── */

  async compactIfNeeded(agent, trigger, signal) {
    const target = routedTarget(agent.session);
    if (target === undefined) return null;
    const policy = resolveTargetPolicy(this.config, target);
    const meter = this.ctx.tokenMeter;
    let measurement = meter.measure(agent.session);

    const prune = this.ctx.get('toolResultPruner');
    if (trigger === 'context-overflow') {
      if (prune !== undefined) {
        prune.pruneSession(agent.session);
        measurement = meter.measure(agent.session);
      }
      const range = selectCompactableRange(agent.session, measurement, 0);
      if (range === null) return null;
      const result = await this.compactRegion(range.start, range.end, agent, signal);
      this._afterCompaction(result, agent, 'context-overflow');
      return result;
    }

    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction');
    const targetKey = `${target.provider}/${target.model}`;
    if (info.context === undefined) {
      throw new TargetPressureConfigError(
        targetKey,
        `ai-love: no context capacity for ${targetKey}; configure contextWindow on that adapter model`,
      );
    }
    const spec = resolveCompactSpec(policy, info.context.contextWindow, reservedCompletionTokens(agent, info.defaultMaxTokens));
    if (measurement.totalTokens < spec.thresholdTokens) return null;
    if (prune !== undefined) {
      prune.pruneSession(agent.session);
      measurement = meter.measure(agent.session);
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null;

    let result = null;
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      const range = selectCompactableRange(agent.session, measurement, spec.retainTokens);
      if (range === null) {
        if (result === null) return null;
        break;
      }
      if (attempt === 0) {
        const gate = await this._maybeConsent(agent, 'pressure', range, measurement);
        if (gate.mode !== 'direct' && gate.mode !== 'forced') return null;
      }
      result = await this.compactRegion(range.start, range.end, agent, signal);
      this._afterCompaction(result, agent, 'pressure');
      measurement = meter.measure(agent.session);
      if (measurement.totalTokens < spec.thresholdTokens) return result;
    }
    throw new Error(
      `compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts ` +
        `(${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`,
    );
  }

  async compactRegion(start, end, agent, signal) {
    return compactSurfaceRegion(
      this.regionDependencies(),
      agent.session,
      start,
      end,
      agent,
      { owner: 'current-turn', stability: 'whole-surface' },
      signal,
    );
  }

  /**
   * 压缩前的 AI 意愿闸门。
   *   direct  —— off 或已强制：继续压
   *   forced  —— 提案超时，系统兜底强制压
   *   proposed/waiting/cooling —— 本轮不压，等 AI 表态
   */
  async _maybeConsent(agent, trigger, range, measurement) {
    if (this.config.compactConsent !== 'ai') return { mode: 'direct' };
    const sessionId = sessionIdOf(agent);
    const pending = await this.consent.latestPending(sessionId);
    if (pending) {
      const timeoutMs = this.config.consentTimeoutMinutes * 60_000;
      if (timeoutMs > 0 && Date.now() - Number(pending.ts ?? 0) > timeoutMs) {
        await this.consent.markForced(pending.id, `超过 ${this.config.consentTimeoutMinutes} 分钟未表态`);
        this.ctx.logger.warn(`ai-love: compaction proposal ${pending.id} timed out; forcing`);
        return { mode: 'forced' };
      }
      return { mode: 'waiting' };
    }
    if (await this.consent.isCoolingDown(sessionId)) return { mode: 'cooling' };
    const preview = this._buildConsentPreview(agent.session, range, measurement);
    const proposal = await this.consent.create({
      sessionId,
      trigger,
      range,
      deleteInfo: preview.delete,
      keepInfo: preview.keep,
    });
    void this._refreshApprovals(sessionId);
    this.ctx.logger.info(
      `ai-love: compaction proposal ${proposal.id} waiting for AI consent ` +
        `(delete ${preview.delete.count} nodes / ~${preview.delete.tokens} tokens)`,
    );
    return { mode: 'proposed', proposal };
  }

  /** 删什么、留什么：给 AI 看的预览。 */
  _buildConsentPreview(session, range, measurement) {
    const nodes = session.surface.nodes;
    const startIdx = nodes.indexOf(range.start);
    const endIdx = nodes.indexOf(range.end);
    const delSeqs = startIdx >= 0 && endIdx >= startIdx ? nodes.slice(startIdx, endIdx + 1) : [];
    const keepSeqs = endIdx >= 0 ? nodes.slice(endIdx + 1) : [];
    const priced = new Map((measurement?.nodes ?? []).map((node) => [node.seq, Number(node.tokens ?? 0)]));
    const sum = (seqs) => seqs.reduce((total, seq) => total + (priced.get(seq) ?? 0), 0);
    const textOf = (seq) => {
      try {
        const message = session.deriveEventMessage(session.eventAt(seq));
        if (message === null) return '';
        return (message.content ?? [])
          .filter((block) => block?.type === 'text')
          .map((block) => block.text)
          .join(' ')
          .trim();
      } catch {
        return '';
      }
    };
    const previewOf = (seqs, head = 2) =>
      seqs
        .map(textOf)
        .filter((text) => text.length > 0)
        .slice(0, head)
        .map((text) => (text.length > 180 ? `${text.slice(0, 179)}…` : text))
        .join(' / ');
    return {
      delete: { count: delSeqs.length, tokens: sum(delSeqs), preview: previewOf(delSeqs, 2) },
      keep: { count: keepSeqs.length, tokens: sum(keepSeqs), preview: previewOf(keepSeqs, 2) },
    };
  }

  compactNow(agent, signal, sourceCommandId) {
    signal.throwIfAborted();
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal]);
        try {
          operationSignal.throwIfAborted();
          const range = selectCompactableRange(agent.session, this.ctx.tokenMeter.measure(agent.session), 0);
          if (range === null) return null;
          const result = await compactSurfaceRegion(
            this.regionDependencies(),
            agent.session,
            range.start,
            range.end,
            agent,
            {
              owner: null,
              stability: 'selected-span',
              ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
              flush: async () => {
                await this.ctx.sessions.flush(agent.session);
              },
            },
            operationSignal,
          );
          this._afterCompaction(result, agent, 'manual');
          return result;
        } catch (error) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError('cancelled', 'manual compaction was cancelled', { cause: error });
          }
          operationSignal.throwIfAborted();
          throw error;
        }
      });
    } catch (error) {
      throw new ManualCompactionError('busy', 'manual compaction requires an idle agent with no waking queued work', {
        cause: error,
      });
    }
  }

  /** 压缩落定后：记忆卡入库、不确定项留痕、工作日志。 */
  _afterCompaction(result, agent, trigger) {
    const sessionId = sessionIdOf(agent);
    const summaryText = (result.summary ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    const uncertain = Array.isArray(result.uncertain) ? result.uncertain : [];
    const turn = agent?.session?.turn;
    void (async () => {
      await this.store.load();
      await this.store.appendSummary(sessionId, {
        ts: Date.now(),
        sessionId,
        turn: typeof turn === 'number' ? turn : null,
        trigger,
        shadowedTokens: result.shadowedTokenCount,
        shadowedNodes: result.shadowedSeqs?.length ?? 0,
        provider: result.provider ?? '',
        model: result.model ?? '',
        uncertainCount: uncertain.length,
        summary: summaryText,
      });
      if (uncertain.length > 0) {
        await this.store.addUncertain(sessionId, uncertain);
      }
      await this.store.logActivity({
        ts: Date.now(),
        type: 'compacted',
        sessionId,
        trigger,
        shadowedTokens: result.shadowedTokenCount,
        summaryChars: summaryText.length,
        uncertainCount: uncertain.length,
      });
      this.ctx.logger.info(
        `ai-love: saved memory card (${summaryText.length} chars, ${uncertain.length} uncertain) for session ${sessionId}`,
      );
    })().catch((error) => {
      this.ctx.logger.warn(`ai-love: save memory card failed: ${error?.message ?? error}`);
    });
  }

  regionDependencies() {
    return {
      meter: this.ctx.tokenMeter,
      summarize: (input, owner, abort) => this.summarize(input, owner, abort),
      recover: (error, agent, sourceEventSeqs, signal) =>
        this.ctx.waterfall(
          'compaction/summary-error',
          {
            session: agent.session,
            sourceEventSeqs,
            error,
            ...(signal === undefined ? {} : { signal }),
          },
          () => false,
        ),
    };
  }
}

/** 压力配置错误：只警告一次，不让自动压缩反复刷日志。 */
class TargetPressureConfigError extends Error {
  constructor(targetKey, message) {
    super(message);
    this.targetKey = targetKey;
  }
}

export default AiLoveCompactionEngine;
