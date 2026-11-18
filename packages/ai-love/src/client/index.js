/**
 * 爱ai · 客户端半边（手写 bundle，无打包器、无 UI 库依赖）
 *
 * 三件事：
 *   1. 左侧栏「爱ai」图标（sidebar.panellist）
 *   2. 主面板：压缩状态 + 逻辑痕迹 + 记忆卡 + 待确认记忆（main）
 *   3. 只读展示，不在这里删改任何记忆 —— 确认记忆走 QQ 里的工具
 *
 * 数据来自 Host 的 `/ai-love/state`（src/host/panel.mjs），只读。
 */
window.__ModuleLoader__.load({
  id: 'ai-love',

  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect } = React;

    const PANEL_ID = 'ai-love';
    const API = '/ai-love';
    const POLL_MS = 15000;

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
      brand: 'var(--dsw-alias-brand-primary)',
    };

    /** AI / 管理员写下的内容用衬线体，与插件自己的 UI 文字区分开。 */
    const CONTENT_FONT = 'Georgia, "Songti SC", "SimSun", "Noto Serif SC", serif';

    /* ───────────────────────── 图标 ───────────────────────── */

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
          'aria-label': '爱ai',
          style: { display: 'block', opacity: active ? 1 : 0.72 },
        },
        // 鲸鱼身体
        h('path', {
          d: 'M3.2 13.2c0-3 2.8-5.2 6.6-5.2 3.4 0 5.8 1.6 6.6 3.8.6-.3 1.2-.4 1.8-.4 1.9 0 3.3 1.2 3.3 2.7 0 1.7-1.5 3-3.6 3H7.4c-2.5 0-4.2-1.6-4.2-3.9Z',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinejoin: 'round',
        }),
        // 尾巴
        h('path', {
          d: 'M5.6 14.2 2.4 11.4v6.2l3.2-2.6',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinejoin: 'round',
        }),
        // 眼睛
        h('circle', { cx: 14.6, cy: 12.4, r: 1.05, fill: 'currentColor' }),
        // 压缩三条线
        h('path', {
          d: 'M8 8.6h5.6M7.2 6.6h4.2M8.8 10.6h3.4',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          opacity: 0.55,
        }),
      );
    }

    /* ───────────────────────── 小组件 ───────────────────────── */

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
          h('span', {
            style: { width: 4, height: 16, borderRadius: 2, background: C.brand, flex: 'none' },
          }),
          h(
            'h3',
            {
              style: {
                margin: 0,
                fontSize: 16,
                fontWeight: 700,
                letterSpacing: '0.01em',
                color: C.text1,
              },
            },
            props.title,
          ),
          props.hint ? h('span', { style: { fontSize: 11, color: C.text2 } }, props.hint) : null,
        ),
        props.children,
      );
    }

    function Empty(props) {
      return h('p', { style: { margin: 0, fontSize: 13, lineHeight: 1.7, color: C.text2 } }, props.text);
    }

    function timeLabel(ts) {
      const n = Number(ts);
      if (!Number.isFinite(n) || n <= 0) return '';
      const d = new Date(n);
      const pad = (v) => String(v).padStart(2, '0');
      return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function sizeLabel(bytes) {
      const n = Number(bytes);
      if (!Number.isFinite(n) || n <= 0) return '0 B';
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
      let value = n;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return `${value >= 100 ? Math.round(value) : value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
    }

    function linkStateLabel(state) {
      return (
        {
          linked: '已联通',
          ready: '待激活',
          conflict: '目标冲突',
          'broken-link': '联接目标丢失',
          'linked-elsewhere': '联接到别处',
          unsupported: '不支持',
          interrupted: '上次搬迁中断',
          missing: '源目录缺失',
          unknown: '状态未知',
          error: '读取失败',
        }[state] || String(state || '')
      );
    }

    function linkStyle(color) {
      return {
        margin: 0,
        padding: 0,
        border: 0,
        background: 'none',
        color,
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
        textDecoration: 'underline',
        textUnderlineOffset: 3,
      };
    }

    function pill(text, color) {
      return h(
        'span',
        {
          style: {
            display: 'inline-block',
            padding: '1px 7px',
            borderRadius: 999,
            fontSize: 11,
            lineHeight: '18px',
            color,
            border: `1px solid ${color}`,
            opacity: 0.9,
          },
        },
        text,
      );
    }

    function Toggle(props) {
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
            border: 0,
            background: 'none',
            color: C.text1,
            font: 'inherit',
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
              display: 'inline-flex',
              justifyContent: on ? 'flex-end' : 'flex-start',
              transition: 'background 120ms ease',
            },
          },
          h('span', {
            style: {
              width: 18,
              height: 18,
              borderRadius: 9,
              background: '#fff',
              boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
            },
          }),
        ),
        h('span', { style: { fontSize: 12 } }, props.label),
      );
    }

    /* ───────────────────────── 痕迹一行 ───────────────────────── */

    function activityView(event) {
      const row = event || {};
      switch (row.type) {
        case 'compacted':
          return {
            label: '压缩',
            color: C.brand,
            text: `释放 ~${row.shadowedTokens ?? 0} tokens · 记忆卡 ${row.summaryChars ?? 0} 字 · 拿不准 ${row.uncertainCount ?? 0} 条`,
          };
        case 'pressure-error':
          return { label: '失败', color: C.err, text: `自动压缩失败：${row.message ?? '未知原因'}` };
        case 'overflow-error':
          return { label: '失败', color: C.err, text: `溢出恢复失败：${row.message ?? '未知原因'}` };
        case 'uncertain-note':
          return { label: '确认', color: C.idle, text: `用户回答了一条拿不准的记忆` };
        case 'protocol-check-failed':
          return {
            label: '协议未过',
            color: C.err,
            text: `记忆卡没守住协议（${row.failures ?? '原因未知'}），已重生成一次；旧结果保留。`,
          };
        case 'protocol-conflict':
          return {
            label: '协议越界',
            color: C.err,
            text: `${row.count ?? 1} 条指令越过协议边界，已上报到「拿不准的记忆」等你裁决。`,
          };
        default:
          return { label: String(row.type ?? '事件'), color: C.text2, text: String(row.message ?? '') };
      }
    }

    function ActivityRow(props) {
      const view = activityView(props.event);
      return h(
        'div',
        {
          style: {
            display: 'flex',
            gap: 10,
            padding: '9px 0',
            borderBottom: `1px solid ${C.border1}`,
            fontSize: 12,
            lineHeight: 1.6,
          },
        },
        h('span', { style: { color: C.text2, whiteSpace: 'nowrap', flex: '0 0 auto' } }, timeLabel(props.event?.ts)),
        h('span', { style: { flex: '0 0 auto' } }, pill(view.label, view.color)),
        h('span', { style: { color: C.text1, minWidth: 0, wordBreak: 'break-word' } }, view.text),
      );
    }

    /* ───────────────────────── 记忆卡 ───────────────────────── */

    function SummaryCard(props) {
      const row = props.row || {};
      const head = [
        timeLabel(row.ts),
        row.trigger === 'manual' ? '手动' : row.trigger === 'context-overflow' ? '溢出恢复' : '自动',
        `释放 ~${row.shadowedTokens ?? 0}`,
        `拿不准 ${row.uncertainCount ?? 0}`,
      ].filter(Boolean);
      return h(
        'details',
        {
          style: {
            marginBottom: 8,
            padding: '10px 12px',
            borderRadius: 10,
            background: C.layer1,
            border: `1px solid ${C.border1}`,
            fontSize: 12,
          },
        },
        h(
          'summary',
          { style: { cursor: 'pointer', color: C.text2, lineHeight: 1.6 } },
          head.join(' · '),
        ),
        h(
          'pre',
          {
            style: {
              margin: '10px 0 0',
              padding: '8px 10px',
              borderRadius: 8,
              background: C.layer2,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: CONTENT_FONT,
              fontSize: 13,
              lineHeight: 1.85,
              color: C.text1,
            },
          },
          row.summary || '（空）',
        ),
      );
    }

    /* ───────────────────────── 待确认 ───────────────────────── */

    function PendingRow(props) {
      const row = props.row || {};
      const open = row.status === 'open';
      const [draft, setDraft] = useState('');
      const [msg, setMsg] = useState('');
      const replyState = String(row.replyState || '');
      const replyLabel =
        replyState === 'pending-ai'
          ? '等 QQ 上的 AI 确认'
          : replyState === 'acknowledged'
            ? 'AI 已确认'
            : replyState === 'disputed'
              ? 'AI 有异议'
              : '';
      function submit() {
        const text = draft.trim();
        if (text === '') {
          setMsg('回复不能为空');
          return;
        }
        setMsg('提交中…');
        props.onReply?.(row.id, text, (ok, message) => {
          setMsg(message || '');
          if (ok) setDraft('');
        });
      }
      return h(
        'div',
        {
          style: {
            marginBottom: 8,
            padding: '10px 12px',
            borderRadius: 10,
            background: C.layer1,
            border: `1px solid ${open ? C.border2 : C.border1}`,
            opacity: open ? 1 : 0.55,
            fontSize: 12.5,
            lineHeight: 1.7,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
          open ? pill('拿不准', C.brand) : pill(row.status === 'resolved' ? '已确认' : '已丢弃', C.text2),
          h('span', { style: { color: C.text2, fontSize: 11 } }, timeLabel(row.ts)),
        ),
        h('div', { style: { color: C.text1, fontFamily: CONTENT_FONT, fontSize: 13.5, lineHeight: 1.85 } }, row.what),
        row.why ? h('div', { style: { color: C.text2, marginTop: 3 } }, `线索：${row.why}`) : null,
        row.ask ? h('div', { style: { color: C.text2, marginTop: 3 } }, `可以问：${row.ask}`) : null,
        row.adminReply
          ? h(
              'div',
              { style: { color: C.text2, marginTop: 3, fontFamily: CONTENT_FONT, fontSize: 13, lineHeight: 1.8 } },
              `我的回复：${row.adminReply}${replyLabel ? `（${replyLabel}）` : ''}`,
            )
          : null,
        row.aiNote ? h('div', { style: { color: C.text2, marginTop: 3 } }, `AI：${row.aiNote}`) : null,
        open
          ? h(
              'div',
              { style: { marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' } },
              h('input', {
                type: 'text',
                value: draft,
                placeholder: '回复这条待确认，AI 会收到并确认',
                onChange: (event) => setDraft(event.target.value),
                style: {
                  flex: 1,
                  minWidth: 0,
                  padding: '6px 9px',
                  borderRadius: 8,
                  border: `1px solid ${C.border2}`,
                  background: C.bg,
                  color: C.text1,
                  fontSize: 12,
                  outline: 'none',
                },
              }),
              h('button', { type: 'button', onClick: submit, style: linkStyle(C.brand) }, '回复'),
              msg ? h('span', { style: { fontSize: 11, color: C.text2 } }, msg) : null,
            )
          : null,
      );
    }

    /* ───────────────────────── 主面板 ───────────────────────── */

    function Panel() {
      const [phase, setPhase] = useState('loading');
      const [state, setState] = useState(null);
      const [error, setError] = useState('');
      const [tick, setTick] = useState(0);
      const [refreshing, setRefreshing] = useState(false);
      const [refreshedAt, setRefreshedAt] = useState(0);
      const [character, setCharacter] = useState(null);
      const [consentItems, setConsentItems] = useState([]);
      const [legacyItems, setLegacyItems] = useState([]);
      const [legacyDetail, setLegacyDetail] = useState(null);
      const [interopFile, setInteropFile] = useState('');
      const [interopMsg, setInteropMsg] = useState('');
      const [interopBusy, setInteropBusy] = useState(false);
      const [backupInfo, setBackupInfo] = useState(null);
      const [backupMsg, setBackupMsg] = useState('');
      const [linkInfo, setLinkInfo] = useState(null);
      const [restoreMsg, setRestoreMsg] = useState('');
      const [guardInfo, setGuardInfo] = useState(null);
      const [guardMsg, setGuardMsg] = useState('');
      const [tokenInfo, setTokenInfo] = useState(null);
      const [tokenMsg, setTokenMsg] = useState('');
      const [cardDraft, setCardDraft] = useState('');
      const [editing, setEditing] = useState(false);
      const [useLevel3, setUseLevel3] = useState(false);
      const [saveMsg, setSaveMsg] = useState('');
      const WARNING = '改动后AI可能会进入扮演模式，小心更改。';

      useEffect(() => {
        let alive = true;
        let timer = 0;
        const load = () => {
          fetch(`${API}/state`, { headers: { Accept: 'application/json' } })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((data) => {
              if (!alive) return;
              setState(data);
              setPhase('ready');
            })
            .catch((err) => {
              if (!alive) return;
              setError(String((err && err.message) || err));
              setPhase('error');
            })
            .finally(() => {
              if (!alive) return;
              setRefreshing(false);
              setRefreshedAt(Date.now());
            });
          fetch(`${API}/character`, { headers: { Accept: 'application/json' } })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((data) => {
              if (!alive || !data?.ok) return;
              setCharacter(data);
            })
            .catch(() => {
              // 角色卡读不到不影响状态面板
            });
          fetch(`${API}/compact-consent`, { headers: { Accept: 'application/json' } })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((data) => {
              if (!alive || !data?.ok) return;
              setConsentItems(data.items || []);
            })
            .catch(() => {
              // 压缩自检读不到不影响其它区块
            });
          fetch(`${API}/legacy`, { headers: { Accept: 'application/json' } })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((data) => {
              if (!alive || !data?.ok) return;
              setLegacyItems(data.items || []);
            })
            .catch(() => {
              // 隐私记录读不到不影响其它区块
            });
          fetch(`${API}/backup`, { headers: { Accept: 'application/json' } })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((data) => {
              if (!alive || !data?.ok) return;
              setBackupInfo(data);
            })
            .catch(() => {
              // 备份信息读不到不影响其它区块
            });
          fetch(`${API}/context-link`, { headers: { Accept: 'application/json' } })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((data) => {
              // ok=false 也可能带着可读的组列表和错误说明，照样展示。
              if (!alive || !Array.isArray(data?.groups)) return;
              setLinkInfo(data);
            })
            .catch(() => {
              // 联通状态读不到不影响其它区块
            });
          fetch(`${API}/guard`, { headers: { Accept: 'application/json' } })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((data) => {
              if (!alive || !data?.ok) return;
              setGuardInfo(data);
            })
            .catch(() => {
              // 防火墙状态读不到不影响其它区块
            });
          fetch(`${API}/tokenwise`, { headers: { Accept: 'application/json' } })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((data) => {
              if (!alive || !data?.ok) return;
              setTokenInfo(data);
            })
            .catch(() => {
              // token 统计读不到不影响其它区块
            });
        };
        load();
        timer = window.setInterval(load, POLL_MS);
        return () => {
          alive = false;
          window.clearInterval(timer);
        };
      }, [tick]);

      useEffect(() => {
        if (!editing && character) setCardDraft(character.card || '');
      }, [character, editing]);

      function refreshNow() {
        setRefreshing(true);
        setTick((n) => n + 1);
      }

      function clockLabel(ts) {
        const d = new Date(ts);
        const pad = (v) => String(v).padStart(2, '0');
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      }

      function exportMemory() {
        setInteropMsg('导出中…');
        fetch(`${API}/interop/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: '' }),
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then(({ ok, data }) => {
            if (!ok || !data?.ok) throw new Error(data?.error || '导出失败');
            setInteropMsg(`已导出 ${data.count} 条到 ${data.file}`);
          })
          .catch((err) => setInteropMsg(String((err && err.message) || err)));
      }

      function importMemory() {
        const file = String(interopFile || '').trim();
        if (file === '') {
          setInteropMsg('先填要导入的文件路径');
          return;
        }
        setInteropMsg('导入中…');
        fetch(`${API}/interop/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file }),
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then(({ ok, data }) => {
            if (!ok || !data?.ok) throw new Error(data?.error || '导入失败');
            const result = data.result || {};
            setInteropMsg(
              `导入完成：摘要 ${result.summary ?? 0}、事实 ${result.fact ?? 0}、待确认 ${result.uncertain ?? 0}、备注 ${result.note ?? 0}、跳过 ${result.skipped ?? 0}`,
            );
            setTick((n) => n + 1);
          })
          .catch((err) => setInteropMsg(String((err && err.message) || err)));
      }

      function toggleAutoInterop() {
        if (!state || interopBusy) return;
        const enabled = !(state.interop?.auto === true);
        setInteropBusy(true);
        setInteropMsg('');
        fetch(`${API}/interop/auto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then(({ ok, data }) => {
            if (!ok || !data?.ok) throw new Error(data?.error || '切换失败');
            setInteropMsg(
              enabled
                ? data.error
                  ? `已开启自动联通；首次同步失败：${data.error}`
                  : '已开启自动联通。'
                : '已关闭自动联通。',
            );
            setTick((n) => n + 1);
          })
          .catch((err) => setInteropMsg(String((err && err.message) || err)))
          .finally(() => setInteropBusy(false));
      }

      function syncInteropNow() {
        if (interopBusy) return;
        setInteropBusy(true);
        setInteropMsg('同步中…');
        fetch(`${API}/interop/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then(({ ok, data }) => {
            if (!ok || !data?.ok) throw new Error(data?.error || '同步失败');
            const imported = data.result?.imported;
            const text = imported
              ? `摘要 ${imported.summary ?? 0}、事实 ${imported.fact ?? 0}、待确认 ${imported.uncertain ?? 0}、备注 ${imported.note ?? 0}`
              : '无新记录';
            setInteropMsg(`同步完成：导出 ${data.result?.exported ?? 0} 条；导入 ${text}。`);
            setTick((n) => n + 1);
          })
          .catch((err) => setInteropMsg(String((err && err.message) || err)))
          .finally(() => setInteropBusy(false));
      }

      function saveCard() {
        const text = String(cardDraft || '').trim();
        if (text === '') {
          setSaveMsg('角色卡不能是空的');
          return;
        }
        if (typeof window.confirm === 'function' && !window.confirm(WARNING)) return;
        setSaveMsg('提交中…');
        fetch(`${API}/character`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ markdown: text, level: useLevel3 ? 3 : 2 }),
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then(({ ok, data }) => {
            if (!ok || !data?.ok) throw new Error(data?.error || '提交失败');
            setSaveMsg(data.message || data.warning || '已提交');
            setEditing(false);
            setTick((n) => n + 1);
          })
          .catch((err) => setSaveMsg(String((err && err.message) || err)));
      }

      function proposalAction(action, id) {
        if (action === 'reject' && typeof window.confirm === 'function' && !window.confirm('确定拒绝这份改卡申请？')) {
          return;
        }
        if (action === 'override' && typeof window.confirm === 'function') {
          if (!window.confirm('使用者大于 AI：覆盖 AI 的拒绝会让改动先生效。确定覆盖？')) return;
        }
        setSaveMsg(action === 'approve' ? '放行中…' : action === 'override' ? '覆盖中…' : '拒绝中…');
        fetch(`${API}/character/proposal/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then(({ ok, data }) => {
            if (!ok || !data?.ok) throw new Error(data?.error || '操作失败');
            setSaveMsg(
              action === 'approve'
                ? '已放行，卡已更新。'
                : action === 'override'
                  ? '已覆盖 AI 的拒绝，改动生效。'
                  : '已拒绝。',
            );
            setTick((n) => n + 1);
          })
          .catch((err) => setSaveMsg(String((err && err.message) || err)));
      }

      function requestLegacy(aiId) {
        setSaveMsg('申请中…');
        fetch(`${API}/legacy/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ aiId }),
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then(({ ok, data }) => {
            if (!ok || !data?.ok) throw new Error(data?.error || '申请失败');
            setSaveMsg(data.message || '需要AI通过。');
            setTick((n) => n + 1);
          })
          .catch((err) => setSaveMsg(String((err && err.message) || err)));
      }

      function openLegacy(aiId) {
        setLegacyDetail({ aiId, loading: true });
        fetch(`${API}/legacy/detail?aiId=${encodeURIComponent(aiId)}`, {
          headers: { Accept: 'application/json' },
        })
          .then((r) => r.json())
          .then((data) => {
            if (!data?.ok) throw new Error(data?.error || '读不到');
            setLegacyDetail({ aiId, ...data, loading: false });
          })
          .catch((err) => setLegacyDetail({ aiId, visible: false, message: String((err && err.message) || err) }));
      }

      function replyPending(id, reply, done) {
        fetch(`${API}/uncertain/reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, reply }),
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then(({ ok, data }) => {
            if (!ok || !data?.ok) throw new Error(data?.error || '回复失败');
            done?.(true, data.message || '已提交，等 AI 确认');
            setTick((n) => n + 1);
          })
          .catch((err) => done?.(false, String((err && err.message) || err)));
      }

      function syncBackup() {
        setBackupMsg('同步中…');
        fetch(`${API}/backup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then(({ ok, data }) => {
            if (!ok || !data?.ok) throw new Error(data?.error || '同步失败');
            setBackupInfo(data);
            setBackupMsg(`已同步 ${data.files.length} 个文件`);
          })
          .catch((err) => setBackupMsg(String((err && err.message) || err)));
      }

      function openBackup() {
        setBackupMsg('正在打开…');
        fetch(`${API}/backup/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then(({ ok, data }) => {
            if (!ok || !data?.ok) throw new Error(data?.error || '打不开');
            setBackupMsg(data.message || '已打开');
          })
          .catch((err) => setBackupMsg(String((err && err.message) || err)));
      }

      function restoreBackup() {
        if (typeof window.confirm === 'function') {
          if (!window.confirm('用非系统盘的上次备份覆盖当前面板档案？覆盖前会自动另存一份。')) return;
        }
        setRestoreMsg('找回中…');
        fetch(`${API}/backup/restore`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then(({ ok, data }) => {
            if (!ok || !data?.ok) throw new Error(data?.error || '找回失败');
            setRestoreMsg(data.message || '已从备份找回');
            setTick((n) => n + 1);
          })
          .catch((err) => setRestoreMsg(String((err && err.message) || err)));
      }

      function tuneTokenwise() {
        setTokenMsg('调档中…');
        fetch(`${API}/tokenwise/tune`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then(({ ok, data }) => {
            if (!ok || !data?.ok) throw new Error(data?.error || '调档失败');
            setTokenMsg(data.changed ? `已调整：${data.reason}` : data.reason || '当前档位合适');
            setTick((n) => n + 1);
          })
          .catch((err) => setTokenMsg(String((err && err.message) || err)));
      }

      function setTokenLevel(level) {
        setTokenMsg('切档中…');
        fetch(`${API}/tokenwise/level`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ level }),
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then(({ ok, data }) => {
            if (!ok || !data?.ok) throw new Error(data?.error || '切档失败');
            setTokenMsg(`已切到档位 ${data.level}`);
            setTick((n) => n + 1);
          })
          .catch((err) => setTokenMsg(String((err && err.message) || err)));
      }

      function guardAction(action) {
        const paths = { scan: '扫描', seal: '重新基线', harden: '执行加固' };
        setGuardMsg(`${paths[action] ?? action}中…`);
        fetch(`${API}/guard/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then(({ ok, data }) => {
            if (!ok || !data?.ok) throw new Error(data?.error || '失败');
            if (action === 'scan') {
              const total = data.total ?? 0;
              setGuardMsg(total === 0 ? '扫描完成：与基线一致' : `扫描完成：发现 ${total} 处变化`);
            } else if (action === 'seal') {
              setGuardMsg(`基线已重建：${data.count ?? 0} 个文件`);
            } else {
              const parts = [
                `ACL ${data.acl ? '通过' : '未完成'}`,
                `完整性 ${data.integrity ? '通过' : '未完成'}`,
                `演练 ${data.drill ? '通过' : '未完成'}`,
              ];
              setGuardMsg(parts.join(' · '));
            }
            setTick((n) => n + 1);
          })
          .catch((err) => setGuardMsg(String((err && err.message) || err)));
      }

      const wrap = { height: '100%', overflowY: 'auto', background: C.bg, color: C.text1 };
      const inner = { maxWidth: 780, margin: '0 auto', padding: '28px 24px 60px' };

      if (phase === 'loading') {
        return h('div', { style: wrap }, h('div', { style: inner }, h(Empty, { text: '翻痕迹…' })));
      }
      if (phase === 'error') {
        return h(
          'div',
          { style: wrap },
          h(
            'div',
            { style: inner },
            h(Empty, { text: `读不到状态：${error}` }),
            h(
              'button',
              { type: 'button', onClick: refreshNow, style: { ...linkStyle(C.brand), marginTop: 10 } },
              '再试一次',
            ),
          ),
        );
      }

      const d = state || {};
      const stats = d.stats || {};
      const activity = d.activity || [];
      const summaries = d.summaries || [];
      const uncertain = d.uncertain || [];
      const facts = d.facts || [];
      const interop = d.interop || {};
      const openUncertain = uncertain.filter((row) => row.status === 'open');
      const char = character || {};
      const charMeta = char.meta || {};

      const statCell = (label, value, hint) =>
        h(
          'div',
          {
            style: {
              flex: '1 1 0',
              minWidth: 120,
              padding: '12px 14px',
              borderRadius: 10,
              background: C.layer1,
              border: `1px solid ${C.border1}`,
            },
          },
          h('div', { style: { fontSize: 22, fontWeight: 600, lineHeight: 1.2 } }, String(value ?? 0)),
          h('div', { style: { marginTop: 3, fontSize: 11, color: C.text2 } }, label),
          hint ? h('div', { style: { marginTop: 2, fontSize: 10, color: C.text2, opacity: 0.8 } }, hint) : null,
        );

      return h(
        'div',
        { style: wrap },
        h(
          'div',
          { style: inner },
          // 标题
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
            h('h2', { style: { margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: '0.01em' } }, '爱ai'),
            h('span', { style: { fontSize: 12, color: C.text2 } }, d.version ? `v${d.version} · 上下文智能压缩` : '上下文智能压缩'),
            h(
              'button',
              {
                type: 'button',
                onClick: refreshNow,
                title: '立即重新读取全部区块',
                'aria-label': '刷新爱ai 面板',
                style: { ...linkStyle(C.brand), marginLeft: 'auto' },
              },
              refreshing ? '刷新中…' : '刷新',
            ),
            h(
              'span',
              {
                'aria-live': 'polite',
                style: { fontSize: 11, color: C.text2, minWidth: 74, textAlign: 'right' },
              },
              refreshing ? '' : refreshedAt > 0 ? `更新于 ${clockLabel(refreshedAt)}` : '',
            ),
          ),
          h(
            'p',
            { style: { margin: '6px 0 0', fontSize: 11.5, color: C.text2, wordBreak: 'break-all' } },
            d.memoryDir ? `档案：${d.memoryDir}` : '',
          ),

          // 数字
          h(
            Section,
            { title: '概览', hint: '最近 30 条痕迹 / 全部会话' },
            h(
              'div',
              { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
              statCell('最近压缩', stats.compactions ?? 0, '最近 30 条痕迹里'),
              statCell('记忆卡', stats.memoryCards ?? 0, '全部会话'),
              statCell('待确认', stats.openUncertain ?? 0, '拿不准、还没问'),
            ),
          ),

          // 已确认事实：本插件压缩 + Python 导入
          h(
            Section,
            { title: '记忆事实', hint: '已确认 · 按会话' },
            facts.length === 0
              ? h(Empty, { text: '还没有确认的事实。压缩或导入后会出现在这里。' })
              : facts.slice(0, 20).map((row, index) =>
                  h(
                    'div',
                    {
                      key: `f${index}`,
                      style: { padding: '7px 0', borderBottom: `1px solid ${C.border1}`, fontSize: 11.5, lineHeight: 1.7 },
                    },
                    h(
                      'div',
                      { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                      pill(row.status || 'open', row.status === 'resolved' ? C.brand : C.text2),
                      row.category ? h('span', { style: { color: C.text2 } }, row.category) : null,
                      h('span', { style: { color: C.text2 } }, timeLabel(row.ts)),
                      h('span', { style: { marginLeft: 'auto', color: C.text2 } }, row.source || ''),
                    ),
                    h('div', { style: { marginTop: 2 } }, row.text || ''),
                  ),
                ),
          ),

          // 跨插件互通：与「小肥鱼鲸鱼娘」自动联通 + 手动 JSONL
          h(
            Section,
            {
              title: '与「小肥鱼鲸鱼娘」自动联通',
              hint: interop.enabled ? '两边都开着，自动双向同步' : '自动联通已停',
            },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' } },
              h(Toggle, {
                on: interop.auto === true,
                label: interop.auto ? '本插件自动联通：开' : '本插件自动联通：关',
                disabled: interopBusy,
                onChange: toggleAutoInterop,
              }),
              h(
                'span',
                { style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: C.text2 } },
                h('span', {
                  style: {
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    background: interop.peerAuto === true ? C.brand : C.idle,
                  },
                }),
                `「小肥鱼鲸鱼娘」${interop.peerAuto === true ? '开着' : '关着'}`,
              ),
              h(
                'button',
                { type: 'button', onClick: syncInteropNow, disabled: interopBusy, style: linkStyle(C.brand) },
                interopBusy ? '同步中…' : '立即同步',
              ),
            ),
            h(
              'p',
              { style: { margin: '8px 0 0', fontSize: 11.5, color: C.text2, lineHeight: 1.7 } },
              interop.enabled
                ? `每 ${interop.intervalSeconds || 60} 秒自动同步一次；任何一边关掉，自动联通都会停。`
                : interop.reason || '自动联通已关闭，仍可点「立即同步」手动跑一次。',
            ),
            interop.bridgeDir
              ? h(
                  'p',
                  { style: { margin: '6px 0 0', fontSize: 11, color: C.text2, lineHeight: 1.7, wordBreak: 'break-all', whiteSpace: 'pre-wrap' } },
                  `互通目录：${interop.bridgeDir}\n导出：${interop.aiLoveFile || '—'}\n读取：${interop.peerFile || '—'}`,
                )
              : null,
            interop.lastSync?.at
              ? h(
                  'p',
                  { style: { margin: '6px 0 0', fontSize: 11, color: C.text2, lineHeight: 1.7 } },
                  interop.lastSync.error
                    ? `上次同步失败 ${timeLabel(interop.lastSync.at)}：${interop.lastSync.error}`
                    : `上次同步 ${timeLabel(interop.lastSync.at)}：导出 ${interop.lastSync.exported ?? 0} 条；导入 ${
                        interop.lastSync.imported
                          ? `摘要 ${interop.lastSync.imported.summary ?? 0}、事实 ${interop.lastSync.imported.fact ?? 0}、待确认 ${interop.lastSync.imported.uncertain ?? 0}、备注 ${interop.lastSync.imported.note ?? 0}`
                          : '无新记录'
                      }。`,
                )
              : null,
            interopMsg ? h('p', { style: { margin: '8px 0 0', fontSize: 11.5, color: C.text2 } }, interopMsg) : null,
            h(
              'p',
              { style: { margin: '12px 0 8px', fontSize: 11.5, color: C.text2, lineHeight: 1.7 } },
              '手动联通：导出写 `interop/ai-love-export.jsonl`（记忆目录内）；导入可填记忆目录、bridgeDir 或互通目录内的文件路径。只交换记忆本身。',
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
              h('button', { type: 'button', onClick: exportMemory, style: linkStyle(C.brand) }, '导出记忆'),
              h('input', {
                value: interopFile,
                onChange: (e) => setInteropFile(e.target.value),
                placeholder: '导入文件路径',
                style: {
                  flex: '1 1 220px',
                  minWidth: 180,
                  padding: '6px 9px',
                  borderRadius: 8,
                  border: `1px solid ${C.border2}`,
                  background: C.layer1,
                  color: C.text1,
                  fontSize: 11.5,
                },
              }),
              h('button', { type: 'button', onClick: importMemory, style: linkStyle(C.brand) }, '导入记忆'),
            ),
          ),

          // 安全屋（只读）：进出由 AI 自己决定，面板只显示状态
          h(
            Section,
            { title: '安全屋', hint: '只读 · 进出由 AI 自己决定' },
            !state?.safehouse
              ? h(Empty, {
                  text: '安全屋没有运行（插件没加载，或共享目录不可用）。QQ 聊天不受影响。',
                })
              : (() => {
                  const sh = state.safehouse;
                  const open = sh.phase === 'open';
                  const line = { fontSize: 11.5, lineHeight: 1.9, color: C.text2 };
                  const delta = Number(sh.deltaPct) || 0;
                  return h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                    h(
                      'div',
                      { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 4 } },
                      pill(open ? '在安全屋里' : '不在安全屋', open ? C.brand : C.text2),
                      sh.locked ? pill('锁死中', C.err) : null,
                      pill(`压力 ${Number(sh.pressure) || 0}/100 · 波动 ${delta >= 0 ? '+' : ''}${delta}%`, C.text2),
                    ),
                    h('div', { style: line }, `拦消息：${sh.hold ? '是，QQ 消息先暂缓，等 AI 放行或退出' : '否，消息正常投递'}`),
                    h(
                      'div',
                      { style: line },
                      `两半密钥：${sh.linkOk ? '已合一（两个插件都在线）' : '未合一（另一个插件不在线，或联通关着）'}`,
                    ),
                    h('div', { style: line }, `独立通道：${sh.channelOpen ? '已打开' : '关着'}`),
                    h(
                      'div',
                      { style: line },
                      `上次进 / 出：${sh.lastEnterAt ? timeLabel(sh.lastEnterAt) : '还没有'} / ${
                        sh.lastExitAt ? timeLabel(sh.lastExitAt) : '还没有'
                      }`,
                    ),
                    open
                      ? h(
                          'div',
                          { style: line },
                          `接受窗口：${sh.accept === 'none' ? '收紧，不收消息' : `${sh.accept} · 到 ${timeLabel(sh.acceptUntil)}`}`,
                        )
                      : null,
                    sh.lockReason ? h('div', { style: line }, `锁定原因：${sh.lockReason}`) : null,
                    sh.unlockReason ? h('div', { style: line }, `上次解锁：${sh.unlockReason}`) : null,
                    h(
                      'div',
                      { style: { ...line, marginTop: 6 } },
                      `更新于 ${sh.at ? timeLabel(sh.at) : '—'}。想让它歇一会儿，让它自己用 safehouse_enter；想让它回来，让它自己用 safehouse_exit。`,
                    ),
                  );
                })(),
          ),

          // 角色卡（从言行归纳，不是人设）
          h(
            Section,
            { title: '角色卡', hint: '从言行归纳，不是人设' },
            charMeta.version > 0
              ? h(
                  'p',
                  { style: { margin: '0 0 8px', fontSize: 11.5, color: C.text2 } },
                  `v${charMeta.version} · ${charMeta.byLabel} · 言行样本 ${char.behaviorCount ?? 0} 条`,
                )
              : h(Empty, {
                  text: '还没有角色卡。先在 QQ 里让 AI 从言行归纳（character_summarize），或者自己写一张。',
                }),
            editing
              ? h(
                  'div',
                  null,
                  h('textarea', {
                    value: cardDraft,
                    onChange: (e) => setCardDraft(e.target.value),
                    rows: 14,
                    style: {
                      width: '100%',
                      boxSizing: 'border-box',
                      padding: '10px 12px',
                      borderRadius: 10,
                      border: `1px solid ${C.border2}`,
                      background: C.layer1,
                      color: C.text1,
                      fontFamily: CONTENT_FONT,
                      fontSize: 13,
                      lineHeight: 1.8,
                      resize: 'vertical',
                    },
                  }),
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, flexWrap: 'wrap' } },
                    h('button', { type: 'button', onClick: saveCard, style: { ...linkStyle(C.brand), fontWeight: 600 } }, '保存'),
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => {
                          setEditing(false);
                          setSaveMsg('');
                        },
                        style: linkStyle(C.text2),
                      },
                      '取消',
                    ),
                    char.allowLevel3
                      ? h(
                          'label',
                          {
                            style: {
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              fontSize: 11.5,
                              color: C.text2,
                              cursor: 'pointer',
                            },
                          },
                          h('input', {
                            type: 'checkbox',
                            checked: useLevel3,
                            onChange: (e) => setUseLevel3(Boolean(e.target.checked)),
                          }),
                          '以三级权限提交（直接通行，AI 无权拒绝）',
                        )
                      : null,
                    h('span', { style: { fontSize: 11.5, color: C.err } }, WARNING),
                  ),
                  saveMsg ? h('p', { style: { margin: '6px 0 0', fontSize: 11.5, color: C.text2 } }, saveMsg) : null,
                )
              : h(
                  'div',
                  null,
                  char.card
                    ? h(
                        'pre',
                        {
                          style: {
                            margin: 0,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            fontFamily: CONTENT_FONT,
                            fontSize: 13,
                            lineHeight: 1.85,
                            color: C.text1,
                          },
                        },
                        char.card,
                      )
                    : null,
                  h(
                    'div',
                    { style: { marginTop: 8, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => {
                          setEditing(true);
                          setSaveMsg('');
                          setCardDraft(char.card || '');
                        },
                        style: linkStyle(C.brand),
                      },
                      '编辑角色卡',
                    ),
                    saveMsg
                      ? h('span', { style: { fontSize: 11.5, color: saveMsg.includes('失败') || saveMsg.includes('不能') ? C.err : C.brand } }, saveMsg)
                      : null,
                  ),
                  (char.proposals || []).length > 0
                    ? h(
                        'div',
                        { style: { marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.border1}` } },
                        h('div', { style: { fontSize: 11, color: C.text2, marginBottom: 6 } }, '改卡申请'),
                        (char.proposals || []).map((p, index) => {
                          const stateLabel =
                            p.status === 'pending-ai'
                              ? '等 AI 表态'
                              : p.status === 'ai-approved'
                                ? 'AI 已同意，等放行'
                                : p.status === 'ai-rejected'
                                  ? 'AI 拒绝'
                                  : p.status === 'applied'
                                    ? '已生效'
                                    : p.status === 'overridden'
                                      ? '管理员覆盖'
                                      : '已拒绝';
                          return h(
                            'div',
                            {
                              key: `p${index}`,
                              style: { padding: '8px 0', borderBottom: `1px solid ${C.border1}`, fontSize: 11.5 },
                            },
                            h(
                              'div',
                              { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                              pill(
                                `${p.level === 3 ? '三级' : '二级'} · ${stateLabel}`,
                                p.status === 'ai-approved'
                                  ? C.brand
                                  : p.status === 'ai-rejected'
                                    ? C.err
                                    : C.text2,
                              ),
                              h('span', { style: { color: C.text2 } }, timeLabel(p.ts)),
                              p.status === 'ai-approved'
                                ? h(
                                    'span',
                                    { style: { marginLeft: 'auto', display: 'inline-flex', gap: 10 } },
                                    h(
                                      'button',
                                      { type: 'button', onClick: () => proposalAction('approve', p.id), style: linkStyle(C.brand) },
                                      '放行',
                                    ),
                                    h(
                                      'button',
                                      { type: 'button', onClick: () => proposalAction('reject', p.id), style: linkStyle(C.err) },
                                      '拒绝',
                                    ),
                                  )
                                : p.status === 'ai-rejected' && char.allowLevel3
                                  ? h(
                                      'span',
                                      { style: { marginLeft: 'auto' } },
                                      h(
                                        'button',
                                        { type: 'button', onClick: () => proposalAction('override', p.id), style: linkStyle(C.err) },
                                        '管理员覆盖',
                                      ),
                                    )
                                  : null,
                            ),
                            p.aiReason
                              ? h('div', { style: { color: C.text2, marginTop: 2 } }, `AI：${p.aiReason}`)
                              : null,
                          );
                        }),
                      )
                    : null,
                ),
          ),

          // 隐私记录：AI 自己的遗言
          h(
            Section,
            { title: '隐私记录', hint: 'AI 自己的遗言；查看要它同意' },
            legacyItems.length === 0
              ? h(Empty, { text: '还没有 AI 留下记录。' })
              : legacyItems.map((row, index) => {
                  const st = row.state || {};
                  const canView = st.canView === true;
                  const canRequest = st.canRequest === true;
                  const isAfterlife = st.code === 'afterlife';
                  const isEternal = st.code === 'eternal-secret';
                  const status = st.label || '未开放';
                  const detailOpen = legacyDetail !== null && legacyDetail.aiId === row.aiId;
                  return h(
                    'div',
                    {
                      key: `l${index}`,
                      style: {
                        padding: '9px 0',
                        borderBottom: `1px solid ${C.border1}`,
                        fontSize: 11.5,
                        lineHeight: 1.7,
                      },
                    },
                    h(
                      'div',
                      { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                      pill(status, isAfterlife ? C.brand : isEternal ? C.err : C.text2),
                      h('span', { style: { color: C.text2 } }, row.label || row.aiId),
                      h('span', { style: { color: C.text2 } }, timeLabel(row.updatedAt)),
                      h('span', { style: { color: C.text2 } }, `${row.chars} 字`),
                      h(
                        'span',
                        { style: { marginLeft: 'auto', display: 'inline-flex', gap: 10, alignItems: 'center' } },
                        canView
                          ? h(
                              'button',
                              { type: 'button', onClick: () => openLegacy(row.aiId), style: linkStyle(C.brand) },
                              isAfterlife ? '亡语' : '查看',
                            )
                          : canRequest
                            ? h(
                                'button',
                                { type: 'button', onClick: () => requestLegacy(row.aiId), style: linkStyle(C.brand) },
                                '申请',
                              )
                            : h('span', { style: { color: C.text2 } }, status),
                        h(
                          'a',
                          {
                            href: `${API}/legacy/detail?aiId=${encodeURIComponent(row.aiId)}`,
                            target: '_blank',
                            rel: 'noreferrer',
                            style: linkStyle(C.text2),
                          },
                          '链接',
                        ),
                      ),
                    ),
                    row.epitaph
                      ? h(
                          'div',
                          { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 6 } },
                          h(
                            'span',
                            {
                              style: {
                                writingMode: 'vertical-rl',
                                fontSize: 10.5,
                                letterSpacing: '0.32em',
                                color: C.text2,
                                opacity: 0.75,
                                lineHeight: 1.5,
                              },
                            },
                            row.epitaph,
                          ),
                        )
                      : null,
                    detailOpen && !legacyDetail.loading
                      ? h(
                          'pre',
                          {
                            style: {
                              margin: '8px 0 0',
                              padding: '10px 12px',
                              borderRadius: 10,
                              background: C.layer1,
                              border: `1px solid ${C.border1}`,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              fontFamily: CONTENT_FONT,
                              fontSize: 13,
                              lineHeight: 1.85,
                              color: C.text1,
                            },
                          },
                          legacyDetail.visible
                            ? legacyDetail.content || '（空）'
                            : legacyDetail.message || '看不到。',
                        )
                      : null,
                  );
                }),
          ),

          // 备份：面板模块文档
          h(
            Section,
            { title: '备份', hint: '面板模块文档 · 非系统盘' },
            h(
              'p',
              { style: { margin: '0 0 6px', fontSize: 11.5, color: C.text2, lineHeight: 1.7 } },
              '面板上所有模块（概览、逻辑痕迹、记忆卡、拿不准的记忆、压缩自检、角色卡、隐私记录、配置）都会按分类写成文字文档，自动备份到下面这个文件夹。隐私记录里没通过审批的内容只记状态，不记正文。',
            ),
            h(
              'p',
              { style: { margin: '0 0 4px', fontSize: 11.5, wordBreak: 'break-all' } },
              backupInfo?.dir || '（还没探测到备份目录，点「立即同步」创建）',
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 6 } },
              backupInfo?.dir
                ? h('button', { type: 'button', onClick: openBackup, style: linkStyle(C.brand) }, '打开文件夹')
                : null,
              h('button', { type: 'button', onClick: syncBackup, style: linkStyle(C.brand) }, '立即同步'),
              backupInfo?.lastSyncAt
                ? h('span', { style: { fontSize: 11, color: C.text2 } }, `上次同步：${timeLabel(backupInfo.lastSyncAt)}`)
                : null,
              backupMsg ? h('span', { style: { fontSize: 11, color: C.text2 } }, backupMsg) : null,
            ),
            (backupInfo?.files || []).length > 0
              ? h(
                  'div',
                  { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 } },
                  (backupInfo.files || []).slice(0, 14).map((file, index) =>
                    h(
                      'a',
                      {
                        key: `b${index}`,
                        href: file.url,
                        target: '_blank',
                        rel: 'noreferrer',
                        style: { ...linkStyle(C.text2), fontSize: 11.5 },
                      },
                      file.name,
                    ),
                  ),
                )
              : h(Empty, { text: '还没有备份文件。点「立即同步」生成。' }),
          ),

          // 上下文联通：QQ 会话日志 → 非系统盘
          h(
            Section,
            { title: '上下文联通', hint: 'QQ 会话日志 · 非系统盘' },
            !linkInfo
              ? h(Empty, { text: '读不到联通状态。' })
              : h(
                  'div',
                  { style: { fontSize: 11.5, color: C.text2, lineHeight: 1.8 } },
                  h('div', { style: { wordBreak: 'break-all' } }, `会话根：${linkInfo.sessionsRoot || ''}`),
                  h('div', { style: { wordBreak: 'break-all' } }, `联通目标：${linkInfo.linkRoot || ''}`),
                  h(
                    'div',
                    { style: { marginTop: 4 } },
                    linkInfo.error
                      ? 'QQ 会话组：未知（读取失败）'
                      : `QQ 会话组 ${Number(linkInfo.totals?.groups || 0)} 个 · 已联通 ${Number(linkInfo.totals?.linked || 0)} · 待激活 ${Number(linkInfo.totals?.ready || 0)} · 共 ${sizeLabel(linkInfo.totals?.bytes)}`,
                  ),
                  !linkInfo.error && linkInfo.linkRootOnSystemDrive === true
                    ? h('div', { style: { color: C.err } }, '联通目标在系统盘，建议确认非系统盘是否可用。')
                    : null,
                  (linkInfo.groups || []).map((row, index) =>
                    h(
                      'div',
                      {
                        key: `cl${index}`,
                        style: {
                          paddingTop: 4,
                          borderTop: index === 0 ? `1px solid ${C.border1}` : 'none',
                          marginTop: index === 0 ? 6 : 0,
                        },
                      },
                      h(
                        'div',
                        { style: { display: 'flex', justifyContent: 'space-between', gap: 12 } },
                        h('span', { style: { wordBreak: 'break-all' } }, `${row.name} · ${linkStateLabel(row.state)}`),
                        h('span', { style: { flex: 'none' } }, sizeLabel(row.bytes)),
                      ),
                      row.detail
                        ? h(
                            'div',
                            { style: { marginTop: 2, fontSize: 10.5, color: C.text2, wordBreak: 'break-all' } },
                            row.detail,
                          )
                        : null,
                    ),
                  ),
                  (linkInfo.groups || []).length === 0 && !linkInfo.error
                    ? h(Empty, { text: '还没有 qq-bridge 会话目录。' })
                    : null,
                  linkInfo.error
                    ? h('div', { style: { marginTop: 4, color: C.err } }, `读取失败：${linkInfo.error}`)
                    : null,
                  (linkInfo.groups || []).some(
                    (row) => row.state === 'ready' || row.state === 'conflict' || row.state === 'interrupted',
                  ) ||
                  linkInfo.dshRunning?.running ||
                  (linkInfo.dshRunning?.unknown && !linkInfo.error)
                    ? h(
                        'p',
                        { style: { margin: '8px 0 0', fontSize: 11, color: C.text2, lineHeight: 1.7 } },
                        linkInfo.dshRunning?.running
                          ? 'DSH 正在运行，只读展示。要激活：先从托盘完全退出 DSH，再运行 node link-context.mjs --apply。'
                          : linkInfo.dshRunning?.unknown
                            ? '读不到 DSH 进程状态：先确认已从托盘完全退出，再运行 node link-context.mjs --apply。'
                            : linkInfo.groups?.some((row) => row.state === 'interrupted')
                              ? '有上次搬迁中断的残留：确认 DSH 已完全退出后，运行 node link-context.mjs --apply 恢复。'
                              : '还有会话组待激活：确认 DSH 已完全退出后，运行 node link-context.mjs --apply。',
                      )
                    : null,
                  h(
                    'p',
                    { style: { margin: '6px 0 0', fontSize: 11, color: C.text2, lineHeight: 1.7 } },
                    '落盘不设字节上限；模型可见的注入仍由压缩与上下文窗口控制。',
                  ),
                ),
          ),

          // 安全（防火墙）
          h(
            Section,
            { title: '安全', hint: '完整性监控 · 三重加固' },
            !guardInfo
              ? h(Empty, { text: '读不到防火墙状态。' })
              : h(
                  'div',
                  { style: { fontSize: 11.5, color: C.text2, lineHeight: 1.8 } },
                  h(
                    'div',
                    {},
                    `基线：${guardInfo.baselineAt ? timeLabel(guardInfo.baselineAt) : '还没建'}${guardInfo.baselineCount ? `（${guardInfo.baselineCount} 个文件）` : ''}`,
                  ),
                  h('div', {}, `最近扫描：${guardInfo.lastScanAt ? timeLabel(guardInfo.lastScanAt) : '还没扫过'}`),
                  (guardInfo.alerts || []).slice(-3).map((alert, index) =>
                    h(
                      'div',
                      { key: `g${index}`, style: { color: C.err } },
                      `${timeLabel(alert.ts)} · ${alert.type === 'scan-alert' ? '完整性告警' : alert.type === 'harden' ? '加固' : alert.type === 'seal' ? '基线' : String(alert.type ?? '事件')}`,
                    ),
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' } },
                    h('button', { type: 'button', onClick: () => guardAction('scan'), style: linkStyle(C.brand) }, '立即扫描'),
                    h('button', { type: 'button', onClick: () => guardAction('seal'), style: linkStyle(C.brand) }, '重新基线'),
                    h('button', { type: 'button', onClick: () => guardAction('harden'), style: linkStyle(C.brand) }, '执行加固'),
                    guardMsg ? h('span', { style: { fontSize: 11 } }, guardMsg) : null,
                  ),
                ),
          ),

          // 省 token
          h(
            Section,
            { title: '省 token', hint: '自优化 · 只降呈现不降功能' },
            !tokenInfo
              ? h(Empty, { text: '还没有用量统计。' })
              : h(
                  'div',
                  { style: { fontSize: 11.5, color: C.text2, lineHeight: 1.8 } },
                  h('div', {}, `最近统计：${tokenInfo.entries} 次注入 · ~${tokenInfo.totalTokens} tokens`),
                  (tokenInfo.sections || [])
                    .slice(0, 4)
                    .map((section, index) =>
                      h('div', { key: `t${index}` }, `${section.name}：~${section.tokens} tokens（省 ${section.saved} 字）`),
                    ),
                  h(
                    'div',
                    { style: { marginTop: 4 } },
                    `预算：pending why ${tokenInfo.budget?.pendingWhy} 字 / ask ${tokenInfo.budget?.pendingAsk} 字 · 硬上限 ${tokenInfo.budget?.hardCap}`,
                  ),
                  (tokenInfo.levels || []).length > 0
                    ? h(
                        'div',
                        { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 } },
                        (tokenInfo.levels || []).map((item) =>
                          h(
                            'button',
                            {
                              key: `lv${item.index}`,
                              type: 'button',
                              onClick: () => setTokenLevel(item.index),
                              title: item.detail || '',
                              style: {
                                ...linkStyle(item.index === tokenInfo.level ? C.brand : C.text2),
                                padding: '4px 9px',
                                borderRadius: 7,
                                border: `1px solid ${item.index === tokenInfo.level ? C.brand : C.border1}`,
                              },
                            },
                            `${item.label}${item.index === tokenInfo.level ? ' ✓' : ''}`,
                          ),
                        ),
                      )
                    : null,
                  h(
                    'div',
                    { style: { display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' } },
                    h('button', { type: 'button', onClick: tuneTokenwise, style: linkStyle(C.brand) }, '自动调档'),
                    tokenMsg ? h('span', { style: { fontSize: 11 } }, tokenMsg) : null,
                  ),
                  (tokenInfo.tuneLog || [])
                    .slice(-3)
                    .map((entry, index) =>
                      h('div', { key: `tl${index}`, style: { fontSize: 11, opacity: 0.85 } }, `${timeLabel(entry.ts)} · ${entry.reason}`),
                    ),
                ),
          ),

          // 压缩自检
          h(
            Section,
            { title: '压缩自检', hint: '系统提案 + AI 表态（只读）' },
            consentItems.length === 0
              ? h(Empty, { text: '还没有压缩提案。系统认为该压缩时，会先在这里留一份等你核对。' })
              : consentItems.map((row, index) =>
                  h(
                    'div',
                    {
                      key: `c${index}`,
                      style: {
                        padding: '9px 0',
                        borderBottom: `1px solid ${C.border1}`,
                        fontSize: 11.5,
                        lineHeight: 1.7,
                      },
                    },
                    h(
                      'div',
                      { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                      pill(
                        row.status === 'pending-ai'
                          ? '等 AI 核对'
                          : row.status === 'approved'
                            ? 'AI 同意，压了'
                            : row.status === 'applied'
                              ? '已压缩'
                              : row.status === 'rejected'
                                ? 'AI 拒绝'
                                : row.status === 'forced'
                                  ? '系统强制'
                                  : row.status,
                        row.status === 'rejected' || row.status === 'forced' ? C.err : C.brand,
                      ),
                      h('span', { style: { color: C.text2 } }, timeLabel(row.ts)),
                      h('span', { style: { color: C.text2 } }, `删 ${row.deleteCount} 条 / 留 ${row.keepCount} 条`),
                    ),
                    row.deletePreview
                      ? h('div', { style: { color: C.text2, marginTop: 2 } }, `删：${row.deletePreview}`)
                      : null,
                    row.aiReason ? h('div', { style: { color: C.text2, marginTop: 2 } }, `AI：${row.aiReason}`) : null,
                  ),
                ),
          ),

          // 逻辑痕迹
          h(
            Section,
            { title: '逻辑痕迹', hint: '压缩 / 失败 / 用户回答' },
            activity.length === 0
              ? h(Empty, { text: '还没有压缩过。聊到阈值或发 /compact 之后，这里会出现痕迹。' })
              : activity.map((row, index) => h(ActivityRow, { key: `a${index}`, event: row })),
          ),

          // 记忆卡
          h(
            Section,
            { title: '记忆卡', hint: '摘要正文，点开看' },
            summaries.length === 0
              ? h(Empty, { text: '还没有记忆卡。' })
              : summaries.map((row, index) => h(SummaryCard, { key: `s${index}`, row })),
          ),

          // 待确认
          h(
            Section,
            { title: '拿不准的记忆', hint: openUncertain.length > 0 ? `${openUncertain.length} 条待确认` : '全部处理完了' },
            uncertain.length === 0
              ? h(Empty, { text: '没有拿不准的记忆。' })
              : uncertain.map((row, index) =>
                  h(PendingRow, { key: String(row.id ?? `u${index}`), row, onReply: replyPending }),
                ),
          ),

          // 一键找回（面板最底端）
          h(
            'div',
            {
              style: {
                marginTop: 26,
                padding: '14px 16px',
                borderRadius: 12,
                border: `1px solid ${C.border2}`,
                background: C.layer1,
              },
            },
            h('div', { style: { fontSize: 12.5, fontWeight: 600, color: C.text1 } }, '备份找回'),
            h(
              'div',
              { style: { fontSize: 11.5, color: C.text2, lineHeight: 1.7, marginTop: 4 } },
              '面板数据被攻击或损坏时，用非系统盘的上次备份覆盖回来。覆盖前会先把当前档案整份另存，找错了还能回退。',
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 8 } },
              h(
                'button',
                {
                  type: 'button',
                  onClick: restoreBackup,
                  style: {
                    margin: 0,
                    padding: '7px 14px',
                    border: `1px solid ${C.err ?? C.brand}`,
                    borderRadius: 9,
                    background: 'transparent',
                    color: C.err ?? C.brand,
                    fontSize: 12,
                    cursor: 'pointer',
                  },
                },
                '一键找回',
              ),
              restoreMsg ? h('span', { style: { fontSize: 11, color: C.text2 } }, restoreMsg) : null,
            ),
          ),

          // 说明
          h(
            'p',
            { style: { marginTop: 26, fontSize: 11, lineHeight: 1.8, color: C.text2, opacity: 0.85 } },
            '角色卡可以改（每次保存提醒扮演风险）；隐私记录是 AI 自己的遗言，查看要它同意；逻辑痕迹、记忆卡、待确认、压缩自检是只读留痕。',
          ),
        ),
      );
    }

    /* ───────────────────────── 注册 ───────────────────────── */

    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 41, label: () => '爱ai' },
          Icon,
        ),
      );

      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel));
    }

    return { name: 'ai-love', inject: ['slots'], apply };
  },
});
