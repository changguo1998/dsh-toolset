# TUI 会话模型切换改走 `agent.model.select()`（接取条目: docs/BACKLOG.md「`agent/request` 弃用迁移: TUI 会话模型切换改走 `agent.model.select()`」）

状态: 关闭　　开启: 2026-11-07　　关闭: 2026-11-07
本文件是本任务唯一的追踪文档与文档改动位置; 计划外的文件不改。

## 目标

1. 修好宿主 `0.2.2-rc.1` 下失效的 TUI 模型切换（`/model` 面板选模型后请求报错 / 不生效）。
2. 会话内切换改走宿主正规入口 `Agent.model.select()`, 不再依赖已弃用的 `agent/request`。
3. 保留两个既有行为: 切换对下一步生效、恢复会话后选择仍生效; 并保留「不写宿主默认模型」的边界。

## 调研

### 失效原因（已实测与代码核实）

- rc.1 的 `agent-loop` 在 `prepareRequest` 里先按本步 `selection` 冻结配置, 再跑 `agent/request`; 监听器若返回不同的 `provider` / `model` / `reasoningEffort` 就抛错（`dsh-agent-loop/lib/index.js:1000-1001`, 文案 "use agent.model.select() before step preparation"）。
- TUI 的 `installSessionModelSelection` 仍在这条事件里替换三项（`TUI/src/app/adapter/dsh.ts:234-251`）, 而 `setSessionModel` 只写前端引用（`TUI/src/app/adapter/dsh-session.ts:745-752`）, 没有通知宿主 → 切换后下一次请求直接抛错, 表现为「切换失效」。
- 官方 rc.1 的 `installModelSelection` 已不再改路由, 只在 `agent/pre-step` 里补一条「模型切换提示」消息; 正规切换入口是 `Agent.model.select({ provider, model, reasoningEffort? })`（持久记录 `model/selection` 事件）。
- `AgentOptions` 的 provider / model / reasoningEffort 已降为「路由回落」; `system-prompt/assemble` 的组装上下文新增 `modelSelection`, 前端再往 prompt 变量里塞 provider / model 已无路由作用。

### 现状代码面

- 前端引用 `SessionModelSelectionRef`（`types/model.ts`）: `current` 是用户选择, `assembled` 是 `system-prompt/assemble` 时抓的快照, 仅供旧 `agent/request` 钩子用。
- 安装点: `TUI/src/main.ts:681` 的 `makeSetup()` 在 create / resume / 启动装配时注入 `installSessionModelSelection`; 挂载钩子到 agentCtx。
- 真实宿主 agent 在适配层是 `activeCommandAgent`（`context.ts:25`, main 传 `commandAgent: rawAgent`）, resume / newSession 时同步更新。
- 显示面: `dsh-events.ts` / `dsh-session.ts` 读 `sessionModel.current` 兜底宿主默认, 用于状态行与面板, 与请求路由解耦。

## 决策

1. 迁移方式: 切换时直接调宿主 `agent.model.select(...)`, 并删掉 `agent/request` 与 `system-prompt/assemble` 两个钩子（它们只服务于旧路由改写, 留着会造成「看似生效实则抛错」的假象）。不复用 `agent/request` 的弃用通道。
2. 前端引用保留: `sessionModel.current` 继续作为显示与目录兜底（状态行 / 面板 / 恢复时同步）, 但不再是请求生效源; 删除不再使用的 `assembled` 字段。
3. `setup` 钩子: 主流程不再注入模型选择钩子, `main.ts` 去掉 `makeSetup` 与三处 `setup:` 传参; 适配层保留通用 `setup` 选项（测试与未来工具引导仍可注入）。
4. 失败面: 宿主未暴露 `agent.model.select` 时明确报错（"宿主未暴露 agent.model.select"), 不静默吞掉; 切换仍返回所选值供面板更新。
5. 文档: `TUI/docs/DESIGN.md` 的两处机制描述（切换语义 / plan 无记录段）同步改为 `agent.model.select`。

## 规划

1. 改代码: `dsh.ts` 删 `installSessionModelSelection`; `dsh-session.ts` 的 `setSessionModel` 调 `agent.model.select` 并更新注释; `types/model.ts` 删 `assembled`; `main.ts` 去钩子装配; `adapter-options.ts` 注释同步。
2. 改用例: 删两组旧钩子用例, 新增「setSessionModel 调用宿主 select 并更新引用」「宿主无 select 时报错」「未注入 sessionModel 时保持原报错」。
3. 文档: `TUI/docs/DESIGN.md` 两处。
4. 验证: `pnpm run test:tui`（含 adapter 用例）、`pnpm run check`、`pnpm run build`、`pnpm run check:docs`。

计划改动文件清单:

