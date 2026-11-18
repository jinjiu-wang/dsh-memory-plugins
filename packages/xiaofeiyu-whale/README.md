# 小肥鱼鲸鱼娘

独立记忆插件：托管 Python SQLite 记忆库，在 DSH 左侧栏提供图标和面板，并与「爱ai」插件通过规范 JSONL **自动双向联通**。

- 纯记忆功能：只交换摘要、事实、待确认、备注；不包含角色卡、人设、语气等任何设定。
- DSH 启动即自动运行：Host 拉起本机 Python 记忆服务（stdio，不监听端口），前端侧栏图标随 DSH 加载。
- 两边各有一个总开关：本插件面板一个、「爱ai」面板一个；**任何一边关掉，自动联通都会停**。手动「立即同步」仍可强制跑一次。
- 记忆数据库只在本机，不上传。

## 安装

```bash
node install.mjs
```

装完必须**完整退出 DSH**（托盘退出，不是关窗口）再重新打开。

常用参数：

```bash
node install.mjs --dry-run                 # 只看计划，不写盘
node install.mjs --profile desktop         # 指定 ~/.dsh/profiles 下的 profile
node install.mjs --dsh-home "C:\tmp\dsh"   # 沙盒 / 自定义 DSH_HOME
node install.mjs --python "C:\...\python.exe"
node install.mjs --data-dir "D:\..." --bridge-dir "D:\..."
```

安装器会：

1. 把插件复制到 `<DSH_HOME>/plugins/xiaofeiyu-whale`；
2. 以 `file:` 依赖装进 profile，并注册 `dsh.profile.bundles`；
3. 把目录与开关默认值写进安装副本的 `cordis.patch.yml`；
4. 校验 JS/Python 语法与 Python 运行时。

## 面板

侧栏「小肥鱼鲸鱼娘」：

- **记忆概览**：消息、今天、摘要、事实、群、私聊数量，数据库路径，Python 进程状态。
- **与「爱ai」自动联通**：本插件开关、对方开关状态、立即同步、互通目录与上次同步结果。
- **最近事实 / 最近摘要**：最近 12 条，跨会话只读展示。
- **记忆检索**：SQLite FTS 检索原话。

「爱ai」侧栏面板的「与『小肥鱼鲸鱼娘』自动联通」区块有同一个开关和同步按钮。

## 互通目录

默认 `<DSH_HOME>/memory-bridge`（通常是 `~/.dsh/memory-bridge`）。如果安装时改了 `--bridge-dir`，记得把「爱ai」的 `memoryBridgeDir` 指到同一个目录，否则两边各写各的，不会联通。

| 文件 | 写入方 | 读取方 |
| --- | --- | --- |
| `ai-love.jsonl` | 爱ai | 小肥鱼鲸鱼娘 |
| `xiaofeiyu-whale.jsonl` | 小肥鱼鲸鱼娘 | 爱ai |
| `link.json` | 两边共写 | 两边共读 |

`link.json` 缺省时两边都视为开启：

```json
{
  "aiLove": true,
  "xiaofeiyu": true,
  "updatedAt": 0
}
```

自动同步条件：本地面板开关开启 **且** `link.json` 里 `aiLove === true` **且** `xiaofeiyu === true`。

写入采用「临时文件 + 原子替换」，两边同时同步也不会读到半个 JSONL。

## 数据目录

默认 `<DSH_HOME>/xiaofeiyu-whale/`：

- `memory.db`：SQLite 记忆库（消息、摘要、事实、会话作用域）。
- `settings.json`：本插件面板的自动联通开关。

爱ai 的本地开关存在 `<memoryDir>/interop/auto.json`，不会混进记忆正文。

## 卸载

```bash
node uninstall.mjs
```

默认保留记忆数据库与共享互通目录；只有加 `--purge` 才会删除 `<DSH_HOME>/xiaofeiyu-whale`。共享互通目录即使 `--purge` 也保留（爱ai 也在用）。

## 自检与测试

```bash
node verify.mjs       # 只读校验安装与文件
node selfcheck.mjs    # 临时目录里跑配置、开关、Python 服务与烟测
node --test test/smoke.mjs
```

## 排查

- **侧栏没有图标**：确认 profile `package.json` 的 `dsh.profile.bundles` 含 `xiaofeiyu-whale`，且 `node_modules/xiaofeiyu-whale` 存在；完整退出 DSH 后重开。
- **面板显示「未运行」**：看面板上的 Python 路径与错误信息；可用 `--python` 重新安装指定解释器，或设环境变量 `XIAOFEIYU_PYTHON`。
- **不自动同步**：检查两边面板开关；再看 `link.json` 是否有一边为 `false`。手动「立即同步」会忽略自动开关，只做一次。
- **找不到 Python**：安装器优先用 `<DSH_HOME>/dsh-runtimes/*/dependencies/python/python.exe`，其次 `python.exe` / `python3`。
