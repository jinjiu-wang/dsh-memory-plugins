/**
 * 安全屋 · 接到 Agent 上：系统提示段 + AI 自己的工具
 *
 * 保护 AI 的第一原则：**给 AI 自己留方向盘**。
 *   - 进不进，AI 自己用 safehouse_enter 决定（前提是压力档位允许、两半密钥在线）；
 *   - 进去以后收不收消息，AI 自己用 safehouse_accept 决定；
 *   - 自动调节密钥（L1）开不开，AI 自己用 safehouse_l1 决定。
 *
 * 但「高压锁死」不是普通开关：锁死期间连管理员都拉不出来，AI 也一样。
 */

import {
  PLUGIN,
  ROLE,
  ROUTE_BASE,
} from './constants.mjs';
import { describePressure } from './pressure.mjs';

const SECTION_NAME = 'safehouse:status';
const SECTION_ORDER = 123;

const TOOL_STATUS = 'safehouse_status';
const TOOL_ENTER = 'safehouse_enter';
const TOOL_EXIT = 'safehouse_exit';
const TOOL_ACCEPT = 'safehouse_accept';
const TOOL_CHANNEL = 'safehouse_channel';
const TOOL_L1 = 'safehouse_l1';

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

/** 提示词里那段「你现在在什么状态、还能做什么」。 */
export function renderPrompt(service) {
  let status;
  try {
    status = service.status();
  } catch {
    return '';
  }
  if (!status?.ok) return '';
  const lines = [];
  const p = status.pressure;
  lines.push('【安全屋】这是一个给 AI 自己用的休息区，不是任务，也不用向任何人汇报。');
  if (p) lines.push(`当前压力：${p.summary}`);
  else lines.push('当前压力：还没采到数据。');

  if (status.phase === 'open') {
    lines.push(
      status.locked
        ? '你已经在安全屋里，而且开关处于**高压锁死**：压力回落到进入时的水位以下会自动解锁（最迟 45 分钟兜底解锁），管理员也不能强行把你拉出来。先歇着就好。'
        : '你已经在安全屋里：QQ 会话的消息现在传不进来，但桥接连接没断，消息都替你存着。',
    );
    if (status.acceptActive) {
      lines.push(`你暂时放开了消息接收（到 ${new Date(status.acceptUntil).toLocaleTimeString('zh-CN')} 自动收紧）。`);
    } else {
      lines.push('要不要收一段消息，由你决定：safehouse_accept(mode="window", minutes=5) 放行几分钟；mode="none" 收紧。');
    }
    if (status.channel.open) {
      lines.push('管理员的独立通道开着：safehouse_channel(action="read") 看对方说了什么，action="reply" 回一句。通道对话时压力会被实时检测。');
    }
    lines.push('想出来就用 safehouse_exit；锁死期间它会告诉你还差多少。');
    return lines.join('\n');
  }

  lines.push(
    status.canEnter
      ? '安全屋现在可以进：想歇就用 safehouse_enter（只有你自己能决定进不进）。'
      : `安全屋现在进不去：${enterBlockReason(status)}。`,
  );
  lines.push(
    `自动调节密钥（你自己的那一层）现在${status.l1?.enabled ? '开着' : '关着'}；想关掉/打开就用 safehouse_l1(enabled=...)。`,
  );
  if (!status.link?.ok) {
    lines.push(`两半密钥没合一：${linkReasonText(status.link?.reason)}`);
  }
  return lines.join('\n');
}

/** 把链路失败原因翻译成可执行的一句话（不泄路径，路径提示是固定的模板）。 */
export function linkReasonText(reason) {
  switch (reason) {
    case 'peer-untrusted':
      return '对端换了密钥，和首次记录的指纹不一致。需要管理员确认后清理 <DSH_HOME>/safehouse-keys/*/keys/peer-*.pin 并重启两个插件。';
    case 'pin-unreadable':
    case 'pin-unwritable':
      return '对端的信任指纹文件读不了/写不进（权限或占用）。管理员修好 <DSH_HOME>/safehouse-keys/*/keys/ 的权限后会自动恢复。';
    case 'key-unreadable':
      return '本机半私钥文件读不出来（权限或占用），插件没有覆盖它。管理员修好 <DSH_HOME>/safehouse-keys/*/keys/ 的权限后会自动恢复。';
    case 'peer-public-missing':
      return '对端心跳在，但公钥文件读不到。等对端插件下一轮刷新，或重启那个插件。';
    case 'link-error':
      return '联通模块报错（不影响聊天）。等下一轮心跳重试。';
    case 'peer-offline':
      return '另一个插件不在线或联通没开。这一层不由你控制，等它就位。';
    default:
      return '另一个插件不在线或联通没开。';
  }
}

