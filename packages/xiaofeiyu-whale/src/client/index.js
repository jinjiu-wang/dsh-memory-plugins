/**
 * 小肥鱼鲸鱼娘 · 客户端半边（手写 bundle，无打包器）
 *
 * 左侧栏图标 + 主面板：
 *   服务状态 / 记忆统计 / 自动联通开关 / 立即同步 / 最近事实 / 最近摘要 / 检索。
 * 数据来自 Host 的 /xiaofeiyu/*，不在这里改记忆内容。
 */
window.__ModuleLoader__.load({
  id: 'xiaofeiyu-whale',

  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState, useCallback } = React;

    const PANEL_ID = 'xiaofeiyu-whale';
    const API = '/xiaofeiyu';
    const POLL_MS = 10000;

    const C = {
      bg: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      text1: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      brand: 'var(--dsw-alias-brand-primary)',
    };

    function Icon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20;
      const active = Boolean(props && props.active);
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          role: 'img',
          'aria-label': '小肥鱼鲸鱼娘',
          style: { display: 'block', opacity: active ? 1 : 0.72 },
        },
        h('path', {
          d: 'M3.2 13.4c0-3 2.8-5.2 6.6-5.2 3.4 0 5.8 1.6 6.6 3.8.6-.3 1.2-.4 1.8-.4 1.9 0 3.3 1.2 3.3 2.7 0 1.7-1.5 3-3.6 3H7.4c-2.5 0-4.2-1.6-4.2-3.9Z',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M5.6 14.4 2.4 11.6v6.2l3.2-2.6',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 14.6, cy: 12.6, r: 1.05, fill: 'currentColor' }),
        h('path', {
          d: 'M8.2 15.4c.9 1.2 2 1.8 3.4 1.8',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M16.2 6.2c1.2-.8 2.5-1 3.8-.6-.5 1.2-1.5 2-2.8 2.3',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M18.4 4.2c.7-.5 1.4-.6 2.1-.4-.3.7-.8 1.1-1.5 1.3',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinejoin: 'round',
          opacity: 0.7,
        }),
      );
    }

    async function api(path, options) {
      const res = await fetch(`${API}${path}`, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) },
      });
      return res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    }

    function Section(props) {
      return h(
        'section',
        {
          style: {
            marginTop: 18,
            padding: '16px 18px 18px',
            borderRadius: 14,
            border: `1px solid ${C.border1}`,
            background: C.layer1,
            boxShadow: '0 1px 2px rgba(0, 0, 0, 0.10)',
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginBottom: 12,
              paddingBottom: 10,
              borderBottom: `1px solid ${C.border1}`,
            },
          },
          h('span', { style: { width: 4, height: 16, borderRadius: 2, background: C.brand, flex: 'none' } }),
          h('h3', { style: { margin: 0, fontSize: 16, fontWeight: 700, color: C.text1 } }, props.title),
          props.hint ? h('span', { style: { marginLeft: 'auto', fontSize: 11.5, color: C.text2 } }, props.hint) : null,
        ),
        props.children,
      );
    }

    function Dot(props) {
      return h('span', {
        style: {
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: 4,
          marginRight: 6,
          background: props.on ? (props.bad ? C.err : C.ok ?? C.brand) : C.idle,
          opacity: props.on ? 1 : 0.6,
        },
      });
    }

    function Btn(props) {
      const danger = Boolean(props.danger);
      return h(
        'button',
        {
          type: 'button',
          onClick: props.onClick,
          disabled: Boolean(props.disabled),
          style: {
            margin: 0,
            padding: '7px 14px',
            borderRadius: 9,
            border: `1px solid ${danger ? C.err : C.border2}`,
            background: 'transparent',
            color: danger ? C.err : C.text1,
            fontSize: 12,
            cursor: props.disabled ? 'default' : 'pointer',
            opacity: props.disabled ? 0.5 : 1,
          },
        },
        props.children,
      );
    }

    function Switch(props) {
      const on = props.on === true;
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': on,
          onClick: props.onChange,
          disabled: Boolean(props.disabled),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            margin: 0,
            padding: 0,
            border: 'none',
            background: 'transparent',
            color: C.text1,
            cursor: props.disabled ? 'default' : 'pointer',
            opacity: props.disabled ? 0.55 : 1,
          },
        },
        h(
          'span',
          {
            style: {
              width: 38,
              height: 22,
              borderRadius: 11,
              padding: 2,
              boxSizing: 'border-box',
              background: on ? C.brand : C.border2,
              transition: 'background 120ms ease',
              display: 'inline-flex',
              justifyContent: on ? 'flex-end' : 'flex-start',
            },
          },
          h('span', {
            style: {
              width: 18,
              height: 18,
              borderRadius: 9,
              background: '#fff',
              boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
              transition: 'transform 120ms ease',
            },
          }),
        ),
        h('span', { style: { fontSize: 12.5 } }, props.label),
      );
    }

    function Pill(props) {
      const color = props.color || C.text2;
      return h(
        'span',
        {
          style: {
            display: 'inline-block',
            padding: '1px 8px',
            borderRadius: 999,
            border: `1px solid ${color}`,
            color,
            fontSize: 10.5,
            lineHeight: 1.7,
            whiteSpace: 'nowrap',
          },
        },
        props.children,
      );
    }

    function Empty(props) {
      return h('div', { style: { fontSize: 11.5, color: C.text2, padding: '6px 0' } }, props.text);
    }

    const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' };
    const muted = { fontSize: 11.5, color: C.text2, lineHeight: 1.7 };

    function fmtTime(ms) {
      if (!ms) return '—';
      try {
        return new Date(ms).toLocaleString('zh-CN', { hour12: false });
      } catch {
        return '—';
      }
    }

    function scopeLabel(row) {
      if (row?.chatType === 'group') return `群 ${row.groupId || '?'}`;
      return row?.peer ? `私聊 ${row.peer}` : '私聊';
    }

    function statusColor(status) {
      if (status === 'confirmed') return C.ok ?? C.brand;
      if (status === 'rejected' || status === 'resolved') return C.err;
      return C.text2;
    }

    function Stat(props) {
      return h(
        'div',
        {
          style: {
            minWidth: 86,
            padding: '10px 12px',
            borderRadius: 10,
            border: `1px solid ${C.border1}`,
            background: C.layer2,
          },
        },
        h('div', { style: { fontSize: 20, fontWeight: 700, color: C.text1, lineHeight: 1.2 } }, String(props.value ?? 0)),
        h('div', { style: { fontSize: 11, color: C.text2, marginTop: 2 } }, props.label),
      );
    }

    function Panel() {
      const [state, setState] = useState(null);
      const [busy, setBusy] = useState('');
      const [message, setMessage] = useState('');
      const [query, setQuery] = useState('');
      const [hits, setHits] = useState([]);
      const [searching, setSearching] = useState(false);

      const refresh = useCallback(async () => {
        const json = await api('/state');
        if (json?.ok) setState(json);
      }, []);

      useEffect(() => {
        refresh();
        const timer = setInterval(refresh, POLL_MS);
        return () => clearInterval(timer);
      }, [refresh]);

      async function toggleAuto() {
        if (!state || busy !== '') return;
        const enabled = !(state.interop?.auto === true);
        setBusy('toggle');
        setMessage('');
        const json = await api('/interop/auto', {
          method: 'POST',
          body: JSON.stringify({ enabled }),
        });
        setBusy('');
        if (json?.ok) {
          setMessage(
            enabled
              ? json.error
                ? `已开启自动联通；首次同步失败：${json.error}`
                : '已开启自动联通。'
              : '已关闭自动联通。',
          );
          await refresh();
        } else {
          setMessage(`切换失败：${json?.error || '未知错误'}`);
        }
      }

      async function syncNow() {
        if (busy !== '') return;
        setBusy('sync');
        setMessage('');
        const json = await api('/interop/sync', { method: 'POST', body: '{}' });
        setBusy('');
        if (json?.ok) {
          const imported = json.result?.imported;
          const count = imported
            ? `摘要 ${imported.summary ?? 0}、事实 ${imported.fact ?? 0}、待确认 ${imported.uncertain ?? 0}、备注 ${imported.note ?? 0}`
            : '无新记录';
          setMessage(`同步完成：导入 ${count}；导出 ${json.result?.exported ?? 0} 条。`);
        } else {
          setMessage(`同步失败：${json?.error || '未知错误'}`);
        }
        await refresh();
      }

      async function search() {
        const text = query.trim();
        if (text === '' || searching) return;
        setSearching(true);
        const json = await api('/search', {
          method: 'POST',
          body: JSON.stringify({ query: text, limit: 20 }),
        });
        setSearching(false);
        if (json?.ok) {
          setHits(json.hits || []);
          setMessage(json.hits?.length ? `找到 ${json.hits.length} 条原话。` : '没有找到相关原话。');
        } else {
          setHits([]);
          setMessage(`检索失败：${json?.error || '未知错误'}`);
        }
      }

      const stats = state?.stats || {};
      const service = state?.service || {};
      const interop = state?.interop || {};
      const facts = state?.facts || [];
      const pending = state?.pending || [];
      const summaries = state?.summaries || [];
      const running = service.running === true;

      return h(
        'div',
        {
          style: {
            height: '100%',
            overflowY: 'auto',
            overflowX: 'hidden',
            overscrollBehavior: 'contain',
            boxSizing: 'border-box',
            padding: '22px 26px 40px',
            maxWidth: 980,
            margin: '0 auto',
            color: C.text1,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 12 } },
          h('div', { style: { width: 34, height: 34, color: C.brand } }, h(Icon, { size: 34 })),
          h(
            'div',
            null,
            h('div', { style: { fontSize: 22, fontWeight: 750, letterSpacing: '0.01em' } }, '小肥鱼鲸鱼娘'),
            h('div', { style: { ...muted, marginTop: 2 } }, `独立记忆插件 · v${state?.version || '…'}`),
          ),
          h(
            'div',
            { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 } },
            h(Dot, { on: running, bad: Boolean(service.error) }),
            h('span', { style: { ...muted } }, running ? '记忆服务运行中' : service.starting ? '启动中' : '未运行'),
            h(Btn, { onClick: refresh, disabled: busy !== '' }, '刷新'),
          ),
        ),

        message
          ? h(
              'div',
              {
                style: {
                  marginTop: 12,
                  padding: '9px 12px',
                  borderRadius: 10,
                  border: `1px solid ${C.border2}`,
                  background: C.layer1,
                  fontSize: 12,
                  color: C.text2,
                  lineHeight: 1.7,
                },
              },
              message,
            )
          : null,

        service.error
          ? h(
              'div',
              {
                style: {
                  marginTop: 12,
                  padding: '9px 12px',
                  borderRadius: 10,
                  border: `1px solid ${C.err}`,
                  color: C.err,
                  fontSize: 11.5,
                  lineHeight: 1.7,
                  wordBreak: 'break-all',
                },
              },
              service.error,
            )
          : null,

        h(
          Section,
          { title: '记忆概览', hint: `${facts.length} 条事实 · ${summaries.length} 条摘要（最近 12 条）` },
          h(
            'div',
            { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
            h(Stat, { label: '消息', value: stats.total }),
            h(Stat, { label: '今天', value: stats.today }),
            h(Stat, { label: '摘要', value: stats.summaries }),
            h(Stat, { label: '事实', value: stats.facts }),
            h(Stat, { label: '群', value: stats.groups }),
            h(Stat, { label: '私聊', value: stats.private }),
            h(Stat, { label: '待确认', value: pending.length }),
          ),
          h(
            'div',
            { style: { ...muted, marginTop: 10, ...mono, wordBreak: 'break-all' } },
            `数据库：${state?.paths?.dbPath || '—'}`,
          ),
          h(
            'div',
            { style: { ...muted, ...mono, wordBreak: 'break-all' } },
            `Python：${service.python || '—'}${service.pid ? ` · PID ${service.pid}` : ''}`,
          ),
        ),

        h(
          Section,
          {
            title: '与「爱ai」自动联通',
            hint: interop.enabled ? '两边都开着，自动双向同步' : '自动联通已停',
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' } },
            h(Switch, {
              on: interop.auto === true,
              label: interop.auto ? '本插件自动联通：开' : '本插件自动联通：关',
              disabled: busy !== '',
              onChange: toggleAuto,
            }),
            h(
              'span',
              { style: { display: 'inline-flex', alignItems: 'center', gap: 4, ...muted } },
              h(Dot, { on: interop.peerAuto === true }),
              `「爱ai」${interop.peerAuto === true ? '开着' : '关着'}`,
            ),
            h(Btn, { onClick: syncNow, disabled: busy !== '' }, busy === 'sync' ? '同步中…' : '立即同步'),
          ),
          h(
            'div',
            { style: { ...muted, marginTop: 10 } },
            interop.enabled
              ? `每 ${interop.intervalSeconds || 60} 秒自动同步一次；任何一边关掉，自动联通都会停。`
              : interop.reason || '自动联通已关闭，仍可点「立即同步」手动跑一次。',
          ),
          h(
            'div',
            { style: { ...muted, marginTop: 6, ...mono, wordBreak: 'break-all' } },
            `互通目录：${interop.bridgeDir || '—'}`,
          ),
          h(
            'div',
            { style: { ...muted, ...mono, wordBreak: 'break-all' } },
            `读取「爱ai」：${interop.aiLoveFile || '—'}`,
          ),
          h(
            'div',
            { style: { ...muted, ...mono, wordBreak: 'break-all' } },
            `导出给「爱ai」：${interop.peerFile || '—'}`,
          ),
          interop.lastSync?.at
            ? h(
                'div',
                { style: { ...muted, marginTop: 8 } },
                interop.lastSync.error
                  ? `上次同步失败 ${fmtTime(interop.lastSync.at)}：${interop.lastSync.error}`
                  : `上次同步 ${fmtTime(interop.lastSync.at)}：导入 ${
                      interop.lastSync.result?.imported
                        ? `摘要 ${interop.lastSync.result.imported.summary ?? 0}、事实 ${interop.lastSync.result.imported.fact ?? 0}、待确认 ${interop.lastSync.result.imported.uncertain ?? 0}、备注 ${interop.lastSync.result.imported.note ?? 0}`
                        : '无新记录'
                    }；导出 ${interop.lastSync.result?.exported ?? 0} 条。`,
              )
            : h('div', { style: { ...muted, marginTop: 8 } }, '还没有同步记录。'),
        ),

        h(
          Section,
          { title: '待确认（她还没弄清的事）', hint: pending.length > 0 ? `${pending.length} 条` : '' },
          pending.length === 0
            ? h(Empty, { text: '没有挂着的事——要么她没遇到没听清的，要么都问清了。' })
            : pending.map((row, index) =>
                h(
                  'div',
                  {
                    key: `p${index}`,
                    style: {
                      padding: '9px 0',
                      borderBottom: `1px solid ${C.border1}`,
                      fontSize: 12,
                      lineHeight: 1.7,
                    },
                  },
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                    h(Pill, { color: C.brand }, '待确认'),
                    row.ask ? h('strong', { style: { fontSize: 12.5 } }, row.ask) : null,
                    h('span', { style: { ...muted, marginLeft: 'auto' } }, `${scopeLabel(row)} · ${fmtTime(row.ts)}`),
                  ),
                  h('div', { style: { marginTop: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, row.text),
                  row.why
                    ? h('div', { style: { ...muted, marginTop: 2 } }, `没把握的原因：${row.why}`)
                    : null,
                ),
              ),
        ),

        h(
          Section,
          { title: '最近事实', hint: facts.length > 0 ? `${facts.length} 条` : '' },
          facts.length === 0
            ? h(Empty, { text: '还没有事实。等「爱ai」那边有已确认事实并完成一次自动同步。' })
            : facts.map((row, index) =>
                h(
                  'div',
                  {
                    key: `f${index}`,
                    style: {
                      padding: '9px 0',
                      borderBottom: `1px solid ${C.border1}`,
                      fontSize: 12,
                      lineHeight: 1.7,
                    },
                  },
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                    h(Pill, { color: statusColor(row.status) }, row.status || 'open'),
                    row.subject ? h('strong', { style: { fontSize: 12.5 } }, row.subject) : null,
                    row.category ? h(Pill, null, row.category) : null,
                    h('span', { style: { ...muted, marginLeft: 'auto' } }, `${scopeLabel(row)} · ${fmtTime(row.ts)}`),
                  ),
                  h('div', { style: { marginTop: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, row.text),
                  h(
                    'div',
                    { style: { ...muted, marginTop: 2, ...mono } },
                    `${row.source || 'local'} · 重要度 ${Number(row.importance ?? 0).toFixed(2)}`,
                  ),
                ),
              ),
        ),

        h(
          Section,
          { title: '最近摘要', hint: summaries.length > 0 ? `${summaries.length} 条` : '' },
          summaries.length === 0
            ? h(Empty, { text: '还没有摘要。' })
            : summaries.map((row, index) =>
                h(
                  'div',
                  {
                    key: `s${index}`,
                    style: {
                      padding: '9px 0',
                      borderBottom: `1px solid ${C.border1}`,
                      fontSize: 12,
                      lineHeight: 1.7,
                    },
                  },
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                    h(Pill, { color: C.brand }, row.kind || 'summary'),
                    h('span', { style: { ...muted, marginLeft: 'auto' } }, `${scopeLabel(row)} · ${fmtTime(row.ts)}`),
                  ),
                  h('div', { style: { marginTop: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, row.text),
                ),
              ),
        ),

        h(
          Section,
          { title: '记忆检索', hint: '只读原话' },
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('input', {
              value: query,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') search();
              },
              placeholder: '输入关键词，例如：烤鸭 / 生日 / 集合地点',
              style: {
                flex: '1 1 260px',
                minWidth: 220,
                padding: '8px 11px',
                borderRadius: 9,
                border: `1px solid ${C.border2}`,
                background: C.bg,
                color: C.text1,
                fontSize: 12.5,
                outline: 'none',
              },
            }),
            h(Btn, { onClick: search, disabled: searching || query.trim() === '' }, searching ? '检索中…' : '检索'),
          ),
          hits.length === 0
            ? null
            : h(
                'div',
                { style: { marginTop: 10 } },
                hits.map((row, index) =>
                  h(
                    'div',
                    {
                      key: `h${index}`,
                      style: {
                        padding: '8px 0',
                        borderBottom: `1px solid ${C.border1}`,
                        fontSize: 12,
                        lineHeight: 1.7,
                      },
                    },
                    h(
                      'div',
                      { style: { ...muted, display: 'flex', gap: 8, flexWrap: 'wrap' } },
                      h('span', null, `${row.role === 'assistant' ? 'AI' : row.speaker || '用户'} · ${scopeLabel(row)}`),
                      h('span', { style: { marginLeft: 'auto' } }, fmtTime(row.ts)),
                    ),
                    h('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, row.content),
                  ),
                ),
              ),
        ),

        h(
          'p',
          { style: { marginTop: 24, fontSize: 11, lineHeight: 1.8, color: C.text2, opacity: 0.85 } },
          '这里只展示记忆，不改写内容；数据库在本机，不上传。自动联通只交换事实、摘要、待确认和备注，不包含任何人设或角色设定。',
        ),
      );
    }

    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 44, label: () => '小肥鱼鲸鱼娘' },
          Icon,
        ),
      );
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel));
    }

    return { name: 'xiaofeiyu-whale', inject: ['slots'], apply };
  },
});
