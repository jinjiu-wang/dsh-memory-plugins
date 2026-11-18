/**
 * ai-love · 不确定记忆的解析
 *
 * 模型可能输出逐行 JSON、JSON 数组、markdown 代码块，或者干脆写人话。
 * 这里全部容错：宁可把一条当纯文本收下，也不要因为格式丢掉一条记忆。
 */

const UNCERTAIN_RE = /<uncertain>([\s\S]*?)<\/uncertain>/i;

function clip(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** 把模型输出拆成「正文」和「不确定项」。 */
export function splitUncertain(text) {
  const source = String(text ?? '');
  const match = UNCERTAIN_RE.exec(source);
  if (match === null) return { body: source.trim(), items: [] };
  const body = (source.slice(0, match.index) + source.slice(match.index + match[0].length)).trim();
  return { body, items: parseUncertainItems(match[1]) };
}

/** 容错解析：行内 JSON、JSON 数组、或纯文本行。 */
export function parseUncertainItems(raw) {
  const items = [];
  let text = String(raw ?? '').trim();
  if (text.length === 0) return items;
  text = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

  const pushItem = (candidate) => {
    if (candidate === null || candidate === undefined) return;
    if (typeof candidate === 'string') {
      const what = candidate.trim();
      if (what.length > 0) items.push({ what: clip(what, 160), why: '', ask: '' });
      return;
    }
    if (typeof candidate !== 'object') return;
    const what = clip(String(candidate.what ?? candidate.item ?? candidate.memory ?? '').trim(), 160);
    if (what.length === 0) return;
    items.push({
      what,
      why: clip(String(candidate.why ?? candidate.reason ?? '').trim(), 200),
      ask: clip(String(candidate.ask ?? candidate.question ?? '').trim(), 160),
    });
  };

  // 整体 JSON 数组
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) pushItem(entry);
        return items;
      }
    } catch {
      // 落到逐行解析
    }
  }

  for (const line of text.split(/\r?\n/)) {
    let candidate = line.trim();
    if (candidate.length === 0) continue;
    candidate = candidate.replace(/^[-*•]\s*/, '').trim();
    if (candidate.length === 0) continue;
    if (candidate.startsWith('{')) {
      try {
        pushItem(JSON.parse(candidate));
        continue;
      } catch {
        // 不是合法 JSON，当纯文本处理
      }
    }
    if (candidate.startsWith('"') && candidate.endsWith('"')) {
      try {
        pushItem(JSON.parse(candidate));
        continue;
      } catch {
        // 同上
      }
    }
    pushItem(candidate);
  }
  return items;
}
