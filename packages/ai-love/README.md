# 爱ai · 记忆压缩 + 角色卡 + 隐私记录 + 跨插件互通

给 DSH 的 QQ 会话用的记忆插件：

- 在 token 压力或上下文溢出时，把较早的历史压成一张**纯事实记忆卡**；
- 记不准确的事写进「拿不准」，下一轮合适时问用户；
- 长期事实按会话注入提示；
- 角色卡从 AI 的言行里归纳，改卡走「AI 表态 → 管理端放行」；
- 隐私记录只由 AI 自己写，继承时按「亡语 / 永恒秘密」规则读取；
- 面板里能看见记忆卡、事实、拿不准、角色卡、隐私记录、压缩自检和互通记录；
- 用规范 JSONL 和 Python 记忆系统双向导入导出。

**记忆卡只写事实**：压缩提示与协议校验会拒绝人设/语气/情绪小节。角色卡是独立档案，不混进压缩记忆。

---

## 一、它能做什么

| 能力 | 说明 |
|---|---|
| 自动压缩 | 接管 QQ 会话的压缩后端，按阈值触发；失败不写表面变更 |
| 纯事实记忆卡 | 话题、人物关系、时间线、约定、当前状态、关键词；不写角色和情绪 |
| 拿不准 | 记不清/有歧义的事进档案，下一轮提醒 AI 问用户；面板可回复，AI 再确认 |
| 长期事实 | `facts.jsonl` 按会话隔离；确认过的事实注入系统提示 |
| 角色卡 | `character/card.md`；二级改动需 AI 表态 + 管理端放行，三级可直通 |
| 隐私记录 | `legacy/<aiId>.json`；AI 自己写，继承时按亡语/永恒秘密规则读取 |
| 压缩自检 | 提案式压缩：AI 同意才压，拒绝冷却，超时可兜底（可配置） |
| 跨插件互通 | 规范记录 v1：摘要 / 事实 / 待确认 / 备注的 JSONL 双向导入导出 |
| 自动联通 | DSH 启动后与「小肥鱼鲸鱼娘」自动双向同步；两边面板各有一个总开关，任一关闭即停 |
| 会话作用域 | `sessionScopes` 把 DSH 会话映射到 QQ 私聊/群，导入导出不串档 |
| 防火墙 | 对核心记忆档案做 SHA-256 基线，发现改动/缺失/新增 |
| 面板备份 | 把面板模块写成文字文档备份到非系统盘，可一键找回 |
| 逐字节备份 | QQ 会话日志 + 爱ai 档案实时镜像到非系统盘 |
| 会话日志联通 | 把 DSH 的 QQ 会话日志目录联接到非系统盘（只读查看） |

---

## 二、安装

```bash
node install.mjs
```

安装器会：

1. 把包复制到 `~/.dsh/plugins/ai-love`；
2. 在 profile 里注册 bundle；
3. 必要时给 QQ 工具白名单补上 14 个 ai-love 模型侧工具；
4. 生成/更新 `cordis.patch.yml`。

卸载：

```bash
node uninstall.mjs
```

安装后可用 `node verify.mjs` 和 `node selfcheck.mjs` 自检。

---

## 三、面板

DSH 左侧栏「爱ai」面板，每 15 秒自动刷新：

| 区块 | 内容 |
|---|---|
| 概览 | 记忆卡、待确认、事实、压缩次数等数字 |
| 逻辑痕迹 | 压缩成功/失败、token 压力、自检结果 |
| 记忆卡 | 各会话最近的压缩记忆卡 |
| 拿不准的记忆 | 待确认列表；可回复，回传给 QQ 上的 AI 确认 |
| 记忆事实 | 按会话列出长期事实（状态、分类、来源、时间） |
| 角色卡 | 看卡、提交改动、AI 表态与管理端放行、变更历史 |
| 隐私记录 | AI 写的隐私记录与查看申请；退役后按规则展示亡语 |
| 压缩自检 | 提案、AI 表态、超时/强制记录 |
| 与「小肥鱼鲸鱼娘」自动联通 | 总开关、对方状态、立即同步、互通目录、上次同步结果；下面保留手动 JSONL 导入导出 |
| 防火墙 | 基线、扫描、加固 |
| token 统计 | 预算档位与注入文本的字符/token 估算 |
| 备份 | 备份目录、立即同步、打开文件夹、一键找回 |
| 上下文联通 | QQ 会话日志联接状态 |

