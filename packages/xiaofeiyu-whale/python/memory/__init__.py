"""记忆层导出（纯功能，无人物设定）。

比 0.1.0 多两样：
  - 待确认记忆：她自己惦记着没弄清的事，独立一张表，不混进事实卡
  - bridge_adapter：把我们的库接到跨插件互通协议 v1 上（6 个方法 + 会话作用域 + 状态映射）
"""
from .bridge_adapter import BridgeStore, PENDING_CATEGORY, ensure_schema  # noqa: F401
from .bridge_adapter import export_to_file as bridge_export_to_file
from .bridge_adapter import import_from_file as bridge_import_from_file
from .context import build_memory_context, build_messages, build_system_prompt
from .interop import (
    SCHEMA_VERSION,
    export_records,
    export_to_file,
    hash_text,
    import_ailove,
    import_from_file,
    import_records,
    make_record,
    normalize_record,
    sanitize_summary_text,
    to_ms,
    to_seconds,
)
from .l1 import ShortTermMemory
from .l2 import MidTermMemory

__all__ = [
    "ShortTermMemory", "MidTermMemory",
    "BridgeStore", "PENDING_CATEGORY", "ensure_schema",
    "bridge_export_to_file", "bridge_import_from_file",
    "build_system_prompt", "build_messages", "build_memory_context",
    "SCHEMA_VERSION", "make_record", "normalize_record", "sanitize_summary_text",
    "hash_text", "to_ms", "to_seconds",
    "import_ailove", "import_records", "import_from_file",
    "export_records", "export_to_file",
]
