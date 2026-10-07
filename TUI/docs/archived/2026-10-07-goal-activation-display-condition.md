# `⟳` 显示条件改「收到过边就显示」（接取条目：`TUI/docs/BACKLOG.md`「`⟳` 显示条件改「收到过边就显示」（取消相位门控 + 取消推导初值）」）

状态：完成　　开启：2026-10-07　　关闭：2026-10-07
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`⟳`（goal 自动续轮开关）现在的显示条件有两处「多余的推断」：① 只在当前 goal `phase === "active"` 时显示；② 无记录时推导为 `disarmed`（灰）。本任务按用户 2026-10-06 裁定改为：**有边就显示、无边就不显示**。

## 调研（2026-10-07，源码复核）

1. selector 现状 `state.ts:234-243` `activeGoalActivation`：`if (phase !== "active") return undefined;`（相位门控）→ `return state.goalActivationBySession[sessionId] ?? "disarmed";`（推导初值）。
1. 渲染现状：`layout.ts:909` `GOAL_ACTIVATION_SYMBOL = "⟳"`；`:1226-1234`（状态列 head 行）与 `:1697`（另一处同族渲染）都以「值是否定义」决定是否出符号；颜色 `GOAL_ACTIVATION_COLOR`（`:912-915`）armed 绿 / disarmed 灰。
1. 宿主事实（条目已核，`dsh-goal/lib/index.js`）：activation 是**会话级进程本地值、恒有值**（初值 disarmed）；`create`/`resume` → armed；`pause`/`block`/`complete`/`clear` → disarmed；`edit` 保留现值；`goal-round-driver` 会在相位仍 active 时主动 disarm。
1. 受影响的用例（子代理探针实测，单点变异去门控 + 去推导）：**3 项变红，全在 `tests/goal-activation.test.ts`**——`:126-133`（期望 `"disarmed"`）、`:155-177`（`:162` 断言无 goal 时 `undefined`，实测变 `'armed'`）、`:179-214`（回放灰 `⟳`）；另有 `:103-124` **仍绿但语义失效**（标题「非 active 相位 → 不显示」不再成立）、`withGoal` 的相位联合（`:40`）缺 `blocked`。`tests/status-column.test.ts:504-522` 实测**全绿**——非 active 相位的显示需要**新增**用例，不是改写。

## 决策

**D1｜selector 语义** → 去门控、去推导：`if (!sessionId) return undefined;` 然后直接 `return state.goalActivationBySession[sessionId];`（无记录 = `undefined` = 不显示）。同时按条目建议**改名**为 `goalActivationDisplay`（旧名里的 "active" 已不成立），调用点与类型注释一并更新。

**D2｜渲染层不动** → `layout.ts` 的「值定义才出符号」判据不变，颜色映射不变（armed 绿 / disarmed 灰——用户已更正：不是黑）。

**D3｜后果（知情接受，按条目原文）** → 宿主重启 / 回放 / 会话切换后**不再显示灰 `⟳`**，直到收到新的 activation 边；「无记录 → disarmed」的当时决策（`docs/archived/2026-10-04-tui-goal-activation-symbol.md`）被推翻——**归档文档不改**，按新口径回写 `TUI/docs/SPEC.md` §15.1、`TUI/docs/DESIGN.md`（状态事件映射 / 顶部状态列）、`TUI/README.md:148`（清理「无记录 → disarmed」表述）。

**D4｜用例改写口径** → ①「无记录 → 不显示」（原「回放仍显示灰」用例按新口径改写，并保留 armed → 绿）；② 四个相位（active / paused / blocked / complete）在**有 disarmed 边**时都显示灰；③ 无当前 goal 整块不显示；④ 历史行**不带**任何符号（不变）。

**明确不做**：不改历史行的符号口径；不改颜色；不动宿主；不为「重启后仍想看到灰」加粘性记忆（条目明确否掉）。

## 规划（计划改动文件清单）

