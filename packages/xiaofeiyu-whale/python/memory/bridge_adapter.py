# -*- coding: utf-8 -*-
"""把「我们自己的记忆库」接到跨插件互通协议 v1 上（适配层，不改 l2 的行为）。

为什么需要这一层：
    `memory/interop.py` 是参考实现，它只认 6 个存储方法
    （upsert_summary / add_fact / summaries / facts / map_session / session_scope），
    而我们的 l2 是另一套写法（facts 没有 status/ask/why，待确认是独立一张表）。
    这里把两边接起来：**协议逻辑一行不改**，只在我们的库上补出那 6 个方法。

字段映射（我们的 ↔ 协议）：
    待确认：uncertain.status  0 待确认 → open / 1 问清了 → confirmed / 2 丢开 → rejected
    摘要备注：summaries.kind  daily·weekly·monthly·yearly·rolling → summary / note → note
    事实卡：facts 直接对应；待确认的行以 category='待确认' 的身份参与导出
"""
from __future__ import annotations

import time

# 我们库里"待确认"的行用这个分类名进协议（对方也是这么认的）
PENDING_CATEGORY = "待确认"

# 我们的整数状态 ↔ 协议字符串状态
# 对方（爱ai）内部只认 open / resolved / dropped：
#   resolved 会吸收 confirmed（问清 = 处理完），rejected 会被它改成 dropped。
# 所以「问清了」我们发 confirmed，「她决定不问/丢开」我们发 dropped——语义各自对得上，来回也不丢。
OURS_TO_PROTO = {0: "open", 1: "confirmed", 2: "dropped"}
PROTO_TO_OURS = {"open": 0, "confirmed": 1, "resolved": 1, "rejected": 2, "dropped": 2}

# 我们自己产生的记录，来源标记
SOURCE_OURS = "python"


def _cols(conn, table: str) -> set[str]:
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def ensure_schema(mem) -> list[str]:
    """给现有库补上协议需要的列和表（幂等，只加不改）。返回补了哪些。"""
    conn = mem._conn  # noqa: SLF001 - 适配层就该贴着库干活
    done: list[str] = []

    for table, ddl in (
        ("summaries", (
            ("source", "ALTER TABLE summaries ADD COLUMN source TEXT NOT NULL DEFAULT ''"),
            ("external_id", "ALTER TABLE summaries ADD COLUMN external_id TEXT NOT NULL DEFAULT ''"),
            ("content_hash", "ALTER TABLE summaries ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''"),
            ("session_id", "ALTER TABLE summaries ADD COLUMN session_id TEXT NOT NULL DEFAULT ''"),
        )),
        ("facts", (
            ("chat_type", "ALTER TABLE facts ADD COLUMN chat_type TEXT NOT NULL DEFAULT 'private'"),
            ("group_id", "ALTER TABLE facts ADD COLUMN group_id TEXT NOT NULL DEFAULT ''"),
            ("status", "ALTER TABLE facts ADD COLUMN status TEXT NOT NULL DEFAULT 'open'"),
            ("ask", "ALTER TABLE facts ADD COLUMN ask TEXT NOT NULL DEFAULT ''"),
            ("why", "ALTER TABLE facts ADD COLUMN why TEXT NOT NULL DEFAULT ''"),
            ("external_id", "ALTER TABLE facts ADD COLUMN external_id TEXT NOT NULL DEFAULT ''"),
            ("content_hash", "ALTER TABLE facts ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''"),
            ("session_id", "ALTER TABLE facts ADD COLUMN session_id TEXT NOT NULL DEFAULT ''"),
        )),
        ("uncertain", (
            ("ask", "ALTER TABLE uncertain ADD COLUMN ask TEXT NOT NULL DEFAULT ''"),
            ("why", "ALTER TABLE uncertain ADD COLUMN why TEXT NOT NULL DEFAULT ''"),
            ("external_id", "ALTER TABLE uncertain ADD COLUMN external_id TEXT NOT NULL DEFAULT ''"),
            ("content_hash", "ALTER TABLE uncertain ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''"),
            ("session_id", "ALTER TABLE uncertain ADD COLUMN session_id TEXT NOT NULL DEFAULT ''"),
        )),
    ):
        have = _cols(conn, table)
        for name, sql in ddl:
            if name not in have:
                conn.execute(sql)
                done.append(f"{table}.{name}")

    conn.execute(
        "CREATE TABLE IF NOT EXISTS session_scopes ("
        "session_id TEXT PRIMARY KEY, chat_type TEXT NOT NULL, group_id TEXT NOT NULL DEFAULT '', "
        "peer TEXT NOT NULL DEFAULT '', ts REAL NOT NULL)"
    )
    # 幂等靠它：同一个来源 + 同一条外部 id 只留一行
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_summaries_ext "
                 "ON summaries(source, external_id) WHERE external_id <> ''")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_facts_ext "
                 "ON facts(source, external_id) WHERE external_id <> ''")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_uncertain_ext ON uncertain(external_id)")
    conn.commit()
    return done


