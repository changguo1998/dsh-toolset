# plan 只读预设恢复未生效（接取条目：docs/BACKLOG.md「plan 只读预设恢复未生效」）

状态：关闭　　开启：2026-11-18　　关闭：2026-11-18
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

计划段终态 / 树完成 / 切走时, plan-mode 的权限预设恢复（read-only → 原预设）应可靠发生。当前实测计划段已 done 但 DSH 文件策略仍停留在 read-only。

## 调研

条目原文二疑: provider 未被触发、或 `ctx.get("taskEngine")` 解析不到导致 `planTerminal` 恒 false。逐项考证后两疑均**不成立**, 实际根因是第三处。

### 已排除的疑点（含证据）

- **宿主 pre-step 载荷是否带 agent**: 宿主 `packages/core/agent-loop/src/agent.ts:302-303` 经 fused dispatcher 派发 `agent/pre-step`, `packages/core/agent/src/dispatch.ts:113-118` 的 `fused(payload)` 把 `agent` 注入载荷; `agent/src/runtime-types.ts:351` 载荷契约确认 `{ agent, messages, turn, step, signal, modelSelection }`。
- **root 级 listener 能否收到 agent-scoped 事件**: `packages/core/scope/src/index.ts:170-185` 的 `scopeTarget` 过滤器对未打 scope tag 的 listener（`scopeOf(ctx) === undefined`）直接放行, 根 ctx 订阅的 pin-note 必然收到。
- **任务引擎快照可读性**: 真宿主 e2e 实测 `ctx.get("taskEngine").query()` 可读, plan_start 建树后帧 id 在 `tasks` 里, `planTerminal` 数据链路通。
- **pin-note 的 pre-step 注入机制**: 真宿主 e2e 手动登记 `pinNotes.hold("debug-hook", () => "DEBUG-INJECTED-TEXT")` 后, pre-step handler 正常输出该文本 → holds 遍历 / 折叠 / 注入链路完好。

### 实测复现（真宿主 e2e, 临时文件 `e2e/plan-mode-dbg.test.ts`）

装配 `plan-mode`（被测包, bundles[0]）+ task-engine / pin-note / memory-base / flow-arbiter 等。流程: `flow_select(plan)` → `plan_start`（`presetSwitched: true`, 真切到 read-only）→ 手动以宿主载荷形态触发 pin-note 的 pre-step handler → 检查:

- 阶段注入文案（探索段应为「当前段: 探索（只读）…」）**未出现**;
- 取消选中后（`arbiter.current` 已 null）**预设仍 read-only, 未恢复**;
- 但同链路手动登记的 debug hold 却能正常注入。

结论: **pin-note 侧一切都好; 断裂点是 plan-mode 的 `pinNotes.hold("plan-mode", …)` 没有登记成功**——provider 从未挂到 pin-note 的 holds 上, 轮询恢复因此永不发生。

### 根因

`plan-mode/src/index.ts:315-329` 在 `apply()` 时对 `pinNotes.hold` **只尝试一次**; 装配顺序下 plan-mode 会先于 pin-note（其依赖 memory 等服务）就绪并 apply, 此时 `readService(ctx, "pinNotes")` 返回 undefined, 走告警分支「ctx.pinNotes 不可用, 轮询恢复不会发生（只剩会话结束与插件卸载两条入口）」后**永不补登记**。

对照: task-engine 遇到过同一时序问题, 已用 `ensureTaskHold()` + `beforeExecute`（每次工具调用前重试补登记, `task-engine/src/plugin.ts:400-418`）解决; plan-mode **没有抄这一机制**, 是遗漏。

真机 fff profile 声明顺序虽然 pin-note 在 plan-mode 前（`package.json` bundles 87/90）, 但 cordis 按依赖拓扑使插件在**各自依赖就绪后即 apply**, plan-mode 只依赖 tools, 必然先于 pin-note（需 memory）apply → 真机同样命中该缺陷。用户实测「计划段已 done 未恢复」与此完全吻合。

## 决策

- 决策项 1 = 修复载体（给 plan-mode 补登记）:
  - a. 仿 task-engine: `ensurePlanHold()` + 在 `tools/pre-execute` 回调开头每工具调用前重试登记（选定）——与既有先例同构, 无新事件 / 无轮询, 覆盖面「任一工具调用」≥「plan 流程内所有推进动作」;
  - b. 订阅宿主服务就绪事件重试——宿主无该事件面, 需要新契约;
  - c. 定时器轮询——不优雅, 引入新周期。
  - 选定 **a**。另在 apply 末尾保留首次尝试（事先已就绪的正常路径零延迟）。
- 决策项 2 = 是否顺带改 pin-note: 不改。pin-note 的订阅依赖 store（memory 就绪）与 `hold()` 内 `subscribe()`（handler 赋值后调用）现状自洽; plan-mode 补登记后, 在 apply 之后调用 hold 即触发订阅, 链路闭合。
- 决策项 3 = 验证方式: e2e 自动化闭环（诊断文件转正 `e2e/plan-mode-restore.test.ts`）+ 单测补登记; 真机 fff 人工确认留待用户择时。

