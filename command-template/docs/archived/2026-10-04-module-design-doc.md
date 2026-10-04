# command-template 模块 DESIGN.md 补建（接取条目：`command-template/docs/BACKLOG.md`「模块无 `DESIGN.md`」）

状态：进行中　　开启：2026-10-04　　关闭：—

## 计划改动文件清单（只改这些）

- `command-template/docs/DESIGN.md`（新建：定位 / 架构取舍 / 命令注册 / 模板加载与解析 / 步骤执行 / 宿主面 / 约束与边界 / 明确不做）
- `command-template/docs/BACKLOG.md`（条目标进行中 → 收尾移除）
- `docs/BACKLOG.md`（登记途中发现：**12 个模块缺 `DESIGN.md`** 的系统性缺口）
- 本追踪文档

## 调研（已核）

- 现状：本包只有 `README.md`（能力 / 配置 / 用法）与 `BACKLOG.md`；AGENTS.md 的模块文档口径含 `DESIGN.md`（架构与机制沉淀），此处缺失。
- 口径与风格参照已有 9 份模块 `DESIGN.md`（`task-engine` / `knowledge-base` / `session-channel` / `code-mark`… 实为 `code-map` / `rule-engine` / `symbol-normalizer` / `output-compress` / `ponytail` / TUI）：开头三行职责 / 不负责 / 过期条件，正文按「定位 → 取舍 → 机制 → 边界 → 明确不做」组织。
- **途中发现**（本条目范围外）：全仓 21 个模块里有 **12 个**没有 `DESIGN.md`（`ast-tools` / `command-template` / `context-report` / `fs-digest` / `goal-contract` / `hash-edit` / `herdr-integration` / `md-logic` / `md-map` / `metric-loop` / `security-guard` / `session-title-cutoff`）——本条目只补本包，系统性缺口按流程登记到项目级 BACKLOG。

## 决策

1. **补一份，而不是记「不建」**：本包的机制密度不低（入口 + 子命令分派、双源覆盖、YAML 子集解析、bestOf + 裁判、总预算「启动闸门」语义、取消竞速），这些取舍在 README 里放不下，且**已经踩过坑**（`dispose` 无界等待），值得沉淀成设计文档。
1. **章节对齐条目要求**（命令注册 / 模板加载 / 步骤执行 / 宿主面）并补「定位」「架构取舍」「约束与边界」「明确不做」——只写**代码里真实存在的机制**（逐节标注落点文件），不复述 README 的能力清单与配置表。
1. **不写变更史**：过程记录留在 `docs/archived/` 与 git；DESIGN 只描述现状与理由（避免两处维护）。
1. 途中发现的 12 模块缺口**不在本条目内顺手补**（每人一份会失控），登记条目后交其他 agent / 由用户裁定口径（补全 or 放宽 AGENTS.md 口径）。

## 实现记录（2026-10-04）

- 新建 `command-template/docs/DESIGN.md`（8 节）：定位与相邻能力分工、5 条架构取舍、命令注册（`inject`/`provide`、子命令分派顺序、服务面双守卫、`disabled`）、模板加载与解析（双源覆盖、坏模板进 `errors`、YAML 子集、`$ARGUMENTS`/`$1..$9`/`{{stepId}}`、未解析占位符 fail-soft）、步骤执行（prompt/agent 步、bestOf + judge、**总预算启动闸门**与 `effectiveBudget` / `budgetOrInfinity` 供 show 复用、首错收口）、宿主面（`readService` 解析序、一次性子代理、**取消竞速与回收不等待**）、约束与边界、明确不做。
- 项目级 `docs/BACKLOG.md` 追加条目（现第 4 行）「11 个模块缺 `DESIGN.md`（系统性缺口）」（本包已补，故计入缺口的为 11）。
- **审阅后的口径修订（同批）**：`DESIGN.md` 首版有 8 处与源码不符（见下「子代理审阅 §决策后」），已逐条改正；同批把 `src/types.ts` 中 `disabled` 的字段注释改为真实语义（**计划外文件**，理由：该注释与 `apply()` 行为矛盾，而本次正把「真实语义」写进机制文档，两处并存会误导；影响面仅注释文案，无行为变化）。
- 清单补充：`command-template/src/types.ts`（上述注释对齐）。

## 测试与证据（2026-10-04）

