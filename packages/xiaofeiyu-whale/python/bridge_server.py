#!/usr/bin/env python3
"""小肥鱼鲸鱼娘 · Python 记忆服务（stdio JSON 行协议）。

由 DSH 插件宿主进程拉起；只在本机通过 stdin/stdout 通信，不监听端口。
支持：状态/事实/摘要/检索/待确认/导入/导出/自动同步/退出。

0.2.0 起记忆层换成"我们自己那套 l2"（带 uncertain 待确认表），
与爱ai 的数据交换统一走 bridge_adapter（协议 v1，字段与哈希都和对方对齐）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from memory import bridge_adapter as ba  # noqa: E402
from memory.l2 import MidTermMemory  # noqa: E402

MAX_INTEROP_BYTES = 128 * 1024 * 1024


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def resolve_inside(root: Path, candidate: str) -> Path:
    base = root.resolve()
    text = str(candidate or "").strip()
    if text == "":
        raise ValueError("缺少互通文件路径")
    target = Path(text)
    if not target.is_absolute():
        target = base / target
    target = target.resolve()
    if target != base and base not in target.parents:
        raise ValueError(f"路径必须位于 {base} 内")
    return target


def load_file_size(path: Path) -> int:
    if not path.is_file():
        return -1
    size = path.stat().st_size
    if size > MAX_INTEROP_BYTES:
        raise ValueError(f"互通文件太大（{size} 字节，上限 {MAX_INTEROP_BYTES}）")
    return size


def _split_pending(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    """把待确认和普通事实分开——面板要分别显示，混在一起会被当成事实卡看。"""
    pending = [r for r in rows if r.get("category") == ba.PENDING_CATEGORY]
    facts = [r for r in rows if r.get("category") != ba.PENDING_CATEGORY]
    return pending, facts


def handle(db: MidTermMemory, bridge_dir: Path, method: str, params: dict) -> dict:
    store = ba.BridgeStore(db)          # 轻量：只补 schema + 提供读写方法
    if method == "ping":
        return {"ok": True, "pid": os.getpid(), "db": db.db_path, "bridgeDir": str(bridge_dir)}

    if method == "state":
        limit = max(1, min(int(params.get("limit") or 10), 100))
        rows = store.facts(limit=limit * 4, all_scopes=True)
        pending, facts = _split_pending(rows)
        return {
            "stats": db.stats(),
            "facts": facts[:limit],
            "pending": pending[:limit],
            "summaries": store.summaries(days=3650, limit=limit, all_scopes=True),
            "db": db.db_path,
        }

    if method == "facts":
        limit = max(1, min(int(params.get("limit") or 20), 200))
        rows = store.facts(limit=limit * 4, all_scopes=True)
        _, facts = _split_pending(rows)
        return {"facts": facts[:limit]}

    if method == "summaries":
        limit = max(1, min(int(params.get("limit") or 20), 200))
        return {"summaries": store.summaries(days=3650, limit=limit, all_scopes=True)}

    if method == "pending":
        limit = max(1, min(int(params.get("limit") or 20), 200))
        rows = db.uncertain_list(status=0, limit=limit)
        return {"pending": rows, "count": len(rows)}

    if method == "pending_set":
        uid = int(params.get("id") or 0)
        status = int(params.get("status") or 0)
        if uid <= 0:
            return {"ok": False, "reason": "缺少 id"}
        if status not in (0, 1, 2):
            return {"ok": False, "reason": "status 只能是 0/1/2"}
        db.uncertain_set(uid, status)
        return {"ok": True, "id": uid, "status": status}

    if method == "search":
        query = str(params.get("query") or "").strip()
        limit = max(1, min(int(params.get("limit") or 20), 100))
        if query == "":
            return {"query": "", "hits": []}
        hits = db.search_fts(query, limit=limit)
        if hits:
            return {"query": query, "hits": hits}
        # 这个插件里通常没有原文消息（只有摘要/事实/待确认）→ 退一步在这三样里找
        key = query.lower()
        alt: list[dict] = []
        for r in store.summaries(days=3650, limit=500, all_scopes=True):
            if key in str(r.get("content") or "").lower():
                alt.append({"kind": "summary", "content": r.get("content"), "ts": r.get("ts")})
        for r in store.facts(limit=500, all_scopes=True):
            if key in str(r.get("fact") or "").lower():
                alt.append({"kind": r.get("category") or "fact",
                            "content": r.get("fact"), "ts": r.get("ts")})
        alt.sort(key=lambda d: float(d.get("ts") or 0), reverse=True)
        return {"query": query, "hits": alt[:limit], "fallback": "summaries+facts"}

    if method == "import_file":
        file = resolve_inside(bridge_dir, str(params.get("file") or ""))
        if load_file_size(file) < 0:
            return {"skipped": True, "reason": "文件不存在"}
        result = ba.import_from_file(db, str(file))
        return {"file": str(file), "result": result}

    if method == "export_file":
        file = resolve_inside(bridge_dir, str(params.get("file") or ""))
        file.parent.mkdir(parents=True, exist_ok=True)
        count = ba.export_to_file(db, str(file))
        return {"file": str(file), "count": count}

    if method == "auto_sync":
        incoming = resolve_inside(bridge_dir, str(params.get("importFile") or "ai-love.jsonl"))
        outgoing = resolve_inside(bridge_dir, str(params.get("exportFile") or "xiaofeiyu-whale.jsonl"))
        imported = None
        if load_file_size(incoming) >= 0:
            imported = ba.import_from_file(db, str(incoming))
        outgoing.parent.mkdir(parents=True, exist_ok=True)
        exported = ba.export_to_file(db, str(outgoing))
        return {
            "importFile": str(incoming),
            "exportFile": str(outgoing),
            "imported": imported,
            "exported": exported,
            "at": int(time.time() * 1000),
        }

    raise ValueError(f"unknown method: {method}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--bridge-dir", required=True)
    args = parser.parse_args()

    db_path = Path(args.db).resolve()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    bridge_dir = Path(args.bridge_dir).resolve()
    bridge_dir.mkdir(parents=True, exist_ok=True)
    db = MidTermMemory(str(db_path))
    ba.ensure_schema(db)

    emit({"id": "ready", "ok": True, "result": {"pid": os.getpid(), "db": str(db_path)}})

    for line in sys.stdin:
        text = line.strip()
        if text == "":
            continue
        request: dict = {}
        try:
            request = json.loads(text)
            req_id = request.get("id")
            method = str(request.get("method") or "")
            params = request.get("params") or {}
            if method == "shutdown":
                emit({"id": req_id, "ok": True, "result": {"stopping": True}})
                break
            result = handle(db, bridge_dir, method, params)
            emit({"id": req_id, "ok": True, "result": result})
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            emit({"id": request.get("id") if isinstance(request, dict) else None,
                  "ok": False, "error": str(exc)})

    try:
        db.close()
    except Exception:  # noqa: BLE001
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