## 规划

计划改动文件清单:

- `plan-mode/src/index.ts` — 新增 `ensurePlanHold()`（含 `holdRegistered` 标记与一次告警, 仿 task-engine ensureTaskHold）; apply 末尾与 `tools/pre-execute` 回调开头各调一次; 恢复逻辑（`holdProvider` / `restoreOnly` / `restoreAndDrop`）本体不动。
- `plan-mode/tests/index.test.ts` — 新测试: apply 时无 pinNotes → 首次工具调用（pre-execute）后补登记成功, provider 可被调用并返回阶段文案 / 触发恢复; 保持既有用例全绿。
- `e2e/plan-mode-dbg.test.ts` → 转正为 `e2e/plan-mode-restore.test.ts` — 断言: (1) pre-step 触发后阶段文案注入; (2) 切走后预设恢复 workspace-write; 删除诊断文件的调试输出。
- `plan-mode/README.md` — 补登记说明（pinNotes 缺席 / 先后 apply 时的补登记与告警口径）。
- `docs/BACKLOG.md` — 本条目标记更新与最终清理（收尾时）。

明确不做:

- 不改 pin-note / task-engine / 宿主;
- 不改恢复触发条件本身（计划段终态 / 树完成 / 切走 / 会话结束 / 卸载 五入口的语义保持现状）;
- 不做 `record.session` 悬空假设的加固（本任务无证据, 不扩大范围; 若真机残留可另立条目）。

## 实现记录

- 2026-11-18 根因定位中的关键转折: 临时诊断 e2e（`e2e/plan-mode-dbg.test.ts`）在「修复后」仍复现 provider 未被调——查 `plan-mode/package.json` 的 `main` 指向 `dist/src/index.js`, 而 host 经 profile 软链接加载的就是 **dist 编译产物**; 之前所有「修复前后」对比都在测旧产物, 属假象。`pnpm -C plan-mode run build` 后重跑, 修复即生效。
- `plan-mode/src/index.ts`: 新增 `ensurePlanHold()`（含 `holdRegistered` / `holdWarned`, 仿 task-engine `ensureTaskHold`）; apply 末尾与 `tools/pre-execute` 回调开头各调一次; `holdProvider` 本体未动。
- `plan-mode/tests/index.test.ts`: 新增「pinNotes 迟到: apply 时不可用告警一次, 首次工具调用后补登记, provider 生效」。
- `e2e/plan-mode-dbg.test.ts`（临时诊断）→ 转正为 `e2e/plan-mode-restore.test.ts`（断言: 建树后 pre-step 注入「当前段: 探索」, 切走后预设恢复 `workspace-write`）。
- `plan-mode/README.md`: 补登记说明（§权限预设切换与恢复）。

## 偏差

无。

## 测试与证据

- 单测: `pnpm -C plan-mode run check` / `build` / `test` —— 65 例全绿（新增补登记用例）。
- e2e（真宿主, dsh-base + plan-mode + task-engine + pin-note + memory-base + flow-arbiter 等）:
  - 新增 `e2e/plan-mode-restore.test.ts`: plan_start 切只读 → 手动以宿主载荷形态触发 pre-step（pin-note handler）→ 断言注入「当前段: 探索（只读）…」; `flow_select` 取消选中后再次触发 → 断言 `permissionPresets.current` 回到 `workspace-write`。通过。
  - 回归 `e2e/plan-mode.test.ts`（建树 + 顺序强制 + 探索段写拒）: 通过。
  - 关键前提: 对 `plan-mode` 的 e2e 需先 `pnpm -C plan-mode run build`（host 经 `main: dist/src/index.js` 加载编译产物, src 改动不 build 不生效——排查时已踩坑并记录）。
- 真机 fff 人工确认（计划段完成后自动恢复）: 未做, 留待用户择时（e2e 已覆盖同一机制的自动化闭环; 计划段 done 为 human 验收, 无法在 e2e 自动达成, 与 `docs/archived/2026-11-15-plan-mode-non-flow-control.md` T16 边界一致）。
- 全仓: `pnpm run check` / `build` / `test` / `check:docs` 通过（plan-mode 单测 65/65）; `pnpm run test:e2e` 44/44 全绿（含新增 `e2e/plan-mode-restore.test.ts` 与回归 `e2e/plan-mode.test.ts`）。

## 收尾

- 回写: `plan-mode/README.md` 补登记说明; `docs/BACKLOG.md` §1 登记完成行、§2 移除条目（未完成项清零）; 本追踪文档移入 `docs/archived/2026-11-18-plan-preset-restore.md`。
- 残留: 无。临时诊断文件 `e2e/plan-mode-dbg.test.ts` 已删除; 临时诊断日志已从 `src/index.ts` 移除; `dist/` 为本任务构建产物（gitignore, 不入库）。
- 遗留: 真机 fff 会话人工确认（计划段 done 后预设自动回写）由用户择时; e2e 已覆盖同一机制的自动化闭环（human 验收段无法在 e2e 自动达成, 与 T16 边界一致）。
