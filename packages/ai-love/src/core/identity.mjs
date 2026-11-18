/**
 * 爱ai · 自我识别（核心）
 *
 * 作用：压缩时区分「我」（当前 QQ 上的 AI）、「我的管理员」和「其他人」，
 * 让言行总结只取这两类原话，不被群里其他人的发言带偏。
 *
 * 标记规则（best effort，不依赖 DSH 的私有字段）：
 *   - assistant 消息 → self
 *   - user 消息按行拆；行内命中 ownerQQ / ownerNames → admin；
 *     命中 botNames → self（桥接回显自己的话）；其余 → other，不记录
 *
 * 安装器会把 bridge config.json 的 ownerQQ 写进 QQ preset 的 config，
 * 插件启动时即可知道「谁是管理员」。
 */

export const SPEAKER_SELF = 'self';
export const SPEAKER_ADMIN = 'admin';
export const SPEAKER_OTHER = 'other';

/** 规范化身份配置。 */
export function normalizeIdentity(raw = {}) {
  const ownerQQ = String(raw.ownerQQ ?? '').trim();
  const ownerNames = Array.isArray(raw.ownerNames)
    ? raw.ownerNames.map((name) => String(name ?? '').trim()).filter((name) => name !== '')
    : [];
  const botNames = Array.isArray(raw.botNames)
    ? raw.botNames.map((name) => String(name ?? '').trim()).filter((name) => name !== '')
    : [];
  return { ownerQQ, ownerNames, botNames };
}

function looksLikePromptLine(line) {
  return line.startsWith('【') || line.startsWith('#') || line.startsWith('<!--');
}

function isAdminLine(line, identity) {
  if (identity.ownerQQ !== '' && line.includes(identity.ownerQQ)) return true;
  return identity.ownerNames.some((name) => line.includes(name));
}

function isSelfLine(line, identity) {
  return identity.botNames.some((name) => line.includes(name));
}

/**
 * 从被压缩的回放消息里提取「我」和「我的管理员」的原话。
 * @returns {{speaker: string, text: string}[]}
 */
export function extractIdentitySamples(input, identityInput = {}) {
  const identity = normalizeIdentity(identityInput);
  const rows = [];
  for (const message of input?.messages ?? []) {
    const role = message?.role;
    const text = (message?.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (text === '') continue;
    if (role === 'assistant') {
      rows.push({ speaker: SPEAKER_SELF, text });
      continue;
    }
    if (role !== 'user') continue;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length < 2) continue;
      // 跳过桥接注入的系统提示、记忆卡、身份说明，避免把提示当发言。
      if (looksLikePromptLine(trimmed)) continue;
      if (isAdminLine(trimmed, identity)) rows.push({ speaker: SPEAKER_ADMIN, text: trimmed });
      else if (isSelfLine(trimmed, identity)) rows.push({ speaker: SPEAKER_SELF, text: trimmed });
      // other：不记录
    }
  }
  return rows.slice(-60);
}

/** 行为样本是否参与角色卡总结：只有 self/admin（旧数据没有 speaker 视为 self）。 */
export function isSummarizableSpeaker(speaker) {
  const value = String(speaker ?? '');
  return value === '' || value === SPEAKER_SELF || value === SPEAKER_ADMIN;
}
