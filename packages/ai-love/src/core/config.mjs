/**
 * ai-love · 配置
 *
 * 只做「校验 + 补默认值」，不依赖 schemastery：
 * 拿不到 schema 时 loader 跳过表单校验，但所有键照样能写在 patch 的 config 里。
 * 配置错误必须在加载时大声失败 —— 压缩后端坏掉比没有更糟。
 */
import path from 'node:path';

import { dshHome } from './memory.mjs';

export const DEFAULT_MEMORY_DIR_NAME = 'ai-love';
export const DEFAULT_THRESHOLD_RATIO = 0.8;
export const DEFAULT_RETAIN_RATIO = 0.16;
export const DEFAULT_HEADROOM_TOKENS = 65536;
export const STYLE_VALUES = new Set(['qq', 'code', 'auto']);

const POLICY_KEYS = [
  'thresholdRatio',
  'headroomTokens',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
];

const TOP_KEYS = new Set([
  ...POLICY_KEYS,
  'modelPolicies',
  'auto',
  'style',
  'memoryDir',
  'uncertainNotify',
  'uncertainPerTurn',
  'uncertainMaxMentions',
  'recallLimit',
  'debug',
  'characterNotify',
  'characterSamples',
  'characterMaxTokens',
  'bridgeDir',
  // 与「小肥鱼鲸鱼娘」交换 JSONL 的共享目录；留空 = <DSH_HOME>/memory-bridge。
  'memoryBridgeDir',
  'compactConsent',
  'consentTimeoutMinutes',
  'consentCooldownMinutes',
  'userLevel',
  'allowLevel3',
  'legacyInactiveHours',
  'backupDir',
  'backupIntervalMinutes',
  // 逐字节记忆备份：DSH 运行期间把 QQ 会话日志 + 爱ai 档案实时镜像到非系统盘。
  'memoryBackup',
  'memoryBackupDir',
  // QQ 会话日志的 junction 目标；留空 = <备份目录>/sessions。
  'contextLinkDir',
  // 跨插件互通：DSH 会话 → QQ 作用域（private/group）。
  'sessionScopes',
  'protocol',
  // 自我识别：谁是「我的管理员」、我的名字（用于区分发言）
  'ownerQQ',
  'ownerNames',
  'botNames',
]);

const MODEL_POLICY_KEYS = new Set(['provider', 'model', ...POLICY_KEYS]);

function fail(message) {
  throw new Error(`ai-love: ${message}`);
}

function assertKeys(config, allowed, name) {
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) fail(`${name}: unknown key "${key}"`);
  }
}

function assertRecord(value, name) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
}

function assertNonEmptyString(name, value) {
  if (typeof value !== 'string' || value.length === 0) fail(`${name} must be a non-empty string`);
}

function assertPositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) fail(`${name} (${String(value)}) must be a positive integer`);
}

function assertNonNegativeInteger(name, value) {
  if (!Number.isInteger(value) || value < 0) fail(`${name} (${String(value)}) must be a non-negative integer`);
}

function assertRatio(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    fail(`${name} (${String(value)}) must be a number in (0, 1]`);
  }
}

function validatePolicy(config, name) {
  const {
    thresholdRatio,
    headroomTokens,
    retainRatio,
    retainTokens,
    maxTokens,
    compactionRetries,
    maxOverflowRetries,
  } = config;
  if (thresholdRatio !== undefined) assertRatio(`${name}.thresholdRatio`, thresholdRatio);
  if (headroomTokens !== undefined) assertNonNegativeInteger(`${name}.headroomTokens`, headroomTokens);
  if (retainRatio !== undefined) assertRatio(`${name}.retainRatio`, retainRatio);
  if (retainTokens !== undefined) assertNonNegativeInteger(`${name}.retainTokens`, retainTokens);
  if (retainRatio !== undefined && retainTokens !== undefined) {
    fail(`${name}: retainRatio and retainTokens are mutually exclusive`);
  }
  if (maxTokens !== undefined) assertPositiveInteger(`${name}.maxTokens`, maxTokens);
  if (compactionRetries !== undefined) assertNonNegativeInteger(`${name}.compactionRetries`, compactionRetries);
  if (maxOverflowRetries !== undefined) assertNonNegativeInteger(`${name}.maxOverflowRetries`, maxOverflowRetries);
  validateSummarizationPair(config, name);
}

function validateSummarizationPair(config, name) {
  const provider = config.summarizationProvider;
  const model = config.summarizationModel;
  if (provider !== undefined && typeof provider !== 'string') fail(`${name}.summarizationProvider must be a string`);
  if (model !== undefined && typeof model !== 'string') fail(`${name}.summarizationModel must be a string`);
  if (provider === undefined && model === undefined) return;
  if (provider === undefined || model === undefined || provider.length === 0 !== (model.length === 0)) {
    fail(`${name}: summarizationProvider and summarizationModel must be set together as an empty or non-empty pair`);
  }
}

