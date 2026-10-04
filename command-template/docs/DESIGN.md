# command-template 设计

> 职责：本包的架构与机制沉淀（为什么这样切、边界在哪）
> 不负责：能力清单与配置表（见 `README.md`）、未完成项（见本目录 `BACKLOG.md`）、变更过程（见 `docs/archived/` 与 git 历史）
> 过期条件：无（机制变化即更新）

## 1. 定位

把「可复用的提示词流程」做成**命令入口 + 模板参数**：仓库随包 `templates/*.md` 提供预案（如 `code-review` / `plan-then-code`），用户可在 `$DSH_HOME/command-templates` 覆盖或新增；调用形态是 `/playbook <模板> [参数]`（模板**不占**独立命令名），模板正文 = 一串**步骤**（注入本会话的 prompt 步 / 一次性子代理的 agent 步），支持模型覆盖、`bestOf` 并行候选与裁判步。

与相邻能力的分工：宿主 `commands` 负责命令注册与分发（本包只注册与实现）；子代理执行复用宿主 `subagents` 的 `spawn` provider（不自己起进程 / 不自己管会话）；本包**不管**会话模型选择（模板级 `model` 只作用于本次子代理运行）。

## 2. 架构取舍

- **单一入口命令**：`register()` 只注册一条命令 —— 入口 `playbook`（`definitionId: command-template:playbook`，description / hint 为**硬编码文案**，只把 `list | show <模板> | reload | <模板> [参数]` 提示出来）；模板**不注册独立命令**，全部经入口的**参数分派**（`/playbook <模板> [参数]`）。取舍理由：模板数量会增长，逐模板注册会长期占用用户命令命名空间，且难以与宿主 / TUI 本地命令共存。
- **保留名只告警不改名**：模板名与保留子命令（`ENTRY_SUBCOMMANDS`，可经 `reservedNames` 改）冲突时**仅记日志**（`模板名与入口 / 子命令名冲突（无法调用）`——告警集合是「入口命令名 + 保留子命令名」），不静默改名、也不覆盖子命令——该模板因此无法通过入口调用，属用户需自行处理的名字问题。
- **双源目录、后覆盖前**：随包目录（低优先级）→ 用户目录（高优先级），用户可用同名文件覆盖随包模板而无需 fork；扫描**不递归**（目录结构由用户掌控，避免 `node_modules` 一类的意外命中）。
- **执行侧是可注入的纯函数**（`runTemplate(tpl, deps, options)`）：`StepDeps` 只暴露「注入本会话」与「跑一次性子代理」两件事，测试用替身即可覆盖全部步骤语义，宿主依赖集中在 `subagent.ts` / `host.ts` 两处。
- **失败面用稳定错误码**（`TemplateErrorCode`）而非文案匹配；文案可改、码不改。**当前会发出的**：`template_invalid`（**仅**步骤数超 `maxSteps` 与 `bestOf` 超 `maxBestOf`——frontmatter 形状 / 解析错误只进 `LoadResult.errors`，不发码）、`step_failed`（agent 步失败或超时归一）、`run_timeout`（超出总预算）、`session_unavailable`（prompt 步注入当前会话失败）。`template_not_found` / `name_conflict` / `agent_unavailable` 属**保留码**（当前实现走 notice / 日志文案，不从这里发出）。

## 3. 命令注册（`src/main.ts`）

- `inject: ["commands"]`、`provide: ["commandTemplate"]`（DSH bundle 契约）；`apply(ctx, config)` 建 `CommandTemplateService` → `load()`（扫模板）→ `register()`（**只注册入口命令** `playbook`：description / `input.hint` 为硬编码文案，模板的 `description` / `input.hint` 只用于 `list` / `show` 的输出）。`commands` 未挂载时记日志并跳过注册，**服务面照常提供**（`list` / `errors` 仍可见）。
- 入口分派（`#dispatch`）：输入为空 → `list`；第一段是保留子命令（`list` / `show` / `reload`）**或入口命令名本身**（`playbook`）→ 走管理面（否则 `run()` ⇄ `#dispatch()` 互调会递归，2026-10-04 修）；否则第一段按**模板名**运行（含后续参数）；模板名未知 → 报「模板不存在」错误（不回落 `list`）。
- 运行路径把 config 的四个旋钮（`maxSteps` / `maxBestOf` / `stepTimeoutMs` / `totalTimeoutMs`）透传给 `runTemplate`（未配置的字段**不传**，由 `steps.ts` 的缺省常量兜底——缺省值只有一处定义）。
- **服务面**（`ctx.get("commandTemplate")`）由 `serviceFace(service)` 构造：`list` / `get` / `errors` / `reload`；键清单常量 `SERVICE_FACE_METHODS` 与实现由两条测试守卫（键漂移、服务方法改名、`apply()` 实际 `provide` 的内容）。
- `config.disabled`（离线排障）：`apply()` 在 `load()` / `provide()` 之前就返回 —— **不加载模板、不注册命令、不提供 `commandTemplate` 服务面**（只向 stderr 记一行禁用提示），故这种模式下 `list` / `errors` 也不可见（`src/types.ts` 的字段注释据此对齐）。
- 加载失败不抛：坏模板进 `LoadResult.errors`——`/playbook list` 输出末尾会列出（服务面 `errors()` 亦可见）。

