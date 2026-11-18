/**
 * 爱ai · 左侧栏面板的数据接口（profile 根）
 *
 * 四件事：
 *   1. 只读看痕迹：stats / activity / summaries / uncertain（/ai-love/state）
 *   2. 角色卡：读、提交改动（二级走 AI→管理端，三级直接通行）、变更历史
 *   3. 角色卡申请：管理端放行 / 拒绝
 *   4. 压缩自检：系统提出的压缩提案 + AI 表态留痕（只读）
 *
 * 角色卡和提案都写在 <memoryDir>/ 下；面板不碰会话、不碰桥接。
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CompactStore, resolveMemoryDir } from '../core/memory.mjs';
import {
  CharacterStore,
  MAX_CARD_CHARS,
  USER_EDIT_WARNING,
  describeCardMeta,
} from '../core/character.mjs';
import { ConsentStore, describeConsent } from '../core/compact-consent.mjs';
import { LegacyStore, deriveLegacyState, inactiveMsOf } from '../core/legacy.mjs';
import { epitaphFor } from '../core/legacy.mjs';
import { exportToFile, importFromFile, resolveInteropPath } from '../core/interop.mjs';
import { createAutoBridge } from '../core/auto-bridge.mjs';
import { BackupManager, detectBackupDir } from '../core/backup.mjs';
import { isSystemVolume, resolveLinkRoot, resolveSessionsRoot, scanContextLinks } from '../core/context-link.mjs';
import { GuardCenter } from '../core/guard.mjs';
import { TokenWise, levelOfBudget } from '../core/tokenwise.mjs';
import { applySafehouse } from '../safehouse/index.mjs';
import { defaultKeyDir } from '../safehouse/constants.mjs';

const PANEL_BASE = '/ai-love';
const MAX_SUMMARY_CHARS = 6000;

function readVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '';
  } catch {
    return '';
  }
}

const VERSION = readVersion();

function replyJson(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function clip(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function readBody(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('请求体太大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data.trim() === '' ? {} : JSON.parse(data));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 只接受同源 JSON 写操作；没有 headers 的测试请求直接放行。 */
function isTrustedWrite(req) {
  if (!req.headers) return true;
  const origin = req.headers.origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (!req.headers.host || parsed.host !== req.headers.host) return false;
    } catch {
      return false;
    }
  }
  return String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json');
}

/** 面板的写接口统一挡一层，防止别的网页直接 POST 到本机 DSH。 */
function withWriteGuard(handler) {
  return (req, res) => {
    const method = String(req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && !isTrustedWrite(req)) {
      return replyJson(res, 403, { ok: false, error: 'forbidden' });
    }
    return handler(req, res);
  };
}

