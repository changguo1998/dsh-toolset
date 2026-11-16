# TUI slash 命令冲突与过时项清理（接取条目：docs/BACKLOG.md「TUI slash 命令冲突与过时项清理」）

状态：实现　　开启：2026-11-17　　关闭：
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

清理 TUI 可见 slash 命令的冲突与过时项：删 `/flow-track` 的 `on|off`（注入开关并入 flow-arbiter select 与配置，只留 `status`）；修 `/help` 缺失与过时文案；同步命令文档计数。全量排查其余命令冲突，确认唯一其它实质重叠为 `/collapse` 与 `/verbose`，用户裁定保留两命令、仅文案澄清。

## 调研

来源：flow-track / flow-arbiter / TUI 源码与既有文档、（本会话）真机命令清单。

- 三层命令现状：本地 45 条（39 命令 + 6 别名，`LOCAL_COMMANDS` 单一来源）；本仓插件注册 5 条（`/flow-track` `/flow-arbiter` `/daemon` `/autoapprove` `/playbook`）；宿主命令 `/compact` `/feedback` `/goal` `/permission` `/export`。
- flow 双命令重叠：`/flow-track on|off|status`（进程内存注入开关，`switch.ts`）与 `/flow-arbiter status|select <id>|off`（会话内存流程放行）互不知晓对方状态；`flow_start`/`plan_start` 由仲裁拦截，注入由 `/flow-track on` 拦截，用户开标准流程需两条命令且顺序敏感。属 2026-11-06 ~ 2026-11-15 拆分（`c6bf67db` 引入开关与 `flow_enable`、`d37b9d2f` 引入仲裁）遗留的接口重叠。
- 全量排查其余命令：`/collapse` 与 `/verbose` 语法完全相同（`[think|tool|reply|all] [on|off]`，共用 `parseActivitySwitch`），同属回合区显示控制（压 1 行 vs 显示/隐藏）——唯一其它实质重叠。其余均为非冲突（口径已文档化）：
  - `/policy`（ask/never 策略）/ `/permission`（预设捆绑）/ `/autoapprove`（审批链逐次裁定）三层并存，`docs/ARCHITECTURE-REUSE.md` 已写；
  - `/goal` `/permission` 与宿主同名 → "本地优先"决议（2026-10-06）已文档化；
  - `/session clean` 与 `/cleanquit`（`/clean`）动作不同（前者只清空会话，后者删记录并退出）；
  - 别名集 `/cls` `/exit` `/clean` `/thinking` `/usage` `/context` 为同命令别名；`/new` vs `/fork` 语义不同；插件命令间无重叠；工具面与命令面双入口（`flow_select` vs `/flow-arbiter` 等）属设计。
- `/help`（`TUI/src/app/runtime/commands.ts` `helpLines()`）缺实际存在的 `/new` `/config` `/group` `/detect-char-width`；`/collapse` 写旧形态 `on|off`、`/verbose` 写旧档位 `think|tool|step`；`/session clean` 未写。
- 文档计数漂移：`TUI/docs/COMMANDS.md` §1.1 写 44 条（实际 45）、§1.2 只列宿主 5 条未含本仓插件 5 条；`TUI/docs/COMMANDS-SPEC.md` 头部写 40 条（实际 45）。

## 决策

- 决策项 1（flow 双命令怎么处理）：a 保留双命令只补状态互见 / b 合并单一入口：删 `/flow-track on|off`，注入开关并入 flow-arbiter select 与配置 / c 只改 TUI 展示 / d 不动。
  选定 **b**（用户 2026-11-17 裁定）：与用户观察一致，消除接口重叠；`/flow-track` 只留 `status`。
- 决策项 2（`/collapse` 与 `/verbose`）：a 保留两条仅文案澄清 / b 合并成一条命令 / c 本轮不处理。
  选定 **a**（用户 2026-11-17 裁定）：两命令是正交维度（压缩 vs 显示），只修 `/help` 文案避免误导，不改命令本体。
- 决策项 3（`/help` 与文档计数）：a 一起修 / b 只修 /help / c 不改。
  选定 **a**（用户 2026-11-17 裁定）。
- 决策项 4（合并后的注入门槛）：a 会话已选中流程（`flowArbiter.current(sessionId)` 非空，任意流程）/ b 只认标准流程 / c 配置单门槛。
  选定 **a**：与"开关并入 select"口径一致；flow-arbiter 缺席 / 未选中 → 注入关闭，降级口径写入 README 与本文档。