面板写接口只有：回复拿不准、压缩自检表态、自动联通开关/立即同步、互通导入/导出、备份同步/找回、token 档位、防火墙操作。

---

## 四、模型侧工具

| 工具 | 作用 |
|---|---|
| `compact_recall` | 翻当前会话的记忆卡 / 待确认 |
| `compact_pending` | 查看、确认或丢弃「拿不准」 |
| `compact_consent` | 对压缩提案表态（同意/拒绝） |
| `memory_facts` | 查当前会话的长期事实（可带关键词） |
| `memory_export` | 导出规范 JSONL（默认 `interop/ai-love-export.jsonl`） |
| `memory_import` | 从规范 JSONL 导入（按外部 id/内容哈希去重） |
| `character_check` | 自查当前角色卡 |
| `character_update` | 提交改卡申请 |
| `character_summarize` | 从言行样本归纳角色卡 |
| `character_export` | 把角色卡导出到 bridge 的 roles |
| `character_vote` | 对管理端改卡申请表态 |
| `legacy_write` | 写自己的隐私记录 |
| `legacy_review` | 审批隐私查看申请 |
| `legacy_read` | 按亡语/永恒秘密规则读隐私记录 |

`memory_export` 只允许写入记忆目录的 `interop/` 子目录；`memory_import` 只允许读取记忆目录或 `bridgeDir` 内的文件。

---

## 五、跨插件互通（规范记录 v1）

### 自动联通（默认开启）

DSH 启动后，两个插件各自跑起来，经同一个互通目录交换 JSONL：

```
~/.dsh/memory-bridge/
├── ai-love.jsonl            爱ai → 小肥鱼鲸鱼娘
├── xiaofeiyu-whale.jsonl    小肥鱼鲸鱼娘 → 爱ai
└── link.json                两边共享的开关状态
```

- 触发：DSH 启动后各跑一次，之后每 60 秒一次（小肥鱼的间隔可配置，最小 15 秒）。
- 条件：爱ai 面板开关开 **且** 小肥鱼面板开关开 **且** `link.json` 里两边都为 true；任何一边关掉，自动同步立即停。
- 手动：面板「立即同步」不受开关限制，可以强制跑一次。
- 幂等：按 `source + external_id` / 内容哈希去重，来回同步不会让记录越滚越多。
- 原子写：两份 JSONL 都先写临时文件再替换，避免对方读到半份文件。
- 只交换记忆本身：摘要、事实、待确认、备注；不包含人设、角色、语气或情绪。

互通目录默认 `<DSH_HOME>/memory-bridge`，可用 `memoryBridgeDir` 改到别处（两个插件要指向同一个目录）。

### 交换格式

交换文件是 JSONL，一行一条：

```json
{
  "schema_version": 1,
  "source": "ai-love",
  "external_id": "ai-love:summary:...",
  "ts_ms": 1793000000000,
  "chat_type": "group",
  "group_id": "20002",
  "peer": "10001",
  "session_id": "dsh-...",
  "kind": "summary",
  "text": "## 发生过什么\n- 约了周六八点集合",
  "status": "",
  "importance": 0.5,
  "subject": "",
  "category": "",
  "ask": "",
  "why": "",
  "content_hash": "..."
}
```

- `kind`：`summary` / `fact` / `uncertain` / `note`
- `chat_type`：`private` 或 `group`；私聊必须有 `peer`，群聊必须有 `group_id`
- 时间统一毫秒；秒级时间戳导入时自动换算
- 去重：`source + external_id`，没有 id 时用内容哈希
- 导出前会清洗记忆卡：人设/语气/情绪小节整节丢弃，只留事实
- 重复导入只更新，不新增；已确认/已拒绝的事实不会被迟到的 `open` 记录改回

### 会话 → QQ 作用域

`sessionScopes` 把 DSH 会话映射到 QQ 作用域，两个插件用同一份映射：

```json
{
  "sessionScopes": {
    "dsh-1": { "chat_type": "group", "group_id": "20002", "peer": "10001" },
    "dsh-2": { "chat_type": "private", "peer": "10001" }
  }
}
```

没登记的会话各自隔离成 `private` + 会话 id，不会并进真实私聊。

### Python 侧

