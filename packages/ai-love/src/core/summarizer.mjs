/**
 * ai-love · 摘要器（纯功能）
 *
 *  1. 把「压缩指令」写成只含事实的记忆卡模板；
 *  2. 调一次 ctx.llm.stream() 生成；
 *  3. 把模型标成「拿不准」的记忆拆出来，交给 pending 层留痕。
 */
import {
  BlockAssembler,
  contentHasImage,
  LlmError,
} from '@deepseek-ai/dsh-llm';
import { splitUncertain } from './uncertain.mjs';
import { factualInstruction, verifyProtocolCard } from './protocol.mjs';
export { verifyProtocolCard } from './protocol.mjs';

export const SUMMARY_OPEN_TAG = '<compacted-summary>';
export const SUMMARY_CLOSE_TAG = '</compacted-summary>';

/** 替换后的 user 消息开头。告诉后来者：这是背景，不是任务。 */
export const CHECKPOINT_PREAMBLE =
  '这是一张自动生成的记忆卡，用来接住前面聊过的内容、腾出上下文。' +
  '把它当成已经发生过的背景，直接接着聊；不要提这张卡，也不要提「压缩」或「摘要」。';

/** 工程向模板：只留事实与待办。 */
function codeInstruction() {
  return [
    '你现在是这段对话的压缩器。把上面的对话压成一份纯事实检查点，让另一个模型能无损接着干活。',
    '',
    '输出格式：严格按下面的小节、按顺序。每条尽量一行，短句，不要散文。空节写「（无）」。',
    '',
    '## 当前话题',
    '- 用户最初和演变中的目标；原话重要处逐字引用。',
    '',
    '## 发生过什么（时间线）',
    '- 按发生顺序，一行一件；关键指令、纠正、错误原文。',
    '',
    '## 技术要点',
    '- 技术栈、框架、约定、约束。',
    '',
    '## 文件与代码',
    '- 精确路径：为什么重要；关键改动/片段。',
    '',
    '## 错误与修复',
    '- 错误原文：怎么解决的；相关的用户反馈。',
    '',
    '## 约定与待办',
    '- 明确要求但还没做的工作；说好要做的事。',
    '',
    '## 当前状态',
    '- 检查点时正在进行什么；下一步动作。',
    '',
    '## 关键词',
    '- 可检索关键词 / 路径 / 标识符。',
    '',
    '规则：',
    '- 保留精确路径、命令、错误字符串、标识符、数值、函数签名。',
    '- 用户反馈和明确指令要忠实记录，尤其是纠正。',
    '- 拿不准的事不要写成确定事实：正文标 (?)，并在 <uncertain> 区各写一条 JSON（what/why/ask）。',
    '- 不写角色、人设、语气、情绪；不提「压缩」「摘要」；只输出检查点和 <uncertain> 区。',
    `- 已有 ${SUMMARY_OPEN_TAG} 是更早的检查点：保留仍成立的，丢掉过时的，合并成一份。`,
    '',
    '<uncertain>',
    '</uncertain>',
  ].join('\n');
}

/** 粗判断这段历史更像聊天还是更像写代码。 */
export function detectStyle(input) {
  const messages = input?.messages ?? [];
  let toolCalls = 0;
  let fileish = 0;
  let chinese = 0;
  let total = 0;
  for (const message of messages) {
    for (const block of message?.content ?? []) {
      if (block?.type === 'tool-call' || block?.type === 'tool-result') toolCalls += 1;
      if (block?.type !== 'text') continue;
      const text = String(block.text ?? '');
      total += text.length;
      chinese += (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
      fileish += (text.match(/(```|[A-Za-z]:\\|\/[\w.-]+\/|\.(?:js|mjs|ts|py|json|yml|yaml|md)\b)/g) ?? []).length;
    }
  }
  if (toolCalls * 2 >= messages.length && fileish > 2) return 'code';
  if (total > 0 && chinese / total < 0.05 && fileish > 0) return 'code';
  return 'qq';
}

function buildInstruction(style, input, retryReason = '') {
  const effective = style === 'auto' ? detectStyle(input) : style;
  const base = effective === 'code' ? codeInstruction() : factualInstruction();
  if (retryReason === '') return base;
  return `${base}\n\n上一次生成没过协议校验（${retryReason}）。这次必须写出具体事实，不要复读模板，也不要写角色/情绪小节。`;
}

/**
 * 生成摘要：回放会话前缀 + 最后一条指令，复用 provider 的热前缀。
 */
export async function summarizeWithLlm(ctx, config, input, agent, signal) {
  const latest = agent.session.requestHeader()?.config;
  const configured =
    config.summarizationProvider.length === 0
      ? undefined
      : { provider: config.summarizationProvider, model: config.summarizationModel };
  const agentTarget =
    agent.options.provider !== undefined &&
    agent.options.provider.length > 0 &&
    agent.options.model !== undefined &&
    agent.options.model.length > 0
      ? { provider: agent.options.provider, model: agent.options.model }
      : undefined;
  const target = configured ?? latest ?? agentTarget;
  if (target === undefined) {
    throw new Error(
      'no provider/model available for summarization: set both summarizationProvider/summarizationModel, route one request, or set both AgentOptions fields',
    );
  }

  const instruction = buildInstruction(config.style, input, config.protocolRetryReason ?? '');
  const assembler = new BlockAssembler();
  const messages = [
    ...input.messages,
    Object.freeze({ role: 'user', content: [{ type: 'text', text: instruction }] }),
  ];
  const options = {
    provider: target.provider,
    model: target.model,
    messages,
    toolHistory: agent.session.toolHistory(),
    ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
    maxTokens: config.maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
  };
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
  const error = finishError(assembler.finish);
  if (error !== undefined) throw error;

  const rawOutput = assembler.blocks();
  const summary = summaryText(rawOutput);
  const joined = summary.map((block) => block.text).join('\n');
  if (joined.trim().length === 0) throw new Error('summarization produced no text summary content');

  const { body, items } = splitUncertain(joined);
  if (body.trim().length === 0) throw new Error('summarization produced only an <uncertain> block');

  return {
    summary: [{ type: 'text', text: body.trim() }],
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens: config.maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    uncertain: items,
  };
}

/** 包一层检查点框，写进替换后的 user 消息。 */
export function frameSummary(summary) {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ];
}

function finishError(finish) {
  switch (finish.kind) {
    case 'error':
    case 'aborted':
      return new LlmError(finish.failure.message, finish.failure.code, finish.failure);
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)');
      error.code = 'MAX_TOKENS';
      return error;
    }
    default:
      return undefined;
  }
}

function summaryText(blocks) {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT');
  }
  return blocks.filter((block) => block.type === 'text');
}