## 4. 模板加载与解析（`src/registry.ts` / `src/frontmatter.ts` / `src/args.ts`）

- `resolveDirs` → `loadTemplates(dirs)`：目录顺序 = 优先级**低 → 高**，同名后者覆盖；每个坏模板记 `{source, error}` 进 `LoadResult.errors`，不中断其它模板。
- `frontmatter.ts` 是**YAML 子集**解析器（frontmatter 键值 + 块标量 + `steps` 序列 + `model` 简写/嵌套），刻意不引 YAML 依赖：模板由人写、形状收敛（`spec`/`acceptance` 那类复杂结构不属于模板）。
- 正文未声明 `steps` → 视为**单个 prompt 步**（「一段提示词就是一条命令」的最短路径）。
- 参数展开（`args.ts`）：`$ARGUMENTS` / `$1..$9` / `{{stepId}}`（引用已完成步的产出）；未解析占位符**告警但继续**（fail-soft：宁可跑出一份带原文的提示词，也不要罢工）。

## 5. 步骤执行（`src/steps.ts`）

- `runTemplate` 顺序执行步骤，每步产出文本进入 `results`（供 `{{stepId}}` 引用）与 `RunOutcome.steps`（失败时带**已完成部分**）。
- `prompt` 步 = `deps.injectPrompt(text)`（注入当前会话，零耗时）；`agent` 步 = `deps.runAgent(text, {model, timeoutMs})`（一次性子代理，模型取步级 → 模板级 → 会话默认）。
- `bestOf > 1`：`Promise.all` 并行跑 N 个候选（上限 `maxBestOf`）；有 `judge` → 裁判步（也走 `runAgent`）从候选中选最佳并标记 `judged`；无 `judge` → 取首个成功；**全灭 → `step_failed` 并带首个候选的错误**（错误面收口成一条可读原因）。
- **总预算是「启动闸门」不是 deadline**：`budgetOrInfinity(options)`（`effectiveBudget` = `totalTimeoutMs ?? maxSteps × stepTimeoutMs`，非正 / 非有限 → 不设）决定剩余预算；预算不足**不再启动新 agent 步**，每步有效超时 = `min(stepTimeoutMs, 剩余)`；超限 → `run_timeout`，文案带已用 / 预算 ms 与已完成步。`/playbook show` **复用 `budgetOrInfinity`**（显示生效值与来源；`effectiveBudget` 是它内部的一步），避免「显示的预算」与「实际生效的预算」两套算法漂移。

## 6. 宿主面（`src/subagent.ts` / `src/host.ts`）

- `host.ts` 的 `readService(ctx, key)`：**同一 ctx 内**先 `ctx.get(key)`（严格模式下未 `inject` 的属性直读会抛，故必须走 getter），抛错 / 空值再回退属性直读，两者都失败视为「服务不可用」（`undefined`）。调用点用的都是 `apply` 收到的那个插件 ctx（`main.ts` 接线 `StepDeps`、`subagent.ts` 取 `subagents`）；`availableProviders(ctx)` 只作诊断出口。
- `runOneShotAgent`：经宿主 `subagents` 跑一次性子代理（`buildOneShotRequest`：prompt 块 + `agentOptions` 模型覆盖；**不带 `outputSchema`**）；provider 从可用列表里挑（`pickProvider`，`spawn` 优先）——**服务缺面 / provider 不可用时抛错**，由 `steps.ts` 归一成 `step_failed`（不是 `agent_unavailable`）。
- **取消语义**（2026-10-02 真机教训）：`start` 与 `run.result` 都与调用方取消信号**竞速**（`settleOrAbort`）；abort 路径 `reclaimInBackground` **发起回收但不等待**——宿主 in-process 的 `dispose()` 内部会 `await run.result`，等它等于换个地方无界等待。命令路径因此恒有终态，文案区分「被调用方取消」/「步骤超时（N ms）」并带子会话 id。

## 7. 约束与已知边界

- 模板目录不递归；同名以「目录优先级」定胜负，无第三处覆盖规则。
- 模板级模型只影响本次子代理运行，不改会话模型（TUI 的 `/model` 才是会话级）。
- `prompt` 步的产出 = 注入的文本本身（不是模型回答）——它代表「已把这段提示词交给当前会话」。
- 单次运行不做跨进程恢复：中途 abort / 超时后已完成步的结果只在返回里（不落盘）。
- `bestOf` 的候选是**并行**独立子代理，彼此看不到对方产出；裁判步只看到拼接后的候选文本。

## 8. 明确不做

- 不做模板市场 / 版本管理 / 依赖解析（模板是文件，覆盖即升级）。
- 不做参数类型校验（参数一律按文本展开为 `$ARGUMENTS`）。
- 不逐模板注册命令：补全里只有入口 `playbook` 一条（模板名只出现在它的 `input.hint` 与 `/playbook list` 输出中）。
- 不做工作流引擎（循环 / 条件 / fan-out 语义属宿主 `workflow`，本包只做线性步骤 + bestOf）。
