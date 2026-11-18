# 小肥鱼鲸鱼娘 0.2.0

独立记忆插件：托管本机 Python SQLite 记忆库，在 DSH 左侧栏提供面板，并与「爱ai」通过规范 JSONL 双向联通。

## 这个版本带什么

- **独立记忆库**：Host 拉起本机 Python 记忆服务（stdio，不监听端口）；SQLite 存消息、摘要、事实、待确认、会话作用域。
- **面板**：记忆概览、与爱ai 的自动联通（开关 / 立即同步 / 上次结果）、待确认、最近事实、最近摘要、FTS 检索原话。
- **纯记忆**：不写角色、语气、情绪、人设。
- **数据只在本机**：数据库不上传。

## 与上一个纯净包（0.1.0）相比

**新增**

- `python/memory/bridge_adapter.py`：与爱ai 的协议适配层。
  - 「待确认」双向：鲸鱼娘侧独立 `uncertain` 表 ↔ 协议里 `category='待确认'` 的记录；
    状态映射 `0 待确认 → open`、`1 问清了 → confirmed`、`2 丢开 → dropped`。
  - 事实与待确认分开落库；普通事实不会被误当成待确认。
  - 自动补列：`uncertain` 的 `ask` / `why` / `external_id` / `content_hash` / `session_id`，并为 `external_id` 建索引。
  - 导出时以 `待确认` 分类把待确认一并交出，保持单一真源。

**修改**

- `python/memory/l2.py`、`python/memory/retrieve.py`：待确认表、检索与导出路径适配。
- `python/bridge_server.py`：`auto_sync` 等方法的处理。
- 面板新增「待确认」区块；同步结果里带上待确认计数。
- 安装/卸载脚本与 `PURE.md` 更新。

## 数据

`<DSH_HOME>/xiaofeiyu-whale/memory.db`、`settings.json`；互通目录默认 `<DSH_HOME>/memory-bridge/`。

## 校验

```powershell
node verify.mjs
node selfcheck.mjs
node --test test/smoke.mjs
```

## 许可

MIT。
