# flow-track 阶段顺序约束与回退工具（接取条目：docs/BACKLOG.md「flow-track 阶段顺序约束与回退工具」）

状态：已关闭　　开启：2026-11-06　　关闭：2026-11-06
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

把 `flow_record` 从「任意阶段随便写」收紧为一条时间线，只允许两种写入：

1. **更新当前阶段内容**：写入与当前阶段相同的阶段名 → 先删掉该阶段的旧记录再写入（替换，id 会变）；
2. **新增下一阶段内容**：写入当前阶段的下一个阶段 → 追加。

跳过阶段、倒回阶段一律拒绝并指路；倒回改走新工具 `flow_rollback`（回到某阶段并清掉目标之后的记录）。首条记录必须从 `目标` 开始。

## 调研（既有代码与裁定）

- 现状：`flow_record` 只校验 `slug` 非空与 `status` 枚举（`flow-track/src/tools.ts:107-126`），阶段名由 JSON schema 枚举约束但不校验顺序；`store.record` 只要求 `slug` / `stage` 非空（`flow-track/src/store.ts:187`）。
- 记录形态：每条记录 = 一行（`title = <slug>@<阶段>`、`content = 状态: <status>` + 正文），`FlowStore.list({ slug })` 按时间正序返回（`flow-track/src/store.ts:297`）。
- 删除面：`FlowStore.remove` 已走 `MemoryScope.forget`（本会话前一条提交 `76377ff1`），可按 id 批量删。
- 阶段表：`STAGES`（`flow-track/src/stages.ts`，目标 / 调研 / 决策 / 规划 / 实现 / 测试 / 审查 / 收尾）；`-` 表示整体推进。
- 裁定（2026-11-06 用户）：当前阶段按**最新记录**判定（不看任务树快照）；更新语义 = **替换该阶段记录**；回退 = **独立工具**；首条必须从 `目标` 起。

## 决策

- 当前阶段：该 slug 时间线上**最新一条 `stage !== "-"` 的记录**的阶段名；`-` 只作整体备注，不参与推导。
- 允许的写入（逐 slug 判定）：
  - 无任何非 `-` 记录 → 只接受 `stage = 目标`；`-` 拒绝（`first_stage`）；
  - 与当前阶段相同 → 替换（删该阶段全部旧记录后写入）；
  - 等于当前阶段的下一阶段 → 追加；
  - 更靠后 → 拒绝 `skip_stage`，文案给当前阶段与下一阶段名；
  - 更靠前 → 拒绝 `rollback_needed`，文案指 `flow_rollback`；
  - `-`（已有记录时）→ 追加备注，不改阶段。
- `flow_rollback({ slug?, stage })`：目标阶段必须**早于**当前阶段（相等或更后拒绝 `not_backward`，指 `flow_record`）；删掉时间线上阶段序大于目标的记录**以及所有 `-` 备注**；只删不写，回执 `removed`、目标阶段与删除的 id。
- 未知当前阶段（历史脏数据，如阶段名不在八阶段内）拒绝并指 `flow_remove`，避免在坏状态上继续写。
- 顺序策略做成纯函数模块 `src/policy.ts`（`decideRecord` / `decideRollback`），便于单测；存储与工具只做执行。

## 计划改动文件清单

- `flow-track/src/policy.ts`：新增（阶段序推导 + 写入判定 + 回退判定，零 IO）。
- `flow-track/src/store.ts`：`FlowStore.removeMany(ids)`（`remove` 复用它）。
- `flow-track/src/tools.ts`：`flow_record` 接入判定与替换、新增 `flow_rollback`、工具顺序与相关链接。
- `flow-track/src/index.ts`：无结构改动（工具循环注册自动带上新工具）。
- `flow-track/tests/policy.test.ts`：新增（首条 / 更新 / 新增 / 跳过 / 倒回 / `-` / 未知当前阶段 / 回退判定）。
- `flow-track/tests/store.test.ts`：`removeMany` 用例。
- `flow-track/tests/main.test.ts`：端到端用例（顺序拦截、替换旧 id 消失、回退清后续）。
- `flow-track/README.md`：工具表、顺序规则、测试条数。
- `AGENTS.md`、`README.md`、`README.zh.md`：包描述补 `flow_rollback` 与顺序约束。

## 实现记录

- `src/policy.ts`（新增）：`STAGE_NAMES` / `WHOLE_STAGE` / `stageIndex` / `latestStageRecord`（跳过 `-` 找最新真实阶段）/ `decideRecord` / `decideRollback`。拒绝码：`first_stage` / `invalid_stage` / `skip_stage` / `rollback_needed` / `unknown_current`；回退拒绝码：`invalid_stage` / `no_records` / `unknown_current` / `not_backward`。
- `src/store.ts`：新增 `removeMany(ids)`（空列表直接成功），`remove` 改为复用 `removeMany`。
- `src/tools.ts`：`flow_record` 写入前先 `list({ slug })` 取时间线 → `decideRecord` → 拒绝直接回错；`replace` 时先删该阶段旧记录再写入，回执带 `replaced`；新增 `flow_rollback`（`slug?` + `stage`, 判定后 `removeMany`, 只删不写）；工具顺序 `flow_record` → `flow_status` → `flow_remove` → `flow_rollback`。
- `src/index.ts`：无改动（工具循环注册自动带上新工具）。
- `tests/policy.test.ts`（新增 11 例）：阶段表 / 空时间线 / 坏阶段名 / 同阶段替换 / 下一阶段 / `-` 备注 / 跳过 / 倒回 / 未知当前阶段 / 最后阶段 / 回退判定。
- `tests/store.test.ts`：补 `removeMany` 1 例。
- `tests/main.test.ts`：原 `flow_record` 用例改为按序写入；新增 4 例（顺序拦截、同阶段替换旧 id 消失、回退清后续与 `-`、回退坏参数与 slug 兜底）。
- 文档：包 README 工具表 + 顺序规则 + 边界 + 测试条数 + 真机验证步骤；`AGENTS.md` 与根 README 双侧包描述补 `flow_rollback` 与顺序约束。

## 偏差

- **替换 = 删旧 + 写新**：memory-base 没有原地更新接口，`replace` 走 `removeMany` + `put`，因此记录 id 会变、`createdAt` 会刷新；回执里用 `replaced: true` 标出这是替换。
- **`-` 保留为备注**：用户口径只约束「更新当前阶段 / 新增下一阶段」；`-` 不进阶段序、不参与当前阶段推导、首条不允许，已有记录时随时可写。
- **历史数据向前兼容**：旧记录若首条不是「目标」，新规则不追溯纠正——当前阶段只看最新一条非 `-` 记录；只有最新阶段不在八阶段内才拒绝并提示 `flow_remove`。
- **未做真机验证**：新工具与顺序约束要重启会话后才在工具面生效。

## 测试与证据

- `pnpm -C flow-track run check`：`tsc --noEmit` 通过。
- `pnpm -C flow-track run build`：编译到 `dist/` 通过。
- `pnpm -C flow-track run test`：73 例全过（阶段 6 / 状态 7 / 存储 13 / 观测 6 / 注入 9 / 顺序 11 / 接线 21）。
- `pnpm run check:docs`：0 错误 0 警告。
- 未做真机验证（见「偏差」）。

## 收尾

- 提交：本文件与 BACKLOG 条目（决策阶段）、实现与测试、关闭提交（文档同步 + 归档）。
- BACKLOG 条目在关闭时移除；追踪文档移入 `docs/archived/`。
- 残留（不另立条目）：真机验证待重启后确认；`-` 备注在 `flow_status` 里仍以 `-` 阶段展示。
