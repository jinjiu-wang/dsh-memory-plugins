/**
 * 安全屋 · 入口
 *
 * ai-love 侧（A 半）的职责：
 *   - 持 A 半密钥（私钥只落在插件自己的密钥目录）
 *   - 常驻压力采样 + 状态机 + 写 gate.json（桥接读它挡消息）
 *   - 提供面板/管理员 HTTP 接口和独立通道
 *   - 给每个 Agent 注入状态提示段和 safehouse_* 工具
 *
 * ai-companion 侧（B 半）只做两件事：持 B 半密钥、写心跳。
 * 两侧不重复注册同名工具/同名提示段，也不重复写 state/gate。
 *
 * 这一层不做的事：
 *   - 不关桥接连接：gate.json 只是「现在别投递」，桥接的消息缓存和 OneBot 连接都还在；
 *   - 不碰聊天正文：只读 social-v2.json 的条数/积压/唤醒时间，不读消息内容；
 *   - 不替 AI 做决定：进、出、收消息都要 AI 自己调工具。
 */

import { ROLE } from './constants.mjs';
import { SafehouseService } from './service.mjs';
import { registerRoutes } from './server.mjs';
import { installAgentHooks } from './agent-hooks.mjs';
import { redactPaths } from './util.mjs';

export function applySafehouse(ctx, config = {}) {
  let service = null;
  try {
    service = new SafehouseService({ config, logger: ctx.logger });
  } catch (error) {
    // 共享目录/密钥目录不可用（只读盘、网盘未挂载、路径被占）不能连累插件其它功能。
    ctx.logger?.warn?.(`safehouse: 初始化失败（安全屋不可用，聊天不受影响）：${redactPaths(error?.message ?? error)}`);
    return null;
  }
  try {
    service.start();
  } catch (error) {
    ctx.logger?.warn?.(`safehouse: 启动失败（安全屋不可用，聊天不受影响）：${redactPaths(error?.message ?? error)}`);
  }

  // 只有 A 半负责对外表面：工具、提示段、HTTP 路由。B 半重复注册会撞名。
  if (ROLE === 'a') {
    try {
      registerRoutes(ctx, service, ctx.logger);
    } catch (error) {
      ctx.logger?.warn?.(`safehouse: 挂 HTTP 路由失败：${redactPaths(error?.message ?? error)}`);
    }
    try {
      installAgentHooks({ ctx, service, logger: ctx.logger });
    } catch (error) {
      ctx.logger?.warn?.(`safehouse: 挂 Agent 钩子失败：${redactPaths(error?.message ?? error)}`);
    }
  }

  const teardown = () => {
    try {
      service.stop();
    } catch {
      /* 卸载阶段不抛 */
    }
  };
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => teardown, 'safehouse: sampler + heartbeat');
  } else if (typeof ctx.on === 'function') {
    // 没有 effect 的宿主也要能停采样：否则卸载后定时器还在跑、gate 永远新鲜。
    ctx.on('dispose', teardown);
  }
  return service;
}

export { SafehouseService };
export { renderPrompt } from './agent-hooks.mjs';
export { describePressure } from './pressure.mjs';
export { readSafehouseExt, readSafehouseExtEvents, describeExt } from './extension.mjs';
