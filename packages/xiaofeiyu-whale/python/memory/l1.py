"""短时记忆（L1）：内存环形队列，保留最近 N 条对话。"""
from __future__ import annotations

import time
from collections import deque


class ShortTermMemory:
    """L1 short-term memory: in-memory deque of recent messages."""

    def __init__(self, maxlen: int = 100) -> None:
        self._buf: deque[dict] = deque(maxlen=maxlen)

    def add(self, role: str, content: str, ts: float | None = None) -> None:
        if not content:
            return
        self._buf.append({"role": role, "content": content, "ts": ts if ts is not None else time.time()})

    def get_recent(self, n: int = 20) -> list[dict]:
        if n <= 0:
            return []
        return list(self._buf)[-n:]
