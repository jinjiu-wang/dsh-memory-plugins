# 爱ai × 小肥鱼鲸鱼娘

两个给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的记忆插件。一个管「聊过的事怎么压小、怎么不忘」，一个管「记下的事存哪儿、怎么查」。装在一起时，两边会自动交换记忆。

| 插件 | 版本 | 一句话 |
|---|---|---|
| **爱ai**（`ai-love`） | 0.20.4 | QQ 会话的压缩记忆卡、长期事实、拿不准、角色卡、隐私记录、备份 |
| **小肥鱼鲸鱼娘**（`xiaofeiyu-whale`） | 0.2.0 | 独立 Python + SQLite 记忆库，面板里看统计、事实、摘要、检索 |
| **联动** | — | 同一目录交换 JSONL，启动后每 60 秒一次；只交换记忆，不交换人设 |

- 纯功能：**不含任何 AI 人设数据** —— 没有角色卡正文、没有 agent preset、没有聊天记录或记忆库，也没有原使用者的本机路径。
- 所有数据只留在本机，不上传。
- MIT。

> 当前发行：**组合包 v1.0.0**（爱ai 0.20.4 + 小肥鱼鲸鱼娘 0.2.0）

---

## 它们各自干什么

### 爱ai：把上下文压小，同时不丢事实

- **自动压缩**：接管 QQ 会话的压缩后端，到阈值触发；失败不写表层变更。
- **纯事实记忆卡**：只写话题、人物关系、时间线、约定、当前状态、关键词；压缩提示与协议校验会拒绝人设/语气/情绪小节。
- **拿不准**：记不清或有歧义的事进档案，下一轮提醒 AI 问用户；面板能回复，再把结果带回 QQ。
- **角色卡**：从 AI 的言行里归纳，改卡走「AI 表态 → 管理端放行」两级，三级可直通。
- **隐私记录**：只由 AI 自己写；继承时按「亡语 / 永恒秘密」规则读取。
- **档案基线**：对核心记忆档案做 SHA-256 基线，发现改动、缺失、新增。
- **备份**：面板模块写成文字文档备份到非系统盘，一键找回；QQ 会话日志与记忆档案可逐字节镜像。
- **运行时防火墙（0.20.4 新增）**：对出站网络、监听端口、越界写盘、危险子进程做拦截，记账到 `<memoryDir>/firewall.log`。
- **安全屋（0.20.4 新增，可选）**：按消息压力给自己留一块不被打扰的区域；要让 QQ 唤醒真正停下来，需要在 qq-bridge 上打一处补丁（`bridge/安全屋接入.md`）。
- **自进化沙盒（0.20.4 新增，默认不启用）**：闭环调度、注册表、哈希链日志；只写 `<memoryDir>/.evolve/`。

面板 13 个区块：概览、逻辑痕迹、记忆卡、拿不准、事实、角色卡、隐私记录、压缩自检、自动联通、防火墙、token 统计、备份、上下文联通。模型侧 14 个工具（`compact_*` / `memory_*` / `character_*` / `legacy_*`）。

### 小肥鱼鲸鱼娘：给记忆一个能查的库

- **独立记忆库**：Host 拉起本机 Python 记忆服务（stdio，不监听端口），SQLite 存消息、摘要、事实、待确认、会话作用域。
- **面板**：记忆概览、与爱ai 的自动联通、待确认（只读）、最近事实、最近摘要、FTS 检索原话。
- **不碰人设**：只存记忆；不写角色、语气、情绪。
- **0.2.0 新增**：与爱ai 的「待确认」双向映射（独立 `uncertain` 表 ↔ 协议里的 `category='待确认'`），以及一套协议适配层，让两边字段对得上。

---

## 两个一起用的时候

两边各写一份 JSONL 到同一个目录，各读对方那份：

```text
<DSH_HOME>/memory-bridge/
├── ai-love.jsonl            爱ai → 小肥鱼鲸鱼娘
├── xiaofeiyu-whale.jsonl    小肥鱼鲸鱼娘 → 爱ai
└── link.json                两边共写共读的总开关
```

- DSH 启动后各跑一次，之后每 60 秒一次；文件没变就跳过。
- 三个开关都为开才自动同步：爱ai 面板本地开关、鲸鱼娘面板本地开关、`link.json` 里 `aiLove` 与 `xiaofeiyu` 都为 `true`。任一边关掉，自动同步即停。
- 面板上的「立即同步」不受开关限制，可以强制跑一次。
- 只交换**摘要、事实、待确认、备注**；人设、角色、语气、情绪不进互通文件。导出前还会把记忆卡里的人设小节整节丢掉。
- 详细格式、开关、排错见 **[docs/联动用法.md](docs/联动用法.md)**。

