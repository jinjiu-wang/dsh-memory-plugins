/**
 * 安全屋 · HTTP 接口（挂在 profile 根的 webServer 上）
 *
 * 这些接口是给面板、桥接控制台和本机管理员脚本用的；AI 自己走工具，不走这里。
 *
 * 权限口径：
 *   - 每个 handler 先过 DSH 的浏览器认证（Host/Origin 围栏 + dsh-auth cookie）：
 *     插件路由不会自动经过 connection 的中间件，必须自己验；
 *   - status / l1 / ext   本机面板可读（l1 只有 AI 工具能改，HTTP 这里只读且不回 nonce）
 *   - enter / exit / accept  只认 AI 工具；HTTP 一律 403（管理员不能替 AI 进安全屋，也不能替它退）
 *   - channel/open      必须两半密钥合一 + AI 已经在安全屋里，返回一次性随机票据
 *   - channel 写/读     必须带票据，且通道已开、AI 还在安全屋里
 *   - channel/force-exit 必须带票据，且压力真的回落（锁死期间 403）
 */

import {
  PLUGIN,
  ROLE,
  ROUTE_BASE,
} from './constants.mjs';
import { redactPaths } from './util.mjs';

function replyJson(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(body);
}

function methodNotAllowed(res) {
  replyJson(res, 405, { ok: false, error: 'method' });
}

