# 冒烟补「总结落在会话 pane」的按列断言（接取条目：`TUI/docs/BACKLOG.md`「冒烟 `activity-mixed-ordered` 只验行序，不再验「总结落在历史 pane」」）

状态：决策　　开启：2026-10-07　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`activity-mixed-ordered` 场景现在只验「活动条目行号递增 + 总结可见」（TUI#2 修取证时删掉了那条恒真的分隔行判据）——**总结落在哪个 pane 无人验**。补一条**按列**判定的断言：`混合最终总结`（`final` → 会话 pane）必须出现在会话 pane 的列区间内，而活动内容（`混合中间输出`）必须落在回合 pane 一侧。

## 调研（2026-10-07，沿用 TUI#2 的取证改造）

1. 取证现状（`demo/main.ts` 的该场景）：`const smokeSize = renderer.getSize()` → `new ScreenEmu(cols, rows)` → `screen.feed(smokeOut)` → `mixedLines = Array.from({length: rows}, (_, r) => screen.line(r))`，随后按 `lineIdx(sub)` 取行号断言时间序。
1. `ScreenEmu` 提供 `slice(r, from, width)`（按**显示列**切片，行尾裁剪），正是按列断言要用的口径（`tests/helpers/screenEmu.ts:117-122`）。
1. 排列与 pane 边界：80×24 的 `auto` 实测为**左右排列**（会话 pane 在左、回合 pane 在右），顶边行形如 `├── Session ──┬── Turn ──`——内部竖线列可用 `┬` 定位；上下排列时该行不存在（`┬` 缺失），此时会话 pane 在上、回合 pane 在下（`layout.ts` 的 `topPaneSplit`）。
1. 列宽换算：`emu.line(r)` 是字符串，`indexOf("┬")` 是**字符**下标；宽字符（CJK）下与显示列不等价 → 必须用 `displayWidth(prefix)` 换算（`src/app/layout.ts` 已导出，demo 可直接用）。

## 决策

**D1｜断言形态** → 加**一对**互相反向的断言（同一 `ok(...)` 组内两条）：

- `activity-mixed-summary-in-dialogue`：`screen.slice(sumRow, 0, divCol)` 含 `混合最终总结`（左右排列）；上下排列退化为 `sumRow < midRow`；
- `activity-mixed-activity-side`：`screen.slice(midRow, divCol, cols - divCol)` 含 `混合中间输出`（左右排列）；上下排列退化为 `midRow > sumRow`。
  理由：单条「总结在左半边」在排列变化时会假红；两条互相钉住两侧。**反向验证的口径**（子代理实测）：临时删掉该场景的 `turn-end` 发射 → 总结留在回合 pane → **断言 1 变红**、断言 2 仍绿（既有 `activity-mixed-ordered` 也仍绿，正说明缺口真实存在）——两条本身互证不了，反向验证靠断言 1 单条 + 该临时改法。

**D2｜pane 边界怎么取** → 从**帧本身**取（含 `Session` 与 `Turn` 的标题行上的 `┬`），不用 `frameGeometry`（demo 侧拿几何要多引一层 API，而标题行就在屏幕上、更贴近「实际渲染」的口径）。

**D3｜列宽换算** → `divCol = displayWidth(line.slice(0, line.indexOf("┬")))`；`┬` 缺失（上下排列）时 `divCol = -1` → 走 D1 的行序退化分支。

**明确不做**：不动 `tests/helpers/screenEmu.ts`、不动渲染层与布局、不改该场景的其它断言、不加其它场景的 pane 归属断言（只补这一条缺口）。

## 规划（计划改动文件清单）

1. `TUI/demo/main.ts`：该场景内新增 `divCol` 计算与上述两条 `ok(...)`（约 20 行，紧跟在既有 `activity-mixed-ordered` 之后）；**同一次改动里改写 `:532-535` 的陈旧注释**（原写着「『总结是否落在历史 pane』需按列判，见 BACKLOG 新条目」），新文案统一用「会话 pane / 回合 pane」；`displayWidth` 加进既有的 `../src/app/layout.ts` import。
1. `TUI/docs/BACKLOG.md`：条目标〔进行中〕→ 关闭时移除（余下条目按编号口径重编）。
1. 本追踪文档：建 → 关闭时移入 `TUI/docs/archived/`。

## 实现记录

- `TUI/demo/main.ts`：
  - import 增 `displayWidth`（既有 `../src/app/layout.ts` 那一行）；
  - 该场景在既有 `activity-mixed-ordered` 之后新增两条断言：`activity-mixed-summary-in-dialogue` / `activity-mixed-activity-side`；
  - 内部分隔列按 D2 取：`mixedLines.findIndex(l => l.includes("Session") && l.includes("Turn"))` → 该行 `┬` 前的文本经 `displayWidth` 换算得 `divCol`；`┬` 缺失（上下排列）时 `divCol = -1` → 退化为行序比较；
  - 同一次改动改写 `:532-535` 的陈旧注释（原文写「『总结是否落在历史 pane』需按列判，见 BACKLOG 新条目」），新文案统一用「会话 pane / 回合 pane」。
- 决策阶段子代理审阅（`35c1c72b`）：**无异议**，3 条非阻塞建议全部采纳——① 反向验证口径写清（删 `turn-end` + 断言 1 单条，见决策 D1）；② 陈旧注释同批改写；③ `┬` 只在同时含 `Session` 与 `Turn` 的标题行上找。

## 测试与证据

- `TUI`：`npm run check` ✓、`npm run build` ✓、`npm run test` → **1335 pass / 0 fail**（与改动前同基线，本轮只改 demo、未加单测）。
- 正向着证：`npm run demo -- --smoke` → `SMOKE_PASS activity-mixed-ordered`、`SMOKE_PASS activity-mixed-summary-in-dialogue`、`SMOKE_PASS activity-mixed-activity-side`，exit 0。
- **反向验证**（按 D1 口径，临时改法）：删掉该场景的 `adapter.emitEvent({ type: "turn-end" })` 后重新构建运行 → `SMOKE_PASS activity-mixed-ordered`（旧断言仍绿，**证明缺口真实存在**）、`SMOKE_FAIL activity-mixed-summary-in-dialogue (divCol=49 sumRow=14 midRow=6)`、`SMOKE_PASS activity-mixed-activity-side`、`SMOKE_FAIL n=1`；还原源文件并重建后 `SMOKE_OK` / exit 0。临时备份 `tmp/main.ts.bak` 已删。
- 审阅侧独立实测（同一帧、两次运行一致）：`divCol=49`，`混合最终总结` 在显示列 21（会话 pane）、`混合中间输出` 在列 51（回合 pane）；两块由 `state.ts` 的 `kind==="tool"` 边界切开、`markFinalSummary` 只标 assistant 行 → 末块只含总结，故两条断言不假绿/假红。

## 收尾

- 已关闭：`TUI/docs/BACKLOG.md` 移除该条目（余下 6 条按编号口径重编，来源注记重写）；本文件移入 `TUI/docs/archived/`。
- 未改：`tests/helpers/screenEmu.ts`、渲染层与布局、该场景其它断言；未新增其它场景的 pane 归属断言。
- 后续口径：新写的 pane 表述统一用**会话 pane / 回合 pane**（旧的「历史区 / 活动区」仅存于既有文档，待术语统一条目处理）。