- 决策项 5（服务面签名）：`flowTrack.enabled()` / `summary()` 无参会话 → 增加可选 `sessionId` 参数按会话派生；TUI 标题栏传 `activeSessionId`。
  选定：带可选 `sessionId`（调用方不传时按"无选中"处理），TUI 消费点传 `activeSessionId`。

## 规划

任务拆分（plan 模式三段：探索 / 计划 / 实施；探索与计划段只读，实施段改文件）：

- 探索：三层命令清单、问题点、约束、候选取舍 → 已产出（现状/约束/方案 A）。
- 计划：改动文件清单、实施顺序、核验方法、明确不做 → 已产出并经用户人工确认。
- 实施：登记流程 → flow-track 代码 → flow-track 测试 → e2e → TUI 消费点与 /help → 文档 → 全仓验证与收尾。

计划改动文件清单：

01. `flow-track/src/switch.ts`（删）
02. `flow-track/src/command.ts`（只留 status）
03. `flow-track/src/index.ts`（门槛与服务面按会话选中派生，装配去 switcher）
04. `flow-track/src/tools.ts`（ToolDeps.switcher → enabledFor(sessionId)，`flow_status` enabled 字段按会话）
05. `flow-track/tests/main.test.ts`（命令 / 服务面 / 注入门槛用例同步）
06. `flow-track/README.md`（用户面与注入门槛描述）
07. `TUI/src/app/app-deps.ts`（FlowTrackLike 带可选 sessionId）
08. `TUI/src/app/runtime/wiring.ts`（`maybeRefreshFlowTrack` 传 `activeSessionId`）
09. `TUI/src/app/runtime/commands.ts`（`helpLines()` 补 4 条、修 `/collapse` `/verbose` 文案、补 `/session clean`）
10. `TUI/src/app/state/types.ts` / `initial.ts` / `reducer-view.ts`（flowTrackEnabled 语义注释，如需）
11. `e2e/flow-track.test.ts`（去掉 `/flow-track on`，改选中驱动）
12. `TUI/docs/COMMANDS.md`（计数 45、§1.2 补插件注册 5 条）
13. `TUI/docs/COMMANDS-SPEC.md`（头部计数 40 → 45）
14. `docs/BACKLOG.md`（新条目，本任务）
15. `docs/implementation/2026-11-17-tui-command-cleanup.md`（本文档）
16. 根 `README.md` / `README.zh.md`（如需同步 flow-track 开关口径；检查后定）

明确不做：

- 不改 flow-arbiter 代码、服务面与命令语义（仅复用 `current(sessionId)` 查询面）。
- 不合并 `/collapse` 与 `/verbose`；不改 `auto-approve` / `policy` / `permission` 语义。
- 不改 flow-track 配置字段名（`config.enabled` 保留）；不做开关持久化。
- 不改其它命令（`LOCAL_COMMANDS` 目录与补全）与冻结基线之外的渲染。
- 不改 `docs/STATUS.md`（用户择时更新）；不重排 `docs/BACKLOG.md` 既有编号。

实施顺序：登记流程 → flow-track 代码 → flow-track 测试与包验证 → e2e → TUI 消费点 → /help 修正 + 冻结重跑与冒烟 → 文档 → 全仓验证 → 收尾。

核验方法：flow-track 包内 check/build/test；e2e 单跑；TUI `pnpm run test:tui` + 冻结脚本 `scripts/freeze-focus-frame.mts` 重跑 + `pnpm run demo -- --smoke`（/help 行变化）；全仓 `pnpm run check` / `build` / `test` / `check:docs`；真机确认留用户。

## 实现记录

