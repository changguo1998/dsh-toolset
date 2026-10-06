# 多题面板当前题符号改实心（接取条目：`TUI/docs/BACKLOG.md`「多题问答面板：当前题的符号除变黄外，还要从空心切到实心」）

状态：关闭　　开启：2026-10-07　　关闭：2026-10-07
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

多题问答面板顶部符号行里，**当前题**除颜色黄之外，符号字形由**空心切实心**（`○→●`、`□→■`、`△→▲`），其余题保持空心 + 灰。范围只在这条符号行，不动单题面板、审批标题、选项标记与其它符号位。

## 调研（2026-10-07，源码 + 既有测试 + 夹具 grep；含子代理复核）

1. 现状（`src/app/components/QuestionPrompt.ts`）：`typeSymOf`（`:443-446`）按类型返回空心符号——`SYM_PLAN = "△"`（`:60`）/ `SYM_MULTI = "□"`（`:61`）/ `SYM_SINGLE = "○"`（`:62`）；`buildSymbolRow`（`:451-480`）在 `:474` 只按 `i === active` 上色（黄 / 灰），字形与当前题无关。
1. **调用面极窄**：全仓 grep（含 `tests/` / `demo/` / `scripts/` / `docs/`）显示 `typeSymOf` 只有一处调用（`buildSymbolRow` 内 `:465`），`SYM_*` 三常量未 export、也只被 `typeSymOf` 使用 → 改这条路径不会外溢。其它渲染挂心符号的位置都是独立常量 / 字面量：`components/ApprovalPrompt.ts:26`、`app/layout.ts:895`（Goal blocked）、`:919`（Todo）、`:2447`（用户块等待）、`components/JobsPanel.ts:98-108`、`app/layout.ts:2394-2398`（运行中 `●`/`○`）。
1. **等宽已实测**（条目原文探针 + 子代理复测）：`○` `●` `□` `■` `△` `▲` 的 `charWidth` / `displayWidth` **均为 1**，` 1○ 2□ 3△` 与 ` 1● 2□ 3△` 同为 9 列（既有断言 `tests/width-eaw.test.ts:48-51` 同口径）→ 截断预算（`:468` 按 `displayWidth(`${i+1}${sym}`)` 累加、为 `…` 预留 1 列）与折行口径**不变**。六个码点都在 `WIDTH_UNCERTAIN_RANGES`（`src/app/layout/eaw-table.ts:120,122`），宽度由运行期逐码点 CPR 实测（`layout/markdown.ts:504-543`）。
1. **冻结基线不涉及**：`tests/fixtures/focus-frame-legacy.json` 经 grep（本会话 + 子代理）**无多题场景**——无 `○` / `□`，`△` 只有 6 处（用户块等待符 `:813`/`:913`、审批标题 `:841`），唯一 question 场景是单题（`scripts/freeze-focus-frame.mts:88-101`）→ 不触发 `scripts/freeze-focus-frame.mts` 重跑。
1. 受影响断言（grep）：`tests/question-window.test.ts`（用例标题、形态 `1○ 2□ 3△`、两处颜色断言、截断用例注释）、`tests/app.test.ts:2177`（`1○ 2□`）、**`demo/main.ts:349`（`plain.includes("1○ 2□")`，载荷见 `:202-210`：q1 单选、q2 多选，面板打开即 `itemIndex = 0` → 不改则 `npm run demo -- --smoke` 必红）**。文档面：`TUI/docs/SPEC.md:450`、`TUI/docs/DESIGN.md:507`、`TUI/README.md:326` 均写「符号用空心几何符号 / 当前题黄」。

## 决策