function resolveRetention(config, fallback) {
  if (config.retainTokens !== undefined) return { retainTokens: config.retainTokens };
  if (config.retainRatio !== undefined) return { retainRatio: config.retainRatio };
  return fallback;
}

function validateRatioRetention(thresholdRatio, retention, name) {
  if (retention.retainRatio !== undefined && retention.retainRatio >= thresholdRatio) {
    fail(`${name}: retainRatio (${retention.retainRatio}) must be less than the resolved thresholdRatio (${thresholdRatio})`);
  }
}

function resolveModelPolicies(configured) {
  if (configured === undefined) return [];
  if (!Array.isArray(configured)) fail('modelPolicies must be an array');
  const seen = new Set();
  return configured.map((source, index) => {
    const name = `modelPolicies[${index}]`;
    assertRecord(source, name);
    assertKeys(source, MODEL_POLICY_KEYS, name);
    assertNonEmptyString(`${name}.provider`, source.provider);
    assertNonEmptyString(`${name}.model`, source.model);
    validatePolicy(source, name);
    const key = `${source.provider}\u0000${source.model}`;
    if (seen.has(key)) fail(`duplicate model policy for ${source.provider}/${source.model}`);
    seen.add(key);
    return { ...source };
  });
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}

/**
 * 解析并校验配置。
 * @param {Record<string, unknown>} config
 */