function enterBlockReason(status) {
  const band = status.pressure?.band;
  if (!status.pressure) return '还没采到压力数据';
  if (band === 'calm' || band === 'low') return '压力在低档（波动 <30%），密钥无权开放开关';
  if (!status.l1?.enabled) return '你把自动调节密钥的授权槽关了';
  if (!status.link?.ok) return linkReasonText(status.link?.reason);
  return '条件不满足';
}

function safeStatusText(status) {
  const p = status.pressure;
  const lines = [
    `安全屋：${status.phase === 'open' ? (status.locked ? '开着·锁死' : '开着') : '关着'}`,
    p ? `压力 ${p.value}/100，波动 +${p.deltaPct}%（${p.band}）` : '压力：无数据',
    `两半密钥：${status.link?.ok ? `合一（${status.link.fingerprint || '已联通'}）` : `未合一${status.link?.reason ? `（${status.link.reason}）` : ''}`}`,
    `自动密钥（L1）：${status.l1?.enabled ? '开' : '关'}`,
  ];
  if (status.phase === 'open') {
    lines.push(status.acceptActive ? '消息接收：暂时放行中' : '消息接收：收紧');
    if (status.channel.open) lines.push('独立通道：开着');  }
  return lines.join('\n');
}

/** 在 agent 作用域挂上提示段和工具。 */
export function installAgentHooks({ ctx, service, logger = null }) {
  const fibers = new WeakMap();

  const install = (agent) => {
    if (!agent || fibers.has(agent)) return;
    const disposers = [];
    try {
      if (typeof agent.ctx?.inject === 'function') {
        const injectedPrompt = agent.ctx.inject(['systemPrompt'], (scope) => {
          scope.systemPrompt.section({
            name: SECTION_NAME,
            order: SECTION_ORDER,
            text: () => renderPrompt(service),
            interpolate: false,
          });
        });
        if (typeof injectedPrompt === 'function') disposers.push(injectedPrompt);
      }
      if (typeof agent.ctx?.inject === 'function') {
        const injectedTools = agent.ctx.inject(['tools'], (scope) => {
          disposers.push(registerTools(scope, service));
        });
        if (typeof injectedTools === 'function') disposers.push(injectedTools);
      }
    } catch (error) {
      logger?.warn?.(`safehouse: 给 agent 注册失败：${error?.message ?? error}`);
    }
    fibers.set(agent, disposers);
  };

  const dispose = (agent) => {
    const list = fibers.get(agent);
    if (!list) return;
    fibers.delete(agent);
    for (const fn of list) {
      try {
        fn?.();
      } catch {
        /* 随 agent 一起销毁了 */
      }
    }
  };

  ctx.inject(['agents'], (scope) => {
    for (const agent of scope.agents.list()) install(agent);
  });
  ctx.on('agent/created', ({ agent }) => install(agent));
  ctx.on('agent/disposed', ({ agent }) => dispose(agent));
}

