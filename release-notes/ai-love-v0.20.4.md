# 爱ai 0.20.4

记忆压缩 + 角色卡 + 隐私记录 + 跨插件互通。面向 DSH 的 QQ 会话。

## 这个版本带什么

- **压缩**：接管 QQ 会话压缩后端；纯事实记忆卡（拒绝人设/语气/情绪小节）；提案式自检，AI 同意才压。
- **记忆**：长期事实按会话隔离并注入提示；拿不准进档案、下一轮提醒追问；面板可回复并回传 QQ。
- **档案**：角色卡（二级改动需 AI 表态 + 管理端放行）、隐私记录（只由 AI 写，按亡语/永恒秘密读取）、压缩留痕、token 统计。
- **防护**：核心记忆档案 SHA-256 基线；运行时防火墙 v2。
- **备份**：面板文字备份 + 一键找回；会话日志与记忆档案逐字节镜像；会话日志只读联通。
- **互通**：规范记录 v1 的 JSONL 双向导入导出；与小肥鱼鲸鱼娘自动联通。

## 与上一个纯净包（0.20.0）相比

**新增模块**

- 运行时防火墙：`src/core/firewall.mjs` + 6 组对抗日志/性能测试（`test/firewall*.mjs`）。
  四层拦截：出站网络、监听端口、越界写盘、危险子进程；记账到 `<memoryDir>/firewall.log`。
  按层临时关闭：`AI_LOVE_FW_NET` / `AI_LOVE_FW_PORT` / `AI_LOVE_FW_DATA` / `AI_LOVE_FW_PROC`。
- 安全屋：`src/safehouse/*`（压力采样、规则、密钥、通道、agent hooks、服务）。
  DSH 侧只负责采样和状态；要挡住 QQ 唤醒，需要在 qq-bridge 侧接入 `bridge/safehouse-gate.mjs`，
  补丁步骤写在 `bridge/安全屋接入.md`。门闸 fail-open：读不到、过期、坏文件一律按「不挡」。
- 自进化沙盒：`src/evolve/*`（闭环调度、注册表、哈希链日志、写入闸门、只读路由）。
  默认不启用，只写 `<memoryDir>/.evolve/`。

**修改**

- 安装器：识别 qq-bridge 是否已接入安全屋门闸；备份隔离预检；逐字节备份根参数 `--memory-backup-dir`。
- 面板 / 宿主 / 互通 / 记忆清洗逻辑同步更新；自检与校验脚本扩充（`selfcheck.mjs`、`verify.mjs`）。

## 数据

运行时数据写在 `<DSH_HOME>/ai-love/`，不随包分发。角色卡安装后是空的。

## 校验

```powershell
node verify.mjs
node selfcheck.mjs
node --test test/smoke.mjs
```

## 许可

MIT。
