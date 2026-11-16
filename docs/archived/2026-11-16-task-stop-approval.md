# task_stop 人工门禁不弹审批面板（接取条目：`docs/BACKLOG.md`「task_stop 人工门禁不弹审批面板」）

状态：关闭　　开启：2026-11-16　　关闭：2026-11-16
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

修复 `task_stop` 对 human 级验收帧不弹审批面板、恒「拒绝或无人应答」fail-closed 的问题，使流程插件八阶段「审查」节点的人工门禁能正常弹出 TUI 审批面板并完成闭环。验收：human 级帧执行 `task_stop` 能触发宿主 `approval.request` 链路（`approval/asked` / 应答者被调用 / `allowed-once` 放行），TUI 侧面板有请求可答。

## 调研

来源：实测（真实宿主 e2e 复现）+ 官方源码研读（安装树 `@deepseek-ai/dsh@0.2.2-rc.3` 的 `dsh-user-approval` / `dsh-tools` / `dsh-scope` / `cordis`）。

- 现象复现（临时 e2e 脚本，`tmp/repro-approval.test.ts`，已删）：在真实宿主内建 agent、`turn/start` 开 turn、拆带 human 验收子帧、`task_implement` 后 `task_stop`，回执恒为「人工验收…未获批准（fail-closed）：拒绝或无人应答。」；在宿主根 ctx 与 approval 服务 ctx 上注册 unscoped `approval/request` 应答者均**未被调用**；会话里 `approval/asked=0`（该事件是 `approval.request` 方法**第一步**的审计 append）→ 证明 `approval.request` 根本没有被调用。
- 关键代码：`task-engine/src/plugin.ts` 旧实现（148-175 行）在 **apply 期** `const approval = (ctx as {get?}).get?.("approval")` 同步解析一次，`approveVia` 闭包捕获该值；`approval === undefined || typeof approval.request !== "function"` 时**静默**返回 false（无告警），hence 无 `approval/asked`、无 waterfall、无应答者。
- 时序根因：宿主 `user-approval` 服务在 profile 装配**之后**才激活；task-engine 的 `apply` 在其之前运行，`ctx.get("approval")` 在此刻返回 `undefined`。本包文档已明示同款坑——`plugin.ts` 219 行注释「apply 期服务 fiber 常未激活」，故 `subagents` / executor 等服务一律**执行期惰性解析**（`serviceResolver`），唯独 approval 用了 apply 期快照。
- 佐证（临时插桩）：在 apply 内 `process.stderr.write` 打 `apply 期 ctx.get("approval") = undefined`；同一宿主 boot 完成后 `host.ctx.get("approval")` 返回完整服务（含 `request` 函数）。二者对照坐实「apply 期拿不到、执行期拿得到」。
- 官方参考实现：`dsh-tools/src/pipeline.ts` 的 `serviceAsk` 在**工具执行期**经 `this.ctx.get('approval')` 解析（`exec.agent` 存在时），而非 apply 期；入参 `{ agent, toolName, callId, reason, displayReason, signal }`。
- 集成测试未抓到的原因：`task-engine/tests/assemble.ts` 的假 `ctx.get` 在 `apply()` 之前就把 `services["approval"]` 放好，apply 期同步解析也能命中 → 测试恒绿，掩盖实时序缺陷。
- 无关既有失败：`tests/integration/plugin.test.ts` 两条（「参数编译成 JSON Schema」「参数非法: decompose 缺 children / executor 非法」）在 HEAD 基线即失败（stash 对照），与本次改动无关（参数 schema 编译由 tool-surface `wrapToolDefinition` 接管后的断言过时），不属本任务范围。

## 决策

- 决策项 1 = approval 服务的解析时机。
  - 选项 a：维持 apply 期同步解析（现状）。
  - 选项 b：改执行期惰性解析，按工具执行 ctx → 插件 ctx 顺序重取（与 `serviceResolver` 同口径）。
  - 选定：**b**。理由：与包内既定模式（subagents / executor / pinNotes 全部执行期重取）一致；修正 apply 期拿不到服务的实时序问题；缺服务仍 fail-closed 语义不变。宿主 `approval.request` 要求 turn-enclosed，工具执行本就在 open turn 内，满足。
- 决策项 2 = 是否顺带传 `signal`。
  - 选项 a：保持只传 `{agent, toolName, reason}`。
  - 选项 b：按官方管道口径补传 `exec.signal`（已有则传）。
  - 选定：**b**。理由：`ApprovalLike.request` 结构面本就声明 `signal?`；宿主 `decide` 用 signal 竞速（工具中断即取消审批），与官方 `serviceAsk` 对齐，低风险。仅在有 `exec.signal` 时传，避免形状变化。

## 规划

任务拆分（单步完成，无并行）：

