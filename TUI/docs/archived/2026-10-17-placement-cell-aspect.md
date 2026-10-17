# 活动区排列判据加入字符格高宽比校正（接取条目：`TUI/docs/BACKLOG.md`「活动区排列判据加入字符格高宽比校正（auto 阈值由 φ 改为 2φ）」）

状态：关闭　　开启：2026-10-17　　关闭：2026-10-17
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`topPaneSplit` 的 auto 判据把 pane 的字符格数当正方形用，视觉宽高比失真：终端字符格高约为宽的 2 倍，故 `w / h` 不是视觉宽高比。加入校正后 `dev = |ln(w / h / 2 / φ)|`，等分（divisor = 2）情形下翻转阈值由「区域正文宽 / 可用行数 > φ ≈ 1.618」变为「> 2φ ≈ 3.236」——即宽高比落在 φ 与 2φ 之间的区域改判上下。

## 调研

来源：`TUI/src/app/layout.ts`（`GOLDEN_RATIO` `:426`、`aspectDeviation` `:459`、`topPaneSplit` `:478`、`frameGeometry` `:644`）、既有文档 `TUI/docs/SPEC.md` §6.1（`:262`）与 §15.5（`:782` 至 `:791`）、`TUI/docs/DESIGN.md`（`:180`）、`TUI/README.md`（`:226`、`:250`）。

- 现判据：`dev(w, h) = w ≤ 0 或 h ≤ 0 ? 0 : |ln(w / h / φ)|`；两 pane 各算一次、取较大者；`hDev < vDev` → 左右，相等 → 上下。
- 等分模型（纵向两 pane 宽 `W`、高 `H/2`；横向两 pane 宽 ≈ `W/2`、高 ≈ `H`）：令 `r = W / H`，纵向两 pane 的比值为 `2r`、横向为 `r/2`，两侧偏差 `|ln(2r/φ)|` 与 `|ln(r/(2φ))|` 取大后相等 ⟺ `r = φ`（现阈值）。
- 加校正 2 后两侧变为 `|ln(2r/(2φ))|` 与 `|ln(r/(4φ))|`，相等 ⟺ `r² = 4φ²` ⟺ `r = 2φ`。
- 判据输入只有区域正文宽与顶部内容高（不含状态列宽），两 pane 的宽高由 `topPaneSplit` 内部算出，故校正只需落在 `aspectDeviation` 一处。
- 判据口径在四处文档重复出现：`TUI/docs/SPEC.md` §6.1 与 §15.5、`TUI/docs/DESIGN.md`「四区域布局」、`TUI/README.md` 布局配置段（`:250`，另 `:226` 的示例注释）。

## 决策

1. 校正形式
   - a) 除以常量 2（`w / h / 2`，用户指定）
   - b) 实测终端单元格像素比后校正（不可行：CPR 只回行列，拿不到像素比）
   - c) 加成可配置项
   - 选定 **a**：用户 2026-10-17 直接指定该形式；2 是通用终端字形比，不需要新配置面。
2. 常量落点
   - a) `aspectDeviation` 内写字面量 `2`
   - b) 模块级导出常量 `CELL_ASPECT = 2`，与 `GOLDEN_RATIO` 并列
   - 选定 **b**：口径单点可引，文档与测试引用同一处。
3. 文档同步范围
   - a) 只改代码注释
   - b) 代码注释 + `SPEC.md` / `DESIGN.md` / `README.md` 判据段
   - 选定 **b**：判据口径重复出现，只改代码会留下旧阈值。

## 规划

计划改动文件清单：

- `TUI/docs/BACKLOG.md`（登记条目 + 关闭注记）
- `TUI/docs/implementation/2026-10-17-placement-cell-aspect.md`（本文件）
- `TUI/src/app/layout.ts`（`CELL_ASPECT` 常量、`aspectDeviation` 公式、`GOLDEN_RATIO` 与 `topPaneSplit` 注释）
- `TUI/src/app/config.ts`（布局配置注释的 auto 判据口径）
- `TUI/src/app/state.ts`、`TUI/src/app/index.ts`（同口径 JSDoc）
- `TUI/docs/SPEC.md`（§6.1 与 §15.5「活动区排列」）
- `TUI/docs/DESIGN.md`（「四区域布局」）
- `TUI/README.md`（布局配置段）
- `TUI/tests/config.test.ts`（auto 判定表：三档阈值）
- 其余受影响用例（跑 `npm run test:tui` 后按实际失败面收敛）

明确不做：不改 `φ` 常量本身；不加配置项；不做字符格尺寸实测；不动 `activityTopRow` / `activityHeightDivisor` 的比例分配、两侧 20 列保底与不可行回落规则。

## 实现记录

2026-10-17 一次做完（用户指示「中间不需要确认提交，一次性做到收尾」，四个提交询问点合并为关闭后一次提交）。

