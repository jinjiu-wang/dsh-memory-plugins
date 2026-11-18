"""上下文组装：只负责记忆，不包含任何人设、语气或角色设定。"""
from __future__ import annotations

import time

MAX_MEMORY_CHARS = 3000


def build_system_prompt(in_group: bool = False, memory_context: str = "") -> str:
    """构造纯功能 system prompt；记忆内容由调用方检索后传入。"""
    base = (
        "【记忆助手】\n"
        "你只负责基于对话和长期记忆回答当前消息。\n"
        "- 只回答眼前这条消息，不要复述上一个话题\n"
        "- 记忆里有依据才说；没有依据就直说不知道，不要编造\n"
        "- 群聊和私聊的记忆严格隔离，不得把私聊内容带到群里\n"
        "- 引用记忆时保持原意，不改写事实、时间和对象\n"
        "- 简洁回答，不用分点，不做总结\n"
    )
    if in_group:
        base += (
            "\n【群聊规则】\n"
            "- 消息前会标出发言人，不同发言人是不同的人\n"
            "- 只回需要你回的那条，别人已经答过的不用补答\n"
        )
    if memory_context:
        base += "\n【记忆】\n" + memory_context.strip() + "\n"
    return base


def _fmt_ts(ts: float) -> str:
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(float(ts)))
    except (TypeError, ValueError, OSError):
        return ""


def build_memory_context(db, chat_type: str, group_id: str = "", peer: str = "",
                         query: str = "", days: float = 30.0, max_chars: int = MAX_MEMORY_CHARS) -> str:
    """按作用域检索事实、摘要和相关原话，拼成可注入的记忆段落。"""
    fact_rows = db.facts(limit=20, chat_type=chat_type, group_id=group_id, peer=peer)
    summary_rows = db.summaries(days=days, limit=8, chat_type=chat_type,
                                group_id=group_id, peer=peer)
    quote_rows = []
    if str(query or "").strip():
        quote_rows = db.search_fts(query, limit=8, chat_type=chat_type,
                                   group_id=group_id, private_uid=peer)

    blocks: list[str] = []
    if fact_rows:
        lines = []
        for row in fact_rows:
            label = f"{row.get('subject')}：" if row.get("subject") else ""
            lines.append(f"- {label}{row.get('fact', '')}")
        blocks.append("【确定事实】\n" + "\n".join(lines))
    if summary_rows:
        lines = []
        for row in reversed(summary_rows):
            when = _fmt_ts(row.get("ts", 0))
            lines.append(f"- {when} {row.get('content', '')}".strip())
        blocks.append("【历史摘要】\n" + "\n".join(lines))
    if quote_rows:
        lines = []
        for row in quote_rows:
            who = row.get("speaker") or ("我" if row.get("role") == "assistant" else "")
            when = _fmt_ts(row.get("ts", 0))
            prefix = f"[{when}] " + (f"{who}：" if who else "")
            lines.append(f"- {prefix}{row.get('content', '')}")
        blocks.append("【相关原话】\n" + "\n".join(lines))

    text = "\n\n".join(block for block in blocks if block.strip())
    if len(text) > max_chars:
        text = text[:max_chars].rstrip() + "\n…"
    return text


def build_messages(system: str, recent: list[dict], user_text: str,
                   memory_context: str = "") -> list[dict]:
    """组装 OpenAI 格式消息列表；群消息带说话人标签，当前消息不重复追加。"""
    if memory_context:
        system = system + "\n【记忆】\n" + memory_context.strip() + "\n"
    messages: list[dict] = [{"role": "system", "content": system}]
    for item in recent or []:
        role = item.get("role")
        content = item.get("content")
        if role not in ("user", "assistant") or not content:
            continue
        if role == "user" and item.get("speaker"):
            content = f"[{item['speaker']}] {content}"
        messages.append({"role": role, "content": content})
    text = str(user_text or "")
    last = messages[-1] if len(messages) > 1 else None
    last_content = str(last.get("content", "")) if last is not None else ""
    if last_content.startswith("[") and "] " in last_content:
        last_content = last_content.split("] ", 1)[1]
    duplicate = (
        last is not None
        and last.get("role") == "user"
        and last_content.strip() == text.strip()
    )
    if text and not duplicate:
        messages.append({"role": "user", "content": text})
    return messages
