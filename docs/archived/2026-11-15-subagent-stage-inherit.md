# 子代理写调用继承父会话阶段（接取条目：docs/BACKLOG.md「子代理写调用继承父会话阶段」）

状态：进行中（调研）　　开启：2026-11-15　　关闭：待定
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

父会话进入 plan 模式的探索 / 计划（只读）段后，由该父会话派生的子代理（subagent，含日后新增的派生会话工具）的写调用同样受只读约束——继承父会话的阶段约束。拒绝对话的显示口径、回执与父会话一致（`plan_stage_readonly`）。

## 现状与缺口

- plan-mode 的 `tools/pre-execute` 按「调用方会话 id」匹配阶段映射（`plan-mode/src/index.ts:314-355`：`sessionIdOf(exec)` 取 `exec.agent.session.id`，`getRecord(sessionId)` 无映射 → 放行）。
- 子代理的写调用带**子会话 id**，父会话的映射查不到 → 直接放行。
- 主条目已在只读段拦 `workflow` / `task_execute` 的**发起**，但拦不住子代理内部的写。
- 宿主层已有「创建时快照继承」：`dsh-subagent` 在子代理创建时把父会话当前的 sandbox override 快照给孩子（`sandbox/mode {source:'delegation'}`），故**只读段新派出**的子代理文件写被宿主文件沙箱兜住；漏掉的 = ①进入 plan 之前已存在的子代理（创建时父非只读），②需要按阶段语义（非单纯文件层）判定的拦截。
- BACKLOG 条目注明的前置：需宿主提供「父会话身份 → 子代理调用面」的公开通路（原判断未找到）。

## 调研（2026-11-15，进行中）

（以下逐条记录宿主源码核验结论，来源：`~/.npm/_npx/*/node_modules/@deepseek-ai/*` 部署的 dsh 0.2.2-rc.1。）

### H1. 子代理创建时宿主已继承权限（快照式）——已核验

- `dsh-subagent/lib/index.js:502-513` `childSessionMeta`：子会话 header 持久化 `parentSession` / `delegationDepth` / `origin:"subagent"`，并继承父 `cwd` 与 `agentPreset`。
- `:542-555` `applyChildComposition`：子代理 **join 父的 agent 预设组合**（`agentPresets.composeFrom(childCtx, parent.ctx)` —— 父的工具注册 / 提示 section 一并进子代理作用域）。
- `:566-590` `captureDelegatedPolicyOverrides` / `appendDelegatedPolicyOverrides`：创建时同步取 `sandboxPolicy.overrideOf(parent.session)`（父会话最近一条 sandbox/mode）快照，写进子会话日志（`source:'delegation'`）；approval 固定 `'never'`。
- `dsh-sandbox-policy/lib/index.js:154-156` `overrideOf` = 读会话最近一条 `sandboxMode`；`dsh-permission-presets/lib/index.js:274-284` `set` 切 read-only 预设时经 `setSandboxMode(session, 'read-only')` 落 `sandbox/mode`。
- 结论：切 read-only 预设 → 父会话 sandbox/mode=read-only → 其后创建的子代理快照继承 read-only（宿主文件层兜底）；已存在子代理不受后续切换影响。

### H2. `tools/pre-execute` 的 exec 形状 与 父会话链通路——已核验

核验结论（来源：`dsh-tools` / `dsh-scope` / `dsh-agent` / `dsh-subagent` 的部署源码）：

1. **exec 携带完整调用方 agent**：`dsh-tools` `createExecution`（`lib/index.js:3025-3051`）把 `exec.agent` 原样带上（`...agent !== void 0 ? { agent } : {}`）；pre-execute 瀑布从 `exec` 取 `name` / `arguments` / `agent`。即 **`exec.agent.session.header.parentSession` 直接可取「调用方的父会话 id」**——BACKLOG 条目说的「公开通路」存在（入口 = 子代理自己的 SessionHeader）。
2. **pre-execute 监听对所有 agent 生效**：`prepareExecution:3115-3116` 以 `scopeTarget(this, exec.agent)` 为瀑布载体；`dsh-scope` `scopeTarget`（`lib/index.js:327-338`）的准入 = 「无 tag 的监听全局收 + 有 tag 的收匹配 key 及其祖先」。plan-mode 以 profile 级 bundle 挂载（`~/.dsh/profiles/fff/cordis.patch.yml:450-453` 官方 plan-mode 停挂；`package.json:90` `@dsh-toolset/plan-mode` 在 bundles），其 `c.on("tools/pre-execute", …)` 不打 scope tag → **子代理的工具调用同样会走到 plan-mode 的 pre-execute 监听**（此前放行只是 `getRecord(子会话 id)` 无映射，见 `plan-mode/src/index.ts:324-326`）。
3. **祖先链可读**：`ctx.get("agents")` 服务本仓已有消费先例（`auto-approve/src/index.ts:450`、`background-daemon/src/main.ts:330`、`session-channel/src/service.ts:254`）；`agents.get(id)` 返回 Agent（`dsh-agent/lib/index.js:563-564` `store.get(id)?.agent`），其 `.session.header.parentSession` 即再上一级。子代理 header 的 `parentSession` 由 `dsh-subagent` `childSessionMeta`（`lib/index.js:502-513`）在建子时会话时持久化（另含 `delegationDepth` / `origin:"subagent"`）。
4. **本仓子代理进程模型**：task-engine 经 `ctx.subagents.start` 派生（`task-engine/src/subagent.ts:143`），workflow / task_execute 走 in-process 组合 → **同进程**，parentSession 链与 plan 的 `session-map`（进程内存）同域。真子的子进程形态（`dsh-subagent` `subprocessRunHandle`）在本仓派生路径未出现，记为边界。