**D1｜实心符号怎么取？** → **加一张按空心符号索引的映射表**（`SYM_FILLED`），只在 `buildSymbolRow` 内按 `i === active` 查表；**不给 `typeSymOf` 加「是否当前题」入参**。理由：`typeSymOf` 的语义是「题类型 → 符号」，实心只是**当前题这一显示态**的修饰；加参数会把显示态混进类型函数，日后其它调用点（若新增）容易漏传而静默回退。为免「查表未命中 → 静默回退空心」（`noUncheckedIndexedAccess` 下 `SYM_FILLED[sym]` 本是 `string | undefined`，写 `?? sym` 兜底就等于引入该回退），把 `typeSymOf` 的返回类型收窄为三常量字面量联合 `QuestionSym`，`SYM_FILLED` 声明为 `Record<QuestionSym, string>` —— 表对联合**完备**，取值类型即 `string`，**不需要兜底分支**，空心 / 实心同源于三个 `SYM_*` 常量。

**D2｜作用范围？** → 只改 `buildSymbolRow` 的当前题一项：单题面板无符号行（`headerRows === 0`，由 `:174` 的 `total > 1 ? 1 : 0` + `:435-438` 保证）不受影响；审批面板标题 ` △ 等待审批`、选项标记 `✓`、状态列 / 用户块符号**都不动**（不同常量 / 字面量，见调研 2）。

**D3｜截断与折行要不要跟着改？** → **不改**。三对字形等宽（1 列；六码点均在 `WIDTH_UNCERTAIN_RANGES`，宽度走运行期 CPR 实测），预留 1 列的截断判据、`displayWidth` 累加口径与 `wrap: false` 均保持。**同宽终端下不出现行为差异**；若某终端实测实心字形为 2 列，因 `:468` 用的是同一个 `displayWidth`，只会让当前题那一项在边界宽度上早 1 列被截断（不溢出、不折行），结论仍是「不改截断」。

**D4｜测试与文档改哪些？**

- `tests/question-window.test.ts`：用例标题与文件头注释补「当前题实心」；形态断言 `1○ 2□ 3△` → **`1● 2□ 3△`**；颜色断言由「当前题黄 `○`」改「当前题黄 `●`」，并补「非当前题仍为空心 `○`」的反向断言；切到第 2 题后由 `□` 改 **`■`**；**追加切到第 3 题（plan-review）断言 `▲`**，把三条映射全锁住；截断用例的注释同步字形（断言本身只查 `…` 与「不出现后续题」，不受影响）。
- `tests/app.test.ts`：`strippedFrame` 断言 `1○ 2□` → **`1● 2□`**（消息文案同步）。
- `demo/main.ts`：冒烟断言 `1○ 2□` → **`1● 2□`**。
- 文档：`TUI/docs/SPEC.md`（§7.1 标题类型标识）、`TUI/docs/DESIGN.md`（问答面板段）、`TUI/README.md`（问答面板段）各补一句「**当前题实心**（`●`/`■`/`▲`）、其余空心灰」。

**明确不做**：符号几何 / 间距 / 截断口径；单题面板；审批面板标题；选项 `✓` 标记；状态列 / 用户块 / Jobs / Goal 符号；冻结基线重跑（无多题场景）。

## 规划（计划改动文件清单）

1. `TUI/src/app/components/QuestionPrompt.ts`：`typeSymOf` 返回类型收窄为 `QuestionSym`；新增 `SYM_FILLED`（`Record<QuestionSym, string>`）与 `:465` 处的当前题查表；同步 `:59` 常量注释与 `:448-450` 的 `buildSymbolRow` 文档注释。
1. `TUI/tests/question-window.test.ts`：多题符号行用例按 D4 改写（形态 / 颜色 / 三题切换 / 截断注释）。
1. `TUI/tests/app.test.ts`：`1● 2□` 断言与文案。
1. `TUI/demo/main.ts`：冒烟断言按新字形更新（**子代理审阅补漏——原计划漏此文件，改后必红**）。
1. `TUI/docs/SPEC.md`、`TUI/docs/DESIGN.md`、`TUI/README.md`：当前题实心口径。
1. `TUI/docs/BACKLOG.md`：条目标〔进行中〕→ 关闭时移除。
1. 本追踪文档：建 → 关闭时移入 `TUI/docs/archived/`。

## 实现记录

