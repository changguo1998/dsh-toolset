# agent-group TUI 命令或面板（接取条目：agent-group/docs/BACKLOG.md「TUI 命令或面板」）

状态：实现（代码 + 测试完成，待提交）　　开启：2026-10-19　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

给 TUI 提供查看群组状态的入口（如 `/group` 命令或状态列），复用 agent-group 服务面 / 模型侧 `status` 工具结果，让人不必让模型调工具即可读组状态；实现归 TUI 模块。

## 调研

来源：`TUI/docs/COMMANDS.md`（单一来源 + 路由 + 落点决策）、`TUI/docs/DESIGN.md`「命令实现落点」、`TUI/src/app/{commands,index}.ts` 与 `TUI/src/main.ts` 现状、`agent-group/src/{main,core,store,types}.ts`。

### 1. TUI 命令架构

- 单一来源 `src/app/commands.ts` 的 `LOCAL_COMMANDS`（name/route/desc）+ `routeSlashCommand`；处理分支在 `src/app/index.ts` 的 `handleSlash`（`case "<name>"` → `handleXxxCommand()`）。
- **落点决策**（COMMANDS.md）：命令一律走 TUI 本地命令，不新建宿主命令插件包；面板骨架（ModelPicker / JobsPanel）与 FakeAdapter 测试基建可复用。
- **只读服务面口径**（COMMANDS.md / DESIGN.md）：插件侧 `ctx.provide("<svc>", {只读方法})`，TUI 入口 `ctx.get("<svc>")`（惰读 getter，防插件晚于 TUI 装载）→ adapter 方法 → 本地命令渲染。样板：`taskEngine`（/task）、`metricLoop`（/loop）、`guard`（/guard）、`memory`（/memory）。
- 呈现：列表面板走 `openListPanel({kind, label, refresh, filter})`；简单命令可直接 `notice(text, tone)` 输出瞬态信息。

### 2. agent-group 现状（服务面缺口）

- agent-group 目前**只注册工具**，无 `provide` 服务面 —— TUI 无法经 `ctx.get("agentGroup")` 读状态。`status` 动作的命令式 read 依赖「调用方会话身份 + 工具 execute 上下文」；TUI 需要**按会话 id 参数化**的只读查询。
- 状态文件：`<管理者会话目录>/agent-group.json`（`sessionPaths.sessionDirFor(managerSessionId)` + `stateFileName`）；文件缺失 = 空组集（`store.load` 对 ENOENT 返回 `emptyBook`）。`groupView` 已具备完整只读视图（成员/连接/平等连接/指令/计数）。
- `bindOptionalServices`（2026-10-19 修复引入）已能把 `sessionPaths` / `sessions` 绑定进 `bindings`，可复用于只读服务的落盘解析。

### 3. 形态与刷新（用户已定）

- 用户 2026-10-20 裁定：**命令先行（`/group`），状态列留二期**。
- `/group` 语义：读**当前会话**（TUI 的 `activeSessionId`）名下的组状态（`/group [组名]` 可选某组；缺省列全部组摘要），只读、不落盘、不改协议。

## 决策

决策项 1　呈现形态：a 列表页面板（进 `CommandPanelKind` 族）　b **单次 `notice` 文本摘要（`/group [组名]`）**　c 常驻状态列
→ 选定 **b**（用户裁定命令先行）。理由：给「人不必让模型调工具即可读组状态」的最小改动；面板族要动 `CommandPanelKind` / reducer / 渲染三处且与二期的状态列重叠；`notice` 直接复用既有信息展示通道。内容 = 每组的 `name / members / links / peerLinks / 未结与收场计数` 紧凑摘要。

决策项 2　接线方式：a TUI 直接读 `agent-group.json`（session-paths）　b **agent-group 提供只读服务面 `agentGroup.status(sessionId, group?)`，TUI 经 `ctx.get("agentGroup")` 消费**　c 复用工具执行
→ 选定 **b**。理由：贴合本项目「插件侧只提供只读查询面、命令 TUI 侧实现」的既定口径（taskEngine / metricLoop / guard 一致模式）；「复用 agent-group 服务面」正是条目原文；把落盘路径与形状知识留在 agent-group，TUI 侧只定义结构面（`AgentGroupLike`）。

决策项 3　agent-group 只读服务面的范围：a 只 `status(sessionId, group?)`　b **`status` + 服务面按现有绑定惰解析、失败返回 `{ok:false,...}`（原因 + 下一步）**　c 顺带暴露写面
→ 选定 **b**。`provide: ["agentGroup"]`；方法签名对齐 `GroupFailure` 信封风格（`ok/error/reason/next`）；只读，不落盘不镜像；沿用 `boundOrDirect` 惰读 `sessionPaths`（未挂载 → `session_paths_unavailable` 信封）。

