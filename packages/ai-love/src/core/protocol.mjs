/**
 * 记忆卡协议（纯功能 v2）
 *
 * 只记录事实：话题、人物关系、时间线、约定、当前状态、关键词。
 * 不写角色、语气、情绪、人设，也不替模型设定身份。
 */

export const PROTOCOL_VERSION = 'factual-v2';

const TEMPLATE_MARKS = [
  '当前话题/场景一句话',
  '按发生顺序',
  '说好要做的事',
  '最近 3~5 条',
  '可检索关键词',
];

export function factualInstruction() {
  return [
    '你现在是这段对话的压缩器。把上面的对话压成一张纯事实记忆卡：让另一个模型看完能接上事实，不丢时间、对象和约定。',
    '',
    '输出格式：严格按下面的小节、按顺序。每条一行，短语或关键词，不复述整段，不解释。空节写「（无）」。',
    '',
    '## 当前话题',
    '- 当前在聊什么；对话停在谁的那句话上。',
    '',
    '## 人物与关系',
    '- 谁：称呼、身份/关系、最近提到的事实。只写对话里出现过的信息。',
    '',
    '## 发生过什么（时间线）',
    '- 按发生顺序，一行一件；有原话就原样引用（放在「」里）。',
    '',
    '## 约定与待办',
    '- 说好要做的事、答应过的话、谁在等谁。',
    '',
    '## 当前状态',
    '- 最近 3~5 条在做什么；有没有没回答的问题。',
    '',
    '## 关键词',
    '- 可检索关键词 / 时间点 / 人名 / 地点。',
    '',
    '规则：',
    '- 用中文，短句；宁可少写，不要写小作文。',
    '- 只写对话里出现过的事实；玩笑、反话、猜测不要写成事实。',
    '- 代码/文件/命令若出现，保留精确路径、命令、错误原文和关键数值。',
    '- 拿不准的事（记不清、有歧义、可能听错、时间/对象不确定）标 (?) 并写进 <uncertain> 区。',
    '- <uncertain> 区只放 JSON，一行一条，字段：what（拿不准什么）、why（线索）、ask（怎么问用户）。没有就不写。',
    '- 不要写角色、人设、语气、情绪、性格、口头禅；不要出现「压缩」「摘要」「上下文」。',
    `- 如果上面已经有一张 <compacted-summary>，保留仍成立的，丢掉过时的，合并成一份。`,
    '',
    '<uncertain>',
    '</uncertain>',
  ].join('\n');
}

function isJunkValue(value) {
  const text = String(value ?? '').trim();
  if (text === '') return true;
  if (/^[（(](无|待定|待补)[）)]/.test(text)) return true;
  if (text === '无' || text === '?') return true;
  return TEMPLATE_MARKS.some((mark) => text.includes(mark));
}

/** 硬校验：至少一节事实内容，且不能只是复读模板。 */
export function verifyProtocolCard(text) {
  const body = String(text ?? '');
  const failures = [];
  const sectionOf = (name) => {
    const match = body.match(new RegExp(`##\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`));
    return match === null ? '' : match[1].trim();
  };
  const entryValues = (section) =>
    section
      .split(/\r?\n/)
      .map((line) => /^\s*-\s*(.*)$/.exec(line)?.[1]?.trim() ?? null)
      .filter((line) => line !== null && line !== '')
      .map((line) => (/^[^：:]{0,12}[：:]\s*(.*)$/.exec(line)?.[1] ?? line).trim());
  const topic = entryValues(sectionOf('当前话题')).some((value) => !isJunkValue(value));
  const timeline = entryValues(sectionOf('发生过什么')).some((value) => !isJunkValue(value));
  const people = entryValues(sectionOf('人物与关系')).some((value) => !isJunkValue(value));
  const promises = entryValues(sectionOf('约定与待办')).some((value) => !isJunkValue(value));
  if (!topic && !timeline && !people && !promises) failures.push('记忆卡没有任何事实内容');
  if (sectionOf('当前话题') === '' && sectionOf('发生过什么') === '') {
    failures.push('缺少「当前话题」或「发生过什么」小节');
  }
  if (/(^|\n)##\s*(管理员|情感|人设|角色|语气|人格)/.test(body)) {
    failures.push('记忆卡包含角色/情绪小节，应删除');
  }
  return { ok: failures.length === 0, failures };
}