- 文档类改动：无代码路径变化，验证 = 逐节对照源码复核（`main.ts` / `registry.ts` / `frontmatter.ts` / `args.ts` / `steps.ts` / `subagent.ts` / `host.ts` / `types.ts` 的导出与注释）+ `format` + diff 自查。
- 事实核对清单：`ENTRY_SUBCOMMANDS`、`SERVICE_FACE_METHODS` + `serviceFace`、`LoadResult.errors`、`maxSteps`/`maxBestOf`/`stepTimeoutMs`/`totalTimeoutMs` 缺省（12 / 8 / 600000 / `maxSteps × stepTimeoutMs`）、`TemplateErrorCode` 七码、`StepDeps` 两件事、`pickProvider`/`settleOrAbort`/`reclaimInBackground` 三处取消语义——均与源码一致（两轮子代理审阅逐条核过）。
- 回归：`command-template` `npm test` 25 例 ✓（文档改动不触碰代码）。

## 子代理审阅

（决策后 / 收尾前各一轮，记录见下）

## 子代理审阅

（决策后 / 收尾前各一轮，记录见下）

### 决策后（2026-10-04）

只读审阅（逐节对照源码；`command-template` 25 例 ✓）。结论「需改」：**2 处阻断 + 1 处重要 + 3 处次要**，全部为「文档写了源码里没有的机制」：

1. **[阻断] 「模板即命令 / 逐模板注册 `/<name>`」不成立**：`register()` 只注册入口 `playbook` 一条（`definitionId: command-template:playbook`），description / hint 硬编码；模板是入口的**参数**。→ §1 / §2 / §3 / §8 全部改正（含「补全里只有 `playbook`」）。
1. **[阻断] `disabled` 语义写错**（原写「只加载不注册」）：`apply()` 在 `load()` / `provide()` **之前** return → 不加载、不注册、不 provide，`list` / `errors` 也不可见。→ 文档改正，并同步 `src/types.ts` 的字段注释。
1. **[重要] `readService` 写成「双 ctx」**：实为单 ctx 内 `ctx.get()` 优先、属性直读兜底、都失败 → `undefined`。同节 `buildOneShotRequest` **无** `outputSchema`；provider 缺面是**抛错** → `steps.ts` 归一为 `step_failed`（`agent_unavailable` 等属保留码，从不发出）。→ §6 改正；§2 错误码段落补「实际会发出 / 保留码」两栏。
1. **[次要] 三处细节**：入口「兜底 list」仅在**输入为空**时发生（未知模板名报错）；保留名冲突**仅记日志**（不静默改名）；`/playbook show` 只调 `budgetOrInfinity`（`effectiveBudget` 是其内部一步）。→ 均改正。
1. **[提示] 头部缺「过期条件」行** → 已补（与其它模块 `DESIGN.md` 三行头一致）。

### 收尾前（2026-10-04）

只读复核（逐条读码）。1 / 2 / 4 / 5 / 6 条与源码一致；第 3 条主体一致但尾句不实。结论「需改」：

1. **[重要] 错误码事实错误**：`session_unavailable` 被列为「保留码」、且把「注入失败」算进 `step_failed`——源码 `steps.ts` 的 `prompt` 步注入失败**即返回 `session_unavailable`**（既有用例有断言）。→ 已把 `session_unavailable` 移入「当前会发出」，并把注入失败从 `step_failed` 说明移走。
1. **[次要] `template_invalid` 触发面写宽**：实际只有「步骤数超 `maxSteps`」与「`bestOf` 超 `maxBestOf`」；frontmatter 形状 / 解析错误只进 `LoadResult.errors`。同处漏列 `run_timeout`（预算超限）。→ 已改正并补 `run_timeout`。
1. **[次要] 「`report` 面」不存在**：服务面只有 `list` / `get` / `errors` / `reload`，坏模板在 `/playbook list` 输出末尾列出。→ 已改。
1. **[次要] `readService` 尾句「调用方各自决定用哪个 ctx」无代码对应**：调用点用的都是 `apply` 的插件 ctx。→ 已删该句、改为陈述事实。
1. **[提示] 「disabled 时全包静默」不准**：仍向 stderr 写一行禁用提示。→ 已改。
1. **[提示 · 源码隐患] `/playbook playbook` 无限递归**：`run()`（入口名 → `#dispatch`）与 `#dispatch`（第一段当模板名 → `run()`）互调，而 `ENTRY_COMMAND` 不在 `#reserved()` 里 → 爆栈。**属源码缺陷、非文档问题**，按流程登记：`command-template/docs/BACKLOG.md`「`/playbook playbook` 触发无限递归」（含复现与修法建议，交其他 agent）。

## 收尾

- 条目从 `command-template/docs/BACKLOG.md` 移除（同表登记收尾审阅发现的源码缺陷条目）。
- 本追踪文档移入 `command-template/docs/archived/`；本次变更合并为一次提交（新建 `DESIGN.md` + `types.ts` 注释对齐 + BACKLOG 两处 + 归档文档），提交见 git 历史。
- 复跑记录：`npm run check`（根，20 包）✓、`npm run build` ✓、`command-template` `npm test` **25 例** ✓。
