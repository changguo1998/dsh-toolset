# 检查官方 deepseek-harness 更新（接取条目：docs/BACKLOG.md「检查官方 deepseek-harness 更新（新 rc 版本与接口约定变动）」）

状态：规划　　开启：2026-10-19　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

查官方 deepseek-harness 发布渠道（npm `@deepseek-ai/*`、GitHub releases 等）确认最新版本 vs 当前基线 `dsh-v0.2.0-rc.2`；若存在新版本，对照工具 / 事件 / 服务面接口约定（尤其本仓实际消费的 `ctx` 面与 `tools/pre-execute` 的 `ToolExecution` 载荷形状）列增删改清单，产出 `docs/host/HOST-UPGRADE-<版本>.md` 对照记录；与用户裁定是否升级基线（升级则按 `scripts/install.sh` 流程同步默认版本与主要版本引用，并按 HOST-UPGRADE 流程复核 `HOST-PACKAGES.md` 与既有消费方）。验收：给出「官方最新版本 vs `0.2.0-rc.2`」结论；接口有变动则给逐项增删改清单与本仓影响判定；结论落盘（无变动也留注记）。

## 调研

（待写 —— 用户指示：新建追踪文档后、调研前先停下。已预置的查证渠道：npm `@deepseek-ai/dsh` 等发布版本 / GitHub `deepseek-ai` 仓库 releases / 已装宿主包 `@deepseek-ai/dsh` 与 `docs/host/HOST-UPGRADE-0.2.0-rc.2.md` 既定对照口径。）

## 决策

（待写。待决点：① 官方是否有新 rc / 正式版；② 接口变动是否波及本仓 29 模块消费的官方面（`HOST-PACKAGES.md` 实挂行 / `ctx` 面）；③ 是否升级基线，升级后 `scripts/install.sh` 默认版本与主要版本引用是否同步。）

## 规划

任务拆分：

- 查证：确认官方最新版本号与发布时间（npm 与 GitHub 双渠道交叉）。
- 对照：若无新版本 → 直接落结论注记；若有 → 逐项列工具 / 事件 / 服务面增删改（读新版本源码与 0.2.0-rc.2 比对）。
- 裁定与产出：写 `docs/host/HOST-UPGRADE-<版本>.md`；升级与否由用户裁定，升级则同步 `scripts/install.sh` 默认版本 / 版本引用 / smoke 门槛，并复核 `HOST-PACKAGES.md` 与既有消费方（`HOST-PACKAGES` 只按升级流程刷）。

计划改动文件清单（预估；无变动则只留注记与清单外零改动）：

- `docs/host/HOST-UPGRADE-<版本>.md`（有变动时新增）
- `docs/host/HOST-PACKAGES.md`（仅升级基线时按其自身流程刷）
- `scripts/install.sh`（若升级：默认版本 + 主要版本引用 + smoke 门槛）
- 本追踪文档

明确不做：不自动升级基线（升级须用户裁定）；不改各包代码；

## 实现记录

（待写。）

## 偏差

（待写。）

## 测试与证据

（待写。）

## 收尾

（待写。）
