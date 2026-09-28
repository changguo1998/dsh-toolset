# 宿主双栈兼容垫片清理（接取条目：docs/BACKLOG.md「宿主双栈兼容垫片清理」）

状态：关闭　　开启：2026-09-29　　关闭：2026-09-29
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

删除 0.1.7-rc.2 升级期保留的「按宿主版本择路」分支，目标宿主收敛为 **0.1.7-rc.2 单一形态**：TUI `jobsCallerFor` / `refreshAgents` 择路 / jobs 事件源择路；output-compress `ptcRuntime` / `codeRuntime` 探测；同步删除对应旧形态测试用例与注释口径。

## 调研

来源：`docs/BACKLOG.md` #38、`docs/host/HOST-UPGRADE-0.1.7-rc.2.md` §0.1/§3.2、`TUI/src/app/adapter/dsh.ts`、`TUI/src/app/adapter/types.ts`、`output-compress/src/index.ts`、`output-compress/src/sandbox.ts`、两侧测试文件、`dsh --version`（= 0.1.7-rc.2）。

- **前提（用户 2026-09-29 确认）**：0.1.5-rc.3 已彻底退役，可删旧分支；本机宿主为 `0.1.7-rc.2`。
- **jobs caller**：0.1.7 起 caller = 裸 SessionId 字符串（owner 判定 `job.owner.id === caller`）；旧实现读 `caller?.id` 需包 `{id}`。现状 `jobsCallerFor(svc, sessionId)` 以「是否暴露 `events` 事件流」为版本特征择路。
- **jobs 事件源**：0.1.7 走 `jobs.events.subscribe(filter, listener)`；旧宿主走 `jobs.onJobsChanged(cb)`。现状两路择路（`dsh.ts` 订阅段）。
- **subagents**：0.1.7 起 `listChildren` 返回投影目录（无 `activity`/`hasChildren`/`diagnostic`），富条目经 `listDescendants`（depth=1 直接子代）；旧宿主两者同形。现状 `useDescendants` 择路。
- **output-compress 沙箱**：服务名 `codeRuntime` → `ptcRuntime`；接口 `run(request)` → `resolve(request) → spec` + `run(spec)`。现状按序探测两个服务名 + `resolve?` 可选。
- **测试面**：`TUI/tests/adapter.dsh.test.ts`（`onJobsChanged` 夹具；「旧宿主 ≤0.1.5」`listChildren` 用例；「投影目录降级」用例）、`output-compress/tests/hooks.test.ts`（`codeRuntime` 参数 / reflect 双名探测断言 / 旧形态 fake）。

## 决策

1. **单一形态 = 0.1.7-rc.2**：caller 直接传 `activeSessionId`（字符串）；subagents 只用 `listDescendants`（filter `depth === 1`），`listChildren` 不可用即报「宿主无子代理服务」；jobs 只走 `events.subscribe`，无事件流即退化为「打开面板拉取一次」（保留 `refreshJobs` 路径，不保留 `onJobsChanged`）。
1. **output-compress 只探 `ptcRuntime`**：`resolve` 改为**必选**并直接调用；删 `codeRuntime` 探测与 `BundleHost.codeRuntime` 字段。
1. **旧形态用例删除、新形态用例保留**：`listDescendants` 用例与 /jobs 实时用例保留（若其夹具含旧形态参数则一并收敛）；「≤0.1.5 listChildren」「投影目录降级」「制品名探测顺序」旧断言删除或改写为新形态断言。
1. **注释口径同步**：把「按宿主版本择路」类说明改为「0.1.7-rc.2 单一形态」；升级对照文档 `docs/host/` 不改（宿主面知识，按自身过期条件维护）。
1. **不扩大到其它兼容面**：`sessionMode` events/投影双路、`jobs` 的其它新版字段等不属本条（前者是运行期能力探测、非版本择路）。

## 规划

任务拆分：

1. `TUI/src/app/adapter/dsh.ts`：删 `jobsCallerFor`（3 处调用点直接传 `activeSessionId`）；`refreshAgents` 收敛为 `listDescendants`；jobs 订阅段收敛为 `events.subscribe`；注释同步。
1. `TUI/src/app/adapter/types.ts`：`SubagentsLike.listChildren` 删除（保留 `listDescendants`）；`JobsLike.onJobsChanged` 删除；caller 类型收敛为 `string`（`JobsLike` 各方法）；相关注释同步。
1. `TUI/tests/adapter.dsh.test.ts`：删/改旧形态用例与夹具（`onJobsChanged`、≤0.1.5 listChildren、投影目录降级）；保留并核对 0.1.7 形态用例。
1. `output-compress/src/index.ts`：`resolveSandboxRuntime` 只探 `ptcRuntime`；`BundleHost` 去 `codeRuntime`；`RuntimeRef.name` 收敛；注释同步。
1. `output-compress/src/sandbox.ts`：`CodeRuntimeLike.resolve` 改必选；`run` 直接 `resolve` → `run(spec)`；注释同步。
1. `output-compress/tests/hooks.test.ts`：删旧形态 fake 与探测顺序断言；新形态用例收敛。
1. 文档：本追踪文档；关闭时回写 `TUI/docs/DESIGN.md`（如提及择路的段落）与 `output-compress/README.md`（沙箱探测口径）。