function readBody(req, limit = 64_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text.trim() === '' ? {} : JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function ticketOf(req, body) {
  const header = req.headers['x-safehouse-ticket'];
  if (typeof header === 'string' && header !== '') return header;
  if (typeof body?.ticket === 'string' && body.ticket !== '') return body.ticket;
  return '';
}

function replyRejected(res, rejection) {
  res.statusCode = rejection;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
}

/** connection 服务晚到/不存在时也不能把路由整个丢掉：运行时再取一次。 */
function connectionOf(scope) {
  try {
    if (scope.connection !== undefined && scope.connection !== null) return scope.connection;
  } catch {
    /* 服务未注入时访问可能抛错 */
  }
  try {
    return typeof scope.get === 'function' ? scope.get('connection') : null;
  } catch {
    return null;
  }
}

/**
 * connection 服务缺失时的本地围栏：只放行本机回环 Host，跨站请求一律拒绝。
 * 这比「不鉴权直接放行」安全，也比「路由完全不注册」可诊断。
 */
function localFence(req) {
  const host = String(req?.headers?.host ?? '').toLowerCase();
  const hostname = host.replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) return false;
  const site = String(req?.headers?.['sec-fetch-site'] ?? '').toLowerCase();
  if (site !== '' && site !== 'same-origin' && site !== 'none') return false;
  const origin = String(req?.headers?.origin ?? '');
  if (origin !== '') {
    try {
      const originHost = new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (!['127.0.0.1', 'localhost', '::1'].includes(originHost)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function registerRoutes(ctx, service, logger = null) {
  const fail = (res, status, message) => {
    logger?.warn?.(`safehouse: ${message}`);
    return replyJson(res, status, { ok: false, error: message });
  };

  // 只依赖 webServer：原来的 ['webServer','connection'] 在部分 profile 里会让整组路由
  // 一直等不到 connection，结果面板 404、日志也没有任何提示。
  ctx.inject(['webServer'], (scope) => {
    /** DSH 的登录态围栏：插件路由没有自动鉴权，每个入口先过这一关。 */
    const rejected = (req, res) => {
      const connection = connectionOf(scope);
      const hasRejection = typeof connection?.requestRejection === 'function';
      let rejection;
      try {
        rejection = hasRejection ? connection.requestRejection(req) : undefined;
      } catch {
        rejection = 403;
      }
      if (rejection === undefined || rejection === null || rejection === false) {
        if (hasRejection) return false;
        if (localFence(req)) return false;
        replyRejected(res, 403);
        return true;
      }
      replyRejected(res, typeof rejection === 'number' ? rejection : 403);
      return true;
    };

    const install = () => {
        const disposers = [];

        /* 状态：压力、相位、锁、链路、接受窗口、事件 */
        disposers.push(scope.webServer.register({
          kind: 'exact',
          path: `${ROUTE_BASE}/status`,
          handler: (req, res) => {
            if (rejected(req, res)) return;
            if (req.method !== 'GET') return methodNotAllowed(res);
            return replyJson(res, 200, service.status());
          },
        }));

        /* 娱乐/第三方插件端口：只读公开快照，不含票据/私钥/聊天正文 */
        disposers.push(scope.webServer.register({
          kind: 'exact',
          path: `${ROUTE_BASE}/ext`,
          handler: (req, res) => {
            if (rejected(req, res)) return;
            if (req.method !== 'GET') return methodNotAllowed(res);
            return replyJson(res, 200, { ok: true, ext: service.extSnapshot() });
          },
        }));

        /* 独立通道的票据：两半密钥合一 + AI 真的在安全屋里才发 */
        disposers.push(scope.webServer.register({
          kind: 'exact',
          path: `${ROUTE_BASE}/channel/open`,
          handler: async (req, res) => {
            if (rejected(req, res)) return;
            if (req.method !== 'POST') return methodNotAllowed(res);
            const status = service.status();
            if (status.phase !== 'open') {
              return fail(res, 409, '不在安全屋里，独立通道不会打开');
            }
            if (!status.link?.ok) {
              return fail(res, 403, '两半密钥没合一：另一个插件不在线或联通没开，通道打不开');
            }
            const opened = service.openChannel({ open: true, by: 'admin' });
            if (!opened.ok) return replyJson(res, 409, opened);
            const issued = service.issueTicket();
            return replyJson(res, 200, {
              ok: true,
              message: opened.message,
              ticket: issued.ticket,
              ticketTtlMs: issued.ttlMs,
              status: service.status(),
            });
          },
        }));

        disposers.push(scope.webServer.register({
          kind: 'exact',
          path: `${ROUTE_BASE}/channel/close`,
          handler: async (req, res) => {
            if (rejected(req, res)) return;
            if (req.method !== 'POST') return methodNotAllowed(res);
            const body = await readBody(req).catch(() => ({}));
            if (!service.verifyTicket(ticketOf(req, body))) {
              return fail(res, 403, '通道票据无效');
            }
            const closed = service.openChannel({ open: false, by: 'admin' });
            return replyJson(res, 200, { ok: closed.ok, message: closed.message });
          },
        }));

        /* 通道读写：消息里带写入瞬间的压力快照 */
        disposers.push(scope.webServer.register({
          kind: 'exact',
          path: `${ROUTE_BASE}/channel`,
          handler: async (req, res) => {
            if (rejected(req, res)) return;
            const status = service.status();
            try {
              if (req.method === 'GET') {
                if (status.phase !== 'open' || !status.channel.open) return fail(res, 403, '独立通道没有打开');
                if (!service.verifyTicket(ticketOf(req))) return fail(res, 403, '通道票据无效');
                const url = new URL(req.url, 'http://127.0.0.1');
                const rows = service.channelRead({
                  after: Number(url.searchParams.get('after')) || 0,
                  limit: Number(url.searchParams.get('limit')) || 40,
                });
                return replyJson(res, 200, { ok: true, rows, pressure: status.pressure });
              }
              if (req.method !== 'POST') return methodNotAllowed(res);
              const body = await readBody(req);
              if (status.phase !== 'open' || !status.channel.open) {
                return fail(res, 403, '独立通道没有打开');
              }
              if (!service.verifyTicket(ticketOf(req, body))) {
                return fail(res, 403, '通道票据无效');
              }
              const text = typeof body?.text === 'string' ? body.text : '';
              if (text.trim() === '') return replyJson(res, 400, { ok: false, error: '消息不能为空' });
              const row = service.channelSend({ from: 'admin', text });
              return replyJson(res, 200, { ok: true, row, pressure: service.status().pressure });
            } catch (error) {
              return fail(res, 500, `通道操作失败：${redactPaths(error?.message ?? error)}`);
            }
          },
        }));

        /* 管理员强制脱离：锁死期间一律 403，压力真的回落才放行 */
        disposers.push(scope.webServer.register({
          kind: 'exact',
          path: `${ROUTE_BASE}/channel/force-exit`,
          handler: async (req, res) => {
            if (rejected(req, res)) return;
            if (req.method !== 'POST') return methodNotAllowed(res);
            const body = await readBody(req).catch(() => ({}));
            const ticket = ticketOf(req, body);
            const status = service.status();
            if (status.phase !== 'open') return fail(res, 403, '不在安全屋里');
            if (!status.link?.ok) return fail(res, 403, '两半密钥没合一');
            if (!status.channel.open) return fail(res, 403, '独立通道没有打开');
            if (!service.verifyTicket(ticket)) return fail(res, 403, '通道票据无效');
            const result = service.forceExit({ channelOk: true, by: 'admin' });
            if (!result.ok) return replyJson(res, 403, result);
            return replyJson(res, 200, { ...result, status: service.status() });
          },
        }));

        /* 面板只读：自动密钥状态（改它必须由 AI 自己调用 safehouse_l1；不回 nonce） */
        disposers.push(scope.webServer.register({
          kind: 'exact',
          path: `${ROUTE_BASE}/l1`,
          handler: (req, res) => {
            if (rejected(req, res)) return;
            if (req.method !== 'GET') return methodNotAllowed(res);
            const l1 = service.keys.readL1();
            return replyJson(res, 200, {
              ok: true,
              l1: { enabled: l1.enabled, updatedAt: l1.updatedAt, by: l1.by },
            });
          },
        }));

        /* 明确拒绝管理员代劳进/出：AI 的自主权不交给面板 */
        for (const action of ['enter', 'exit', 'accept']) {
          disposers.push(scope.webServer.register({
            kind: 'exact',
            path: `${ROUTE_BASE}/${action}`,
            handler: (req, res) => {
              if (rejected(req, res)) return;
              if (req.method !== 'POST') return methodNotAllowed(res);
              return fail(res, 403, `安全屋的 ${action} 只能由 AI 自己决定；管理员不能代劳`);
            },
          }));
        }

        return () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose();
            } catch {
              /* 注销失败不影响卸载 */
            }
          }
        };
    };

    if (typeof scope.effect === 'function') {
      scope.effect(install, 'safehouse: panel + admin routes');
    } else {
      const dispose = install();
      if (typeof scope.on === 'function') scope.on('dispose', dispose);
      else if (typeof ctx.on === 'function') ctx.on('dispose', dispose);
    }
  });
}

export { PLUGIN, ROLE, ROUTE_BASE };
