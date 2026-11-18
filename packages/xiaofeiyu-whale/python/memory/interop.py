"""跨插件记忆互通：规范记录 v1、去人设清洗、幂等导入导出。

规范记录只有记忆本身，不携带角色、语气、人设等任何设定。
时间统一用毫秒（ts_ms），落库前换算成秒；外部 id + 内容哈希保证重复导入不膨胀。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path

SCHEMA_VERSION = 1
SOURCE_AILOVE = "ai-love"
SOURCE_PYTHON = "python"

# 旧版记忆卡里属于「角色/语气/人格」的小节，导入时整节丢弃。
_PERSONA_HEADING_MARKS = (
    "管理员",
    "情感",
    "人格",
    "语气",
    "人设",
    "角色设定",
    "性格",
    "口癖",
    "口头禅",
    "说话风格",
    "情绪轨迹",
    "未说出口",
)
_HEADING_RE = re.compile(r"^(#{1,6})\s*(.+?)\s*$")
_TAG_BLOCK_RE = re.compile(r"<protocol-conflict>.*?</protocol-conflict>", re.S | re.I)
_TAG_RE = re.compile(r"</?(?:uncertain|protocol-conflict)>", re.I)


def to_ms(value: float | int | None) -> int:
    """秒/毫秒都接受，统一成毫秒。"""
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return 0
    if number <= 0:
        return 0
    return int(round(number * 1000)) if number < 1e11 else int(round(number))


def to_seconds(value: float | int | None) -> float:
    """秒/毫秒都接受，统一成秒；没有时间就用当前时间。"""
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return time.time()
    if number <= 0:
        return time.time()
    return number / 1000.0 if number >= 1e11 else number


def hash_text(text: str) -> str:
    normalized = " ".join(str(text or "").split())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:32]


def _heading_is_persona(heading: str) -> bool:
    plain = re.sub(r"[\s/／、，,。:：()（）\-—_]+", "", str(heading or ""))
    return any(mark in plain for mark in _PERSONA_HEADING_MARKS)


def sanitize_summary_text(text: str) -> str:
    """去掉记忆卡里的人设/语气小节，只留事实性内容。"""
    raw = str(text or "")
    if not raw.strip():
        return ""
    raw = _TAG_BLOCK_RE.sub("", raw)
    raw = _TAG_RE.sub("", raw)
    kept: list[tuple[str | None, list[str]]] = [(None, [])]
    keep = True
    for line in raw.splitlines():
        match = _HEADING_RE.match(line.strip())
        if match is not None:
            keep = not _heading_is_persona(match.group(2))
            if keep:
                kept.append((match.group(2).strip(), []))
            continue
        if keep:
            kept[-1][1].append(line)
    blocks: list[str] = []
    for heading, lines in kept:
        body = "\n".join(line.rstrip() for line in lines).strip()
        if body == "":
            continue
        blocks.append(f"## {heading}\n{body}" if heading else body)
    cleaned = "\n\n".join(blocks)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    if cleaned.strip("-• \t") == "":
        return ""
    return cleaned


def make_record(*, source: str, external_id: str, ts, chat_type: str, group_id: str = "",
                peer: str = "", session_id: str = "", kind: str = "summary", text: str = "",
                status: str = "", importance: float = 0.5, subject: str = "",
                category: str = "", ask: str = "", why: str = "") -> dict:
    text = str(text or "")
    return {
        "schema_version": SCHEMA_VERSION,
        "source": str(source or SOURCE_PYTHON),
        "external_id": str(external_id or ""),
        "ts_ms": to_ms(ts),
        "chat_type": str(chat_type or "private"),
        "group_id": str(group_id or ""),
        "peer": str(peer or ""),
        "session_id": str(session_id or ""),
        "kind": str(kind or "summary"),
        "text": text,
        "status": str(status or ""),
        "importance": float(importance or 0.5),
        "subject": str(subject or ""),
        "category": str(category or ""),
        "ask": str(ask or ""),
        "why": str(why or ""),
        "content_hash": hash_text(text),
    }


def normalize_record(record: dict) -> dict:
    """校验并补齐一条规范记录；不认识的结构直接报错，避免静默丢数据。"""
    if not isinstance(record, dict):
        raise ValueError("record must be an object")
    version = int(record.get("schema_version") or SCHEMA_VERSION)
    if version != SCHEMA_VERSION:
        raise ValueError(f"unsupported schema_version: {version}")
    kind = str(record.get("kind") or "summary").strip().lower()
    if kind not in ("summary", "fact", "note", "uncertain"):
        raise ValueError(f"unsupported kind: {kind}")
    ct = str(record.get("chat_type") or "").strip().lower()
    group_id = str(record.get("group_id") or "").strip()
    peer = str(record.get("peer") or "").strip()
    if not ct:
        ct = "group" if group_id else "private"
    if ct == "group" and not group_id:
        raise ValueError("group record requires group_id")
    if ct == "private" and not peer:
        raise ValueError("private record requires peer")
    text = str(record.get("text") or record.get("content") or record.get("summary") or "")
    ts_ms = to_ms(record.get("ts_ms", record.get("ts")))
    if ts_ms <= 0:
        ts_ms = to_ms(time.time())
    status = str(record.get("status") or "").strip().lower()
    if status == "dropped":
        status = "rejected"
    if kind == "uncertain" and status == "":
        status = "open"
    normalized = {
        "schema_version": SCHEMA_VERSION,
        "source": str(record.get("source") or SOURCE_PYTHON),
        "external_id": str(record.get("external_id") or ""),
        "ts_ms": ts_ms,
        "chat_type": ct,
        "group_id": group_id,
        "peer": peer,
        "session_id": str(record.get("session_id") or ""),
        "kind": kind,
        "text": text,
        "status": status,
        "importance": float(record.get("importance") or 0.5),
        "subject": str(record.get("subject") or ""),
        "category": str(record.get("category") or ""),
        "ask": str(record.get("ask") or ""),
        "why": str(record.get("why") or ""),
        "content_hash": str(record.get("content_hash") or hash_text(text)),
    }
    if normalized["external_id"] == "":
        normalized["external_id"] = (
            f"{normalized['source']}:{kind}:{normalized['session_id'] or peer}:"
            f"{ts_ms}:{normalized['content_hash'][:12]}"
        )
    return normalized


def _read_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return rows
    for line in text.splitlines():
        line = line.strip()
        if line == "":
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def _apply_session_scopes(mem, session_scopes: dict[str, object] | None) -> None:
    for session_id, spec in (session_scopes or {}).items():
        sid = str(session_id or "").strip()
        if sid == "":
            continue
        if isinstance(spec, dict):
            chat_type = str(spec.get("chat_type") or "private")
            group_id = str(spec.get("group_id") or "")
            peer = str(spec.get("peer") or "")
        else:
            parts = list(spec) if isinstance(spec, (tuple, list)) else []
            chat_type = str(parts[0]) if len(parts) > 0 else "private"
            group_id = str(parts[1]) if len(parts) > 1 else ""
            peer = str(parts[2]) if len(parts) > 2 else ""
        try:
            mem.map_session(sid, chat_type, group_id=group_id, peer=peer)
        except ValueError:
            # 外部给的映射缺 group_id/peer 时跳过这一条，不拖垮整批导入。
            continue


def _scope_of(mem, session_id: str) -> tuple[str, str, str]:
    """外部会话没有登记时，各自隔离成独立的私聊作用域，绝不并进真实私聊。"""
    sid = str(session_id or "").strip() or "unknown"
    scope = mem.session_scope(sid)
    if not scope.get("mapped"):
        mem.map_session(sid, "private", peer=sid)
        return ("private", "", sid)
    return (scope["chat_type"], scope["group_id"], scope["peer"])


def _uncertain_status(row: dict) -> str:
    status = str(row.get("status") or "open").strip().lower()
    if status in ("resolved", "dropped", "rejected", "confirmed"):
        return "resolved" if status in ("resolved", "dropped") else status
    if str(row.get("replyState") or "").strip() == "acknowledged":
        return "resolved"
    return "open"


def import_ailove(mem, root: str | Path, *, session_scopes: dict | None = None,
                  include_summaries: bool = True, include_uncertain: bool = True,
                  include_notes: bool = True, include_activity: bool = False) -> dict:
    """把 ai-love 的数据目录导入 Python 记忆库；重复导入不新增。"""
    base = Path(root)
    _apply_session_scopes(mem, session_scopes)
    result = {
        "summaries": 0, "summaries_skipped": 0,
        "uncertain": 0, "uncertain_updated": 0,
        "notes": 0, "notes_updated": 0,
        "activity": 0, "activity_skipped": 0,
    }

    if include_summaries:
        summaries_dir = base / "summaries"
        files = sorted(summaries_dir.glob("*.jsonl")) if summaries_dir.is_dir() else []
        for path in files:
            for row in _read_jsonl(path):
                raw = str(row.get("summary") or row.get("content") or row.get("text") or "")
                text = sanitize_summary_text(raw)
                if text == "":
                    result["summaries_skipped"] += 1
                    continue
                sid = str(row.get("sessionId") or row.get("session_id") or path.stem)
                ts_ms = to_ms(row.get("ts_ms", row.get("ts")))
                external_id = str(row.get("id") or "")
                if external_id == "":
                    external_id = f"{SOURCE_AILOVE}:summary:{sid}:{ts_ms}:{hash_text(raw)[:12]}"
                ct, gid, peer = _scope_of(mem, sid)
                _, created = mem.upsert_summary(
                    text, ts=to_seconds(ts_ms), chat_type=ct, group_id=gid, peer=peer,
                    kind="compaction", source=SOURCE_AILOVE, external_id=external_id,
                    content_hash=hash_text(text), session_id=sid,
                )
                result["summaries"] += 1 if created else 0

    if include_uncertain:
        for row in _read_jsonl(base / "uncertain.jsonl"):
            what = str(row.get("what") or "").strip()
            if what == "":
                continue
            sid = str(row.get("sessionId") or row.get("session_id") or "unknown")
            ct, gid, peer = _scope_of(mem, sid)
            status = _uncertain_status(row)
            external_id = str(row.get("id") or "")
            if external_id == "":
                external_id = f"{SOURCE_AILOVE}:uncertain:{sid}:{hash_text(what)[:16]}"
            else:
                external_id = f"{SOURCE_AILOVE}:uncertain:{external_id}"
            created = mem.add_fact(
                "", what, category="待确认", importance=0.6,
                ts=to_seconds(row.get("ts_ms", row.get("ts"))),
                source=SOURCE_AILOVE, chat_type=ct, group_id=gid, peer=peer,
                status=status, ask=str(row.get("ask") or ""), why=str(row.get("why") or ""),
                external_id=external_id, content_hash=hash_text(what), session_id=sid,
            )
            result["uncertain" if created else "uncertain_updated"] += 1

    if include_notes:
        for row in _read_jsonl(base / "companion-notes.jsonl"):
            text = str(row.get("text") or "").strip()
            if text == "":
                continue
            title = str(row.get("title") or "").strip()
            ts_ms = to_ms(row.get("ts_ms", row.get("ts")))
            body = f"{title}：{text}" if title and title not in text else text
            external_id = str(row.get("id") or "")
            if external_id == "":
                external_id = f"{SOURCE_AILOVE}:note:{ts_ms}:{hash_text(body)[:16]}"
            sid = str(row.get("sessionId") or "companion")
            mem.map_session(sid, "private", peer="__companion__")
            _, created = mem.upsert_summary(
                body, ts=to_seconds(ts_ms), chat_type="private", group_id="",
                peer="__companion__", kind="note", source=SOURCE_AILOVE,
                external_id=external_id, content_hash=hash_text(body), session_id=sid,
            )
            result["notes" if created else "notes_updated"] += 1

    if include_activity:
        for row in _read_jsonl(base / "activity.jsonl"):
            text = str(row.get("type") or "").strip()
            if text == "":
                continue
            sid = str(row.get("sessionId") or "unknown")
            ts_ms = to_ms(row.get("ts_ms", row.get("ts")))
            external_id = f"{SOURCE_AILOVE}:activity:{sid}:{ts_ms}:{hash_text(text)[:12]}"
            ct, gid, peer = _scope_of(mem, sid)
            _, inserted = mem.upsert_summary(
                f"压缩记录：{text}", ts=to_seconds(ts_ms), chat_type=ct, group_id=gid,
                peer=peer, kind="activity", source=SOURCE_AILOVE,
                external_id=external_id, content_hash=hash_text(text), session_id=sid,
            )
            result["activity"] += 1 if inserted else 0
    return result


def export_records(mem, *, days: float = 3650.0, limit: int = 100000,
                   chat_type: str | None = None, group_id: str | None = None,
                   peer: str | None = None, source: str = SOURCE_PYTHON) -> list[dict]:
    """导出规范记录；摘要、事实、待确认、备注都带上稳定 id 与毫秒时间。"""
    records: list[dict] = []
    summary_rows = mem.summaries(days=days, limit=limit, chat_type=chat_type,
                                 group_id=group_id, peer=peer, all_scopes=True)
    for row in summary_rows:
        kind = str(row.get("kind") or "summary")
        if kind == "activity":
            # 工作量日志不属于规范 v1 的记忆种类，导出会污染对方记忆卡。
            continue
        if kind not in ("summary", "note"):
            kind = "summary"
        text = sanitize_summary_text(row.get("content") or "")
        if text == "":
            continue
        external_id = str(row.get("external_id") or "")
        if external_id == "":
            external_id = f"{source}:summary:{row.get('id')}"
        records.append(make_record(
            source=row.get("source") or source, external_id=external_id, ts=row.get("ts"),
            chat_type=row.get("chat_type") or "private", group_id=row.get("group_id") or "",
            peer=row.get("peer") or "", session_id=row.get("session_id") or "",
            kind=kind, text=text,
        ))
    fact_rows = mem.facts(limit=limit, chat_type=chat_type, group_id=group_id,
                          peer=peer, include_inactive=True, all_scopes=True)
    for row in fact_rows:
        external_id = str(row.get("external_id") or "")
        is_uncertain = external_id.startswith(f"{SOURCE_AILOVE}:uncertain:") or row.get("category") == "待确认"
        kind = "uncertain" if is_uncertain else "fact"
        if external_id == "":
            external_id = f"{source}:{kind}:{row.get('id')}"
        text = str(row.get("fact") or "")
        records.append(make_record(
            source=row.get("source") or source, external_id=external_id, ts=row.get("ts"),
            chat_type=row.get("chat_type") or "private", group_id=row.get("group_id") or "",
            peer=row.get("peer") or "", session_id=row.get("session_id") or "",
            kind=kind, text=text,
            status=row.get("status") or "", importance=float(row.get("importance") or 0.5),
            subject=row.get("subject") or "", category=row.get("category") or "",
            ask=row.get("ask") or "", why=row.get("why") or "",
        ))
    records.sort(key=lambda item: (int(item["ts_ms"]), item["external_id"]))
    return records


def export_to_file(mem, path: str | Path, **kwargs) -> int:
    records = export_records(mem, **kwargs)
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    body = "\n".join(json.dumps(record, ensure_ascii=False) for record in records)
    # 对方可能正好在读：临时文件写完再原子替换，避免半个 JSONL。
    tmp = target.with_name(f"{target.name}.tmp-{os.getpid()}-{int(time.time() * 1000)}")
    tmp.write_text(body + ("\n" if body else ""), encoding="utf-8")
    os.replace(tmp, target)
    return len(records)


def _record_scope(mem, row: dict) -> tuple[str, str, str]:
    """记录自带作用域优先；会话已登记时以登记为准；否则隔离到会话自己的私聊。"""
    sid = str(row.get("session_id") or "").strip()
    if sid:
        scope = mem.session_scope(sid)
        if scope.get("mapped"):
            return (scope["chat_type"], scope["group_id"], scope["peer"])
    chat_type = str(row.get("chat_type") or "private")
    group_id = str(row.get("group_id") or "")
    peer = str(row.get("peer") or "")
    if chat_type == "group" and group_id:
        return ("group", group_id, peer)
    if peer:
        return ("private", "", peer)
    return _scope_of(mem, sid)


def import_records(mem, records: list[dict], *, session_scopes: dict | None = None) -> dict:
    """导入规范记录；同 source+external_id 重复写入只更新，不新增。"""
    _apply_session_scopes(mem, session_scopes)
    result = {"summary": 0, "summary_updated": 0, "fact": 0, "fact_updated": 0,
              "note": 0, "note_updated": 0, "uncertain": 0, "uncertain_updated": 0,
              "skipped": 0}
    for record in records or []:
        try:
            row = normalize_record(record)
        except ValueError:
            result["skipped"] += 1
            continue
        text = row["text"]
        if text.strip() == "":
            result["skipped"] += 1
            continue
        kind = row["kind"]
        chat_type, group_id, peer = _record_scope(mem, row)
        if kind in ("summary", "note"):
            _, created = mem.upsert_summary(
                text, ts=to_seconds(row["ts_ms"]), chat_type=chat_type,
                group_id=group_id, peer=peer, kind=kind,
                source=row["source"], external_id=row["external_id"],
                content_hash=row["content_hash"], session_id=row["session_id"],
            )
            result[kind if created else f"{kind}_updated"] += 1
        else:
            status = row["status"] or "open"
            created = mem.add_fact(
                row["subject"], text, category=row["category"] or ("待确认" if kind == "uncertain" else "一般"),
                importance=row["importance"], ts=to_seconds(row["ts_ms"]),
                source=row["source"], chat_type=chat_type, group_id=group_id,
                peer=peer, status=status, ask=row["ask"], why=row["why"],
                external_id=row["external_id"], content_hash=row["content_hash"],
                session_id=row["session_id"],
            )
            result[kind if created else f"{kind}_updated"] += 1
    return result


def import_from_file(mem, path: str | Path, *, source: str | None = None,
                     session_scopes: dict | None = None) -> dict:
    records = []
    for row in _read_jsonl(Path(path)):
        if source and not row.get("source"):
            row["source"] = source
        records.append(row)
    return import_records(mem, records, session_scopes=session_scopes)
