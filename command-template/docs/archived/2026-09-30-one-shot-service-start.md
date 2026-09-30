# 一次性子代理改走宿主服务面 start（接取条目：`command-template/docs/BACKLOG.md`「一次性子代理改走 `ctx.subagents.start`（现直调 provider.start，绕过宿主 catalog 与生命周期）」）

状态：完成（2026-09-30）　　开启：2026-09-30
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`agent` 步骤的一次性子代理改经宿主服务面 `ctx.subagents.start(name, request)` 启动（替代现状直调 `provider.start`），使子代理：① 写入父会话 `subagent/catalog`（`/agents` 面板与 TUI 状态列可见）；② 发出 `subagent/start` · `subagent/end` 生命周期事件；③ 保留现有能力（provider 选择、模型覆盖仅本次、超时/取消、结果文本抽取）。

## 调研

（来源：本仓源码 / 宿主包 `@deepseek-ai/dsh-subagent`（0.1.7-rc.2））

- 现状：`src/subagent.ts` 的 `runOneShotAgent` 经 `ctx.subagents.getProvider(name)` 直调 `provider.start(request)`。
- 宿主服务面 `SubagentRuntime.start(name, request)`（`lib/index.js`）：`assertCapabilities`（本包请求仅用到 `agentOptions` 一项，spawn provider 声明支持）→ `provider.start({…request, descriptor})`（descriptor 由宿主 `snapshotSubagentDescriptor` 构建并**覆盖**调用方同名字段）→ `establishCatalogChild(request.parent.session, child.header, descriptor)`（向父会话写 `subagent/catalog`）→ `observeRun(…)`（生命周期事件）→ 返回 run。
- 宿主文件注释明示一次性委派应走 `ctx.subagents.start()`；本仓 TUI `/council` 亦走该面（对比证据）。
- 真机实证（TUI 小问题批）：playbook 子代理不出现在 `/agents`/状态列；父会话 `subagentCatalog` 投影为空（同会话历史 catalog 仅含 continuable 子代）。
- `settleRun(run)` 取自宿主模块（`importHostModule`），对服务面返回的 run 形状不变、同样适用。

## 决策

- 选定：`runOneShotAgent` 改调 `runtime.start(providerName, request)`；`pickProvider` 仅用于选 provider 名（保留 spawn 优先、fork 兜底）。
- 请求体：`{label:"command-template", prompt, signal, parent, agentOptions?}`；**不再自建 descriptor**（由宿主构建，label 取 `request.label`）。
- 可测性：`OneShotAgentOptions` 增可选 `loadHostModule?`（测试注入宿主模块读取器；缺省 `importHostModule`）——避免单测依赖本机宿主安装。
- 失败语义不变：缺服务 / 无可用 provider / 服务未暴露 `start` → 抛错（上层转 `step_failed` 并带原因）；模型覆盖仍仅本次运行。

## 规划

任务顺序：文档（本文件 + BACKLOG 状态）→ 实现 → `check`/`build` → 测试 → 真机复验（TUI `/playbook` 场景）→ 收尾。

计划改动文件清单（**只改这些**）：

1. `command-template/src/subagent.ts`：改服务面 start；抽 `buildOneShotRequest()` 纯函数；宿主模块读取走可注入 seam；文件头注释同步。
1. `command-template/tests/subagent.test.ts`（新增）：选名（spawn 优先）、服务面 start 入参（name/request：label/prompt/parent/signal/agentOptions，且无 descriptor）、provider.start 不被直调、结果文本抽取、失败路径。
1. `command-template/src/main.ts`：`#runAgent` 注释同步（provider → 服务面）。
1. `command-template/README.md`：`agent` 步骤口径同步（服务面一次性运行）。
1. `command-template/docs/BACKLOG.md`：接取/完成状态与收尾清理。
1. 本追踪文档。

明确不做：不改其他步骤类型与模板格式；不改宿主包；不做顺手改。

## 实现记录

- 2026-09-30 `src/subagent.ts`：`runOneShotAgent` 改调服务面 `runtime.start(providerName, request)`（provider 仅用于选名与 start 能力守卫）；新增 `buildOneShotRequest()` 纯函数（label / prompt / signal / parent / agentOptions；**不自建 descriptor**）；宿主模块读取走可注入 seam `options.loadHostModule`（缺省 `importHostModule`）；移除自建 descriptor 与 `SUBAGENT_DESCRIPTOR_VERSION` 读取；文件头注释同步。
- 2026-09-30 `src/main.ts`：`#runAgent` 注释同步（provider → 服务面）。
- 2026-09-30 `tests/subagent.test.ts`（新增 5 例）：请求形状（含「无 descriptor」断言）；服务面 start 调用（spawn 优先、raw provider.start 不被直调）；模型覆盖透传；服务未暴露 start / 无 provider 明确报错；失败结算带子会话 id。
- 流程记录：提交询问点 1（仅文档）已问，用户答「暂不提交」→ 合并到关闭后一次提交。

## 测试与证据

- `npm --prefix command-template run check`（tsc --noEmit）✓。
- `npm --prefix command-template run build` ✓。
- `npm --prefix command-template run test`：**13 pass / 0 fail**（新增 5 例 + 既有 8 例）。
- 真机复验 ✓（2026-09-30 21:26-21:32，TUI 干净重启后 pid 404769）：`/playbook list`（21:26:29，success）→ `/playbook code-review README.md`（21:26:41 起，21:32:05 success「已完成 2 步（review → verify）」）。**父会话新增 2 条 `subagent/catalog`**（`154ac44e` 评审 / `1df5f59f` 验证，均 `mode=one-shot`、`label=command-template`）；**状态列自动出现 Agents 块**（`Agents 0/2`，两条 command-template 子代，无需开面板）。修复前同一命令 0 条 catalog 记录（对照见 TUI 追踪文档）。

## 收尾

- 状态：**完成**（2026-09-30）。所接条目 #1：BACKLOG 已标完成并清理移除（文件回到「当前无未完成项」）。
- 提交：`e646ca1`（代码 + 实现记录）、`0afd460`（测试 + 真机复验证据）；BACKLOG 状态随关闭后提交。
- 文档回写：`command-template/README.md`「不实现执行器」一条改为服务面口径。
- 验收证据：真机复验 ✓（父会话 2 条 `subagent/catalog` + 状态列 `Agents 0/2`，见「测试与证据」）。
- 归档：本文件移入 `command-template/docs/archived/`（原名保留）。
