# background-daemon 真机验证（接取条目：docs/BACKLOG.md「background-daemon 真机验证（已挂载，发现 timer 适配缺陷）」）

状态：规划　　开启：2026-10-19　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

在 `~/.dsh/profiles/fff` 已挂载 `@dsh-toolset/background-daemon` 的前提下，修掉 timer 适配缺陷（`src/scheduler.ts:32` 的 `TimerLike` 按 `schedule(delay, cb)` 读宿主，宿主 `cordis-plugin-timer` 只有 `timeout(cb, delay)`，与设计 D16「用 `ctx.timer` 的 `timeout()`」不符），跑通四条端到端（文本投递 / 命令执行 / 重启恢复 / 无活跃 agent 的 `skipped`）与 `backend=memory` 路径；验收按条目：四条端到端各一次通过，memory-base 可用时 `/daemon` 状态面报 `records: memory`。

## 调研

（待写 —— 用户指示：新建追踪文档后、调研前先停下。）

## 决策

（待写。）

## 规划

任务拆分：

- 修缺陷：`background-daemon/src/scheduler.ts` 的 `TimerLike` 改为按宿主 `ctx.timer.timeout` 语义适配；单测保持 136 例全绿并补适配回归。
- 真机端到端：在 fff profile 环境（dependencies + bundles + node_modules 软链已就位）按设计 §C 跑四条端到端 + `backend=memory` 路径，核对启动日志无「不可用」告警、`/daemon` 与 `daemon_task` 注册成功。
- 与「新增定时插件」条目的衔接：若该插件先行落地统一 timer 面，本处可改切统一面（顺序由用户裁定）。

计划改动文件清单（预估）：

- `background-daemon/src/scheduler.ts`（`TimerLike` 适配宿主 timeout）
- `background-daemon/tests/**`（适配回归用例）
- 本追踪文档
- 真机验证动作在 profile 侧，不落仓库（如需补 `profiles/example` 再登记）

明确不做：不做周期投递等新功能；不重做已合入的设计；不推进 `/daemon` 之外的通路。

## 实现记录

（待写。）

## 偏差

（待写。）

## 测试与证据

（待写。）

## 收尾

（待写。）
