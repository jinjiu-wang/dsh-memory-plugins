# 纯功能发行说明

- 插件：爱ai（`ai-love`）
- 版本：0.20.4
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

- `<DSH_HOME>/ai-love/`：记忆卡、事实、拿不准、角色卡、隐私记录、防火墙
- `<DSH_HOME>/memory-bridge/`：与「小肥鱼鲸鱼娘」交换的 JSONL 和共享开关
- 面板备份目录：安装时选的非系统盘目录（默认 `<盘>:\爱ai`）

这些文件不会被打进安装包，也不会随包分发。

## 角色卡

「爱ai」里的角色卡是**运行时功能**：安装后默认没有卡。可以由使用者自己的 AI 从言行里归纳，也可以在面板里自己写。包里不带任何预置人格。

## qq-bridge

爱ai 要接管 QQ 会话压缩，需要本机有 qq-bridge。没有的话可以只装插件本体：

```powershell
node install.mjs --no-preset
```

这样左侧栏面板、记忆档案、备份和互通功能都能用；之后找到 qq-bridge，再用 `--repo` 重装一次即可补上 QQ preset。