决策项 4　TUI 命令归属与协调：agent-group 模块本次实现 TUI 侧命令（本 worktree 含 `TUI/`），落点 `TUI/src/app/**` + `TUI/src/main.ts` 接线 + TUI 文档；tui 模块会话可能与 TUI 代码并发 —— 由主分支合并时仲裁，归属说明写入追踪文档。
→ 选定该项。

决策项 5　降级与无数据：`ctx.get("agentGroup")` 缺失 → `/group` notice「agentGroup 服务不可用（未挂载 agent-group）」；当前会话无组 → notice「无群组」；组不存在（带参）→ 提示现有组名。
→ 选定该项。

## 规划

任务拆分（按决策项 1-5）：

1. `agent-group/src`：`provide: ["agentGroup"]` + 只读服务 `status(sessionId, group?)`（core 层实现、main 接线、`AgentGroupLike` 结构面 + 单测）。
2. `TUI/src`：`LOCAL_COMMANDS` 加 `/group`（route "group"）；`handleSlash` case；`handleGroupCommand()`（activeSessionId → adapter.readGroupStatus → notice 摘要渲染）；adapter types 加 `AgentGroupLike` 结构面与 deps 字段；`main.ts` deps 加惰读 `agentGroup` getter；adapter/dsh.ts 加 `readGroupStatus`。
3. `TUI/tests`：FakeAdapter 补 readGroupStatus + `/group` 用例（服务缺失降级 / 空组 / 有组摘要）。
4. 文档：`TUI/docs/COMMANDS.md`（命令单源计数 + 描述）与 `DESIGN.md`「命令实现落点」补 `/group` 行；agent-group `README.md` / `DESIGN.md` 补只读服务面。
5. 验证：`TUI` check + test:tui（过滤 `/group` 相关 + 全量按需）、`agent-group` check + test + build。

计划改动文件清单：

- `agent-group/src/main.ts`（provide + 接线）、`agent-group/src/core.ts`（只读服务实现）、`agent-group/src/types.ts`（结构面）、`agent-group/tests/core.test.ts`（或 main.test.ts 服务用例）
- `TUI/src/app/commands.ts`（LOCAL_COMMANDS + route）、`TUI/src/app/index.ts`（case + handler）、`TUI/src/app/adapter/types.ts`（AgentGroupLike + deps）、`TUI/src/app/adapter/dsh.ts`（readGroupStatus）、`TUI/src/main.ts`（deps 惰读）
- `TUI/tests/**`（FakeAdapter + 用例）
- `TUI/docs/COMMANDS.md` / `TUI/docs/DESIGN.md`；`agent-group/README.md` / `docs/DESIGN.md`
- 本追踪文档

明确不做：不做状态列（二期）；不做写操作命令（只读视图）；不改 agent-group 协议与既有动作；不动 host 命令插件面（仍走 TUI 本地命令）。

## 实现记录

**agent-group 侧（只读服务面）**：

- `agent-group/src/core.ts`：新增 `readGroupStatus(store, managerSessionId, groupName?)`——`store.load`（失败 → `state_unavailable`，原因含「确认该会话目录存在且 agent-group.json 可读」）；`groupName` trim 后非空 → 未命中 `group_not_found`（`reason` 列现有组名）；命中 / 缺省 → `{ok:true, groups:[{name, view:groupView(group)}]}`，核名字典序排序。
- `agent-group/src/main.ts`：`export const provide = ["agentGroup"];`；新增 `AgentGroupReadService` 接口、`createReadService(ctx, bindings, config)`（`boundOrDirect(bindings,"paths",ctx,"sessionPaths")` 惰解析 → `sessionDirFor` 缺失 → `session_paths_unavailable` 信封；否则 `new FileBookStore(...)` + `readGroupStatus`）、`readProvide(ctx)`（仿 `readInject` 的守卫读，读不到不警告）；`apply` 尾部 `provideFn.call(ctx, "agentGroup", createReadService(...))`，`.call` 抛错才 warn。
- `agent-group/tests/core.test.ts`：新增 `readGroupStatus` 用例（按会话 id 读清单 / 单组 / 组不存在 / 读盘失败），56/56 绿。

**TUI 侧（`/group` 命令）**：