export function resolveConfig(config = {}) {
  assertRecord(config, 'config');
  assertKeys(config, TOP_KEYS, 'config');
  validatePolicy(config, 'config');
  if (config.auto !== undefined && typeof config.auto !== 'boolean') fail('auto must be a boolean');
  if (config.style !== undefined && !STYLE_VALUES.has(config.style)) {
    fail(`style (${String(config.style)}) must be one of qq / code / auto`);
  }
  if (config.memoryDir !== undefined && typeof config.memoryDir !== 'string') fail('memoryDir must be a string');
  if (config.uncertainNotify !== undefined && typeof config.uncertainNotify !== 'boolean') {
    fail('uncertainNotify must be a boolean');
  }
  if (config.uncertainPerTurn !== undefined) assertNonNegativeInteger('uncertainPerTurn', config.uncertainPerTurn);
  if (config.uncertainMaxMentions !== undefined) {
    assertNonNegativeInteger('uncertainMaxMentions', config.uncertainMaxMentions);
  }
  if (config.recallLimit !== undefined) assertPositiveInteger('recallLimit', config.recallLimit);
  if (config.debug !== undefined && typeof config.debug !== 'boolean') fail('debug must be a boolean');
  if (config.characterNotify !== undefined && typeof config.characterNotify !== 'boolean') {
    fail('characterNotify must be a boolean');
  }
  if (config.characterSamples !== undefined) assertPositiveInteger('characterSamples', config.characterSamples);
  if (config.characterMaxTokens !== undefined) assertPositiveInteger('characterMaxTokens', config.characterMaxTokens);
  if (config.bridgeDir !== undefined && typeof config.bridgeDir !== 'string') fail('bridgeDir must be a string');
  if (config.memoryBridgeDir !== undefined && typeof config.memoryBridgeDir !== 'string') {
    fail('memoryBridgeDir must be a string');
  }
  if (config.compactConsent !== undefined && !['ai', 'off'].includes(config.compactConsent)) {
    fail('compactConsent must be "ai" or "off"');
  }
  if (config.consentTimeoutMinutes !== undefined) {
    assertNonNegativeInteger('consentTimeoutMinutes', config.consentTimeoutMinutes);
  }
  if (config.consentCooldownMinutes !== undefined) {
    assertNonNegativeInteger('consentCooldownMinutes', config.consentCooldownMinutes);
  }
  if (config.userLevel !== undefined && ![2, 3].includes(config.userLevel)) {
    fail('userLevel must be 2 or 3');
  }
  if (config.allowLevel3 !== undefined && typeof config.allowLevel3 !== 'boolean') {
    fail('allowLevel3 must be a boolean');
  }
  if (
    config.legacyInactiveHours !== undefined &&
    (!Number.isFinite(config.legacyInactiveHours) || config.legacyInactiveHours < 0)
  ) {
    fail('legacyInactiveHours must be a non-negative number');
  }
  if (config.backupDir !== undefined && typeof config.backupDir !== 'string') {
    fail('backupDir must be a string');
  }
  if (config.backupIntervalMinutes !== undefined) {
    assertNonNegativeInteger('backupIntervalMinutes', config.backupIntervalMinutes);
  }
  if (config.memoryBackup !== undefined && typeof config.memoryBackup !== 'boolean') {
    fail('memoryBackup must be a boolean');
  }
  if (config.memoryBackupDir !== undefined && typeof config.memoryBackupDir !== 'string') {
    fail('memoryBackupDir must be a string');
  }
  if (config.contextLinkDir !== undefined && typeof config.contextLinkDir !== 'string') {
    fail('contextLinkDir must be a string');
  }
  if (config.sessionScopes !== undefined) {
    assertRecord(config.sessionScopes, 'sessionScopes');
    for (const [sessionId, scope] of Object.entries(config.sessionScopes)) {
      assertRecord(scope, `sessionScopes["${sessionId}"]`);
      const chatType = scope.chat_type ?? 'private';
      if (!['private', 'group'].includes(chatType)) {
        fail(`sessionScopes["${sessionId}"].chat_type must be "private" or "group"`);
      }
      for (const key of ['group_id', 'peer']) {
        if (scope[key] !== undefined && typeof scope[key] !== 'string') {
          fail(`sessionScopes["${sessionId}"].${key} must be a string`);
        }
      }
      if (chatType === 'group' && String(scope.group_id ?? '').trim() === '') {
        fail(`sessionScopes["${sessionId}"].group_id is required for group`);
      }
      if (chatType === 'private' && String(scope.peer ?? '').trim() === '') {
        fail(`sessionScopes["${sessionId}"].peer is required for private`);
      }
    }
  }
  if (config.protocol !== undefined && !['admin-first', 'classic'].includes(config.protocol)) {
    fail('protocol must be "admin-first" or "classic"');
  }
  if (config.ownerQQ !== undefined && typeof config.ownerQQ !== 'string') {
    fail('ownerQQ must be a string');
  }
  for (const key of ['ownerNames', 'botNames']) {
    if (config[key] === undefined) continue;
    if (!Array.isArray(config[key]) || config[key].some((item) => typeof item !== 'string')) {
      fail(`${key} must be an array of strings`);
    }
  }

  const headroomTokens = config.headroomTokens ?? DEFAULT_HEADROOM_TOKENS;
  const maxTokens = config.maxTokens ?? headroomTokens;
  assertPositiveInteger('maxTokens (explicit or from headroomTokens)', maxTokens);
  const thresholdRatio = config.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO;
  const retention = resolveRetention(config, { retainRatio: DEFAULT_RETAIN_RATIO });
  validateRatioRetention(thresholdRatio, retention, 'config');

  const modelPolicies = resolveModelPolicies(config.modelPolicies);
  for (const [index, policy] of modelPolicies.entries()) {
    if (policy.maxTokens === undefined && config.maxTokens === undefined && policy.headroomTokens !== undefined) {
      policy.maxTokens = policy.headroomTokens;
    }
    assertPositiveInteger(
      `modelPolicies[${index}].maxTokens (explicit or from headroomTokens)`,
      policy.maxTokens ?? maxTokens,
    );
    validateRatioRetention(
      policy.thresholdRatio ?? thresholdRatio,
      resolveRetention(policy, retention),
      `modelPolicies[${index}]`,
    );
  }

  return freeze({
    thresholdRatio,
    headroomTokens,
    ...retention,
    summarizationProvider: config.summarizationProvider ?? '',
    summarizationModel: config.summarizationModel ?? '',
    maxTokens,
    compactionRetries: config.compactionRetries ?? 1,
    maxOverflowRetries: config.maxOverflowRetries ?? 1,
    modelPolicies,
    auto: config.auto ?? true,
    style: config.style ?? 'qq',
    memoryDir: config.memoryDir ?? '',
    uncertainNotify: config.uncertainNotify ?? true,
    uncertainPerTurn: config.uncertainPerTurn ?? 1,
    uncertainMaxMentions: config.uncertainMaxMentions ?? 2,
    recallLimit: config.recallLimit ?? 3,
    debug: config.debug ?? false,
    characterNotify: config.characterNotify ?? true,
    characterSamples: config.characterSamples ?? 60,
    characterMaxTokens: config.characterMaxTokens ?? 1200,
    bridgeDir: config.bridgeDir ?? '',
    // 与「小肥鱼鲸鱼娘」的共享互通目录；两边默认都指向 <DSH_HOME>/memory-bridge。
    memoryBridgeDir:
      typeof config.memoryBridgeDir === 'string' && config.memoryBridgeDir.trim() !== ''
        ? path.resolve(config.memoryBridgeDir.trim())
        : path.join(dshHome(), 'memory-bridge'),
    compactConsent: config.compactConsent ?? 'ai',
    consentTimeoutMinutes: config.consentTimeoutMinutes ?? 5,
    consentCooldownMinutes: config.consentCooldownMinutes ?? 10,
    userLevel: config.userLevel ?? 2,
    // 三级权限默认关闭：面板能打开的人不应自动获得“直接通行/覆盖 AI”的权力。
    allowLevel3: config.allowLevel3 ?? false,
    // 多久没有心跳算「停止使用」，之后由最后一次申请结果定亡语/永恒秘密。
    legacyInactiveHours: config.legacyInactiveHours ?? 24,
    // 面板备份目录：留空 = 自动找一个非系统盘建「爱ai」。
    backupDir: config.backupDir ?? '',
    backupIntervalMinutes: config.backupIntervalMinutes ?? 10,
    // 逐字节记忆备份：留空 = <备份目录>/qq-ai-memory-backup。
    memoryBackup: config.memoryBackup ?? true,
    memoryBackupDir: config.memoryBackupDir ?? '',
    // DSH 会话 → QQ 作用域映射；互通导入导出按它对齐 Python 侧的会话归属。
    sessionScopes: config.sessionScopes ?? {},
    // QQ 会话日志的 junction 目标：留空 = <备份目录>/sessions。
    contextLinkDir: config.contextLinkDir ?? '',
    // 压缩协议：admin-first（管理员至上，默认）或 classic（旧模板）。
    protocol: config.protocol ?? 'admin-first',
    // 自我识别：安装器会从 bridge config.json 读 ownerQQ 写进来。
    ownerQQ: config.ownerQQ ?? '',
    ownerNames: config.ownerNames ?? [],
    botNames: config.botNames ?? [],
  });
}