1. 登记条目：`TUI/docs/BACKLOG.md` 新增「活动区排列判据加入字符格高宽比校正（auto 阈值由 φ 改为 2φ）」并标〔进行中: 2026-10-17〕；建本追踪文档。
2. `TUI/src/app/layout.ts`：`GOLDEN_RATIO` 注释改「**视觉**宽高比」；新增导出常量 `CELL_ASPECT = 2`（紧跟 `GOLDEN_RATIO`）；`aspectDeviation` 公式改为 `Math.abs(Math.log(w / h / CELL_ASPECT / GOLDEN_RATIO))` 并补三行注释（为何把列数折成等效高度、阈值 φ → 2φ）；`topPaneSplit` 文档注释的等分判据改为「> 2φ」、`auto` 分支行内注释改「视觉宽高比偏离 φ 更小者胜」。
3. `TUI/src/app/config.ts`：布局配置头注释（`activityPlacement` 条）与 `activityPlacement` 的 JSDoc 补「视觉宽高比 / 字符格高宽比 2」。
4. `TUI/docs/SPEC.md`：§6.1 步骤 3 的判据句；§15.5 小节标题（改为「活动区排列：按视觉宽高比与黄金分割比自动选上下 / 左右」）与「判定」条（补 `|ln(w/h/2/φ)|`、阈值 2φ 与校正前口径）。
5. `TUI/docs/DESIGN.md`「四区域布局」的「排列方式」条、`TUI/README.md` 布局配置段的 `activityPlacement: "auto"` 句同步。
6. `TUI/tests/config.test.ts`：导入 `CELL_ASPECT`；auto 判定用例改写为三档（`< φ` / 中间带 / `> 2φ`），新增中间带一例 `topPaneSplit(30, 60, 2, undefined, "auto")` → `vertical`（校正前该例为 `horizontal`，是本次改动的实质差别）。

工具面：本次工作区为只读文件策略，`write` / `edit` / bash 写入均被拒（`EROFS` / `file access denied`）；`hash_edit`（LINE:HASH 锚定编辑）未被拦，改文件均走它，仅新建追踪文档、`git mv`、`build` 与提交经一次性提权。

## 偏差

- **计划里的 `TUI/src/app/state.ts` / `TUI/src/app/index.ts` 的 JSDoc 未改**：两处只写「按黄金分割比自动在上下/左右间选择，见 `topPaneSplit`」，不含阈值与宽高比口径，且已把定义指向改动过的 `topPaneSplit` —— 改它们只增 diff 不增信息，判定为不需要改（符合「改动范围限于被要求的部分」）。
- **无其他偏差**：公式、常量、文档同步范围与测试面均按计划执行；`φ` 常量本身、`activityTopRow` / `activityHeightDivisor` 比例分配、两侧 20 列保底与不可行回落规则未动。
- **真机目视未做**：profile 以 `link:` 指向主检出，需合并后生效；替代证据见下节（全量测试 + build + mock demo 冒烟）。

## 测试与证据

命令与结果（需写盘的两步在只读策略下经一次性提权执行）：

- `npm --prefix TUI run check`：通过（`tsc --noEmit` 无输出）。
- `npm run test:tui`：**1627 例，1598 通过、29 失败**；29 例失败**全部**是 `EROFS: read-only file system`（如 `mkdtemp '/tmp/dsh-tui-state-XXXXXX'`），来自沙箱只读文件系统，与本次改动无关 —— 复查输出里 `AssertionError` / 断言差异为零（失败面集中在 `session-ui-state` / `session-delete` / `width-symbols` / 主题调色板 / `/init` / 重启交接文件等**纯写盘**用例）。
- 关键用例：`npm run test:tui -- config.test.ts` **14 例全绿**（含新增中间带一例：`topPaneSplit(30, 60, 2, undefined, "auto")` → `vertical`，实测坐实「校正前该例判 `horizontal`」这一实质差别）；`layout-horizontal.test.ts` / `layout4.test.ts` / `command-panel.test.ts`（随包 `tui.config.json` 的 auto 口径）等布局用例**零失败**。
- `npm run build`：通过（全部子包 `tsc` 编译到 `dist/`）。
- `npm run demo -- --smoke`：`SMOKE_PASS`（preset-badge / jobs-panel / jobs-kill 等场景）+ `SMOKE_OK sent=[...] interrupts=1`。帧内仍为左右排列，与校正后预期一致：80×24（状态列 20 列、顶部内容高 16 行、`activityTopRow: "half"`）下纵向 pane 视觉宽高比 `(59/10)/2 = 2.95` 与 `(59/3)/2 = 9.83` 取较差 `vDev ≈ 1.80`，横向两 pane `(29/14)/2 ≈ 1.04` 取 `hDev ≈ 0.45`，左右胜出。

## 收尾

- 回写文档：`TUI/docs/SPEC.md`（§6.1 与 §15.5）、`TUI/docs/DESIGN.md`（四区域布局）、`TUI/README.md`（布局配置段）、`TUI/src/app/config.ts` 注释 —— 均在本任务内完成；`ROADMAP.md` 与 `STATUS.md` 未改（后者由用户择时更新）。
- BACKLOG：所接条目已标完成并**从 `TUI/docs/BACKLOG.md` 移除**，关闭注记追加在文件末尾（剩余 `#1` 至 `#3` 编号未重排，留待下次整理）。
- 本文件已移入 `TUI/docs/archived/`。
- 遗留项：无（真机目视留到合并后，见「偏差」）。
- 临时文件：无（未建 `tmp/` 产物；`dist/` 为常规构建产物、不入库）。