- `TUI/src/app/adapter/types.ts`：新增 `AgentGroupViewLike`（宽松子集：name / createdAt / members{name,level,role} / links / peerLinks / instructions / summary 计数）与 `AgentGroupLike { status(managerSessionId, groupName?) }`；`RealAdapterOptions` 追加 `agentGroup?`；`DshAdapter` 追加可选 `readGroupStatus?`。
- `TUI/src/app/adapter/dsh.ts`：新增 `readGroupStatus(sessionId, groupName?)` 适配器方法（未挂载/无 `status` → throw「agentGroup 未挂载（宿主无群组查询面）」；否则原样透传服务返回）；新增纯函数 `groupStatusText(groups, groupName?)`（notice 渲染：带组名 → ≤4 行单组详情；无组名 → 首行计数 + 每组一行紧凑摘要；空 → 「当前会话无群组」）；`export type` 块补 `AgentGroupLike`。
- `TUI/src/main.ts`：import `AgentGroupLike`；deps 追加**惰读** `get agentGroup()`（`ctx.get?.("agentGroup")`，与 guard/knowledge 同口径，防 agent-group 晚于 TUI 装载）。
- `TUI/src/app/commands.ts`：`SlashRoute` 加 `"group"`；`LOCAL_COMMANDS` 加 `/group` 条目（desc「群组状态（agent-group 只读：当前会话群组/单组详情，notice 型）」）。
- `TUI/src/app/index.ts`：`handleSlash` 加 `case "group" → handleGroupCommand(line)`；handler 取 activeSessionId（无活动会话 → warn）→ 窄化 `readGroupStatus`（未声明 → 「agentGroup 服务不可用（未挂载 agent-group）」）→ 失败面 error+reason 拼 `warn`、成功 `notice(groupStatusText(...), "info")`。

**测试**：

- `TUI/tests/group-notice.test.ts`（新）：7 用例——路由；服务未挂载 → warn；空清单 → 无群组；有组 → 清单（计数 + 每组摘要）；带组名命中 → 单组详情（建组/成员/连接/指令）；带组名未命中 → warn（error + 现有组清单）；查询 reject → warn。
- `TUI/tests/adapter.dsh.test.ts`：`AdapterServices` 加 `agentGroup?`；新增 2 用例——readGroupStatus 透传（入参/成功清单/失败面）、agentGroup 缺失 → reject。

## 偏差

- 计划清单写 adapter types 只加 `AgentGroupLike` 结构面；实际还需在 `DshAdapter` 接口补可选 `readGroupStatus?`（否则 index.ts 调用点类型不过）。
- 计划在 handler 内联渲染；实际按 `contractSummaryText` 模式把渲染提为 `dsh.ts` 纯函数 `groupStatusText`（可单测、与既有 notice 型命令一致）。
- 清单排序实现在服务端（`readGroupStatus` 核名字典序），TUI 直接展示。
- `agent-group` 计划改动清单写在 core/main/types/main 测试四处；实际 `types.ts` 无需改（`GroupView` 已存在），测试落在 `tests/core.test.ts`。
- 全量 `npm run build` 卡在 `herdr-integration` / `session-paths`（worktree 未链 node_modules，既有环境状态，与本任务无关）；受影响包 `TUI` / `agent-group` 单独 build 通过。
- **真机修正（2026-10-20）**：`handleGroupCommand` 失败面初版渲染 `error（reason）`，但 `failure` 信封的 `error` 是**稳定错误码**（如 `group_not_found`）、`reason` 是描述、`next` 是下一步 / 现有组清单 —— 真机 `/group ghost` 显示 `group_not_found（组「ghost」不存在）`，丢掉了现有组清单，不符决策项 5。改为拼 `reason ?? error` + `next`（`；` 分隔）的可读文案；`group-notice` 测试夹具同步为真信封形状（error=错误码、reason/next=可读），并加「不展示错误码」断言。

## 测试与证据

- `npm --prefix agent-group run check` 通过；`npm --prefix agent-group run test` 56/56 绿。
- `npm --prefix TUI run check` 通过（无 TS 错误）。
- `npm --prefix TUI run test` 全量 1661/1661 绿（含新增 group-notice 7 + adapter.dsh 2）。
- `npm --prefix TUI run build`、`npm --prefix agent-group run build` 通过。

## 收尾

- 待办：格式化改动文件 → 提交询问点（§5：实现后 check+build 已过 → 问一次是否提交代码与测试）→ 用户同意后提交 → 向协调会话 `ui-ravine-5e31` 汇报（含 check/test 结果、是否需合并主分支）→ 真机验证 `/group` 对 agent-group 持久化（依赖合并主分支后重启 profile）。
- 归属说明（决策项 4）：TUI 侧改动本次由 agent-group worktree（本任务）实现；若 tui 模块会话并发改 TUI 代码，主分支合并时仲裁。
