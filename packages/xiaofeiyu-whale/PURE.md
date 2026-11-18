# 纯功能发行说明

- 插件：小肥鱼鲸鱼娘（`xiaofeiyu-whale`）
- 版本：0.2.0
- 打包时间：2026-11-18T04:27:11.629Z

这个包只包含**功能代码**，不包含任何 AI 人设数据。

## 不包含

- 人格提示词、agent preset（`qq-chat` / `qq-chat-v2` / `agent.cordis.yml`）
- 角色卡正文（`character/card.md`、`card.meta.json`、`behavior.jsonl`）
- 聊天记录、记忆库、事实、摘要、拿不准、隐私记录
- 原使用者的本机路径、QQ 号、管理员身份、安装状态（`.install-state.json`）
- 任何运行时数据目录的副本

## 运行时数据在哪

安装并运行后，数据只会写到使用者的本机目录，例如：

- `<DSH_HOME>/xiaofeiyu-whale/memory.db`：SQLite 记忆库
- `<DSH_HOME>/xiaofeiyu-whale/settings.json`：本地面板开关
- `<DSH_HOME>/memory-bridge/`：与「爱ai」交换的 JSONL 和共享开关

这些文件不会被打进安装包，也不会随包分发。

## 角色卡

本插件不提供角色卡功能；包里也没有任何角色卡数据。

## qq-bridge

本插件不依赖 qq-bridge，直接 `node install.mjs` 即可。它只使用 DSH 与 Python，记忆库留在本机。