- 2026-10-07：接取条目并标〔进行中〕；建本追踪文档（目标 / 调研 / 决策 / 规划）。
- **决策阶段子代理审阅（`823865d1`）：有异议 1 条（中等，改后必红）+ 2 条低风险说明，三条全部采纳**：
  1. `demo/main.ts:349` 冒烟断言 `1○ 2□` 未列入计划 → 已并入计划与本次改动（子代理实测：改后无任何帧含旧字形，`SMOKE_FAIL` 必现）；
  1. D1 理由补自洽——`noUncheckedIndexedAccess` 下查表本会得 `string | undefined`，故收窄 `typeSymOf` 返回类型为三常量联合、表声明为 `Record<QuestionSym, string>`，对联合完备、**无需兜底分支**；
  1. D3 措辞附条件（同宽终端无差异；若某终端实测实心 2 列，仅当前题早 1 列截断、不溢出）。
- `src/app/components/QuestionPrompt.ts`：新增 `QuestionSym` 字面量联合与 `SYM_FILLED`（`△→▲` / `□→■` / `○→●`）；`typeSymOf` 返回类型改 `QuestionSym`；`buildSymbolRow` 内 `const hollow = typeSymOf(...)` + `const sym = i === active ? SYM_FILLED[hollow] : hollow`；常量注释与函数文档注释同步（示例改 ` 1● 2□ 3△`）。
- `tests/question-window.test.ts`：形态断言 → `1● 2□ 3△`；颜色断言改「当前题黄 `●`」并补「非当前题仍空心 `□`」；切题后断言 `1○ 2■ 3△`；**追加切到第 3 题（plan-review）断言 `1○ 2□ 3▲`**（三条映射全覆盖）；截断用例注释同步字形。
- `tests/app.test.ts`：`1● 2□`（含消息文案）。
- `demo/main.ts`：冒烟断言 `1● 2□`。
- 文档：`TUI/docs/SPEC.md`（§7.1）、`TUI/docs/DESIGN.md`（问答面板段）、`TUI/README.md`（问答面板段）同步「当前题实心、其余空心」。

## 测试与证据

- `TUI` 实测（2026-10-07，本机）：
  - `npm run check` ✓（`tsc --noEmit` 无输出）
  - `npm run build` ✓
  - `npm run test` ✓ **1332/1332 通过**（`fail 0`；与改动前基线同为 1332 例——本条目只改既有用例内的断言，不新增用例）
  - `npm run demo -- --smoke`：**`SMOKE_PASS question-rendered`** ✓（本次改动的断言）；整体 `SMOKE_FAIL n=1`，唯一失败为 **`activity-mixed-ordered`**——即 `TUI/docs/BACKLOG.md`「`npm run demo -- --smoke` 的 `activity-mixed-ordered` 场景恒失败」记录的既有缺陷，与本次改动无关（不涉及该场景的帧解析路径）。
- 冻结基线 `tests/fixtures/focus-frame-legacy.json`：**未重跑**——基线无多题场景（`○` / `□` 零命中，`△` 均为用户块等待符与审批标题），本改动不触及这些帧。
- 反向验证（子代理）：六个字形 `charWidth` / `displayWidth` 全为 1，` 1○ 2□ 3△` 与 ` 1● 2□ 3△` 同为 9 列。
- 人工确认门禁：按用户在 goal 中的指示（跳过中间提交确认点、每条目一次收尾提交），以「`check` / `build` / `test` 全绿 + 冒烟相关断言绿 + 子代理审阅闭环」为凭据；条目验收里的「真机目视切题符号随手切换」由单测三题切换 + 冒烟断言替代覆盖，真机目视留待用户下次 `dsh --profile fff` 时顺带确认。

## 收尾

- 条目：按完成清理，已从 `TUI/docs/BACKLOG.md` 移除；余下六条按编号口径重编为 1-6，两处「前置 = 条目 N」与来源注记同步左移。
- 回写：`TUI/docs/SPEC.md`、`TUI/docs/DESIGN.md`、`TUI/README.md`（当前题实心口径）。
- 本文件移入 `TUI/docs/archived/`。
- 遗留项：真机目视（用户侧，非阻塞）；无代码遗留。
- 关闭日期：2026-10-07。
