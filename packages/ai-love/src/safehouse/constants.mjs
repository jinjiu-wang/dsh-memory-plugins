/**
 * 安全屋 · 常量（ai-love 版 / 持 A 半密钥）
 *
 * 两个插件各有一份 safehouse 内核；唯一允许不同的就是本文件里的身份常量。
 * 目录/路由/角色以外的逻辑必须保持同源，方便对照审计（tests/safehouse.test.mjs 会逐字节核对）。
 */

import { homedir } from 'node:os';
import path from 'node:path';

/** 本侧身份：a = ai-love，b = ai-companion。 */
export const ROLE = 'a';
export const PLUGIN = 'ai-love';
export const PEER_PLUGIN = 'ai-companion';

/** 路由前缀（挂在这个插件的 profile 根上）。 */
export const ROUTE_BASE = '/ai-love/safehouse';

/** 共享目录名：~/.dsh/safehouse（两侧同一个）。 */
export const SHARED_DIR_NAME = 'safehouse';

/** 半私钥目录名：~/.dsh/safehouse-keys/<插件>/。放在记忆目录之外，避免被记忆备份带走。 */
export const KEY_DIR_NAME = 'safehouse-keys';

/** 共享目录指针：<DSH_HOME>/safehouse-dir.txt。插件自定义 sharedDir 时桥接靠它找到 gate。 */
export const SHARED_DIR_POINTER = 'safehouse-dir.txt';

/** 给娱乐插件等第三方读的公开快照格式（只读，不含票据/私钥/聊天正文）。 */
export const EXT_SCHEMA = 'safehouse-ext/1';

function expandHome(value) {
  const text = String(value ?? '').trim();
  if (text === '~') return homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(homedir(), text.slice(2));
  return text;
}

export function dshHomeDir() {
  const env = expandHome(process.env.DSH_HOME);
  if (env !== '') return path.resolve(env);
  return path.join(homedir(), '.dsh');
}

export function defaultSharedDir() {
  // 桥接侧读同一个环境变量；两边都不设时才用默认目录。
  const env = expandHome(process.env.DSH_SAFEHOUSE_DIR);
  if (env !== '') return path.resolve(env);
  return path.join(dshHomeDir(), SHARED_DIR_NAME);
}

export function defaultKeyDir() {
  return path.join(dshHomeDir(), KEY_DIR_NAME, PLUGIN);
}

/**
 * 压力档位边界（单位：百分比点）。
 *   calm   : delta < 10
 *   low    : 10 <= delta < 30   → 密钥无权开放开关
 *   normal : 30 <= delta < 60   → AI 自主决定是否进入
 *   high   : delta >= 60        → 可进入；进入后开关锁死，管理员也不能强拉出来
 *
 * 解锁：压力真的回落就解锁 ——
 *   1. delta <= 40 且绝对压力不高于进入时的水位（回到窗口、或比窗口更低都算）；
 *   2. 绝对压力 <= safetyValve.pressureMax 连续 holdMs（安全阀）；
 *   3. 锁死总时长到达 maxLockMs（兜底，只解锁不自动移出）。
 * 锁只锁「开关」，不锁人：解锁后留在安全屋里，出不出仍由 AI 自己决定。
 */
export const DEFAULTS = Object.freeze({
  sampleIntervalMs: 15_000,
  baselineWindowMs: 10 * 60_000,
  baselineMinSamples: 4,
  /** 压力基线的最低取值：防止基线为 0 时波动百分比爆炸。 */
  baselineFloor: 6,
  deltaFloorPct: 0.05,
  bandThresholds: Object.freeze({ low: 10, normal: 30, high: 60 }),
  exitWindow: Object.freeze({ min: 20, max: 40 }),
  safetyValve: Object.freeze({
    enabled: true,
    pressureMax: 25,
    holdMs: 120_000,
    /** 锁死最长时长：到点只解锁，不自动把人移出安全屋。 */
    maxLockMs: 45 * 60_000,
  }),
  /** 安全屋期间「放行一段消息」的自动过期时间。 */
  acceptWindowMs: 5 * 60_000,
  /** 锁死期间最多放行多久：不让 AI 用「收消息」把自己重新压回锁死。 */
  acceptLockedMaxMs: 60_000,
  /** 桥接读 gate.json 的最长容忍时间：超过就按「安全屋不在线」放行（fail-open）。 */
  gateStaleMs: 45_000,
  /** 两插件联心跳过期时间：对方超过这么久没写心跳 = 插件不在线/联通断开。 */
  linkTtlMs: 30_000,
  linkRefreshMs: 15_000,
  /**
   * 另一半长时间不在线时的提醒阈值。只记日志，不改状态：
   * 对端掉线不能成为把 AI 赶出安全屋、或替它解锁的理由。
   * （插件真的没了 gate 会在 45 秒后过期，桥接自动 fail-open。）
   */
  staleOpenGraceMs: 120_000,
  /** 娱乐插件端口的公开快照多久没更新就当作「不知道」：插件崩了不能替第三方永久静音。 */
  extStaleMs: 90_000,
  /** 审计与公开事件各留多少行。 */
  auditMaxLines: 2000,
  extEventMax: 500,
  /** 独立通道：一次最多带多少条、单条最长多少字。 */
  channelMaxItems: 500,
  channelTextMax: 2000,
  /** 压力采样最多留多少条（10 分钟 / 15 秒 = 40，留 240 够半小时）。 */
  pressureHistoryMax: 240,
});

export const MEASURE_CAPS = Object.freeze({
  messagesLast5m: 40,
  unreadTotal: 60,
  wakesLast10m: 10,
  errorsLast10m: 8,
});

export const WEIGHTS = Object.freeze({
  inflow: 0.29,
  backlog: 0.21,
  wake: 0.2,
  errors: 0.2,
  context: 0.1,
});