---

## 快速开始

### 方式一：从仓库拿源码

在仓库页面点 **Code → Download ZIP**，或复制仓库地址后：

```powershell
git clone https://github.com/jinjiu-wang/dsh-memory-plugins.git
cd dsh-memory-plugins
node install-all.mjs
```

`install-all.mjs` 会依次调用两个包自己的安装器，找得到 qq-bridge 就顺手改 QQ preset，找不到就只装插件本体。

### 方式二：用 Release 里的安装包

在 Releases 页面下载任一 zip。组合包解压后是一个顶层目录，先进去再执行：

```powershell
cd ai-love-xiaofeiyu-whale-combo-1.0.0
node install-all.mjs
```

只要一个插件的话，独立包解压后直接：

```powershell
node install.mjs
```

### 装完必须做的一件事

**完整退出 DSH**（托盘图标右键退出，不是关窗口），再打开。插件只在启动时加载。

打开后左侧栏应出现「爱ai」和「小肥鱼鲸鱼娘」两个图标；两个面板里的自动联通开关默认都开着，`<DSH_HOME>/memory-bridge/` 里会冒出三份文件。

### 只用其中一个

```powershell
cd packages\ai-love
node install.mjs --repo "D:\qq-bridge"      # 有 qq-bridge
node install.mjs --no-preset                # 没有，只装插件本体
```

```powershell
cd packages\xiaofeiyu-whale
node install.mjs
```

单独装也行，只是没有联动。想补上联动，把另一个也装上即可，两边默认指向同一个互通目录。

---

## 要求

| 项 | 要求 |
|---|---|
| DSH | 已安装并能正常启动 |
| Node.js | ≥ 22（DSH 自带的 Node 也可以） |
| Python | ≥ 3.10，带 `sqlite3`（只有小肥鱼鲸鱼娘需要） |
| qq-bridge | 可选；爱ai 想接管 QQ 会话压缩时才需要 |

主要开发与测试在 Windows 上完成；脚本按跨平台写的，macOS / Linux 未逐项验证。

---

## 仓库结构

```text
.
├── README.md                本文件
├── LICENSE                  MIT
├── docs/
│   ├── 安装.md              两个插件 + 组合包的安装与卸载
│   ├── 联动用法.md          互通原理、文件格式、开关、排错
│   ├── 排错.md              常见症状对照表
│   ├── 数据与隐私.md        数据写在哪、什么不上传
│   └── 发布流程.md          维护者：打包、校验、发版
├── install-all.mjs          一键安装
├── uninstall-all.mjs        一键卸载（默认保留数据）
├── verify-pure.mjs          校验 packages/ 里没有人设数据
├── release-notes/           每个版本的发布说明
└── packages/
    ├── ai-love/             完整可装包（含 README、PURE.md、LICENSE）
    └── xiaofeiyu-whale/     完整可装包
```

每个包里的 `PURE.md` 写清了「这个包不含什么、运行时数据写到哪」。包里的 `README.md` 是该插件自己的完整文档。

---

## 校验与测试

```powershell
node verify-pure.mjs                       # 仓库根：扫 packages/，确认无人设数据
node packages\ai-love\verify.mjs           # 安装状态与文件校验
node packages\ai-love\selfcheck.mjs        # 临时目录里跑配置、存储、协议、面板
node packages\xiaofeiyu-whale\selfcheck.mjs
```

单元/烟测：

```powershell
cd packages\ai-love
node --test test/smoke.mjs                 # 17 项

cd ..\xiaofeiyu-whale
node --test test/smoke.mjs                 # 6 项（含真实 Python 服务）
```

---

## 边界

- 两个包都**不提供人设**：你的 AI 是什么性格，由你自己的 DSH agent preset / 人格卡决定。爱ai 的角色卡功能安装后是空的。
- 记忆数据库、角色卡、隐私记录都是运行时数据，安装后才写到 `<DSH_HOME>`，不随包分发。
- 爱ai 只管 QQ 会话的压缩，不接管 web GUI 的全局压缩。
- 失败不挡聊天：记忆写盘失败只记日志，不回滚你的对话。
- 互通只搬记忆，不搬人设；`link.json` 读取失败时按「两边都开」处理。

## 许可

MIT，见 [LICENSE](LICENSE)。