- `docs/BACKLOG.md` — 条目标〔进行中〕, 收尾移除。
- `docs/implementation/2026-11-07-tui-model-selection.md` — 本追踪文档。
- `TUI/src/app/adapter/dsh.ts` — 删 `installSessionModelSelection` 与其 import。
- `TUI/src/app/adapter/dsh-session.ts` — `setSessionModel` 走 `agent.model.select`, 注释同步。
- `TUI/src/app/adapter/types/model.ts` — 删 `SessionModelSelectionRef.assembled`。
- `TUI/src/app/adapter/types/adapter-options.ts` — `setup` / `sessionModel` 注释同步。
- `TUI/src/main.ts` — 删 `makeSetup` 与 `installSessionModelSelection` 装配。
- `TUI/tests/adapter.dsh.test.ts` — 替换旧钩子用例, 新增 select 用例。
- `TUI/docs/DESIGN.md` — 切换机制描述。
- `TUI/src/app/adapter/tool-bootstrap.ts` — 两处注释去掉旧钩子引用（无行为改动）。

明确不做:

- 不改宿主包, 不碰 `agent/request` 弃用面。
- 不改 `/model` 面板与目录查询逻辑（只改生效通路）。
- 不改 `agentDefaultModel` 只读兜底语义（仍不写宿主默认模型）。

## 实现记录

- 2026-11-07: `TUI/src/app/adapter/dsh.ts` 删除 `installSessionModelSelection`（`system-prompt/assemble` + `agent/request` 双钩子）及随之无用的类型 import; 公共类型重导出保持不变。
- 2026-11-07: `TUI/src/app/adapter/dsh-session.ts` 的 `setSessionModel` 改调真实 agent 的 `model.select({ provider, model, reasoningEffort? })`（effort 未选时省略字段, 跟随适配器默认）, 同时更新显示引用; 宿主缺 `agent.model.select` 时抛「宿主未暴露 agent.model.select」。恢复与回填注释同步为「显示源, 路由由宿主会话记录决定」。
- 2026-11-07: `types/model.ts` 删 `SessionModelSelectionRef.assembled`; `adapter-options.ts` 的 `setup` / `sessionModel` 注释同步。
- 2026-11-07: `TUI/src/main.ts` 删 `makeSetup` 与三处 `setup:` 传参（启动装配 / create / resume）及不再使用的 `installSessionModelSelection`、`readDefaultSelection` import; 会话级模型说明改为宿主 `agent.model.select`。
- 2026-11-07: `TUI/tests/adapter.dsh.test.ts` 删除两组旧钩子用例, 新增「走宿主 select 并更新引用」「未指定 effort 时省略字段」「宿主未暴露 select 抛错」, 并把「只改 ref」用例改为「更新引用与目录、不写宿主默认设置」且断言 select 被调用。
- 2026-11-07: 文档同步 `TUI/docs/DESIGN.md`（切换语义 / 接线 / 持久化与恢复 / 工具引导段）与 `tool-bootstrap.ts` 的两处注释。

## 偏差

- 旧 `system-prompt/assemble` 钩子除改路由外还往 prompt 变量塞 provider / model; rc.1 的组装上下文已带 `modelSelection`、变量不再影响路由, 该副作用按「只服务旧方案」一并删除, 未保留。
- 恢复会话时只同步显示引用, 不再主动 `model.select` 回推: 宿主按会话记录的 `model/selection` 决定路由, 回推反而会把「无记录时回落 config 种子」的行为改成强制写记录。无记录的会话仍由宿主按 `agentOptions` 回落。
- 未做真机 TUI 交互验证（需终端 + 模型凭据）; 以单测（219 例 adapter）+ 宿主契约（`Agent.model.select` 与 rc.1 agent-loop 抛错条件）为证据。

## 测试与证据

- `pnpm --dir TUI run check`: 通过。
- `sh TUI/scripts/test.sh adapter.dsh.test.ts`: 219 例全过。
- `sh TUI/scripts/test.sh`（全量）: 1859 例全过, 0 失败。
- `pnpm run check`: 退出 0（38 个包的 tsc 全过）。
- `pnpm run build`: 退出 0。
- `pnpm run check:docs`: 通过（117 篇 / 948 个 `.ts`, 0 错 0 警）。
- 关键证据: rc.1 `dsh-agent-loop/lib/index.js:1000-1001` 只在 `agent/request` 返回不同 provider / model / effort 时抛错; 新实现不再监听该事件, 改为写宿主 `model/selection` 事件。

## 收尾

- 2026-11-07: 用户确认修复方案与提交; 条目 `#1` 已从 `docs/BACKLOG.md` §2 移除, 本文件移入 `docs/archived/`。
- 2026-11-07: 按用户要求同步 `scripts/install.sh --profile fff --sync`, 主 profile 快照带上本次修复（fff-test 依赖 link, 随 `pnpm run build` 即生效）。
- 本次为关闭提交, 之后不再有本任务相关提交。