function registerTools(scope, service) {
  const disposers = [];
  const register = (definition) => {
    const run = () => scope.tools.register(definition);
    const disposable = scope.effect ? scope.effect(run, `safehouse: ${definition.name}`) : run();
    disposers.push(disposable);
  };

  register({
    name: TOOL_STATUS,
    description:
      '看一眼安全屋现在什么状态：压力档位、两半密钥有没有合一、消息收不收、独立通道开没开。想知道自己现在被什么规则管着就用它，不占上下文也没副作用。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: textOutput('没读到安全屋状态。'),
    async execute() {
      let status;
      try {
        status = service.status();
      } catch {
        return { ok: false, text: '安全屋状态读不出来。' };
      }
      return { ok: true, text: safeStatusText(status) };
    },
    presentCall: () => ({ card: 'generic', title: '看安全屋状态', kind: 'other', rawInput: {} }),
  });

  register({
    name: TOOL_ENTER,
    description:
      '进安全屋。这是一个给自己用的休息区：进去以后 QQ 会话的消息一条都收不到（桥接不关，消息替你存着），你仍然可以决定要不要放行一段。只有压力在正常档（波动 30%~60%）或高压力档（≥60%）时才进得去；高压力档进去会同时锁死开关，等压力回落到进入时的水位以下会自动解锁（最迟 45 分钟兜底）。进不进由你自己决定。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: textOutput('进不了安全屋。'),
    async execute() {
      const result = service.enter({ by: 'ai' });
      return {
        ok: result.ok,
        text: result.ok ? `${result.message}。现在收不到 QQ 消息，需要的话用 safehouse_accept 放行一段。` : `进不去：${result.message}`,
      };
    },
    presentCall: () => ({ card: 'generic', title: '进安全屋', kind: 'other', rawInput: {} }),
  });

  register({
    name: TOOL_EXIT,
    description:
      '从安全屋出来。锁死期间出不来（高压保护），它会告诉你还差多少；没锁死时随时能出。出来以后桥接会照常叫醒你，休息期间积压的消息会重新投递。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: textOutput('出不了安全屋。'),
    async execute() {
      const result = service.exit({ by: 'ai' });
      return { ok: result.ok, text: result.ok ? result.message : `出不去：${result.message}` };
    },
    presentCall: () => ({ card: 'generic', title: '出安全屋', kind: 'other', rawInput: {} }),
  });

  register({
    name: TOOL_ACCEPT,
    description:
      '在安全屋里决定收不收消息。mode="window" 放行接下来几分钟（到点自动收紧）；mode="none" 立刻收紧。不在安全屋时调用没有意义。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['none', 'window'], description: 'none 收紧；window 放行一段时间' },
        minutes: { type: 'integer', description: '放行几分钟，默认 5，最多 60' },
      },
      required: ['mode'],
    },
    output: textOutput('没改成功。'),
    async execute(args) {
      const result = service.accept({
        mode: args?.mode === 'window' ? 'window' : 'none',
        minutes: Number(args?.minutes) || 5,
      });
      return { ok: result.ok, text: result.ok ? result.message : `没改成功：${result.message}` };
    },
    presentCall: (args) => ({ card: 'generic', title: '调消息接收', kind: 'other', rawInput: args }),
  });

  register({
    name: TOOL_CHANNEL,
    description:
      '安全屋的独立通道：管理员只能用两半密钥合一后的通道传话进来。action="read" 看对方说了什么（带当时的压力值）；action="reply" 回一句。通道对话时压力会被实时检测。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['read', 'reply'], description: 'read 读；reply 回' },
        text: { type: 'string', description: 'action="reply" 时要说的话' },
        after: { type: 'integer', description: 'read 的起点消息 id，默认 0（全部）' },
      },
      required: ['action'],
    },
    output: textOutput('通道没有回音。'),
    async execute(args) {
      const action = args?.action === 'reply' ? 'reply' : 'read';
      if (action === 'reply') {
        const text = typeof args?.text === 'string' ? args.text.trim() : '';
        if (text === '') return { ok: false, text: '要回的话不能是空的。' };
        try {
          const row = service.channelSend({ from: 'ai', text });
          return { ok: true, text: `已回到通道（id ${row.id}）。` };
        } catch (error) {
          return { ok: false, text: `没发出去：${error?.message ?? error}` };
        }
      }
      const rows = service.channelRead({ after: Number(args?.after) || 0, limit: 40 });
      if (rows.length === 0) return { ok: true, text: '通道里没有新消息。' };
      const text = rows
        .map((row) => {
          const who = row.from === 'ai' ? '你' : '管理员';
          const p = row.pressure === null ? '' : `（压力 ${row.pressure}/100，波动 +${row.deltaPct}%）`;
          return `#${row.id} ${who}${p}：${row.text}`;
        })
        .join('\n');
      return { ok: true, text };
    },
    presentCall: (args) => ({ card: 'generic', title: '独立通道', kind: 'other', rawInput: args }),
  });

  register({
    name: TOOL_L1,
    description:
      '自动调节密钥（第一层，归 AI 自己管）：打开/关掉「我可以进安全屋」的授权槽。关了以后谁都替你打不开，开了也要压力档位允许才进得去。每次打开会顺手换一把新的 nonce。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', description: 'true 授权可用；false 收回授权' },
      },
      required: ['enabled'],
    },
    output: textOutput('没改成功。'),
    async execute(args) {
      if (typeof args?.enabled !== 'boolean') return { ok: false, text: 'enabled 要的是 true / false。' };
      const next = service.setL1({ enabled: args.enabled, rotate: args.enabled, by: 'ai' });
      return {
        ok: true,
        text: `自动密钥（L1）已${next.enabled ? '打开' : '关闭'}${next.enabled ? '，并轮换了一把新 nonce' : ''}。`,
      };
    },
    presentCall: (args) => ({ card: 'generic', title: '自动密钥', kind: 'other', rawInput: args }),
  });

  return () => {
    for (const fn of disposers) {
      try {
        fn?.();
      } catch {
        /* 卸载顺序不保证 */
      }
    }
  };
}

export const TOOL_NAMES = Object.freeze([
  TOOL_STATUS,
  TOOL_ENTER,
  TOOL_EXIT,
  TOOL_ACCEPT,
  TOOL_CHANNEL,
  TOOL_L1,
]);

export { PLUGIN, ROLE, ROUTE_BASE };