**父会话链通路结论**：子代理调用面（pre-execute）能拿到「自己 → 父 → 祖父 …」的会话链（首跳来自 exec.agent.session.header，后续经 agents 服务）。原「前置未找到」的判断**不成立**，可实施。

### H3. 缺口的最新排序（宿主继承 + 链上溯之间的分工）——已核验

- 宿主 sandbox 创建时快照继承（H1）已兜住「进入只读段**之后**新派生」子代理的**文件写**（宿主文件沙箱层）。
- plan-mode 链上溯（候选方案 A）可补：①进入 plan **之前**已存在的同进程子代理（其 sandbox 快照非只读，但 plan 记录在进程内存里能上溯到）；②按阶段语义（而非仅文件层）给统一回执。
- 真子的子进程子代理：A 不覆盖（不同进程无 plan 记录）→ 其文件写仍靠 H1 快照（若创建时父已只读），语义层缺。全覆盖需方案 B（阶段面跨进程化）。

## 决策（2026-11-15 用户裁定：实施 A）

- 决策项 1 = **实施方案 A**（会话链上溯判定），B（阶段面跨进程化）另行立项，C（只记边界）不采纳。
- 决策项 2 = 复用现有 `decide` 判定核，仅放宽「会话映射」一处：直接记录优先，其次祖先记录（`nearestPlanRecord` 含自身）。
- 决策项 3 = 回执标注：继承命中在现有 reason 后追加「（继承自父会话 plan 只读段）」。
- 决策项 4 = 已有的 `workflow` / `task_execute` 发起硬拦**保留**（多一道闸，不因 A 放宽）。

## 计划改动文件清单（已按方案 A 定稿）

- `docs/BACKLOG.md`（条目标进行中，完成后清理）
- 本追踪文档
- `plan-mode/src/ancestor.ts`（新增：`nearestPlanRecord` / `makeParentReader` / `ANCESTOR_MAX_HOPS`，纯函数可单测）
- `plan-mode/src/index.ts`（pre-execute 分支：直接映射缺失 → 上溯祖先记录；`agentsOf` 懒读；拒绝回执区分继承命中）
- `plan-mode/tests/ancestor.test.ts`（新增纯函数用例 6 例）
- `plan-mode/tests/index.test.ts`（makeContext 支持 agents + 新增 4 例：只读祖先拒写标注 / 两跳命中 / 实施段放行 / 无记录或 agents 缺席或直接命中优先）
- `plan-mode/README.md`（写面拦截段补子代理继承口径）

## 实现记录（2026-11-15）

- `ancestor.ts`（新建）：`nearestPlanRecord<T>(start, recordOf, parentOf)` 沿父链（含自身）找最近 plan 记录，上限 `ANCESTOR_MAX_HOPS = 24`；`makeParentReader(agents)` 从 `agents.get(id).session.header.parentSession` 建父链读取器，agents 缺席恒 undefined。
- `index.ts`：pre-execute 直接 `getRecord(sessionId)` 无命中时不直接放行，改 `nearestPlanRecord(sessionId, getRecord, makeParentReader(agentsOf()))`（`agentsOf` = `readService(c, "agents")`）；命中祖先记录按既有判定流程（任务引擎快照 + 该记录的 frames）判段拒写；继承命中（`hit.sessionId !== sessionId`）在 reason 后追加继承标注。工作流 / 任务面的发起硬拦未动。
- 测试：`ancestor.test.ts` 6 例（含自身 / 上溯最近命中 / 链尽 / 超限终止 / agents 缺席 / header 读取）；`index.test.ts` 新增 4 例 + makeContext 支持 `agents`。

## 验证记录

- `pnpm --filter plan-mode test`：**63 例全过**（原 53 + ancestor 6 + index 4）。
- 全仓 `pnpm run check`：退出 0；`pnpm run test`：41 包全绿（plan-mode 63）；`pnpm run build`：41 OK / 0 FAIL。
- `pnpm run check:docs`：122 篇 / 1004 个 .ts，错误 0 / 警告 0。
- 未做真机 e2e（本次为纯 TUI 外插件逻辑，单测覆盖判定面；真机验证留待用户择时）。

## 收尾

- 追踪文档归档到 `docs/archived/2026-11-15-subagent-stage-inherit.md`。
- `docs/BACKLOG.md` §2 条目移除，§1 完成索引补记录（含提交号）。
- 边界记录（不实现，随 B 另行立项）：子进程子代理（不同进程无 plan 内存）不覆盖，其文件写靠宿主 sandbox 创建时快照继承（若创建时父已只读）。