class BridgeStore:
    """协议 v1 要的那 6 个方法，全都落在我们自己的表上。"""

    def __init__(self, mem) -> None:
        self.mem = mem
        self._conn = mem._conn  # noqa: SLF001
        ensure_schema(mem)

    # ---------- 会话作用域 ----------
    def map_session(self, session_id: str, chat_type: str, group_id: str = "",
                    peer: str = "") -> dict:
        sid = str(session_id or "").strip()
        if sid == "":
            raise ValueError("session_id 不能为空")
        ct = "group" if str(chat_type) == "group" else "private"
        gid = str(group_id or "")
        pr = str(peer or "")
        if ct == "group" and gid == "":
            raise ValueError("group 会话必须带 group_id")
        if ct == "private" and pr == "":
            raise ValueError("private 会话必须带 peer")
        self._conn.execute(
            "INSERT INTO session_scopes(session_id, chat_type, group_id, peer, ts) "
            "VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET "
            "chat_type=excluded.chat_type, group_id=excluded.group_id, "
            "peer=excluded.peer, ts=excluded.ts",
            (sid, ct, gid, pr, time.time()),
        )
        self._conn.commit()
        return {"session_id": sid, "chat_type": ct, "group_id": gid, "peer": pr}

    def session_scope(self, session_id: str) -> dict:
        row = self._conn.execute(
            "SELECT chat_type, group_id, peer FROM session_scopes WHERE session_id = ?",
            (str(session_id or "").strip(),),
        ).fetchone()
        if not row:
            return {"mapped": False, "chat_type": "private", "group_id": "", "peer": ""}
        return {"mapped": True, "chat_type": row[0], "group_id": row[1], "peer": row[2]}

    # ---------- 摘要 / 备注 ----------
    def upsert_summary(self, text: str, *, ts: float | None = None,
                       chat_type: str = "private", group_id: str = "", peer: str = "",
                       kind: str = "summary", source: str = "", external_id: str = "",
                       content_hash: str = "", session_id: str = "") -> tuple[int, bool]:
        body = str(text or "").strip()
        if body == "":
            return 0, False
        when = float(ts if ts is not None else time.time())
        kd = "note" if str(kind) == "note" else ("compaction" if str(kind) == "compaction" else "rolling")
        if external_id:
            row = self._conn.execute(
                "SELECT id FROM summaries WHERE source = ? AND external_id = ?",
                (str(source or ""), str(external_id)),
            ).fetchone()
            if row:
                self._conn.execute(
                    "UPDATE summaries SET ts = ?, content = ?, chat_type = ?, group_id = ?, "
                    "kind = ?, peer = ?, content_hash = ?, session_id = ? WHERE id = ?",
                    (when, body, chat_type, str(group_id or ""), kd, str(peer or ""),
                     content_hash, session_id, row[0]),
                )
                self._conn.commit()
                return int(row[0]), False
        cur = self._conn.execute(
            "INSERT INTO summaries(ts, content, chat_type, group_id, kind, peer, source, "
            "external_id, content_hash, session_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (when, body, chat_type, str(group_id or ""), kd, str(peer or ""),
             str(source or ""), str(external_id or ""), content_hash, session_id),
        )
        self._conn.commit()
        return int(cur.lastrowid or 0), True

    # ---------- 事实 / 待确认 ----------
    def add_fact(self, subject: str, text: str, *, category: str = "一般",
                 importance: float = 0.5, ts: float | None = None, source: str = "",
                 chat_type: str = "private", group_id: str = "", peer: str = "",
                 status: str = "open", ask: str = "", why: str = "",
                 external_id: str = "", content_hash: str = "", session_id: str = "") -> bool:
        body = str(text or "").strip()
        if body == "":
            return False
        # 只有「明确是待确认」的才进 uncertain 表：
        # 认 category='待确认' 或 对方的 uncertain external_id。
        # ⚠️ 不能拿 status 判断——协议里普通事实的 status 也常常是 "open"，
        #    那样每条事实都会被当成"待确认"（实测踩过：事实全部落进了 uncertain）。
        pending = (str(category) == PENDING_CATEGORY
                   or str(external_id).startswith("ai-love:uncertain:")
                   or str(external_id).startswith(f"{PENDING_CATEGORY}:"))
        if pending:
            return self._add_pending(body, status=status, ask=ask, why=why, ts=ts,
                                     source=source, chat_type=chat_type, group_id=group_id,
                                     peer=peer, external_id=external_id,
                                     content_hash=content_hash, session_id=session_id)
        when = float(ts if ts is not None else time.time())
        if external_id:
            row = self._conn.execute(
                "SELECT id FROM facts WHERE source = ? AND external_id = ?",
                (str(source or ""), str(external_id)),
            ).fetchone()
            if row:
                self._conn.execute(
                    "UPDATE facts SET ts = ?, fact = ?, category = ?, importance = ?, "
                    "chat_type = ?, group_id = ?, peer = ?, status = ?, ask = ?, why = ?, "
                    "content_hash = ?, session_id = ? WHERE id = ?",
                    (when, body, str(category or "一般"), float(importance or 0.5),
                     chat_type, str(group_id or ""), str(peer or ""), str(status or "open"),
                     str(ask or ""), str(why or ""), content_hash, session_id, row[0]),
                )
                self._conn.commit()
                return False
        dup = self._conn.execute(
            "SELECT id FROM facts WHERE fact = ? AND subject = ? AND category = ?",
            (body, str(subject or ""), str(category or "一般")),
        ).fetchone()
        if dup:
            return False
        self._conn.execute(
            "INSERT INTO facts(ts, subject, fact, category, importance, source, permanent, peer, "
            "chat_type, group_id, status, ask, why, external_id, content_hash, session_id) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (when, str(subject or ""), body, str(category or "一般"), float(importance or 0.5),
             str(source or "private"), 0, str(peer or ""), chat_type, str(group_id or ""),
             str(status or "open"), str(ask or ""), str(why or ""), str(external_id or ""),
             content_hash, session_id),
        )
        self._conn.commit()
        return True

    def _add_pending(self, body: str, *, status: str, ask: str, why: str, ts,
                     source: str, chat_type: str, group_id: str, peer: str,
                     external_id: str, content_hash: str, session_id: str) -> bool:
        """待确认的事落到我们自己的 uncertain 表（不塞进 facts，避免两处真源）。"""
        ours = PROTO_TO_OURS.get(str(status or "open").strip().lower(), 0)
        when = float(ts if ts is not None else time.time())
        if external_id:
            row = self._conn.execute(
                "SELECT id FROM uncertain WHERE external_id = ? AND external_id <> ''",
                (str(external_id),),
            ).fetchone()
            if row:
                self._conn.execute(
                    "UPDATE uncertain SET status = ?, ask = ?, why = ?, content_hash = ?, "
                    "session_id = ? WHERE id = ?",
                    (ours, str(ask or ""), str(why or ""), content_hash, session_id, row[0]),
                )
                self._conn.commit()
                return False
        dup = self._conn.execute(
            "SELECT id FROM uncertain WHERE substr(content, 1, 12) = ? AND status = ?",
            (body[:12], ours),
        ).fetchone()
        if dup:
            return False
        self._conn.execute(
            "INSERT INTO uncertain(ts, content, source, chat_type, group_id, peer, status, "
            "asked, last_ask_ts, ask, why, external_id, content_hash, session_id) "
            "VALUES(?,?,?,?,?,?,?,0,0,?,?,?,?,?)",
            (when, body[:120], str(source or "ai-love"), chat_type, str(group_id or ""),
             str(peer or ""), ours, str(ask or ""), str(why or ""), str(external_id or ""),
             content_hash, session_id),
        )
        self._conn.commit()
        return True

    # ---------- 读（导出用） ----------
    def summaries(self, days: float = 30.0, limit: int = 5, chat_type: str | None = None,
                  group_id: str | None = None, peer: str | None = None,
                  all_scopes: bool = True) -> list[dict]:
        start = time.time() - float(days) * 86400
        sql = ("SELECT id, ts, content, chat_type, group_id, kind, peer, source, external_id, "
               "session_id FROM summaries WHERE ts >= ?")
        params: list = [start]
        if not all_scopes:
            if chat_type is not None:
                sql += " AND chat_type = ?"
                params.append(chat_type)
            if group_id is not None:
                sql += " AND group_id = ?"
                params.append(str(group_id))
            if peer is not None:
                sql += " AND peer = ?"
                params.append(str(peer))
        sql += " ORDER BY ts DESC LIMIT ?"
        params.append(int(limit))
        rows = self._conn.execute(sql, params).fetchall()
        return [{"id": r[0], "ts": r[1], "content": r[2], "chat_type": r[3], "group_id": r[4],
                 "kind": r[5], "peer": r[6], "source": r[7], "external_id": r[8],
                 "session_id": r[9]} for r in rows]

    def facts(self, limit: int = 20, chat_type: str | None = None,
              group_id: str | None = None, peer: str | None = None,
              include_inactive: bool = True, all_scopes: bool = True) -> list[dict]:
        sql = ("SELECT id, ts, subject, fact, category, importance, source, permanent, peer, "
               "chat_type, group_id, status, ask, why, external_id, session_id FROM facts")
        where: list[str] = []
        params: list = []
        if not include_inactive:
            where.append("active = 1")
        if not all_scopes:
            if chat_type is not None:
                where.append("chat_type = ?")
                params.append(chat_type)
            if group_id is not None:
                where.append("group_id = ?")
                params.append(str(group_id))
            if peer is not None:
                where.append("peer = ?")
                params.append(str(peer))
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY ts DESC LIMIT ?"
        params.append(int(limit))
        out = [{"id": r[0], "ts": r[1], "subject": r[2], "fact": r[3], "category": r[4],
                "importance": r[5], "source": r[6], "permanent": r[7], "peer": r[8],
                "chat_type": r[9], "group_id": r[10], "status": r[11], "ask": r[12],
                "why": r[13], "external_id": r[14], "session_id": r[15]}
               for r in self._conn.execute(sql, params).fetchall()]
        # 待确认的事在我们这边是独立表 → 以 category='待确认' 的身份一并交出（单一真源）
        pending = self._conn.execute(
            "SELECT id, ts, content, source, chat_type, group_id, peer, status, ask, why, "
            "external_id, content_hash, session_id FROM uncertain "
            "ORDER BY ts DESC LIMIT ?", (int(limit),)).fetchall()
        for r in pending:
            out.append({
                "id": f"uncertain:{r[0]}", "ts": r[1], "subject": "", "fact": r[2],
                "category": PENDING_CATEGORY, "importance": 0.6, "source": r[3] or "python",
                "permanent": 0, "peer": r[6], "chat_type": r[4], "group_id": r[5],
                "status": OURS_TO_PROTO.get(int(r[7] or 0), "open"), "ask": r[8] or "",
                "why": r[9] or "", "external_id": r[10] or "", "session_id": r[12] or "",
            })
        out.sort(key=lambda d: float(d.get("ts") or 0), reverse=True)
        return out[: int(limit)]


# ---------- 一步到位的出入口 ----------
def export_to_file(mem, path: str, **kwargs) -> int:
    from . import interop
    return interop.export_to_file(BridgeStore(mem), path, **kwargs)


def import_from_file(mem, path: str, **kwargs) -> dict:
    from . import interop
    return interop.import_from_file(BridgeStore(mem), path, **kwargs)


def export_records(mem, **kwargs) -> list[dict]:
    from . import interop
    return interop.export_records(BridgeStore(mem), **kwargs)


def import_records(mem, records: list[dict], **kwargs) -> dict:
    from . import interop
    return interop.import_records(BridgeStore(mem), records, **kwargs)