1. `task-engine/src/plugin.ts`：`approveVia` 改为执行期惰性解析 approval（`readService(exec) ?? readService(ctx)`），补 `signal`；删除 apply 期 `const approval` 快照。
2. `task-engine/tests/assemble.ts`：`ApprovalMode` 加 `late-allowed`（apply 之后该服务才进 `services`，模拟宿主 boot 顺序）；`afterApply` 登记。
3. `task-engine/tests/integration/plugin.test.ts`：新增守成测试用例「审批服务 apply 期缺席、执行期到场: 请求仍送达」。
4. 追踪文档 + BACKLOG 收尾（关闭时）。

计划改动文件清单：

- `task-engine/src/plugin.ts`
- `task-engine/tests/assemble.ts`
- `task-engine/tests/integration/plugin.test.ts`
- `docs/implementation/2026-11-16-task-stop-approval.md`（本文件）
- `docs/BACKLOG.md`（关闭时：条目清理 + §1 索引追加）
- `docs/archived/2026-11-16-task-stop-approval.md`（关闭时：追踪文档归档）

明确不做：

- 不改 TUI 审批桥（已核实接线完整；问题在宿主链路源头，TUI 侧无需改动）。
- 不修为 tool-surface 参数 schema 断言那两条既有失败（另立条目交其他 agent）。
- 不改 README / DESIGN（纯缺陷修复，行为语义不变）。

## 实现记录

- 2026-11-16 复现与定位：临时 e2e 脚本（真实宿主 boot，模拟 TUI 的 unscoped `approval/request` 应答者）复现「应答者零调用、approval/asked=0」；apply 期插桩坐实 `ctx.get("approval")` 返回 undefined。
- 2026-11-16 修复：`plugin.ts` `approveVia` 内每调用改 `readService<ApprovalLike>(exec, "approval") ?? readService<ApprovalLike>(ctx, "approval")`；移除 apply 期 `const approval` 快照与对它的闭包引用；入参补 `signal: exec.signal`（仅当存在）。
- 2026-11-16 守成测试：`assemble.ts` 加 `late-allowed` 模式（服务在 apply 之后注入）；`plugin.test.ts` 加守成测试用例。反向验证：临时把 `approveVia` 换回 apply 期快照 → 新用例红（`next` 指向 root，审批未放行）；恢复修复 → 绿。
- 2026-11-16 端到端验证：真实宿主 e2e 复现脚本改断言后全绿——`approval/request` 应答者被调用（`agent=有`）、`allowed-once` 后 `task_stop` 返回 `{ok:true, accepted:true, next:null}`。

## 偏差

- 无（实现与规划一致；TUI 侧未改，符合「明确不做」）。

## 测试与证据

命令与结果：

- `task-engine`: `pnpm run check` 通过；`pnpm run build` 通过；`pnpm run test` 203 例全绿。
- `task-engine`: `pnpm run test:integration` 18 例 → pass 16 / fail 2。fail 2 经 stash 对照为 HEAD 基线既有失败（tool-surface 参数 schema 断言过时），与本次改动无关。
- 仓库级：`pnpm run check` 全仓通过；`pnpm run test` 全仓通过（task-engine 203 pass 0 fail）。
- e2e：`e2e/task-engine.test.ts` 通过（1 pass 0 fail）。
- 真机复现脚本（临时文件 `tmp/repro-approval.test.ts`，用后删除）：修复前 0 调用、approval/asked=0、`ok:false`；修复后应答者被调用、`{ok:true, accepted:true, next:null}`、`approval/asked` 路径走通。

残留 / 需人工确认：

- TUI 审批面板的**最终真机呈现**（真实 dsh 会话 + 真实 TUI 进程弹窗并点「同意」）尚未人工确认——本任务在宿主链路层面根治了投递问题（应答者已能收到请求），且 TUI 桥的注册点（unscoped `runtime.on`）与复现脚本所用注册点同构；真机面板确认留给用户择时执行（可经 `fff-test` profile 跑一次 flow-track 八阶段的「审查」节点）。

## 收尾

- 回写文档：本次内容型文档仅本追踪文档；`README` / `DESIGN` 无行为语义变化，不需要回写。
- BACKLOG：`docs/BACKLOG.md` §2 条目「task_stop 人工门禁不弹审批面板」标记完成并清理移除（只留未完成项）；§1 已完成索引追加本任务条（含验收要点；`STATUS.md` 由用户择时更新）。
- 追踪文档：本文件移入 `docs/archived/2026-11-16-task-stop-approval.md`。
- 遗留项：TUI 面板真机确认（见「测试与证据」残留）；tool-surface 参数 schema 断言两条既有失败另开条目。
- BACKLOG 清理记录：§2 原第一条（`task_stop` 人工门禁不弹审批面板, P1, 待排查）删除；§2 现只剩「flow 流程记录删除失败（FOREIGN KEY constraint failed）」一条。