计划改动文件清单（**只改这些**）：

- `docs/BACKLOG.md`（条目状态；同批移除 #25/#26/#28/#29）
- `docs/implementation/2026-09-29-host-single-stack-cleanup.md`（本追踪文档）
- `TUI/src/app/adapter/dsh.ts`
- `TUI/src/app/adapter/types.ts`
- `TUI/tests/adapter.dsh.test.ts`
- `output-compress/src/index.ts`
- `output-compress/src/sandbox.ts`
- `output-compress/tests/hooks.test.ts`
- `TUI/docs/DESIGN.md`（关闭时按需回写）
- `output-compress/README.md`（关闭时按需回写）

明确不做：不动 `docs/host/` 升级对照文档（宿主面知识）；不做 `sessionMode` / `sessionMessages` 的能力探测融合；不顺手重构相邻代码；不改包版本号与依赖。

## 实现记录

2026-09-29：

- `TUI/src/app/adapter/dsh.ts`：删 `jobsCallerFor`（3 处调用点改传裸 `activeSessionId`）；`refreshAgents` 收敛为 `listDescendants`（无该能力即报「宿主未挂载」，去 `useDescendants` / `listChildren` 分支与注释）；jobs 订阅段去 `onJobsChanged` 分支（只走 `events.subscribe({owner})`，不可用即退化为面板拉取）；相关注释同步。
- `TUI/src/app/adapter/types.ts`：`JobsLike` caller 收敛为 `string`、删 `onJobsChanged`；`SubagentsLike` 删 `listChildren`（`listDescendants` 改可选——缺失由 adapter 报不可用）；`SubagentEntryLike` / `AgentRowInfo` / `refreshAgents` 注释去双形态口径。
- `TUI/tests/adapter.dsh.test.ts`：删「旧宿主 ≤0.1.5 caller={id}」与「投影目录降级（listChildren only）」两条用例；caller 用例与 jobs 订阅用例合并/改名为单一形态；`makeAgentsToolsServices` 夹具改 `listDescendants`；/agents 断言拆为「depth=1 + diagnostic」与「depth=2 过滤」两条；文件头注释同步。
- `output-compress/src/index.ts`：`resolveSandboxRuntime` 只探 `ptcRuntime`（去 `codeRuntime` 兜底）；`BundleHost` 删 `codeRuntime` 字段；`RuntimeRef.name` 收敛为 `"ptcRuntime"`；文件头与沙箱选择注释同步。
- `output-compress/src/sandbox.ts`：`CodeRuntimeLike.resolve` 改必选；`run` 直接 `resolve → run(spec)`（去 `typeof resolve === "function"` 择路）；文件头 / 类注释同步。
- `output-compress/tests/hooks.test.ts`：fake 去 `withResolve` 参数（恒提供 resolve）；`makeHost` / `mount` 参数改 `ptcRuntime`；「reflect 返回 code-runtime」用例改 ptcRuntime 并补 `resolve` 转发；cordis 代理用例断言收敛为 `["ptcRuntime:false"]`；失败用例改 `resolve: (req)=>req`；`withResolve: true` 调用点收敛。
- 注释残留清理（同属本条口径）：`TUI/src/app/state.ts`（2 处 onJobsChanged）、`TUI/src/app/components/JobsPanel.ts`、`output-compress/src/sandbox.ts` 文件头、`TUI/tests/adapter.dsh.test.ts` 文件头。
- `output-compress/README.md`：单测计数 42 → 45（trigger 9 + summary 9 + kb-write 9 + hooks 18）。

## 测试与证据

- 根 `npm run check`：通过（15 包，0 处 `error TS`）。
- `TUI && npm run build`、`output-compress && npm run build`：通过。
- 全仓 `npm run test`（15 包并行）：全 OK——TUI **1205 pass / 0 fail**（较清理前 -2：删旧形态用例 2 条）；output-compress **45 pass / 0 fail**；rule-engine 59；其余包无回归。
- 残留检查：`grep -rn "jobsCallerFor|onJobsChanged|listChildren|codeRuntime"` 在 `TUI/src`、`TUI/tests`、`output-compress/src`、`output-compress/tests`、`TUI/docs/DESIGN.md`、`output-compress/README.md` 全部为空（仅 `docs/host/` 升级对照文档保留历史口径，属宿主面知识、不参与本流程）。
- 真机：本机宿主即 0.1.7-rc.2，单形态即当前运行形态；未额外做 tmux 真机目视（改动为删除旧分支，风险面由全量测试覆盖）。

## 收尾

- 回写 `TUI/docs/DESIGN.md`「后台任务 /jobs」：删「按宿主版本择路 / jobsCallerFor / onJobsChanged」表述，改为单一形态口径。
- 回写 `output-compress/README.md`：单测计数同步（42 → 45）。
- `docs/BACKLOG.md`：本条目从待办清理移除（原「待 0.1.5-rc.3 退役后」条件已由用户 2026-09-29 确认满足）。
- 本文件移入 `docs/archived/`。
- 遗留项：无（`docs/host/HOST-UPGRADE-0.1.7-rc.2.md` §0.1 的「双栈」表述保留为升级期历史记录，不再回写——该文档过期条件是「下次升级时另开新文件」）。
- 临时文件：无。
