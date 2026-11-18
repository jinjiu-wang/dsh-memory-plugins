"""记忆检索工具：中文分词（字符二元组）+ BM25 打分 + 中文相对时间解析。

不依赖第三方库（无 jieba/embedding），纯 Python，够用且快。
"""
from __future__ import annotations

import datetime
import math
import re

# 停用词（检索时忽略，避免"我/你/的"这类词把无关记忆顶上来）
_STOP = set(
    "的 了 是 在 我 你 他 她 它 们 这 那 有 和 就 都 也 不 要 会 说 吗 呢 吧 啊 呀 哦 嗯 哈 呀 "
    "什么 怎么 为什么 一下 一个 这个 那个 我们 你们 他们 人家 主人 群友 群聊 群里 大家 "
    "还是 还有 已经 可以 现在 时候 知道 觉得 感觉".split()
)

_CJK = re.compile(r"[\u4e00-\u9fff]+")
_WORD = re.compile(r"[a-zA-Z0-9_]+")


def tokenize(text: str) -> list[str]:
    """中文按字符二元组切（无词典也能匹配），英文/数字按词切。"""
    text = (text or "").lower()
    tokens: list[str] = []
    for run in _CJK.findall(text):
        if len(run) == 1:
            tokens.append(run)
        else:
            tokens.extend(run[i:i + 2] for i in range(len(run) - 1))
    tokens.extend(w for w in _WORD.findall(text) if len(w) > 1)
    return [t for t in tokens if t not in _STOP]


def bm25_rank(query: str, docs: list[dict], text_key: str = "content",
              k1: float = 1.4, b: float = 0.7) -> list[tuple[float, dict]]:
    """对 docs 做 BM25 打分，返回 [(score, doc)] 降序。"""
    q_tokens = set(tokenize(query))
    if not q_tokens or not docs:
        return []
    doc_tokens: list[list[str]] = [tokenize(str(d.get(text_key) or "")) for d in docs]
    n = len(docs)
    avg_len = sum(len(t) for t in doc_tokens) / n or 1.0
    # 文档频率
    df: dict[str, int] = {}
    for toks in doc_tokens:
        for t in set(toks):
            df[t] = df.get(t, 0) + 1
    idf = {t: math.log((n - c + 0.5) / (c + 0.5) + 1.0) for t, c in df.items()}
    scored: list[tuple[float, dict]] = []
    for doc, toks in zip(docs, doc_tokens):
        if not toks:
            continue
        tf: dict[str, int] = {}
        for t in toks:
            tf[t] = tf.get(t, 0) + 1
        score = 0.0
        for t in q_tokens:
            f = tf.get(t)
            if not f:
                continue
            denom = f + k1 * (1 - b + b * len(toks) / avg_len)
            score += idf.get(t, 0.5) * f * (k1 + 1) / denom
        if score > 0:
            scored.append((score, doc))
    scored.sort(key=lambda x: x[0], reverse=True)
    return scored


# ---------- 中文相对时间 ----------
_CN_NUM = {"零": 0, "一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5,
           "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}


def _num(s: str) -> int:
    if s.isdigit():
        return int(s)
    if s in _CN_NUM:
        return _CN_NUM[s]
    if s.startswith("十"):
        return 10 + _CN_NUM.get(s[1:], 0) if len(s) > 1 else 10
    if "十" in s:
        a, _, bb = s.partition("十")
        return _CN_NUM.get(a, 1) * 10 + (_CN_NUM.get(bb, 0) if bb else 0)
    return 0


def parse_time_range(text: str, now: datetime.datetime | None = None) -> tuple[float, float] | None:
    """识别"昨天/前天/今天上午/刚才/两小时前"之类，返回 (start_ts, end_ts)。"""
    now = now or datetime.datetime.now()
    t = text or ""

    # N 分钟/小时前
    m = re.search(r"(\d+|[一两二三四五六七八九十]+)\s*(分钟|小时)\s*(之前|以前|前)", t)
    if m:
        n = _num(m.group(1))
        unit = m.group(2)
        delta = n * 60 if unit == "分钟" else n * 3600
        end = now.timestamp() - delta + delta * 0.6
        start = now.timestamp() - delta - delta * 0.6
        return (start, end)

    if re.search(r"(刚才|刚刚|方才|刚)", t):
        return (now.timestamp() - 1800, now.timestamp())

    day = None
    if re.search(r"前天", t):
        day = now - datetime.timedelta(days=2)
    elif re.search(r"昨天|昨晚|昨日", t):
        day = now - datetime.timedelta(days=1)
    elif re.search(r"今天|今日|今儿|今晚", t):
        day = now
    if day is None:
        return None

    start = day.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + datetime.timedelta(days=1)
    # 上午/下午/晚上/中午 细分
    if re.search(r"上午|早上|清晨", t):
        end = start + datetime.timedelta(hours=12)
    elif re.search(r"下午", t):
        start = start + datetime.timedelta(hours=12)
        end = start + datetime.timedelta(hours=6)
    elif re.search(r"晚上|夜里|半夜", t):
        start = start + datetime.timedelta(hours=18)
        end = start + datetime.timedelta(hours=6)
    elif re.search(r"中午", t):
        start = start + datetime.timedelta(hours=11)
        end = start + datetime.timedelta(hours=3)
    return (start.timestamp(), end.timestamp())