/** 合并精确 provider/model 覆盖。 */
export function resolveTargetPolicy(config, target) {
  const override = config.modelPolicies.find(
    (policy) => policy.provider === target.provider && policy.model === target.model,
  );
  const inheritedRetention =
    config.retainTokens === undefined ? { retainRatio: config.retainRatio } : { retainTokens: config.retainTokens };
  return freeze({
    target: { provider: target.provider, model: target.model },
    thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
    headroomTokens: override?.headroomTokens ?? config.headroomTokens,
    ...resolveRetention(override ?? {}, inheritedRetention),
    summarizationProvider: override?.summarizationProvider ?? config.summarizationProvider,
    summarizationModel: override?.summarizationModel ?? config.summarizationModel,
    maxTokens: override?.maxTokens ?? config.maxTokens,
    compactionRetries: override?.compactionRetries ?? config.compactionRetries,
    maxOverflowRetries: override?.maxOverflowRetries ?? config.maxOverflowRetries,
    style: config.style,
    // 压缩协议必须透传：路由会话把 policy 当 config 传给 summarize() 和
    // 协议硬校验，缺这个键会让 admin-first 校验整条被跳过（v0.16.1 修的事故）。
    protocol: config.protocol,
    uncertainNotify: config.uncertainNotify,
    uncertainPerTurn: config.uncertainPerTurn,
    uncertainMaxMentions: config.uncertainMaxMentions,
    recallLimit: config.recallLimit,
    memoryDir: config.memoryDir,
    debug: config.debug,
  });
}

/** 面向某个路由模型的阈值与保留预算。 */
export function resolveCompactSpec(policy, contextWindow, reservedCompletionTokens) {
  const targetKey = `${policy.target.provider}/${policy.target.model}`;
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    fail(`contextWindow (${contextWindow}) must be a positive integer for ${targetKey}`);
  }
  if (!Number.isInteger(reservedCompletionTokens) || reservedCompletionTokens < 0) {
    fail(`reservedCompletionTokens (${reservedCompletionTokens}) must be a non-negative integer for ${targetKey}`);
  }
  const messageBudgetTokens = contextWindow - reservedCompletionTokens;
  if (messageBudgetTokens <= 0) {
    fail(
      `${targetKey} reserves ${reservedCompletionTokens} completion tokens of its ${contextWindow}-token window; ` +
        'configure a larger contextWindow or a smaller maxTokens',
    );
  }
  const pressureBudgetTokens = messageBudgetTokens - policy.headroomTokens;
  if (pressureBudgetTokens <= 0) {
    fail(
      `${targetKey} reserves ${reservedCompletionTokens} completion tokens and ${policy.headroomTokens} headroom tokens ` +
        'of its context window; leaving no pressure budget',
    );
  }
  const thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens));
  const retainTokens =
    policy.retainTokens === undefined ? Math.floor(messageBudgetTokens * policy.retainRatio) : policy.retainTokens;
  if (retainTokens >= thresholdTokens) {
    fail(`${targetKey} retainTokens (${retainTokens}) must be less than threshold tokens ${thresholdTokens}`);
  }
  return freeze({
    target: { ...policy.target },
    contextWindow,
    thresholdRatio: policy.thresholdRatio,
    thresholdTokens,
    retainTokens,
    summarizationProvider: policy.summarizationProvider,
    summarizationModel: policy.summarizationModel,
    maxTokens: policy.maxTokens,
    compactionRetries: policy.compactionRetries,
    maxOverflowRetries: policy.maxOverflowRetries,
  });
}
