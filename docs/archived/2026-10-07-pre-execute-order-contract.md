# `tools/pre-execute` 拦截顺序契约（接取条目：`docs/BACKLOG.md` §2「`tools/pre-execute` 拦截顺序无契约」）

状态：完成（2026-10-07）　　开启：2026-10-07　　关闭：2026-10-07
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。实施面预期只落 `security-guard/README.md`（+ 必要时 `security-guard/src/`）。

## 目标

确认 `security-guard` 在宿主 `tools/pre-execute` 点的**真实执行顺序**，把依据写进 `security-guard/README.md`；若顺序不可依赖，则改为不依赖顺序的判定。

## 调研（2026-10-07，全部为装在本机的 `dsh 0.2.0-rc.2` 事实）

### 1. 宿主机制：两段式，语义明确

- 派发点 `dsh-tools/lib/index.js:3225`：
  `const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }))`
  → `tools/pre-execute` 是 **cordis waterfall**，缺省（无人否决时）`{ kind: "allow" }`。
- 之后 `:3239`：`const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;`
  → waterfall 之后跑**单调守卫**；waterfall 判 `deny`/`ask`/`cancel` 时**不再咨询守卫**。
- 宿主 README 自述（`dsh-tools/README.md:85`、`:105`、`:138`）：
  「`ctx.tools.guard(guard)` registers a **monotonic** synchronous guard **after** the extensible `tools/pre-execute` waterfall: a returned reason denies the call, and **no later listener can turn that denial back into permission**」；
  管线 = `tools/pre-execute`（可重排的 allow/deny/ask）→ **monotonic guards** → `tools/execute` → `tools/post-execute` → `finalizeContent` → `tools/result`。
- 守卫 API（`dsh-tools/lib/index.js:2912-2928`）：`guard(guard)` 同步检查、返回字符串即拒绝；plain ctx 全局生效、`agent.ctx` 只对该 agent；已在用的宿主例子：`dsh-subagent-in-process-driver/lib/index.js:85`。

### 2. 顺序由什么决定：注册顺序（= 插件装载顺序），且能被否决截断

- `cordis/lib/index.js:336-347` `register()`：`const method = options.prepend ? "unshift" : "push";` → 监听器存在 `_hooks[name]` **数组**里；缺省 **push**（= 注册顺序），`prepend: true`（或 `ctx.on(name, cb, true)`）插到**队首**。
- `cordis/lib/index.js:258-264` `dispatch()`：按数组存储顺序返回（仅按 scope 过滤）。
- `cordis/lib/index.js:317-326` `waterfall()`：**outermost-first** 执行；注释原文「a listener that **does not call `next()`** **vetoes the rest of the chain, including the built-in behavior**」。
- ⇒ 顺序**确定**（给定 profile 装载顺序）但**不是契约**：配置重排、增删插件、HMR 都会改变；除 `prepend` 外没有该事件的优先级 API。

### 3. 本仓现状：我们挂在「可重排」那一段，靠顺序保护

- `security-guard/src/index.ts:1271`：`const detach = host.on("tools/pre-execute", (exec, next) => { … })` → 普通 `on` = **push**，排在所有更早注册的监听器**之后**，且**不是**单调守卫。
- 文件头注释（`:11`）已把拦截点记为「宿主 `tools/pre-execute` waterfall」。
- ⇒ **风险成立**：任一更早注册的监听器若**不调用 `next()`**（cordis 语义 = 否决后续整条链，含宿主内建行为），我们的黑名单 / 敏感文件层会被**整段跳过**——而这不是假设：本机已装 5 个官方监听器都在这条链上（见下）。

### 4. 本机实际监听方（条目原文名单有误，需修正）

| 包 | 位置 | 形态 |
| --- | --- | --- |
| `dsh-experimental-auto-review` | `lib/index.js:462` | `ctx.on("tools/pre-execute", async (exec, next) => …)` |
| `dsh-hooks-claude-code` | `lib/index.js:248` | 同上 |
| `dsh-hooks-codex` | `lib/index.js:232` | 同上 |
| `dsh-tool-jobs` | `lib/index.js:235` | `ctx.on("tools/pre-execute", (exec, next) => …)` |
| `dsh-workspace-changes` | `lib/index.js:1095` | `ctx.on("tools/pre-execute", async (exec, next) => …)` |
| `security-guard`（本仓） | `src/index.ts:1271` | 同上 |

