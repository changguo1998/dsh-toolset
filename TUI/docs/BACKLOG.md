# TUI 待办与开放项

> 职责：TUI 包的**未完成**待办（TUI 的变更优先写在本目录）；跨包待办见 `docs/BACKLOG.md`，TUI 现状见 `TUI/docs/STATUS.md`
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用（追踪文档按条目标题引用，见 `docs/WORKFLOW-STANDARD.md` §6/§7）；**每次整理时按当前顺序从 1 起重新编号**（故 `TUI/src`、`TUI/tests` 注释中的 `TUI#n` 仅作历史线索）；本文件的 `#n` 与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 本文件只列未完成项；已完成项见 git 历史与 `TUI/docs/archived/`，不在此重复。
> 组织：按主题分组（组内按编号）；条目统一结构——现象 / 现状 → 期望 →（可选）复现 / 疑似范围 / 接取时裁定 → 落点 → 验收 → 来源·状态·优先级。

## 待办

> 临时分组（2026-10-04：新增 2 条；条目结构见文件头）。

1. **`/new` 启动自检门控取到上一会话的模型（求值窗口）**：现象 —— `/new` 后 `kickoffForNewSession()` 在 `restoreSessionState()`（异步回填，含 `sessionModel.current` 重置）落定前求值，读到的仍是上一会话的模型，跨模型切换时该发不发 / 不该发而发。期望 —— 按「新会话」判定：以默认选择 / 种子兜底，或把判据挪到状态回填落定后（注意须保持 kickoff 先于 rule-engine 会话注入的时序——回填是 I/O，不能在 `.then` 里简单同步补发）。落点 —— `TUI/src/main.ts`（`kickoffForNewSession`）+ `TUI/src/app/index.ts`（`/new` 分支），视需要 `TUI/src/app/adapter/dsh.ts`。验收 —— 非 deepseek 会话 `/new` 不误发；deepseek 会话 `/new` 且默认模型非 deepseek 也不误发；反向组合必发。来源：`docs/implementation/2026-10-04-bootstrap-kickoff-order.md` 子代理审阅发现（2026-10-04）· 状态：待接取 · 优先级：P2。
1. **宽度表生成器与检入表不同步（`⟳` 等符号恒按 1 列）**：现象 —— `TUI/scripts/gen-width-table.mts` 重新生成时，与检入的 `TUI/src/app/layout/eaw-table.ts` 不一致：仅补一段 ranges（`SYMBOL_UNCERTAIN_RANGES` 加 `[0x27c0,0x27ff]`）重生成即产生 229 行 diff（108 增 / 122 删，区间归并差异）。期望 —— 先查清漂移来源（谁生成、为何不一致、是否有手工编辑或生成器版本差异），把生成器与检入表对齐后再谈补字符：`⟳`（U+27F3）不在 `SYMBOL_UNCERTAIN_RANGES` 内，故永远按 1 列且无自校正（注意 `[0x27c0,0x27ef]` **不含** U+27F3，须用 `[0x27c0,0x27ff]`）。落点 —— `TUI/scripts/gen-width-table.mts` + `TUI/src/app/layout/eaw-table.ts`（必要时 `TUI/tests/width-table.test.ts` / `width-eaw.test.ts`）。验收 —— 生成器与检入表零 diff（或在脚本内固化为可重放产物）；补进 ranges 后 `⟳` 走自校正路径且有对应用例。来源：`docs/archived/2026-10-04-tui-goal-activation-symbol.md` 探针记录（2026-10-04，原条目「goal 状态行补 activation」拆出）· 状态：待接取 · 优先级：P3。
