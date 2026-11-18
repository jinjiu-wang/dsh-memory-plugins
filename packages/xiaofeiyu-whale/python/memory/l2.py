"""中期记忆（L2）：SQLite 持久化，按 私聊/群 分区，LIKE 关键词检索（中文可靠）。

升级：情绪权重（arousal）+ 时间衰减（遗忘曲线）+ 群聊聚合 + 每日摘要。
"""
from __future__ import annotations

import sqlite3
import time

from .retrieve import tokenize as _tokenize

# 遗忘曲线参数（秒）
HALF_LIFE_SECONDS = 30 * 86400   # 普通记忆半衰期 30 天
AROUSAL_BOOST = 1.0              # 情绪权重放大系数


class MidTermMemory:
    """L2 mid-term memory: sqlite store with arousal, decay, group scoping."""

    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                ts        REAL NOT NULL,
                role      TEXT NOT NULL,
                chat_id   TEXT NOT NULL DEFAULT '',
                content   TEXT NOT NULL,
                arousal   REAL NOT NULL DEFAULT 0.5,
                chat_type TEXT NOT NULL DEFAULT 'private',
                group_id  TEXT NOT NULL DEFAULT '',
                user_id   TEXT NOT NULL DEFAULT '',
                speaker   TEXT NOT NULL DEFAULT ''
            )
            """
        )
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS summaries (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                ts      REAL NOT NULL,
                content TEXT NOT NULL,
                chat_type TEXT NOT NULL DEFAULT 'private',
                group_id  TEXT NOT NULL DEFAULT '',
                kind      TEXT NOT NULL DEFAULT 'daily',
                peer      TEXT NOT NULL DEFAULT ''
            )
            """
        )
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS rules (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                ts      REAL NOT NULL,
                content TEXT NOT NULL,
                active  INTEGER NOT NULL DEFAULT 1
            )
            """
        )
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS facts (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                ts         REAL NOT NULL,
                subject    TEXT NOT NULL DEFAULT '',
                fact       TEXT NOT NULL,
                category   TEXT NOT NULL DEFAULT '一般',
                importance REAL NOT NULL DEFAULT 0.5,
                source     TEXT NOT NULL DEFAULT 'private',
                active     INTEGER NOT NULL DEFAULT 1,
                permanent  INTEGER NOT NULL DEFAULT 0,
                peer       TEXT NOT NULL DEFAULT ''
            )
            """
        )
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS reminders (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                ts      REAL NOT NULL,
                fire_ts REAL NOT NULL,
                user_id TEXT NOT NULL DEFAULT '',
                chat_id TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL,
                done    INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS state (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                ts    REAL NOT NULL
            )
            """
        )
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS members (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id  TEXT NOT NULL,
                user_id   TEXT NOT NULL,
                number    INTEGER NOT NULL,
                nickname  TEXT NOT NULL DEFAULT '',
                first_seen REAL NOT NULL,
                last_seen  REAL NOT NULL,
                UNIQUE(group_id, user_id)
            )
            """
        )
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS refs (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                ts      REAL NOT NULL,
                path    TEXT NOT NULL,
                desc    TEXT NOT NULL DEFAULT '',
                user_id TEXT NOT NULL DEFAULT ''
            )
            """
        )
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS relations (
                user_id TEXT PRIMARY KEY,
                score   REAL NOT NULL DEFAULT 0,
                ts      REAL NOT NULL
            )
            """
        )
        # 待确认的事：她当时没弄明白/拿不准的，先挂着，之后可以自己顺口问一句。
        # 这是"她惦记着没搞清的事"，不是待办清单——所以只存内容、来源、问过几次。
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS uncertain (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                ts         REAL NOT NULL,
                content    TEXT NOT NULL,
                source     TEXT NOT NULL DEFAULT 'her',
                chat_type  TEXT NOT NULL DEFAULT 'private',
                group_id   TEXT NOT NULL DEFAULT '',
                peer       TEXT NOT NULL DEFAULT '',
                status     INTEGER NOT NULL DEFAULT 0,
                asked      INTEGER NOT NULL DEFAULT 0,
                last_ask_ts REAL NOT NULL DEFAULT 0
            )
            """
        )
        self._conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages USING fts5(message_id UNINDEXED, tokens)"
        )
        self._conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts)")
        self._conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id)")
        self._migrate()
        self._conn.commit()

    def _migrate(self) -> None:
        cols = [r[1] for r in self._conn.execute("PRAGMA table_info(messages)").fetchall()]
        for name, ddl in (
            ("arousal", "ALTER TABLE messages ADD COLUMN arousal REAL NOT NULL DEFAULT 0.5"),
            ("chat_type", "ALTER TABLE messages ADD COLUMN chat_type TEXT NOT NULL DEFAULT 'private'"),
            ("group_id", "ALTER TABLE messages ADD COLUMN group_id TEXT NOT NULL DEFAULT ''"),
            ("user_id", "ALTER TABLE messages ADD COLUMN user_id TEXT NOT NULL DEFAULT ''"),
            ("speaker", "ALTER TABLE messages ADD COLUMN speaker TEXT NOT NULL DEFAULT ''"),
        ):
            if name not in cols:
                self._conn.execute(ddl)
        # 旧数据回填：解析旧 chat_id（'group_x_y' 或 纯数字）
        rows = self._conn.execute(
            "SELECT id, chat_id FROM messages WHERE chat_type = '' OR group_id = '' AND user_id = ''"
        ).fetchall()
        for rid, cid in rows:
            cid = (cid or "").strip()
            if cid.startswith("group_"):
                parts = cid.split("_")
                gid = parts[1] if len(parts) > 1 else ""
                uid = parts[2] if len(parts) > 2 else ""
                self._conn.execute(
                    "UPDATE messages SET chat_type='group', group_id=?, user_id=? WHERE id=?",
                    (gid, uid, rid),
                )
            elif cid:
                self._conn.execute(
                    "UPDATE messages SET chat_type='private', user_id=? WHERE id=?",
                    (cid, rid),
                )
        # 清理历史脏数据：她自己的回复曾被记成 user_id='private_*'（chat_id 回填的副产物）
        self._conn.execute(
            "UPDATE messages SET user_id = '' WHERE role = 'assistant' AND user_id LIKE 'private%'"
        )
        # 摘要表升级：按 私聊/群 分开存
        scols = [r[1] for r in self._conn.execute("PRAGMA table_info(summaries)").fetchall()]
        if "chat_type" not in scols:
            self._conn.execute("ALTER TABLE summaries ADD COLUMN chat_type TEXT NOT NULL DEFAULT 'private'")
        if "group_id" not in scols:
            self._conn.execute("ALTER TABLE summaries ADD COLUMN group_id TEXT NOT NULL DEFAULT ''")
        # 事实卡升级：标记来源（私聊/群），防止群友闲话混进私聊记忆
        fcols = [r[1] for r in self._conn.execute("PRAGMA table_info(facts)").fetchall()]
        if fcols and "source" not in fcols:
            self._conn.execute("ALTER TABLE facts ADD COLUMN source TEXT NOT NULL DEFAULT 'private'")
        if fcols and "permanent" not in fcols:
            self._conn.execute("ALTER TABLE facts ADD COLUMN permanent INTEGER NOT NULL DEFAULT 0")
        if "kind" not in scols:
            self._conn.execute("ALTER TABLE summaries ADD COLUMN kind TEXT NOT NULL DEFAULT 'daily'")
        if "peer" not in scols:
            self._conn.execute("ALTER TABLE summaries ADD COLUMN peer TEXT NOT NULL DEFAULT ''")
        if fcols and "peer" not in fcols:
            self._conn.execute("ALTER TABLE facts ADD COLUMN peer TEXT NOT NULL DEFAULT ''")
        # 事实卡升级：记下"这条事实是关于谁"的 uid——认人靠 id 精确查，不再靠名字模糊匹配
        if fcols and "user_id" not in fcols:
            self._conn.execute("ALTER TABLE facts ADD COLUMN user_id TEXT NOT NULL DEFAULT ''")
        # 回填：老事实卡有 peer（私聊 uid）但没 user_id 的，直接补上
        try:
            self._conn.execute(
                "UPDATE facts SET user_id = peer WHERE (user_id IS NULL OR user_id = '') AND peer != ''")
        except Exception:  # noqa: BLE001
            pass
        # 待确认表补协议字段：跨插件互通要用（ask/why/external_id/...）；老库没有就加上
        try:
            ucols = [r[1] for r in self._conn.execute("PRAGMA table_info(uncertain)").fetchall()]
            for name, ddl in (
                ("ask", "ALTER TABLE uncertain ADD COLUMN ask TEXT NOT NULL DEFAULT ''"),
                ("why", "ALTER TABLE uncertain ADD COLUMN why TEXT NOT NULL DEFAULT ''"),
                ("external_id", "ALTER TABLE uncertain ADD COLUMN external_id TEXT NOT NULL DEFAULT ''"),
                ("content_hash", "ALTER TABLE uncertain ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''"),
                ("session_id", "ALTER TABLE uncertain ADD COLUMN session_id TEXT NOT NULL DEFAULT ''"),
            ):
                if name not in ucols:
                    self._conn.execute(ddl)
        except Exception as e:  # noqa: BLE001
            print(f"[l2] uncertain migrate skipped: {e}")
        self._conn.commit()

    # ---------- 消息 ----------
    @staticmethod
    def _fts_tokens(content: str) -> str:
        """把正文切成检索用的 token（中文二元组 + 英文词），给 FTS5 用。

        老问题：全标点/纯空白会切成空串，写进 FTS 等于这条消息永远搜不到。
        这里兜底成"原文字符"，至少还能被 FTS 里的单字命中。
        """
        try:
            toks = " ".join(_tokenize(content or ""))
        except Exception:  # noqa: BLE001
            toks = ""
        if not toks.strip():
            raw = (content or "").strip()
            toks = " ".join(ch for ch in raw if ch.strip())[:400]
        return toks

    def add(self, role: str, content: str, chat_id: str = "", ts: float | None = None,
            arousal: float = 0.5, chat_type: str = "private", group_id: str = "",
            user_id: str = "", speaker: str = "") -> int:
        if not content:
            return 0
        cur = self._conn.execute(
            "INSERT INTO messages(ts, role, chat_id, content, arousal, chat_type, group_id, user_id, speaker) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (ts if ts is not None else time.time(), role, chat_id, content, float(arousal),
             chat_type, str(group_id), str(user_id), speaker),
        )
        mid = int(cur.lastrowid or 0)
        try:
            self._conn.execute(
                "INSERT INTO fts_messages(message_id, tokens) VALUES(?,?)",
                (mid, self._fts_tokens(content)),
            )
        except Exception:  # noqa: BLE001
            pass
        self._conn.commit()
        return mid

    def update_content(self, msg_id: int, content: str) -> None:
        """回填/修正某条消息的内容（比如把'发了一张图片'换成图片描述）。"""
        if not msg_id or not content:
            return
        self._conn.execute("UPDATE messages SET content = ? WHERE id = ?", (content, int(msg_id)))
        try:
            self._conn.execute("DELETE FROM fts_messages WHERE message_id = ?", (int(msg_id),))
            self._conn.execute(
                "INSERT INTO fts_messages(message_id, tokens) VALUES(?,?)",
                (int(msg_id), self._fts_tokens(content)),
            )
        except Exception:  # noqa: BLE001
            pass
        self._conn.commit()

    def build_fts_index(self, force: bool = False) -> int:
        """一次性把历史消息灌进 FTS 索引（幂等）。

        顺手清孤儿：fts 里有、messages 里没了的行（原文被清掉但索引没删干净）。
        判断"建好了没"用**有效行数**（能 join 上 messages 的），不是 fts 表总行数——
        否则孤儿会让 have/total 虚高，永远跳过重建。
        """
        try:
            orphan = self._conn.execute(
                "DELETE FROM fts_messages WHERE message_id NOT IN (SELECT id FROM messages)"
            ).rowcount
            if orphan:
                print(f"[l2] cleaned {orphan} orphan fts rows")
            valid = self._conn.execute(
                "SELECT COUNT(*) FROM fts_messages f JOIN messages m ON m.id = f.message_id"
            ).fetchone()[0]
            blank = self._conn.execute(
                "SELECT COUNT(*) FROM fts_messages WHERE tokens = ''").fetchone()[0]
            total = self._conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
            # 空 token 的行等于"这条消息永远搜不到"（老版本切词留下的），也得重建
            if not force and total > 0 and valid >= total * 0.95 and blank == 0:
                self._conn.commit()
                return 0
            if blank and not force:
                print(f"[l2] rebuilding fts: {blank} empty-token rows would never be found")
            self._conn.execute("DELETE FROM fts_messages")
            rows = self._conn.execute("SELECT id, content FROM messages").fetchall()
            data = [(rid, self._fts_tokens(c)) for rid, c in rows]
            self._conn.executemany(
                "INSERT INTO fts_messages(message_id, tokens) VALUES(?,?)", data)
            self._conn.commit()
            return len(data)
        except Exception as e:  # noqa: BLE001
            print(f"build fts failed: {e}")
            return 0

    def search_fts(self, query: str, limit: int = 20, chat_type: str | None = None,
                   group_id: str | None = None, private_uid: str | None = None) -> list[dict]:
        """FTS5 全文检索（适合大数据量/久远记忆），按相关度返回消息。"""
        toks = self._fts_tokens(query)
        if not toks:
            return []
        parts = [t for t in dict.fromkeys(toks.split()) if len(t) >= 1][:24]
        if not parts:
            return []
        match = " OR ".join(f'"{t}"' for t in parts)
        sql = ("SELECT m.role, m.content, m.ts, m.arousal, m.speaker, m.chat_type, m.group_id, "
               "m.user_id, m.chat_id FROM fts_messages f JOIN messages m ON m.id = f.message_id "
               "WHERE fts_messages MATCH ?")
        params: list = [match]
        if chat_type is not None:
            sql += " AND m.chat_type = ?"
            params.append(chat_type)
        if group_id is not None:
            sql += " AND m.group_id = ?"
            params.append(str(group_id))
        if private_uid is not None:
            sql += " AND ((m.role = 'user' AND m.user_id = ?) OR (m.role = 'assistant' AND m.chat_id = ?))"
            params.extend([str(private_uid), f"private_{private_uid}"])
        sql += " ORDER BY rank LIMIT ?"
        params.append(int(limit))
        try:
            rows = self._conn.execute(sql, params).fetchall()
        except Exception as e:  # noqa: BLE001
            print(f"fts search failed: {e}")
            return []
        return [
            {"role": r[0], "content": r[1], "ts": r[2], "arousal": r[3], "speaker": r[4],
             "chat_type": r[5], "group_id": r[6], "user_id": r[7], "chat_id": r[8]}
            for r in rows
        ]

    def search(self, keyword: str, limit: int = 10, chat_id: str | None = None,
               chat_type: str | None = None, group_id: str | None = None,
               user_id: str | None = None) -> list[dict]:
        kw = (keyword or "").strip()
        if not kw:
            return []
        sql = "SELECT role, content, ts, arousal, speaker, chat_type, group_id, user_id, chat_id FROM messages WHERE content LIKE ?"
        params: list = [f"%{kw}%"]
        if chat_id is not None:
            # 注意：这个参数以前只在签名里挂着、SQL 里没用（等于摆设，跨会话会串味）
            sql += " AND chat_id = ?"
            params.append(str(chat_id))
        if chat_type is not None:
            sql += " AND chat_type = ?"
            params.append(chat_type)
        if group_id is not None:
            sql += " AND group_id = ?"
            params.append(str(group_id))
        if user_id is not None:
            sql += " AND user_id = ?"
            params.append(str(user_id))
        sql += " ORDER BY ts DESC LIMIT ?"
        params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [
            {"role": r[0], "content": r[1], "ts": r[2], "arousal": r[3],
             "speaker": r[4], "chat_type": r[5], "group_id": r[6], "user_id": r[7], "chat_id": r[8]}
            for r in rows
        ]

    def recent(self, days: float = 3.0, limit: int = 200, chat_id: str | None = None,
               chat_type: str | None = None, group_id: str | None = None,
               user_id: str | None = None, private_uid: str | None = None) -> list[dict]:
        since = time.time() - days * 86400
        sql = "SELECT role, content, ts, arousal, speaker, chat_type, group_id, user_id, chat_id FROM messages WHERE ts >= ?"
        params: list = [since]
        if chat_id is not None:
            sql += " AND chat_id = ?"        # 同上：以前是摆设，现在真按会话过滤
            params.append(str(chat_id))
        if chat_type is not None:
            sql += " AND chat_type = ?"
            params.append(chat_type)
        if group_id is not None:
            sql += " AND group_id = ?"
            params.append(str(group_id))
        if user_id is not None:
            sql += " AND user_id = ?"
            params.append(str(user_id))
        if private_uid is not None:
            # 私聊按人分开：他的消息 + 她在这个窗口里的回复，别把别人的私聊混进来
            sql += " AND ((role = 'user' AND user_id = ?) OR (role = 'assistant' AND chat_id = ?))"
            params.extend([str(private_uid), f"private_{private_uid}"])
        # 取"最新的 N 条"再按时间正序返回（原来 ASC LIMIT 会拿到最旧的 N 条）
        sql = ("SELECT * FROM (" + sql + " ORDER BY ts DESC LIMIT ?) ORDER BY ts ASC")
        params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [
            {"role": r[0], "content": r[1], "ts": r[2], "arousal": r[3],
             "speaker": r[4], "chat_type": r[5], "group_id": r[6], "user_id": r[7], "chat_id": r[8]}
            for r in rows
        ]

    # ---------- 摘要 ----------
    def add_summary(self, content: str, ts: float | None = None,
                    chat_type: str = "private", group_id: str = "", kind: str = "daily",
                    peer: str = "") -> None:
        if not content:
            return
        self._conn.execute(
            "INSERT INTO summaries(ts, content, chat_type, group_id, kind, peer) VALUES(?,?,?,?,?,?)",
            (ts if ts is not None else time.time(), content, chat_type, str(group_id or ""), kind, str(peer or "")),
        )
        self._conn.commit()

    def summaries(self, days: float = 30.0, limit: int = 5,
                  chat_type: str | None = None, group_id: str | None = None,
                  since: float | None = None, kind: str | None = None,
                  peer: str | None = None) -> list[dict]:
        start = since if since is not None else time.time() - days * 86400
        sql = "SELECT ts, content, chat_type, group_id, kind FROM summaries WHERE ts >= ?"
        params: list = [start]
        if chat_type is not None:
            sql += " AND chat_type = ?"
            params.append(chat_type)
        if group_id is not None:
            sql += " AND group_id = ?"
            params.append(str(group_id))
        if kind:
            sql += " AND kind = ?"
            params.append(kind)
        if peer is not None:
            sql += " AND peer = ?"
            params.append(str(peer))
        sql += " ORDER BY ts DESC LIMIT ?"
        params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [{"ts": r[0], "content": r[1], "chat_type": r[2], "group_id": r[3], "kind": r[4]} for r in rows]

    def last_summary_ts(self, chat_type: str, group_id: str = "", peer: str = "") -> float:
        row = self._conn.execute(
            "SELECT MAX(ts) FROM summaries WHERE chat_type = ? AND group_id = ? AND peer = ?",
            (chat_type, str(group_id or ""), str(peer or "")),
        ).fetchone()
        return float(row[0] or 0)

    # ---------- 事实卡（长期记忆：她一直记着的事）----------
    def add_fact(self, subject: str, fact: str, category: str = "一般",
                 importance: float = 0.5, ts: float | None = None,
                 source: str = "private", peer: str = "",
                 user_id: str = "") -> bool:
        """写入一条事实；同主语同内容只存一次（重复出现则提升重要度）。"""
        fact = (fact or "").strip()
        if not fact:
            return False
        subject = (subject or "").strip()
        # 哪些算"永久记忆"：约定 / 事件 / 身体 / 计划，或者重要度很高
        permanent = 1 if (float(importance) >= 0.75 or category in ("约定", "事件", "主人健康", "主人计划")) else 0
        row = self._conn.execute(
            "SELECT id, importance, source FROM facts WHERE subject = ? AND fact = ?", (subject, fact)
        ).fetchone()
        if row:
            src = row[2] or "private"
            if src != source:
                src = "both"
            self._conn.execute(
                "UPDATE facts SET importance = ?, ts = ?, source = ?, permanent = MAX(permanent, ?) WHERE id = ?",
                (min(1.0, max(float(row[1]), float(importance)) + 0.1),
                 ts if ts is not None else time.time(), src, permanent, row[0]),
            )
            self._conn.commit()
            return False
        self._conn.execute(
            "INSERT INTO facts(ts, subject, fact, category, importance, source, permanent, peer, user_id) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (ts if ts is not None else time.time(), subject, fact, category,
             float(importance), source, permanent, str(peer or ""), str(user_id or "")),
        )
        self._conn.commit()
        return True

    def facts(self, limit: int = 20, category: str | None = None,
              sources: tuple[str, ...] | None = None,
              peer: str | None = None, user_id: str | None = None) -> list[dict]:
        sql = ("SELECT id, ts, subject, fact, category, importance, source, permanent, user_id "
               "FROM facts WHERE active = 1")
        params: list = []
        if category:
            sql += " AND category = ?"
            params.append(category)
        if sources:
            sql += " AND source IN (" + ",".join("?" * len(sources)) + ")"
            params.extend(sources)
        if peer is not None:
            sql += " AND peer = ?"
            params.append(str(peer))
        if user_id is not None:
            sql += " AND user_id = ?"
            params.append(str(user_id))
        sql += " ORDER BY permanent DESC, importance DESC, ts DESC LIMIT ?"
        params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [{"id": r[0], "ts": r[1], "subject": r[2], "fact": r[3],
                 "category": r[4], "importance": r[5], "source": r[6],
                 "permanent": r[7], "user_id": r[8]} for r in rows]

    def prune_facts(self, keep: int = 80) -> int:
        """事实卡太多时淘汰：永久记忆不动，其余按 重要度×新鲜度 留最好的。"""
        total = self._conn.execute("SELECT COUNT(*) FROM facts WHERE active = 1").fetchone()[0]
        if total <= keep:
            return 0
        rows = self._conn.execute(
            "SELECT id, importance, ts, permanent FROM facts WHERE active = 1"
        ).fetchall()
        now = time.time()
        scored = []
        for fid, imp, ts, perm in rows:
            if perm:
                continue
            age_days = max(0.0, now - float(ts)) / 86400.0
            scored.append((float(imp) * (0.5 ** (age_days / 30.0)), fid))
        scored.sort()
        need = total - keep
        drop = [fid for _, fid in scored[:need]]
        if drop:
            self._conn.executemany("UPDATE facts SET active = 0 WHERE id = ?", [(i,) for i in drop])
            self._conn.commit()
        return len(drop)

    def delete_fact(self, fact_id: int) -> None:
        self._conn.execute("UPDATE facts SET active = 0 WHERE id = ?", (int(fact_id),))
        self._conn.commit()

    # ---------- 提醒（持久化，重启不丢）----------
    def add_reminder(self, fire_ts: float, user_id: str, chat_id: str, content: str) -> int:
        cur = self._conn.execute(
            "INSERT INTO reminders(ts, fire_ts, user_id, chat_id, content) VALUES(?,?,?,?,?)",
            (time.time(), float(fire_ts), str(user_id), str(chat_id), str(content)),
        )
        self._conn.commit()
        return int(cur.lastrowid or 0)

    def pending_reminders(self, after_ts: float | None = None) -> list[dict]:
        """未完成的提醒，按到点时间正序。

        注意：**包含已经过期的**（`fire_ts <= now`）。以前写成 `fire_ts >= now`，
        等于"过期未发"这个状态根本不存在——重启期间到点的提醒会被永久漏掉。
        调用方自己判断：到点了就补发，没到点就排程。
        """
        sql = ("SELECT id, fire_ts, user_id, chat_id, content FROM reminders "
               "WHERE done = 0")
        params: list = []
        if after_ts is not None:
            sql += " AND fire_ts >= ?"
            params.append(float(after_ts))
        sql += " ORDER BY fire_ts ASC LIMIT 50"
        rows = self._conn.execute(sql, params).fetchall()
        return [{"id": r[0], "fire_ts": r[1], "user_id": r[2],
                 "chat_id": r[3], "content": r[4]} for r in rows]

    def mark_reminder_done(self, rid: int) -> None:
        self._conn.execute("UPDATE reminders SET done = 1 WHERE id = ?", (int(rid),))
        self._conn.commit()

    # ---------- 按时间段取消息（时间锚点回忆用）----------
    def messages_between(self, start: float, end: float, chat_type: str | None = None,
                         group_id: str | None = None, limit: int = 300,
                         private_uid: str | None = None) -> list[dict]:
        sql = "SELECT role, content, ts, arousal, speaker, chat_type, group_id, user_id, chat_id FROM messages WHERE ts >= ? AND ts <= ?"
        params: list = [float(start), float(end)]
        if chat_type is not None:
            sql += " AND chat_type = ?"
            params.append(chat_type)
        if group_id is not None:
            sql += " AND group_id = ?"
            params.append(str(group_id))
        if private_uid is not None:
            sql += " AND ((role = 'user' AND user_id = ?) OR (role = 'assistant' AND chat_id = ?))"
            params.extend([str(private_uid), f"private_{private_uid}"])
        sql = ("SELECT * FROM (" + sql + " ORDER BY ts DESC LIMIT ?) ORDER BY ts ASC")
        params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [
            {"role": r[0], "content": r[1], "ts": r[2], "arousal": r[3],
             "speaker": r[4], "chat_type": r[5], "group_id": r[6], "user_id": r[7], "chat_id": r[8]}
            for r in rows
        ]

    # ---------- 规矩（自定义指令）----------
    def add_rule(self, content: str) -> None:
        if not content:
            return
        self._conn.execute(
            "INSERT INTO rules(ts, content, active) VALUES(?,?,1)",
            (time.time(), content),
        )
        self._conn.commit()

    def rules(self) -> list[dict]:
        rows = self._conn.execute(
            "SELECT id, ts, content FROM rules WHERE active = 1 ORDER BY id DESC LIMIT 50"
        ).fetchall()
        return [{"id": r[0], "ts": r[1], "content": r[2]} for r in rows]

    def delete_rule(self, rule_id: int) -> None:
        self._conn.execute("UPDATE rules SET active = 0 WHERE id = ?", (int(rule_id),))
        self._conn.commit()

    # ---------- 小状态（心情等）----------
    def state_get(self, key: str, default: str = "") -> str:
        row = self._conn.execute("SELECT value FROM state WHERE key = ?", (key,)).fetchone()
        return row[0] if row else default

    def state_set(self, key: str, value: str) -> None:
        self._conn.execute(
            "INSERT INTO state(key, value, ts) VALUES(?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
            (key, str(value), time.time()),
        )
        self._conn.commit()

    def last_assistant_ts(self, chat_type: str, group_id: str = "") -> float:
        """这个空间里她最后一次说话的时间（用来标记哪些消息已经答过了）。"""
        row = self._conn.execute(
            "SELECT MAX(ts) FROM messages WHERE chat_type = ? AND group_id = ? AND role = 'assistant'",
            (chat_type, str(group_id or "")),
        ).fetchone()
        return float(row[0] or 0)

    def max_ts(self, chat_type: str, group_id: str = "") -> float:
        """某个空间里最新一条消息的时间（补拉漏消息时当水位线用）。"""
        row = self._conn.execute(
            "SELECT MAX(ts) FROM messages WHERE chat_type = ? AND group_id = ?",
            (chat_type, str(group_id or "")),
        ).fetchone()
        return float(row[0] or 0)

    def set_speaker(self, user_id: str, speaker: str, group_id: str | None = None) -> int:
        """把某个 QQ 号缺失的昵称补上（顺带回填历史空昵称行），返回更新条数。"""
        if not user_id or not speaker:
            return 0
        sql = "UPDATE messages SET speaker = ? WHERE role = 'user' AND chat_type = 'group' AND user_id = ? AND (speaker IS NULL OR speaker = '')"
        params: list = [speaker, str(user_id)]
        if group_id is not None:
            sql += " AND group_id = ?"
            params.append(str(group_id))
        cur = self._conn.execute(sql, params)
        self._conn.commit()
        return cur.rowcount or 0

    # ---------- 群成员编号（固定，不随昵称变化）----------
    def member_no(self, group_id: str, user_id: str, nickname: str = "") -> int:
        """取某人在本群的固定编号；没有就按出现顺序新分配一个。"""
        gid, uid = str(group_id or ""), str(user_id or "")
        if not gid or not uid:
            return 0
        now = time.time()
        row = self._conn.execute(
            "SELECT number FROM members WHERE group_id = ? AND user_id = ?", (gid, uid)
        ).fetchone()
        if row:
            num = int(row[0])
            if nickname:
                self._conn.execute(
                    "UPDATE members SET nickname = ?, last_seen = ? WHERE group_id = ? AND user_id = ?",
                    (nickname, now, gid, uid),
                )
                self._conn.commit()
            return num
        row = self._conn.execute(
            "SELECT MAX(number) FROM members WHERE group_id = ?", (gid,)
        ).fetchone()
        num = int(row[0] or 0) + 1
        self._conn.execute(
            "INSERT INTO members(group_id, user_id, number, nickname, first_seen, last_seen) "
            "VALUES(?,?,?,?,?,?)",
            (gid, uid, num, nickname, now, now),
        )
        self._conn.commit()
        return num

    def members_of(self, group_id: str, limit: int = 20) -> list[dict]:
        """本群已编号的成员（按编号升序）。"""
        rows = self._conn.execute(
            "SELECT number, user_id, nickname FROM members WHERE group_id = ? ORDER BY number LIMIT ?",
            (str(group_id or ""), int(limit)),
        ).fetchall()
        return [{"number": r[0], "user_id": r[1], "nickname": r[2]} for r in rows]

    # ---------- 保留策略 ----------
    def prune_group_messages(self, keep_days: float = 60.0, archive_dir: str | None = None) -> int:
        """清理超过保留期的群消息原文（摘要、事实、编号表不动）。返回删除条数。

        删之前先把这批原文写进 `archive_dir/group-YYYYMM.jsonl.gz`——
        以后想翻三个月前的群聊还有原文，而不是只剩一句摘要。
        """
        cutoff = time.time() - float(keep_days) * 86400
        rows = self._conn.execute(
            "SELECT id, ts, role, chat_id, content, arousal, chat_type, group_id, user_id, speaker "
            "FROM messages WHERE chat_type = 'group' AND ts < ?", (cutoff,)
        ).fetchall()
        ids = [r[0] for r in rows]
        if not ids:
            return 0
        if archive_dir:
            try:
                import gzip
                import json as _json
                import os
                os.makedirs(archive_dir, exist_ok=True)
                by_month: dict[str, list] = {}
                for r in rows:
                    mon = time.strftime("%Y%m", time.localtime(float(r[1])))
                    by_month.setdefault(mon, []).append({
                        "ts": r[1], "role": r[2], "chat_id": r[3], "content": r[4],
                        "arousal": r[5], "chat_type": r[6], "group_id": r[7],
                        "user_id": r[8], "speaker": r[9],
                    })
                for mon, items in by_month.items():
                    path = os.path.join(archive_dir, f"group-{mon}.jsonl.gz")
                    with gzip.open(path, "at", encoding="utf-8") as f:
                        for it in items:
                            f.write(_json.dumps(it, ensure_ascii=False) + "\n")
            except Exception as e:  # noqa: BLE001
                # 归档失败就别删（宁可占磁盘，也别丢原文）
                print(f"[l2] group archive failed, skip pruning: {e}")
                return 0
        # 索引删除和正文删除必须一致：索引删失败就整体回滚，别留下"正文没了、索引还在"的孤儿
        try:
            with self._conn:            # 同一事务
                self._conn.execute("DELETE FROM fts_messages WHERE message_id IN (" +
                                   ",".join("?" * len(ids)) + ")", ids)
                self._conn.execute("DELETE FROM messages WHERE chat_type = 'group' AND ts < ?", (cutoff,))
        except Exception as e:  # noqa: BLE001
            print(f"[l2] prune group messages failed (rolled back): {e}")
            return 0
        return len(ids)

    # ---------- 参考图（画图用的"照着这张画"）----------
    def add_ref(self, path: str, desc: str = "", user_id: str = "") -> int:
        cur = self._conn.execute(
            "INSERT INTO refs(ts, path, desc, user_id) VALUES(?,?,?,?)",
            (time.time(), str(path), desc or "", str(user_id or "")),
        )
        self._conn.commit()
        return int(cur.lastrowid or 0)

    def recent_ref(self, minutes: float = 60.0, user_id: str | None = None) -> dict | None:
        since = time.time() - float(minutes) * 60.0
        sql = "SELECT id, ts, path, desc, user_id FROM refs WHERE ts >= ?"
        params: list = [since]
        if user_id is not None:
            sql += " AND user_id = ?"
            params.append(str(user_id))
        sql += " ORDER BY ts DESC LIMIT 1"
        row = self._conn.execute(sql, params).fetchone()
        if not row:
            return None
        return {"id": row[0], "ts": row[1], "path": row[2], "desc": row[3], "user_id": row[4]}

    def refs(self, limit: int = 20) -> list[dict]:
        rows = self._conn.execute(
            "SELECT id, ts, path, desc FROM refs ORDER BY ts DESC LIMIT ?", (int(limit),)
        ).fetchall()
        return [{"id": r[0], "ts": r[1], "path": r[2], "desc": r[3]} for r in rows]

    def prune_refs(self, keep: int = 50) -> int:
        """只留最近 N 张参考图记录（磁盘文件另行处理）。"""
        row = self._conn.execute("SELECT MIN(id) FROM (SELECT id FROM refs ORDER BY ts DESC LIMIT ?)",
                                 (int(keep),)).fetchone()
        if not row or not row[0]:
            return 0
        cur = self._conn.execute("DELETE FROM refs WHERE id < ?", (row[0],))
        self._conn.commit()
        return cur.rowcount or 0

    def clear_refs(self) -> int:
        cur = self._conn.execute("DELETE FROM refs")
        self._conn.commit()
        return cur.rowcount or 0

    # ---------- 关系值（她喜不喜欢这个人）----------
    def _rel_decayed(self, uid: str) -> float:
        """好感度随时间往 0 回（半衰期 30 天）：记仇但不记一辈子。"""
        row = self._conn.execute("SELECT score, ts FROM relations WHERE user_id = ?", (uid,)).fetchone()
        if not row:
            return 0.0
        score, ts = float(row[0]), float(row[1] or 0)
        if not ts:
            return score
        age_days = max(0.0, time.time() - ts) / 86400.0
        return score * (0.5 ** (age_days / 30.0))

    def rel_add(self, user_id: str, delta: float) -> float:
        uid = str(user_id or "")
        if not uid:
            return 0.0
        score = self._rel_decayed(uid)
        score = max(-10.0, min(10.0, score + float(delta)))
        self._conn.execute(
            "INSERT INTO relations(user_id, score, ts) VALUES(?,?,?) "
            "ON CONFLICT(user_id) DO UPDATE SET score = excluded.score, ts = excluded.ts",
            (uid, score, time.time()),
        )
        self._conn.commit()
        return score

    def rel_get(self, user_id: str) -> float:
        return round(self._rel_decayed(str(user_id or "")), 2)

    def last_user_ts(self, user_id: str) -> float:
        """某人（私聊）最后一次说话的时间。"""
        row = self._conn.execute(
            "SELECT MAX(ts) FROM messages WHERE chat_type = 'private' AND role = 'user' AND user_id = ?",
            (str(user_id),),
        ).fetchone()
        return float(row[0] or 0)

    def private_uids(self) -> list[str]:
        rows = self._conn.execute(
            "SELECT DISTINCT user_id FROM messages WHERE chat_type = 'private' AND role = 'user' AND user_id <> ''"
        ).fetchall()
        return [r[0] for r in rows]

    # ---------- 待确认的事（她当时没弄清/拿不准的）----------
    def uncertain_add(self, content: str, source: str = "her", chat_type: str = "private",
                      group_id: str = "", peer: str = "") -> int:
        """挂一条"没搞清的事"。同一件事（开头 12 个字一样）还挂着就不重复记。"""
        t = (content or "").strip()
        if len(t) < 4:
            return 0
        t = t[:120]
        dup = self._conn.execute(
            "SELECT id FROM uncertain WHERE status = 0 AND substr(content, 1, 12) = ?",
            (t[:12],),
        ).fetchone()
        if dup:
            return 0
        cur = self._conn.execute(
            "INSERT INTO uncertain(ts, content, source, chat_type, group_id, peer) "
            "VALUES(?,?,?,?,?,?)",
            (time.time(), t, str(source or "her"), str(chat_type or "private"),
             str(group_id or ""), str(peer or "")),
        )
        self._conn.commit()
        return int(cur.lastrowid or 0)

    def uncertain_pick(self, chat_type: str = "private", group_id: str = "",
                       peer: str = "", min_age: float = 1800.0,
                       max_asked: int = 3) -> dict | None:
        """挑一条最该确认的：同一个窗口的事优先，问得少的先，放了一会儿的才提。"""
        now = time.time()
        cutoff = now - max(0.0, float(min_age))
        if str(chat_type) == "group":
            scope = "chat_type = 'group' AND group_id = ?"
            extra = [str(group_id or "")]
        else:
            scope = "chat_type = 'private' AND (peer = ? OR peer = '')"
            extra = [str(peer or "")]
        row = self._conn.execute(
            "SELECT id, ts, content, source, asked FROM uncertain "
            f"WHERE status = 0 AND asked < ? AND ts <= ? AND {scope} "
            "ORDER BY asked ASC, ts ASC LIMIT 1",
            [int(max_asked), cutoff] + extra,
        ).fetchone()
        if not row:
            return None
        return {"id": int(row[0]), "ts": float(row[1]), "content": row[2],
                "source": row[3] or "her", "asked": int(row[4] or 0)}

    def uncertain_touch(self, uid: int) -> None:
        """把这条标成"问过一次"（只是记着她惦记过，不代表催她）。"""
        if not uid:
            return
        self._conn.execute(
            "UPDATE uncertain SET asked = asked + 1, last_ask_ts = ? WHERE id = ?",
            (time.time(), int(uid)),
        )
        self._conn.commit()

    def uncertain_set(self, uid: int, status: int) -> None:
        """0 待确认 / 1 已问清（她就此放下） / 2 丢开（她决定不问）."""
        if not uid:
            return
        self._conn.execute("UPDATE uncertain SET status = ? WHERE id = ?",
                           (int(status), int(uid)))
        self._conn.commit()

    def uncertain_list(self, status: int | None = 0, limit: int = 20) -> list[dict]:
        sql = ("SELECT id, ts, content, source, chat_type, group_id, peer, status, asked, "
               "ask, why, external_id, session_id FROM uncertain")
        args: list = []
        if status is not None:
            sql += " WHERE status = ?"
            args.append(int(status))
        sql += " ORDER BY ts DESC LIMIT ?"
        args.append(int(limit))
        rows = self._conn.execute(sql, args).fetchall()
        return [{"id": r[0], "ts": r[1], "content": r[2], "source": r[3], "chat_type": r[4],
                 "group_id": r[5], "peer": r[6], "status": r[7], "asked": r[8],
                 "ask": r[9] or "", "why": r[10] or "", "external_id": r[11] or "",
                 "session_id": r[12] or ""} for r in rows]

    def uncertain_purge(self, keep_days: float = 30.0) -> int:
        """挂太久还没问出口的，就别惦记了（免得攒成待办清单）。"""
        cutoff = time.time() - float(keep_days) * 86400
        cur = self._conn.execute("DELETE FROM uncertain WHERE status = 0 AND ts < ?", (cutoff,))
        self._conn.commit()
        return cur.rowcount or 0

    def delete_messages(self, ids: list[int]) -> int:
        """删消息（同时清 FTS 索引）。"""
        if not ids:
            return 0
        pairs = [(int(i),) for i in ids]
        self._conn.execute("DELETE FROM fts_messages WHERE message_id IN (" +
                           ",".join("?" * len(pairs)) + ")", [i for (i,) in pairs])
        cur = self._conn.executemany("DELETE FROM messages WHERE id = ?", pairs)
        self._conn.commit()
        return cur.rowcount or 0

    def group_ids(self) -> list[str]:
        rows = self._conn.execute(
            "SELECT DISTINCT group_id FROM messages WHERE chat_type = 'group' AND group_id <> ''"
        ).fetchall()
        return [r[0] for r in rows]

    # ---------- 统计 ----------
    def stats(self) -> dict:
        total = self._conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        today = self._conn.execute(
            "SELECT COUNT(*) FROM messages WHERE ts >= ?", (time.time() - 86400,)
        ).fetchone()[0]
        by_type = dict(
            self._conn.execute("SELECT chat_type, COUNT(*) FROM messages GROUP BY chat_type").fetchall()
        )
        rules = self._conn.execute("SELECT COUNT(*) FROM rules WHERE active = 1").fetchone()[0]
        summaries = self._conn.execute("SELECT COUNT(*) FROM summaries").fetchone()[0]
        facts = self._conn.execute("SELECT COUNT(*) FROM facts WHERE active = 1").fetchone()[0]
        members = self._conn.execute("SELECT COUNT(DISTINCT group_id) FROM members").fetchone()[0]
        try:
            pending = self._conn.execute(
                "SELECT COUNT(*) FROM uncertain WHERE status = 0").fetchone()[0]
        except Exception:  # noqa: BLE001
            pending = 0
        return {
            "total": total,
            "today": today,
            "private": by_type.get("private", 0),
            "group": by_type.get("group", 0),
            "rules": rules,
            "summaries": summaries,
            "facts": facts,
            "groups": members,
            "uncertain": pending,
        }

    def checkpoint(self) -> None:
        """把 WAL 里还没并回主库的内容落盘。

        备份前必须先做这一步：WAL 模式下只拷 `midterm.db` 会拿到**旧的**库
        （实测今早 07:59 那份备份比实库少 190 条消息，WAL 还有 4MB 没并）。
        """
        try:
            self._conn.execute("PRAGMA wal_checkpoint(FULL)")
            self._conn.commit()
        except Exception:  # noqa: BLE001
            pass

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:  # noqa: BLE001
            pass


def tier_weight(ts: float, now: float | None = None) -> float:
    """记忆分层权重：短期(≤7天) 1.0 / 中期(≤30天) 0.6 / 长期(≤90天) 0.3 / 归档 0.1。"""
    now = time.time() if now is None else now
    age_days = max(0.0, now - float(ts)) / 86400.0
    if age_days <= 7:
        return 1.0
    if age_days <= 30:
        return 0.6
    if age_days <= 90:
        return 0.3
    return 0.1


def decay_score(arousal: float, ts: float, now: float | None = None) -> float:
    """遗忘曲线评分：情绪权重越高越"慢忘"，越久远越淡（有下限）。"""
    now = time.time() if now is None else now
    age = max(0.0, now - float(ts))
    decay = 0.5 ** (age / HALF_LIFE_SECONDS)
    return max(0.05, min(1.0, float(arousal)) * AROUSAL_BOOST * decay)