条目原文写的 6 个（`dsh-tools` / `dsh-scope` / `dsh-bash-local` / `dsh-tool-bash` / `dsh-tool-jobs` / `dsh-workspace-changes`）里：`dsh-tools` 是**派发方**（非监听）; `dsh-scope` / `dsh-bash-local` / `dsh-tool-bash` 只在**注释**里提到该点（本版本未注册）; 而 `dsh-experimental-auto-review` / `dsh-hooks-claude-code` / `dsh-hooks-codex` 三个真实监听方原文未列。

### 5. 附带约束（写 README 时一并记）

- waterfall **不能改写 `exec.arguments`**（`dsh-tools/README.md:230`，改了就与日志 / 渲染脱节）→ 我们的拦截只能是 allow/deny/ask，不能「修参数再放行」。
- 单调守卫是**同步**且**只返回拒绝原因字符串**（没有 `ask` 流程、没有 `info` 载荷）; 且仅在 waterfall 判 `allow` 后才跑。

## 初步结论（待裁定）

1. **顺序可确认、不可契约**：它等于「profile 装载顺序 + 各自是否 `prepend`」，宿主没有为该事件提供优先级语义；把它写成契约没有依据。
1. **可依赖的机制是单调守卫**（`ctx.tools.guard`）：宿主文档明确「后注册的监听器无法把已被守卫拒绝的调用翻回放行」，且它排在 waterfall 之后、不受否决截断影响 → 这正是「安全层不得被顺序翻转」的落点。
1. 因此倾向：**硬拒层（命令黑名单 + 敏感文件）改为（或同时）注册为单调守卫**，`ask` / 策略层继续留在 waterfall；README 写清两段的顺序依据与各自语义。

## 决策（用户 2026-10-07 裁定：按 A 执行；免子代理审阅）

**D1｜形态：移动，不并存** → 把硬拒层从 `tools/pre-execute` 监听器**移到**单调守卫；**不留**并行监听器。
理由：`inspect()` 有副作用——「每次判定都会记入缓冲」（`security-guard/src/index.ts:960`，实现 `:1012` 的 `#records.push`）→ 并存会让一次调用**判定两次、`recent()` 记两条**、blocked 日志重复、参数遍历白跑一遍。

**D2｜降级路径：`tools.guard` 缺失时回退原监听器** → `host.tools?.guard` 不可用时，仍用现有 `host.on("tools/pre-execute", …)`；两种模式都在挂载日志里写明。
理由：否则在旧宿主 / 极简 ctx 上会**静默失去全部拦截**（比顺序依赖更糟）。降级路径行为与今天完全一致，不引入新语义。

**D3｜接口面** → `GuardHost` 增可选 `tools?: { guard(check: (exec: PreExecuteExecution) => string | undefined): unknown }`；守卫**同步**判定，命中返回**回执字符串**，未命中返回 `undefined`。
用户可见面等价：waterfall 的 `{kind:"deny",reason}` 与守卫返回的字符串，宿主都 materialize 成 `Error: <原因>`（`dsh-tools/lib/index.js:3239-3250`）。

**D4｜知情接受的差异** → 移动后我们的拒绝**不再提前截断链路**：
① 审计类监听器（`dsh-workspace-changes` / `dsh-tool-jobs`）会记录到这次被拒调用（视为更好：事后可见尝试）；
② `dsh-experimental-auto-review` 可能先弹一次审批，用户批准后仍被守卫拒绝（噪音，非安全损失）。
为消除 ② 而并存会增加双判定，不采纳。

**D5｜文档** → `security-guard/README.md` 新增「拦截顺序与契约」：事实链（cordis 数组顺序 + `prepend`/`unshift`；waterfall 不调 `next()` 即否决后续；单调守卫在 waterfall **之后**且拒绝不可翻盘；ask 批准后守卫仍跑）+ 我们的选择（硬拒层 = 单调守卫，顺序无关、单次判定）+ 已知差异（D4）+ 降级路径（D2）。

