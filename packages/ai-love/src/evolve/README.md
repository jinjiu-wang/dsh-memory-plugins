# 爱ai · 自进化板块

> 沙盒原型，未安装到 DSH。所有写入只落在 `<memoryDir>/.evolve/`。

## 五个零件

| 文件 | 管什么 | 关键约束 |
|---|---|---|
| `loops.mjs` | 工程化闭环调度 | observe → plan → act → verify → **四阶段缺一不可**；verify 必须明确 `ok:true` 才提交；每阶段原子落盘可续跑；同机跨进程 `cycle.lock` 互斥且**活进程的锁绝不强抢**；commit 按环号幂等，写日志失败保留已验证产物、下轮先复核产物再重试；状态坏了自己备份并从日志恢复高水位；失败/放弃只清未验证的半成品 |
| `registry.mjs` | 模块化扩展 | id 唯一、能力名唯一（不允许后者覆盖）、依赖必须齐、缺一个整批拒绝、自依赖直接拒、拓扑序加载；加载失败把已起来的反序拆掉并允许修好后重试；加载开始后拒绝新注册 |
| `journal.mjs` | 状态可追溯 | JSONL 哈希链，改/删任意一行都能定位；崩溃留下的半行下次追加前截断并记 `journal.repair`；文件中间坏行 fail-closed；跨进程 `journal.jsonl.lock` 保证 seq 不重号 |
| `guard.mjs` | 写入闸门 | 只准写 `<memoryDir>/.evolve/`；用 realpath 判真实位置，并逐级拒绝 junction / 符号链接（`mklink /J` 绕不过去） |
| `index.mjs` | 运行时与宿主集成 | 四个内置板块由注册表驱动；只读路由 `GET /ai-love/evolve/state`（非 GET 405）；可选定时调度 |

## 闭环语义

```
observe  → 拍记忆指纹 + 统计
plan     → 生成候选（只读观察结果）
act      → 在 .evolve/archive/ 原子写一份产物
verify   → 日志链 + 产物 sha/环号/goal + 记忆对称差（新增/丢失/改动都算）
commit   → 只有 verify.ok === true 才写 committed
```

- 同一时刻只跑一个环：同进程重入返回 `status: 'busy'`，同机另一进程由 `cycle.lock` 挡住（`reason: 'locked'`）；锁按持有进程是否存活判定，活进程的锁不会被时间阈值抢走。
- 每次运行先加 `attempts`；超过 `maxAttempts` 记 `cycle.abandoned` 并清掉产物；已经 verify 通过的产物不清。
- `act` 崩溃后重跑会复用预留的归档路径，不会留下两份孤儿文件。
- 记忆基线在 `act` 动手之前才拍，观察与动手之间（含崩溃等待）的外部改动不会算成循环写的。
- `commit` 写日志失败不会删已验证归档：环保持 pending，下一次运行**重新复核归档 sha 后**再提交（不重算记忆差，避免等待期间用户自己写记忆把环判死）。
- `state.json` 坏了不会把环号清零：原文件改名为 `state.corrupt-<ts>.json`，
  从 `journal.jsonl` 和 `archive/` 恢复已提交环号与高水位，并记 `state.recovered`。
- 启动时清理 `.evolve/` 下超过 10 分钟的 `*.tmp-*` 半成品。

## 怎么接进爱ai

爱ai 的宿主入口是 `src/host/panel.mjs` 的 `export function apply(ctx, config)`。
这个板块按同样的形状提供 `apply`，通过同包子路径导出：

```json
// package.json
"exports": { "./evolve": "./src/evolve/index.mjs" }
```

```yaml
# cordis.patch.yml
- insert:
    - id: ai-love-evolve
      name: 'ai-love/evolve'
      config:
        memoryDir: ''
        intervalSeconds: 1800   # 自主进化间隔；0 = 只保留手动/测试入口
        runOnStart: false
        maxActions: 8
        maxAttempts: 3
```

> `name` 必须是 Node 能解析的包名/子路径。写成 `ai-love-evolve` 会解析失败，
> loader 只记一条日志然后跳过，等于没装。

面板路由是只读的：`GET /ai-love/evolve/state`，返回模块列表、日志链状态、
当前环状态、最近事件和调度器状态。

## 数据落点

全部在 `<memoryDir>/.evolve/`：

- `journal.jsonl` 事件链（哈希链），追加时用 `journal.jsonl.lock` 跨进程互斥
- `state.json` 环状态（含未完成的 pending，用于续跑），运行环时另有 `cycle.lock`
- `archive/cNNNN.json` 每轮产物（含 cycle / goal / plan / 时间戳）
- `state.corrupt-<ts>.json` 坏状态备份（只在自愈时出现）
- 所有写入先落 `*.tmp-<pid>-<ts>` 再 rename，启动时清掉超过 10 分钟的残留

记忆文件（activity / uncertain / summaries / character / guard …）**一个字节都不写**；
`GuardCenter` 的扫描也显式跳过 `.evolve/`，不会把它误报成"新增文件"。

## 验收

沙盒验收在仓库根的 `test/run-tests.mjs`，覆盖 43 项：基础模块零丢失、
配置行可解析、日志半行/中段损坏、实例交替追加、**两进程并发追加不重号**、
**死进程残留锁可回收**、注册表原子性/重复能力/自依赖/加载回滚/
**失败可重试与加载后拒注册**、junction 越界、
闭环提交/续跑/act 崩溃复用路径/verify 失败/并发 busy/**跨进程环锁**/
状态自愈/attempts 放弃/归档篡改与**越界归档路径**/**真实 memory-touched 分支**、
**commit 写日志失败保留归档并重试**、**重试前归档被改则拒绝提交**、
**续跑基线取在动手之前**、**跨实例 status 即时可见**、路由 405、调度器注册与 **runOnStart 实跑**、记忆逐字节未变。
所有写操作都在 `report/work/` 的临时副本里跑，`data/` 只读。
