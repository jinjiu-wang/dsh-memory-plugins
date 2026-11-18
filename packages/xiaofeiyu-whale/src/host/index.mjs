/**
 * 小肥鱼鲸鱼娘 · Host 半边
 *
 * 1. DSH 启动后自动拉起 Python 记忆服务（本机 stdio，不监听端口）；
 * 2. 在 profile 根挂 /xiaofeiyu/* 接口给左侧栏面板；
 * 3. 与「爱ai」通过 <bridgeDir>/link.json + 两份 JSONL 自动双向联通；
 *    两边面板各有一个总开关，任何一边关掉，自动联通都会停。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  DISPLAY_NAME,
  PLUGIN_NAME,
  detectPython,
  normalizeConfig,
  resolveBridgeFiles,
} from '../core/config.mjs';
import {
  linkEnabled,
  linkReason,
  readLinkState,
  readLocalSettings,
  writeLinkFlag,
  writeLocalSettings,
} from '../core/state.mjs';
import { PythonService } from './python-service.mjs';

const PANEL_BASE = '/xiaofeiyu';
const SYNC_TIMEOUT_MS = 30_000;

function readVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '';
  } catch {
    return '';
  }
}

const VERSION = readVersion();

function replyJson(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}

function readBody(req, limit = 100_000) {
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

function clip(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function toMs(ts) {
  const number = Number(ts ?? 0);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.round(number < 1e11 ? number * 1000 : number);
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  const files = resolveBridgeFiles(config.bridgeDir);
  const service = new PythonService({
    python: detectPython(config.python),
    dbPath: config.dbPath,
    bridgeDir: config.bridgeDir,
    logger: ctx.logger,
  });

  const settingsFile = path.join(config.dataDir, 'settings.json');
  if (!existsSync(settingsFile) && config.autoInterop === false) {
    writeLocalSettings(config.dataDir, { autoInterop: false });
    try {
      writeLinkFlag(config.bridgeDir, 'xiaofeiyu', false);
    } catch {
      // 联通目录还没建好，面板里还能再关
    }
  }
  let settings = readLocalSettings(config.dataDir);
  let syncing = null;
  let lastSync = { at: 0, result: null, error: '', reason: '' };
  let lastLoggedError = '';

  function currentLink() {
    return readLinkState(config.bridgeDir);
  }

  function autoStatus() {
    const link = currentLink();
    const enabled = linkEnabled(settings.autoInterop, link);
    return {
      auto: settings.autoInterop,
      peerAuto: link.aiLove,
      ownLink: link.xiaofeiyu,
      enabled,
      reason: linkReason(settings.autoInterop, link),
      bridgeDir: config.bridgeDir,
      aiLoveFile: files.aiLoveFile,
      peerFile: files.peerFile,
      linkFile: files.linkFile,
      intervalSeconds: config.intervalSeconds,
      syncing: syncing !== null,
      lastSync,
    };
  }

  function logOnce(message) {
    if (message === lastLoggedError) return;
    lastLoggedError = message;
    ctx.logger?.warn?.(`xiaofeiyu: ${message}`);
  }

  async function syncNow({ force = false } = {}) {
    if (syncing !== null) return syncing;
    if (!force && !autoStatus().enabled) {
      const reason = autoStatus().reason || '自动联通已关闭';
      lastSync = { ...lastSync, reason };
      return { ok: false, skipped: true, error: reason };
    }
    syncing = (async () => {
      try {
        const result = await service.call(
          'auto_sync',
          { importFile: 'ai-love.jsonl', exportFile: `${PLUGIN_NAME}.jsonl` },
          SYNC_TIMEOUT_MS,
        );
        lastSync = { at: Date.now(), result, error: '', reason: '' };
        lastLoggedError = '';
        return { ok: true, ...result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastSync = { at: Date.now(), result: null, error: message, reason: '' };
        logOnce(`自动同步失败：${message}`);
        throw error;
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  }

  async function panelState() {
    const interop = autoStatus();
    let data = null;
    let error = '';
    try {
      data = await service.call('state', { limit: 12 }, 15_000);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      if (error !== '' && error !== lastLoggedError) logOnce(error);
    }
    const stats = data?.stats ?? {};
    return {
      ok: true,
      plugin: PLUGIN_NAME,
      name: DISPLAY_NAME,
      version: VERSION,
      service: { ...service.status(), error: error || service.status().error },
      paths: {
        dataDir: config.dataDir,
        dbPath: config.dbPath,
        bridgeDir: config.bridgeDir,
      },
      stats,
      facts: (data?.facts ?? []).map((row) => ({
        ts: toMs(row.ts),
        subject: clip(row.subject, 120),
        text: clip(row.fact, 800),
        category: clip(row.category, 60),
        status: row.status,
        importance: row.importance,
        source: row.source,
        chatType: row.chat_type,
        groupId: clip(row.group_id, 80),
        peer: clip(row.peer, 80),
      })),
      summaries: (data?.summaries ?? []).map((row) => ({
        ts: toMs(row.ts),
        text: clip(row.content, 800),
        kind: row.kind,
        source: row.source,
        chatType: row.chat_type,
        groupId: clip(row.group_id, 80),
        peer: clip(row.peer, 80),
      })),
      pending: (data?.pending ?? []).map((row) => ({
        id: typeof row.id === 'number' ? row.id : null,
        ts: toMs(row.ts),
        text: clip(row.fact, 800),
        status: row.status,
        ask: clip(row.ask, 200),
        why: clip(row.why, 200),
        category: row.category,
        source: row.source,
        chatType: row.chat_type,
        groupId: clip(row.group_id, 80),
        peer: clip(row.peer, 80),
      })),
      interop,
    };
  }

  ctx.effect(
    () => {
      const kick = setTimeout(() => {
        service.start();
        if (autoStatus().enabled) {
          void syncNow().catch(() => {
            // 失败状态在面板显示，不阻塞 DSH 启动
          });
        }
      }, 800);
      const timer = setInterval(() => {
        if (autoStatus().enabled) {
          void syncNow().catch(() => {
            // 同上
          });
        }
      }, config.intervalSeconds * 1000);
      return () => {
        clearTimeout(kick);
        clearInterval(timer);
        void service.stop();
      };
    },
    'xiaofeiyu: auto service + interop',
  );

  ctx.inject(['webServer'], (scope) => {
    scope.effect(
      () => {
        const disposers = [
          scope.webServer.register({
            kind: 'exact',
            path: `${PANEL_BASE}/state`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'GET') return replyJson(res, 405, { ok: false, error: 'method' });
                return replyJson(res, 200, await panelState());
              } catch (error) {
                replyJson(res, 500, {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            },
          }),
          scope.webServer.register({
            kind: 'exact',
            path: `${PANEL_BASE}/interop/auto`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                if (!isTrustedWrite(req)) return replyJson(res, 403, { ok: false, error: 'forbidden' });
                const body = await readBody(req);
                if (typeof body?.enabled !== 'boolean') {
                  return replyJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' });
                }
                settings = writeLocalSettings(config.dataDir, { autoInterop: body.enabled });
                const link = writeLinkFlag(config.bridgeDir, 'xiaofeiyu', body.enabled);
                let result = null;
                let error = '';
                if (body.enabled && link.aiLove === true) {
                  try {
                    result = await syncNow({ force: true });
                  } catch (caught) {
                    error = caught instanceof Error ? caught.message : String(caught);
                  }
                }
                return replyJson(res, 200, {
                  ok: true,
                  auto: settings.autoInterop,
                  link,
                  enabled: linkEnabled(settings.autoInterop, link),
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
          scope.webServer.register({
            kind: 'exact',
            path: `${PANEL_BASE}/interop/sync`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                if (!isTrustedWrite(req)) return replyJson(res, 403, { ok: false, error: 'forbidden' });
                await readBody(req);
                const result = await syncNow({ force: true });
                return replyJson(res, 200, { ok: true, result });
              } catch (error) {
                return replyJson(res, 200, {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            },
          }),
          scope.webServer.register({
            kind: 'exact',
            path: `${PANEL_BASE}/search`,
            handler: async (req, res) => {
              try {
                if (req.method !== 'POST') return replyJson(res, 405, { ok: false, error: 'method' });
                if (!isTrustedWrite(req)) return replyJson(res, 403, { ok: false, error: 'forbidden' });
                const body = await readBody(req);
                const query = typeof body?.query === 'string' ? body.query.trim() : '';
                const limit = Math.min(50, Math.max(1, Number(body?.limit) || 20));
                if (query === '') return replyJson(res, 200, { ok: true, query: '', hits: [] });
                const data = await service.call('search', { query, limit }, 15_000);
                return replyJson(res, 200, {
                  ok: true,
                  query,
                  hits: (data?.hits ?? []).map((row) => ({
                    ts: toMs(row.ts),
                    content: clip(row.content, 800),
                    role: row.role,
                    speaker: row.speaker,
                    chatType: row.chat_type,
                    groupId: clip(row.group_id, 80),
                  })),
                });
              } catch (error) {
                return replyJson(res, 200, {
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
      'xiaofeiyu: panel routes',
    );
  });
}