- 2026-11-17 登记流程：`docs/BACKLOG.md` 新增条目「TUI slash 命令冲突与过时项清理」；本追踪文档创建（含目标/调研/决策/规划/清单/不做/顺序/核验）。
- 已删除 `flow-track/src/switch.ts`（进程级注入开关文件，唯一删除动作）。
- **阻塞**：`plan_start` 把会话权限预设切到 `read-only`，计划段终态后 plan-mode 轮询恢复未生效，DSH 文件策略停留在 `read-only`，本次改动的写操作（`flow-track/src/{command,index,tools}.ts`、TUI、e2e、文档）被站位档拦；`command.ts` 的 `workspace-write` 提升被用户拒绝。已按用户指示另登记「plan 只读预设恢复未生效」条目（`docs/BACKLOG.md` §2），后续处理；实施暂停。
- 2026-11-17（续，用户人工放开权限后）：
  - `flow-track/src/command.ts` 重写：只留 `status`（无参缺省），`on|off` 报未知子命令；`FlowCommandDeps` 改 `configEnabled / selected(sessionId) / hasActive / sessionOf`。
  - `flow-track/src/index.ts`：删 `createFlowSwitch`；新增 `selectedFlow` / `enabledFor`（惰读 `flowArbiter.current(sessionId)`，缺席/未选中 → 关闭）；服务面 `enabled(sessionId?)` / `summary(sessionId?)` 按会话选中派生；注入门槛改「配置 ✓ 会话选中 ✓ 有未完成记录」；命令 `sessionOf` 经 `callerSessionId`；工具依赖 `switcher` → `enabledFor`。
  - `flow-track/src/tools.ts`：`ToolDeps.switcher` → `enabledFor(sessionId)`；`flow_status` 的 `enabled` 字段按调用会话（`execute(args, exec)`）。
  - `flow-track/tests/main.test.ts`：harness 加 flow-arbiter mock（`selectFlow` / `clearFlow`，false 不挂降级）+ `runCommand` invocation 带会话；「服务面 enabled() 跟随选中与配置」「/flow-track 命令只留 status」重写；`enableInjection` 改 `selectFlow("standard")`；flow_enable 迁出用例注释更新。
  - `e2e/flow-track.test.ts`：第一例去掉 `/flow-track on`，改 `flow_select` 选中后写记录，服务面 `enabled(sessionId)` / `summary(sessionId)` 断言；第二例不变。
  - TUI：`app-deps.ts` `FlowTrackLike` 的 `enabled` / `summary` 带可选 `sessionId`；`runtime/wiring.ts` 状态列 Flow 块与标题栏 `maybeRefreshFlowTrack` 传 `activeSessionId`；`state/types|actions|initial.ts` 与 `layout/title-bar.ts` 注释口径；`runtime/commands.ts` `helpLines()` 补 `/new` `/config` `/group` `/detect-char-width`、修 `/collapse` `/verbose` 为 `[think|tool|reply|all] [on|off]`、`/session` 补 `clean`；冻结脚本重跑（fixture 无变化）；`tests/app.test.ts` 的 `/collapse on|off` 断言同步为新语法。
  - 文档：`TUI/docs/COMMANDS.md` §1.1 计数 44→45、§1.2 扩为本仓插件 5 条 + 宿主 5 条并补 `/flow-track` 只留 status；`TUI/docs/COMMANDS-SPEC.md` 头部计数 40→45；`flow-track/README.md` 用户面 / 注入门槛 / 服务面 / 配置 / 降级五处同步；`TUI/docs/DESIGN.md` 标题栏 `flowTrack.enabled(activeSessionId)` 口径。根 README 双侧核对无旧开关口径（不改）。

## 测试与证据

- flow-track：`pnpm -C flow-track run check` ✓ / `build` ✓ / `test` 85 例全过 ✓
- TUI：`pnpm -C TUI run check` ✓；`pnpm run test:tui` 1894 例全过（+1：`/collapse` 断言同步）；`node scripts/freeze-focus-frame.mts` 重跑 fixture 无 diff；`pnpm run demo -- --smoke` 42 项 SMOKE_PASS + SMOKE_OK ✓
- e2e：`e2e/flow-track.test.ts` 2/2（选中驱动 enabled=true）✓；全量 `test:e2e` 43/43 ✓（含 flow-arbiter / plan-mode / task-engine）
- 全仓：`pnpm run check` ✓ / `build` ✓ / `test` 退出码 0（各包 pass 全绿）✓ / `check:docs` 123 篇 0 错 0 警 ✓
- 临时诊断脚本 `tmp/_diag-flow-track.mts` 已删

## 偏差

- 计划文件清单第 14/15 项（BACKLOG 条目、追踪文档）如期；第 10 项（TUI state 三文件）仅改注释口径（无行为改动）；第 16 项（根 README 双侧）核对后无需改动（无旧开关口径）——已在实现记录标注。
- 计划里未列 `TUI/tests/app.test.ts` 的 `/collapse on|off` 断言更新——属 /help 修正的必然伴随（旧断言语义已过时），已记入实现记录。
- 原计划「flow-track 包内验证」与「全仓验证」两步合并执行，验证顺序不变，结果如上。
- 无其它偏差。

## 收尾

- 条目「TUI slash 命令冲突与过时项清理」→ 完成：已从 `docs/BACKLOG.md` §2 移除，§1 已完成索引补摘要行。
- 追踪文档移入 `docs/archived/2026-11-17-tui-command-cleanup.md`。
- 遗留：「plan 只读预设恢复未生效」条目仍在 §2 待处理（与本次变更无因果关系，另立条目）。
- 提交询问：按流程在关闭点询问用户是否提交（未获同意不提交）。