**D6｜明确不做** → 不改 `inspect` 与规则内容；不加 `prepend`；不动服务面（`recent` / `policy` / `inspectCommand`）；不动 TUI 侧 `/guard` 接线；不改宿主。

## 规划（计划改动文件清单）

1. `security-guard/src/index.ts`：`GuardHost` 增可选 `tools.guard`；`createSecurityGuard` 改为「优先注册守卫、缺失则回退监听器」，挂载日志写明模式，disposer 相应返回。
1. `security-guard/tests/guard.test.ts`：`makeHost()` 增 `guards` 收集器与 `tools.guard`；新增守卫路径用例——命中返回字符串回执、未命中返回 `undefined`、**只注册守卫而不注册 pre-execute 监听器**（锁住「移动、不并存」）、无 `tools.guard` 的宿主降级后行为不变（沿用既有监听器用例）。
1. `security-guard/README.md`：新增 D5 所述「拦截顺序与契约」段落。
1. `docs/BACKLOG.md`：条目〔进行中〕→ 关闭时移除（余下条目按编号口径重编）。
1. 本追踪文档：建 → 关闭时移入 `docs/archived/`。

**估时** 30-45 min。**验收**：`security-guard` 的 `npm run check` / `build` / `test` 全绿 + 根 `npm run check` 绿；真机（需人工确认）：挂载后跑一条被黑名单命中的命令 → 被拒且结果为 `Error: <回执>`，`/guard` 只记**一条**记录。

## 实现记录

- `security-guard/src/index.ts`：`GuardHost` 增可选 `tools?: { guard(check: (exec: PreExecuteExecution) => string | undefined): unknown }`（`:149-155`）；`createSecurityGuard` 抽出单次判定 `inspect()`（命中→记日志 + 返回回执），**优先** `host.tools.guard` 注册单调守卫（命中返回回执字符串、未命中 `undefined`，`disposer` 取守卫返回值里的函数），**降级**才 `host.on("tools/pre-execute", …)` 返回 `{kind:"deny", reason}`；两种形态各写一条挂载日志（`monotonic guard` / `tools/pre-execute 回退`）。
- `security-guard/tests/guard.test.ts`：`makeHost({ monotonic })` 增 `guards` 收集器与 `tools.guard`（缺省不提供 → 既有 30+ 例仍走降级路径）；新增/改写 3 例——bundle 用例断言降级形态（1 listener / 0 guard + 日志含「回退」）、单调守卫形态（1 guard / **0 listener**，锁「移动、不并存」+ 日志含 `monotonic guard`）、守卫行为（命中回执字符串、未命中 `undefined`、两次判定 `recent()` 恰 2 条、`dispose()` 后守卫注销）。
- `security-guard/README.md`：首段改口径（单调守卫 + 回退）；新增「拦截顺序与契约（2026-10-07 裁定）」小节（两段判定机制 + 证据行号 + 本包选择 + 已知差异 + 回退路径）；`## 边界与限制` 的检查点分工措辞与例数（122 → 124）同步。
- 未改：`GuardEngine` 判定与规则内容、服务面（`recent` / `policy` / `inspectCommand`）、TUI `/guard` 接线、宿主。

## 测试与证据

调研证据全部为源码事实，逐条已注 `文件:行`（本机 `@deepseek-ai/dsh@0.2.0-rc.2` 安装目录 + 本仓）。

实施证据：

- `security-guard`：`npm run check` exit 0；`npm run test` **124 pass / 0 fail**（新增 2 例）。
- 全仓（本批两条目的同一轮）：`npm run check` exit 0；`npm run build` exit 0；`npm run test` 全绿（各包并行）；`npm run demo -- --smoke` → `SMOKE_OK` exit 0。
- 待人工：真机 `dsh --profile fff` 跑一条命中黑名单的命令 → 被拒且结果为 `Error: <回执>`，`/guard` 只记**一条**记录（验证「单次判定、不并存」）。

## 收尾

- 条目「`tools/pre-execute` 拦截顺序无契约」：完成 → 从 `docs/BACKLOG.md` 移除（余下条目重编）。
- `security-guard/README.md` 已按 D5 回写（「拦截顺序与契约」小节）。
- 本文件移入 `docs/archived/`。
- 本次未产生临时 / 调试文件。
