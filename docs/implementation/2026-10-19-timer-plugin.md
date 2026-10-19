# 新增定时插件（统一 timer 原语）（接取条目：docs/BACKLOG.md「新增定时插件（统一 timer 原语）」）

状态：规划　　开启：2026-10-19　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

新增一个本仓定时插件 / 统一面，封装宿主原语（`cordis-plugin-timer` 的 `timeout(cb, delay)` / `interval(...)`，fiber 绑定、无 `schedule`）与进程内回退，至少含 `schedule(delay, cb) → dispose`、`now()`、可注入假时钟，供各包按需注入、卸载不泄漏；消费方（`TUI` 的 `StatusTicker` / `session-channel` 心跳 TTL / `background-daemon` 的 `TimerLike` / `metric-loop` 测量节奏）统一走该面。先按条目「接取时裁定」三项定形态。

## 调研

（待写 —— 用户指示：新建追踪文档后、调研前先停下。）

## 决策

（待写。待决点：① 形态：独立新包 vs 放进既有工具包；② 接口形状：是否对齐宿主 `timeout` 语义、是否带假时钟注入；③ 与宿主 `cordis-plugin-timer` 的关系：包装 / 并存 / 替代托管。）

## 规划

任务拆分：

- 决策 ①②③（形态 / 接口 / 与宿主关系）。
- 落地统一面（新包或既有公共层）+ 单测（假时钟、卸载无残留 timer、进程内回退路径）。
- 消费方逐个切换：`TUI` / `session-channel` / `background-daemon` / `metric-loop`，每个消费方切换前单独核验回归。

计划改动文件清单（预估，形态决策后定稿；清单外文件需用户裁定）：

- 若新包：`package.json` / `cordis.patch.yml` / `src/**` / `tests/**` / `README.md` / 模块级 `docs/BACKLOG.md`（新建包需登记条目）
- 若「放进既有公共层」：对应包内文件
- 消费方：`TUI/src/app/**`（`StatusTicker` 相关）、`session-channel/src/**`（心跳 TTL）、`background-daemon/src/scheduler.ts`、`metric-loop/src/**`
- 本追踪文档

明确不做：不替代宿主 `cordis-plugin-timer` 的托管（决策前语义为「包装 / 并存」）；不做定时任务的持久化 / 补偿；不改宿主代码。

## 实现记录

（待写。）

## 偏差

（待写。）

## 测试与证据

（待写。）

## 收尾

（待写。）