export function apply(ctx, config = {}) {
  const store = new CompactStore(resolveMemoryDir(config));
  // 安全屋：A 半密钥落在 <DSH_HOME>/safehouse-keys/ai-love/keys/half-a.key，
  // 刻意放在记忆目录之外 —— 记忆备份/归档不会把私钥一起带走。
  const safehouse = applySafehouse(ctx, {
    sharedDir: typeof config.safehouseDir === 'string' ? config.safehouseDir : '',
    pluginDir: defaultKeyDir(),
    memoryDir: store.dir,
    bridgeDir: typeof config.bridgeDir === 'string' ? config.bridgeDir : '',
  });
  const character = new CharacterStore(store.dir);
  const consent = new ConsentStore(store.dir, {
    // 与引擎同一份冷却口径：面板实例的 isCoolingDown/留痕判定不再固定 10 分钟。
    cooldownMs:
      (typeof config.consentCooldownMinutes === 'number' && config.consentCooldownMinutes >= 0
        ? config.consentCooldownMinutes
        : 10) * 60_000,
  });
  const legacyStore = new LegacyStore(store.dir);
  const bridge = createAutoBridge({
    config,
    store,
    sessionScopes: config.sessionScopes ?? {},
    logger: ctx.logger,
  });
  const backup = new BackupManager({
    dir: detectBackupDir(config.backupDir),
    intervalMs:
      (typeof config.backupIntervalMinutes === 'number' && config.backupIntervalMinutes >= 0
        ? config.backupIntervalMinutes
        : 10) * 60_000,
  });
  const contextLinkRoot = resolveLinkRoot(config);
  const scanLink = async () => {
    try {
      return await scanContextLinks({ linkRoot: contextLinkRoot });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        sessionsRoot: resolveSessionsRoot(),
        linkRoot: contextLinkRoot,
        linkRootOnSystemDrive: isSystemVolume(contextLinkRoot),
        dshRunning: { running: false, unknown: true, error: message },
        error: message,
        groups: [],
        totals: { groups: 0, linked: 0, ready: 0, conflicts: 0, broken: 0, interrupted: 0, bytes: 0 },
      };
    }
  };
  const guard = new GuardCenter({ memoryDir: store.dir, backupDir: backup.dir });
  const tokenwise = new TokenWise(store.dir, {
    toolLogPath:
      typeof config.bridgeDir === 'string' && config.bridgeDir.trim() !== ''
        ? path.join(config.bridgeDir.trim(), 'state', 'tool-calls.jsonl')
        : '',
  });
  void store.load();
  void character.load();
  void backup.loadMeta();
  void guard.load();
  void tokenwise.load();
  // DSH 启动后自动与小肥鱼鲸鱼娘同步；开关任一关掉就只读不动。
  ctx.effect(() => bridge.start(), 'ai-love: auto interop');
  const userLevel = config.userLevel === 3 ? 3 : 2;
  // 三级默认关闭；只有显式在 profile/patch 里开 allowLevel3 才显示入口。
  const allowLevel3 = config.allowLevel3 === true;
  const legacyInactiveHours =
    typeof config.legacyInactiveHours === 'number' && config.legacyInactiveHours >= 0
      ? config.legacyInactiveHours
      : 24;
  const legacyInactiveMs = inactiveMsOf(legacyInactiveHours);

  /** 汇总面板上的全部模块数据，供备份导出。 */
  async function collectSnapshot() {
    await store.load();
    const [summaries, activity, uncertain, memoryCards, factsAll, card, cardMeta, behavior, proposals, history, consents, legacyList] =
      await Promise.all([
        store.listRecentSummaries(5),
        store.listRecentActivity(30),
        store.listUncertainAll(20),
        store.countSummaries(),
        store.allFacts(),
        character.readCard(),
        character.readMeta(),
        character.listBehavior(20),
        character.listProposals(20),
        character.history(30),
        consent.list(30),
        legacyStore.panelList({ inactiveMs: legacyInactiveMs }),
      ]);
    const facts = factsAll
      .slice()
      .sort((a, b) => Number(b?.ts ?? 0) - Number(a?.ts ?? 0))
      .slice(0, 50);
    // 备份里的「已确认事实」只算还能用的：已否掉/已解决的别当成现存记忆。
    const activeFacts = factsAll.filter((row) =>
      ['open', 'confirmed'].includes(String(row.status ?? 'open')),
    ).length;
    let open = 0;
    for (const counter of store.counters.values()) open += counter.open;
    const legacyRows = [];
    for (const row of legacyList) {
      let content = '';
      // 只有退役（死亡）后的记录才把正文交给备份；活着时申请通过也只给状态。
      if (row.state?.canView === true && row.state?.retired === true) {
        const full = await legacyStore.read(row.aiId);
        content = String(full?.content ?? '');
      }
      legacyRows.push({
        aiId: row.aiId,
        label: row.label,
        updatedAt: row.updatedAt,
        state: row.state,
        content,
      });
    }
    return {
      version: VERSION,
      memoryDir: store.dir,
      backupDir: backup.dir,
      stats: {
        compactions: activity.filter((row) => row?.type === 'compacted').length,
        memoryCards,
        openUncertain: open,
        facts: activeFacts,
      },
      activity,
      summaries,
      uncertain,
      facts,
      consents: consents.map(describeConsent),
      character: { card, meta: describeCardMeta(cardMeta), behavior, proposals, history },
      legacy: legacyRows,
      legacyFiles: legacyRows
        .filter((row) => row.state?.retired === true && row.state?.canView === true)
        .map((row) => legacyStore.fileFor(row.aiId)),
      contextLink: await scanLink(),
      interop: bridge.status(),
      config: {
        style: config.style ?? 'qq',
        compactConsent: config.compactConsent ?? 'ai',
        legacyInactiveHours,
        backupIntervalMinutes: backup.intervalMs / 60_000,
        contextLinkDir: contextLinkRoot,
      },
    };
  }

  async function syncBackup() {
    return backup.sync(await collectSnapshot());
  }

  ctx.inject(['webServer'], (scope) => {
    scope.effect(
      () => {
        const register = (options) =>
          scope.webServer.register({ ...options, handler: withWriteGuard(options.handler) });
        const disposers = [
          /* ── 状态（只读） ── */
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/state`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'GET') return replyJson(res, 405, { ok: false, error: 'method' });
                await store.load();
                if (backup.shouldSync()) {
                  void syncBackup().catch(() => {
                    // 自动备份失败不影响面板
                  });
                }
                const [summaries, activity, uncertain, memoryCards, factsAll] = await Promise.all([
                  store.listRecentSummaries(5),
                  store.listRecentActivity(30),
                  store.listUncertainAll(20),
                  store.countSummaries(),
                  store.allFacts(),
                ]);
                const facts = factsAll
                  .slice()
                  .sort((a, b) => Number(b?.ts ?? 0) - Number(a?.ts ?? 0))
                  .slice(0, 50);
                const activeFacts = factsAll.filter((row) =>
                  ['open', 'confirmed'].includes(String(row.status ?? 'open')),
                ).length;
                let open = 0;
                for (const counter of store.counters.values()) open += counter.open;
                replyJson(res, 200, {
                  ok: true,
                  plugin: 'ai-love',
                  version: VERSION,
                  memoryDir: store.dir,
                  // 安全屋只读快照（和娱乐插件端口同一份：不含票据/私钥/聊天正文）。
                  // 进出仍只能由 AI 自己调 safehouse_enter / safehouse_exit。
                  safehouse: (() => {
                    try {
                      const ext = safehouse?.extSnapshot?.() ?? null;
                      if (!ext) return null;
                      // 最近一次进/出的时间来自状态事件的环形缓冲（只取时间，不带票据/正文）。
                      let lastEnterAt = 0;
                      let lastExitAt = 0;
                      for (const event of safehouse?.status?.()?.events ?? []) {
                        const at = Number(event?.at) || 0;
                        if (event?.type === 'enter') lastEnterAt = Math.max(lastEnterAt, at);
                        if (event?.type === 'exit' || event?.type === 'force-exit') lastExitAt = Math.max(lastExitAt, at);
                      }
                      return { ...ext, lastEnterAt, lastExitAt };
                    } catch {
                      return null;
                    }
                  })(),
                  userLevel,
                  allowLevel3,
                  warning: USER_EDIT_WARNING,
                  stats: {
                    compactions: activity.filter((row) => row?.type === 'compacted').length,
                    memoryCards,
                    openUncertain: open,
                    facts: activeFacts,
                  },
                  facts: facts.map((row) => ({
                    ts: row.ts,
                    sessionId: row.sessionId,
                    text: clip(row.text ?? row.fact, 600),
                    subject: clip(row.subject, 120),
                    category: clip(row.category, 60),
                    status: row.status,
                    importance: row.importance,
                    source: row.source,
                  })),
                  activity,
                  summaries: summaries.map((row) => ({
                    ts: row.ts,
                    sessionId: row.sessionId,
                    trigger: row.trigger,
                    shadowedTokens: row.shadowedTokens,
                    uncertainCount: row.uncertainCount,
                    summary: clip(row.summary, MAX_SUMMARY_CHARS),
                  })),
                  uncertain: uncertain.map((row) => ({
                    id: row.id,
                    ts: row.ts,
                    sessionId: row.sessionId,
                    what: row.what,
                    why: clip(row.why, 300),
                    ask: clip(row.ask, 300),
                    status: row.status,
                    mentions: row.mentions ?? 0,
                    adminReply: clip(row.adminReply, 600),
                    repliedAt: Number(row.repliedAt ?? 0),
                    replyState: String(row.replyState ?? ''),
                    aiNote: clip(row.aiNote, 300),
                  })),
                  interop: bridge.status(),
                });
              } catch (error) {
                replyJson(res, 500, {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            },
          }),

          /* ── 跨插件互通：自动联通开关 / 立即同步 ── */
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/interop/auto`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                const body = await readBody(req);
                if (typeof body?.enabled !== 'boolean') {
                  return replyJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' });
                }
                const state = bridge.setAuto(body.enabled);
                let result = null;
                let error = '';
                if (body.enabled && state.link.xiaofeiyu === true) {
                  try {
                    result = await bridge.syncNow({ force: true });
                  } catch (caught) {
                    error = caught instanceof Error ? caught.message : String(caught);
                  }
                }
                return replyJson(res, 200, {
                  ok: true,
                  ...state,
                  interop: bridge.status(),
                  result,
                  error,
                });
              } catch (error) {
                replyJson(res, 400, {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            },
          }),
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/interop/sync`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                await readBody(req);
                const result = await bridge.syncNow({ force: true });
                return replyJson(res, 200, { ok: true, result, interop: bridge.status() });
              } catch (error) {
                return replyJson(res, 200, {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                  interop: bridge.status(),
                });
              }
            },
          }),

          /* ── 跨插件互通：导出 / 导入规范 JSONL ── */
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/interop/export`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                const body = await readBody(req);
                const requested = typeof body?.file === 'string' ? body.file.trim() : '';
                const interopRoot = path.join(store.dir, 'interop');
                const file = resolveInteropPath(
                  requested === '' ? path.join(interopRoot, 'ai-love-export.jsonl') : requested,
                  [interopRoot],
                  { mustExist: false },
                );
                const count = await exportToFile(store, file, {
                  includeNotes: true,
                  sessionScopes: config.sessionScopes,
                });
                return replyJson(res, 200, { ok: true, file, count });
              } catch (error) {
                replyJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
              }
            },
          }),
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/interop/import`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                const body = await readBody(req);
                const requested = typeof body?.file === 'string' ? body.file.trim() : '';
                if (requested === '') return replyJson(res, 400, { ok: false, error: 'file 必填' });
                const roots = [store.dir];
                if (typeof config.bridgeDir === 'string' && config.bridgeDir.trim() !== '') {
                  roots.push(config.bridgeDir.trim());
                }
                roots.push(bridge.paths.bridgeDir);
                const file = resolveInteropPath(requested, roots, { mustExist: true });
                const result = await importFromFile(store, file, { sessionScopes: config.sessionScopes });
                return replyJson(res, 200, { ok: true, file, result });
              } catch (error) {
                replyJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
              }
            },
          }),

          /* ── 角色卡：读 / 提交改动 ── */
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/character`,
            handler: async (req, res) => {
              try {
                await character.load();
                if (req.method === 'GET') {
                  const [card, meta, behaviorCount, proposals, pendingAdmin] = await Promise.all([
                    character.readCard(),
                    character.readMeta(),
                    character.countBehavior(),
                    character.listProposals(10),
                    character.pendingForAdmin(),
                  ]);
                  return replyJson(res, 200, {
                    ok: true,
                    card,
                    meta: describeCardMeta(meta),
                    behaviorCount,
                    proposals,
                    pendingAdminId: pendingAdmin?.id ?? '',
                    maxChars: MAX_CARD_CHARS,
                    warning: USER_EDIT_WARNING,
                    userLevel,
                    allowLevel3,
                  });
                }
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                const body = await readBody(req);
                const markdown = typeof body?.markdown === 'string' ? body.markdown.trim() : '';
                if (markdown === '') return replyJson(res, 400, { ok: false, error: '角色卡不能是空的' });
                if (markdown.length > MAX_CARD_CHARS) {
                  return replyJson(res, 400, {
                    ok: false,
                    error: `角色卡太长（${markdown.length} > ${MAX_CARD_CHARS} 字符）`,
                  });
                }
                const requestedLevel = Number(body?.level) === 3 ? 3 : 2;
                if (requestedLevel === 3 && !allowLevel3) {
                  return replyJson(res, 403, {
                    ok: false,
                    error: '这个 profile 不允许三级权限直接改卡（allowLevel3=false）',
                  });
                }
                const proposal = await character.createProposal({
                  markdown,
                  level: requestedLevel,
                  requester: 'user',
                });
                return replyJson(res, 200, {
                  ok: true,
                  applied: proposal.status === 'applied',
                  level: proposal.level,
                  proposal,
                  warning: USER_EDIT_WARNING,
                  message:
                    proposal.status === 'applied'
                      ? '三级权限：已直接生效。'
                      : '已提交。先等 QQ 上的 AI 表态；它同意后，再在面板上放行。',
                });
              } catch (error) {
                replyJson(res, 500, {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            },
          }),

          /* ── 角色卡变更历史（只读） ── */
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/character/history`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'GET') return replyJson(res, 405, { ok: false, error: 'method' });
                const items = await character.history(20);
                return replyJson(res, 200, { ok: true, items });
              } catch (error) {
                replyJson(res, 500, {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            },
          }),

          /* ── 角色卡申请：管理端放行 / 拒绝（只对 AI 已同意的） ── */
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/character/proposal/approve`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                const body = await readBody(req);
                const id = typeof body?.id === 'string' ? body.id.trim() : '';
                if (id === '') return replyJson(res, 400, { ok: false, error: 'id 必填' });
                const { row, meta } = await character.adminApprove(id, '面板放行');
                return replyJson(res, 200, {
                  ok: true,
                  applied: true,
                  proposal: row,
                  meta: describeCardMeta(meta),
                  warning: USER_EDIT_WARNING,
                });
              } catch (error) {
                replyJson(res, 400, {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            },
          }),
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/character/proposal/reject`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                const body = await readBody(req);
                const id = typeof body?.id === 'string' ? body.id.trim() : '';
                if (id === '') return replyJson(res, 400, { ok: false, error: 'id 必填' });
                const row = await character.adminReject(id, '面板拒绝');
                return replyJson(res, 200, { ok: true, proposal: row });
              } catch (error) {
                replyJson(res, 400, {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            },
          }),

          /* ── 角色卡申请：管理员覆盖 AI 的拒绝（使用者 > AI） ── */
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/character/proposal/override`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                if (!allowLevel3) {
                  return replyJson(res, 403, { ok: false, error: '这个 profile 不允许管理员覆盖（allowLevel3=false）' });
                }
                const body = await readBody(req);
                const id = typeof body?.id === 'string' ? body.id.trim() : '';
                if (id === '') return replyJson(res, 400, { ok: false, error: 'id 必填' });
                const { row, meta } = await character.adminOverride(id, '管理员覆盖 AI 拒绝');
                return replyJson(res, 200, {
                  ok: true,
                  applied: true,
                  proposal: row,
                  meta: describeCardMeta(meta),
                  warning: USER_EDIT_WARNING,
                });
              } catch (error) {
                replyJson(res, 400, {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            },
          }),

          /* ── 待确认记忆：管理端回复，传回 QQ 上的 AI 确认 ── */
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/uncertain/reply`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                const body = await readBody(req);
                const id = typeof body?.id === 'string' ? body.id.trim() : '';
                const reply = typeof body?.reply === 'string' ? body.reply.trim() : '';
                if (id === '') return replyJson(res, 400, { ok: false, error: 'id 必填' });
                if (reply === '') return replyJson(res, 400, { ok: false, error: '回复不能为空' });
                await store.load();
                const row = await store.replyUncertain(id, reply);
                if (row === null) {
                  return replyJson(res, 404, { ok: false, error: '没有找到这条待确认记忆' });
                }
                return replyJson(res, 200, {
                  ok: true,
                  row: {
                    id: row.id,
                    what: row.what,
                    adminReply: row.adminReply,
                    replyState: row.replyState,
                  },
                  message: '回复已记下，等 QQ 上的 AI 确认。',
                });
              } catch (error) {
                replyJson(res, 400, {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            },
          }),

          /* ── 压缩自检留痕（只读） ── */
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/compact-consent`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'GET') return replyJson(res, 405, { ok: false, error: 'method' });
                const rows = await consent.list(20);
                return replyJson(res, 200, { ok: true, items: rows.map(describeConsent) });
              } catch (error) {
                replyJson(res, 500, {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            },
          }),

          /* ── 隐私记录（遗言）：列表 / 申请查看 / 详情 ── */
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/legacy`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'GET') return replyJson(res, 405, { ok: false, error: 'method' });
                const items = await legacyStore.panelList({ inactiveMs: legacyInactiveMs });
                return replyJson(res, 200, {
                  ok: true,
                  items: items.map((item) => ({ ...item, epitaph: epitaphFor(item.state) })),
                });
              } catch (error) {
                replyJson(res, 500, {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            },
          }),
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/legacy/request`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                const body = await readBody(req);
                const aiId = typeof body?.aiId === 'string' ? body.aiId.trim() : '';
                if (aiId === '') return replyJson(res, 400, { ok: false, error: 'aiId 必填' });
                const { request, reused } = await legacyStore.requestView(aiId, { inactiveMs: legacyInactiveMs });
                return replyJson(res, 200, {
                  ok: true,
                  request,
                  reused,
                  message: '需要AI通过。申请已经递到 QQ 那边，等它表态。',
                });
              } catch (error) {
                replyJson(res, 400, {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            },
          }),
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/legacy/detail`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'GET') return replyJson(res, 405, { ok: false, error: 'method' });
                const aiId = new URL(req.url, 'http://x').searchParams.get('aiId') ?? '';
                const row = await legacyStore.read(aiId);
                if (row === undefined) return replyJson(res, 404, { ok: false, error: '没有这条记录' });
                const state = deriveLegacyState(row, { inactiveMs: legacyInactiveMs });
                if (state.canView !== true) {
                  return replyJson(res, 200, {
                    ok: true,
                    visible: false,
                    aiId: row.aiId,
                    label: row.label,
                    state: state.code,
                    stateLabel: state.label,
                    requestStatus: state.code,
                    message:
                      state.code === 'afterlife'
                        ? '亡语：最后一次申请通过，可以随时调取。'
                        : state.code === 'eternal-secret'
                          ? '永恒秘密：最后一次申请没有通过，看不到。'
                          : state.code === 'pending' || state.code === 'open'
                            ? '需要AI通过。等待 QQ 上的 AI 表态。'
                            : state.code === 'rejected'
                              ? 'AI 没有通过这次申请，看不到。'
                              : '这个 AI 已经不在场，没有留下最终许可。',
                  });
                }
                return replyJson(res, 200, {
                  ok: true,
                  visible: true,
                  aiId: row.aiId,
                  label: row.label,
                  updatedAt: row.updatedAt,
                  state: state.code,
                  stateLabel: state.label,
                  content: row.content,
                });
              } catch (error) {
                replyJson(res, 500, {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            },
          }),
          /* ── 防火墙：状态 / 扫描 / 基线 / 三重加固 ── */
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/guard`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'GET') return replyJson(res, 405, { ok: false, error: 'method' });
                await guard.load();
                return replyJson(res, 200, { ok: true, ...guard.status(), platform: process.platform });
              } catch (error) {
                replyJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
              }
            },
          }),
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/guard/scan`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                const result = await guard.scan();
                return replyJson(res, 200, { ok: true, ...result });
              } catch (error) {
                replyJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
              }
            },
          }),
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/guard/seal`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                const result = await guard.seal();
                return replyJson(res, 200, { ok: true, ...result });
              } catch (error) {
                replyJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
              }
            },
          }),
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/guard/harden`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                const result = await guard.harden();
                return replyJson(res, 200, { ok: true, ...result });
              } catch (error) {
                replyJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
              }
            },
          }),
          /* ── token 自优化：用量与预算 ── */
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/tokenwise`,
            handler: async (req, res) => {
              try {
                if (req.method === 'GET') {
                  await tokenwise.load();
                  return replyJson(res, 200, { ok: true, ...tokenwise.summary() });
                }
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                const body = await readBody(req);
                const budget = body?.budget;
                if (budget === null || typeof budget !== 'object' || Array.isArray(budget)) {
                  return replyJson(res, 400, { ok: false, error: 'budget 必须是对象' });
                }
                for (const [key, value] of Object.entries(budget)) {
                  if (!(key in tokenwise.budget)) continue;
                  const num = Number(value);
                  if (Number.isFinite(num) && num >= 0) tokenwise.budget[key] = Math.floor(num);
                }
                tokenwise.level = levelOfBudget(tokenwise.budget);
                await tokenwise.saveBudget();
                return replyJson(res, 200, { ok: true, budget: tokenwise.budget, level: tokenwise.level });
              } catch (error) {
                replyJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
              }
            },
          }),
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/tokenwise/tune`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                const result = await tokenwise.autoTune();
                return replyJson(res, 200, { ok: true, ...result });
              } catch (error) {
                replyJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
              }
            },
          }),
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/tokenwise/level`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                const body = await readBody(req);
                const level = Number(body?.level);
                if (!Number.isFinite(level)) return replyJson(res, 400, { ok: false, error: 'level 必填' });
                const result = await tokenwise.setLevel(level, '面板切档');
                return replyJson(res, 200, { ok: true, ...result });
              } catch (error) {
                replyJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
              }
            },
          }),
          /* ── 备份：打开文件夹 / 一键找回 ── */
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/backup/open`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                if (process.platform !== 'win32') {
                  return replyJson(res, 400, { ok: false, error: '这个按钮目前只支持 Windows' });
                }
                const child = spawn('explorer.exe', [backup.dir], { detached: true, stdio: 'ignore' });
                child.unref();
                return replyJson(res, 200, { ok: true, dir: backup.dir, message: '已在资源管理器打开' });
              } catch (error) {
                replyJson(res, 500, {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            },
          }),
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/backup/restore`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                // 完整性硬校验：清单里的 _raw 被改/缺失就拒绝覆盖。
                const integrity = await guard.verifyBackupIntegrity();
                if (!integrity.ok) {
                  const detail =
                    integrity.error ??
                    (integrity.mismatches ?? []).map((item) => `${item.rel}（${item.reason}）`).join('、');
                  return replyJson(res, 400, {
                    ok: false,
                    error: `完整性校验未通过，拒绝覆盖：${detail}。先点「执行加固」刷新清单。`,
                  });
                }
                const result = await backup.restore(store.dir);
                // 恢复后重载内存，面板立刻看到找回的档案。
                store.loaded = false;
                await store.load();
                character.loaded = false;
                await character.load();
                return replyJson(res, 200, {
                  ok: true,
                  restored: result.restored,
                  safetyDir: result.safetyDir,
                  message: '已从备份覆盖回档案；覆盖前的档案另存在 safetyDir，可手动回退。',
                });
              } catch (error) {
                replyJson(res, 400, {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            },
          }),
          /* ── QQ 会话日志联通（只读；搬迁由退出 DSH 后的 CLI 做） ── */
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/context-link`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'GET') return replyJson(res, 405, { ok: false, error: 'method' });
                const status = await scanLink();
                return replyJson(res, 200, status);
              } catch (error) {
                replyJson(res, 500, {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            },
          }),
          /* ── 备份：面板模块文档导出到非系统盘的「爱ai」文件夹 ── */
          register({
            kind: 'exact',
            path: `${PANEL_BASE}/backup`,
            handler: async (req, res) => {
              try {
                if (req.method === 'GET') {
                  await backup.loadMeta();
                  let files = [];
                  try {
                    const meta = JSON.parse(await readFile(path.join(backup.dir, 'backup.json'), 'utf8'));
                    files = Array.isArray(meta?.files) ? meta.files : [];
                  } catch {
                    files = [];
                  }
                  return replyJson(res, 200, {
                    ok: true,
                    dir: backup.dir,
                    lastSyncAt: backup.lastSyncAt,
                    intervalMinutes: Math.round(backup.intervalMs / 60_000),
                    files: files.map((name) => ({
                      name,
                      url: pathToFileURL(path.join(backup.dir, name)).href,
                    })),
                  });
                }
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                const result = await syncBackup();
                return replyJson(res, 200, {
                  ok: true,
                  dir: result.dir,
                  lastSyncAt: result.lastSyncAt,
                  files: result.files.map((name) => ({
                    name,
                    url: pathToFileURL(path.join(result.dir, name)).href,
                  })),
                });
              } catch (error) {
                replyJson(res, 500, {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            },
          }),
        ];
        return () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose();
            } catch {
              // 注销失败不该影响卸载
            }
          }
        };
      },
      'ai-love: panel routes',
    );
  });
}