```python
from memory import MidTermMemory, import_from_file, export_to_file

mem = MidTermMemory("memory.db")
import_from_file(
    mem,
    "ai-love-export.jsonl",
    session_scopes={"dsh-1": {"chat_type": "group", "group_id": "20002", "peer": "10001"}},
)
export_to_file(mem, "python-export.jsonl")
```

Python 侧的上下文只组装记忆（L1 最近窗口 + L2 摘要/事实 + 检索原话），不含任何身份或语气设定。

---

## 六、配置

写在 `cordis.patch.yml` 的插件 `config` 里；未知键会直接报错。

| 键 | 默认 | 说明 |
|---|---|---|
| `auto` | `true` | 是否自动压缩 |
| `style` | `'qq'` | 记忆卡风格 |
| `memoryDir` | `''` | 记忆目录；留空 = `~/.dsh/ai-love` |
| `thresholdRatio` | `0.8` | 达到上下文窗口的多少比例开始压缩 |
| `retainRatio` | `0.16` | 压缩后保留的消息预算比例 |
| `headroomTokens` | 自动 | 预留给输出的 token |
| `maxTokens` | `headroomTokens` | 单次压缩输出上限 |
| `modelPolicies` | `[]` | 按 provider/model 覆盖阈值 |
| `uncertainNotify` | `true` | 下一轮是否提醒「拿不准」 |
| `uncertainPerTurn` | `1` | 每轮最多提醒几条 |
| `uncertainMaxMentions` | `2` | 同一条最多提醒几次 |
| `recallLimit` | `3` | `compact_recall` 默认返回条数 |
| `compactConsent` | `'ai'` | 压缩提案模式 |
| `consentTimeoutMinutes` | `5` | 提案超时（0 = 不强制） |
| `consentCooldownMinutes` | `10` | AI 拒绝后的冷却 |
| `backupDir` | `''` | 面板备份目录；留空自动选非系统盘 |
| `backupIntervalMinutes` | `10` | 面板备份同步间隔 |
| `memoryBackup` | `true` | 是否逐字节备份会话日志 + 记忆档案 |
| `memoryBackupDir` | `''` | 逐字节备份目录 |
| `contextLinkDir` | `''` | QQ 会话日志联接目标 |
| `bridgeDir` | `''` | qq-bridge 目录（互通文件可放这里） |
| `memoryBridgeDir` | `''` | 自动联通目录；留空用 `<DSH_HOME>/memory-bridge` |
| `sessionScopes` | `{}` | DSH 会话 → QQ 作用域映射 |
| `debug` | `false` | 调试日志 |

---

## 七、档案布局

```
~/.dsh/ai-love/
├── summaries/<会话>.jsonl       压缩记忆卡（按会话隔离）
├── uncertain.jsonl              拿不准的记忆
├── facts.jsonl                  长期事实
├── character/                   角色卡、言行记录、改卡申请、变更历史
├── legacy/                      隐私记录（按 aiId 隔离）
├── activity.jsonl               压缩留痕
├── compact-consent.json         压缩提案
├── interop/                     互通 JSONL
└── guard/                       防火墙基线与告警
```

面板备份目录（默认 `<非系统盘>:\爱ai`）：

```
爱ai/
├── 01-概览.md
├── 02-逻辑痕迹.md
├── 03-记忆卡.md
├── 04-拿不准的记忆.md
├── 05-压缩自检.md
├── 06-角色卡/
├── 07-隐私记录/
├── 08-配置与版本.md
├── 09-上下文联通.md
├── _raw/memory/                 导出前的原始档案快照
└── backup.json
```

---

## 八、边界

- 插件只管 QQ 会话的压缩与记忆，不接管 Web GUI 的全局压缩；
- 压缩记忆卡只留事实；角色卡是独立档案，不会混进记忆卡；
- 隐私记录只由 AI 自己写，面板与继承方按亡语/永恒秘密规则只读；
- 面板的确认/丢弃记忆要在 QQ 里说，面板只提供回复；
- 失败不挡聊天：记忆写盘失败只记日志；
- 逐字节备份会原样复制会话日志和记忆目录，不会跳过历史数据。

---

## 九、测试

```bash
node --test test/smoke.mjs
```

烟测覆盖配置、记忆卡读写与幂等、事实、待确认、协议校验、互通导入导出、清洗、角色卡、隐私记录、防火墙。