1. `TUI/src/app/state.ts`：`activeGoalActivation` → `goalActivationDisplay`，去门控 + 去 `?? "disarmed"`，注释改写。
1. `TUI/src/app/layout.ts`：**唯一代码调用点**是 `:1698`（import 在 `:26`）——改名 + 注释同步；判据与颜色不变。
1. `TUI/tests/goal-activation.test.ts`（D4 ①②③）：`:126-133` 去掉「无记录 → `disarmed`」断言；`:155-177` 的 `:162` 改为「selector 仍返回值 + **渲染面无 `⟳`**」（块级门控现在由 `layout.ts:1210` 的 `goalList.length > 0` 承担）；`:179-214` 按「无记录 → 不显示」改写并保留 armed → 绿；`:103-124` 标题与语义重写；`withGoal` 的相位联合（`:40`）补 `blocked` 以覆盖四相位。
1. `TUI/tests/status-column.test.ts`：**新增**「非 active 相位 + 有 disarmed 边 → 灰 `⟳`」用例（既有断言无变红）。
1. 文档回写：`TUI/docs/SPEC.md:664`（两处：「`phase !== "active"` 时不显示」+「展示值经 `activeGoalActivation` 推导（无记录 → `disarmed`）」）与 `:668`（回归条口径）；`TUI/docs/DESIGN.md:228`（状态事件映射表行）、`:239`（渲染语义「无记录按 `disarmed` 兜底」）、`:413`（会话状态恢复「无记录时由展示值推导为 `disarmed`」）；`TUI/README.md:148`。归档文档（项目级 `docs/archived/2026-10-04-tui-goal-activation-symbol.md`）按约定不改。
1. `TUI/docs/BACKLOG.md`：条目〔进行中〕→ 关闭时移除（余下条目按编号口径重编）。
1. 本追踪文档：建 → 关闭时移入 `TUI/docs/archived/`。

**估时** 45 min（子代理复核后上调：用例改写面比原估大）。**验收**（条目原文）：无记录（重启 / 回放）不显示 `⟳`；有 disarmed 边 → 四个相位均显示灰；有 armed 边 → active 绿；无当前 goal 整块不显示；历史行无符号；回归全绿 + 真机目视。

## 实现记录

- `state.ts`：`activeGoalActivation` → `goalActivationDisplay`，去掉相位门控与 `?? "disarmed"`；文档注释改写为新口径（有边就显示、无记录不显示）；两处描述旧推导的注释（`:743` / `:2263`）同步改写。
- `layout.ts`：import（`:26`）与唯一调用点（`:1698`）改名；判据与颜色映射未动。
- 用例：`goal-activation.test.ts` 三处按 D4 改写——`103` 起的用例改为「无记录 → 不显示（与相位无关）」+ 新增「四相位 + disarmed 边都显示」（`withGoal` 的相位联合补 `blocked`）；「重启回归」用例改断言 `undefined`；「边先到」用例改断言 `"armed"` 并注明整块门控在渲染层；端到端回放用例改为「无记录不显示 ⟳ → disarmed 边显示灰 ⟳ → armed 边转绿」。`status-column.test.ts` 的 `⟳` 用例新增「非 active 相位（paused / blocked / complete）+ disarmed 边 → 灰 `⟳`」三条断言。
- 文档回写：`SPEC.md:664`（两处）+ `:668`、`DESIGN.md:164` / `:228` / `:239` / `:413`、`README.md:148` 全部改为新口径；归档文档（项目级 `docs/archived/2026-10-04-tui-goal-activation-symbol.md`）按约定未改。

## 测试与证据

- `TUI`：`npm run check` ✓；`./scripts/test.sh goal-activation.test.ts` → **7 pass / 0 fail**；`status-column.test.ts` → **20 pass / 0 fail**；全量 `npm run test` → **1335 pass / 0 fail**。
- 变异验证（子代理审阅阶段）：仅去门控 + 去推导 → 恰好 3 项变红（`goal-activation.test.ts` 的重启回归、无 goal 顺序无关、端到端回放），与本轮改写面一致；`status-column.test.ts` 测得全绿 → 新口径的渲染覆盖以**新增断言**补齐。
- 真机目视：待用户确认（`⟳` 在 paused / blocked / complete + 有边时显示灰；重启后无记录不显示）。

## 收尾

- 已关闭：`TUI/docs/BACKLOG.md` 移除该条目（余下 5 条按编号口径重编，来源注记重写；本条目的下游「Goal 块一句话概括」前置已落地）；本文件移入 `TUI/docs/archived/`。
- 附带：`layout.ts` 无其它引用（`demo` 未用），未越界改任何计划外文件。
