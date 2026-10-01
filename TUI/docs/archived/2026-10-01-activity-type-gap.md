# 活动区类型间隔：思考 / 正文 / 工具三类互切插 1 行空行（接取条目：`TUI/docs/BACKLOG.md`「活动区内「思考 / 正文 / 工具」三类互切时插一个空行」）

状态：已完成　　开启：2026-10-01　　关闭：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

活动区（回合过程区）内「**思考 / 正文 / 工具**」三类**相邻互切**时插 **1 行空行**（例：reasoning → assistant）；仅活动区、历史区不变。

用户裁定（2026-10-01，两问两答）：① 作用范围**只活动区**；② 只在这三类之间插（notice / step 头 / shell / 已有空行**不算类型边界**，不改现有紧排），同类连续只在边界插一次。

## 计划改动文件清单

代码：

- `TUI/src/app/layout/build-box.ts`：活动区叶子组装期新增 `noteActKind()`（三类各一处调用：thinking 分支、tool 分支、非 final assistant 分支）；step 分割行的「吸收拖尾空行」跳过刚插入的类型间隔空行。

测试：

- `TUI/tests/activity-type-gap.test.ts`（新增）：互切矩阵（思考↔正文、正文↔工具）、同类连续只插一次、notice 不新增、实时 step 头不吞间隔空行、活动区开头不插。
- 既有用例按新口径更新（有意变更）：`TUI/tests/activity-verbose.test.ts`（紧凑模式行数 = 条目数 + 间隔数）、`TUI/tests/content-mapping.test.ts`（双轨→「已偏离」：只多空行）、`TUI/tests/layout4.test.ts`（思考与下一个 step 分割行之间为空行）、`TUI/tests/fixtures/focus-frame-legacy.json`（用 `scripts/freeze-focus-frame.mts` 原地重生成）。

文档：

- `TUI/docs/SPEC.md` §15.5 新增「活动区类型间隔」小节；`TUI/docs/DESIGN.md`「活动区」一句补类型间隔；`TUI/docs/BACKLOG.md` 条目状态维护与收尾清理。
- 本文件。

## 设计

- **判据在构建期**：`noteActKind(kind, rowMeta)` 记录上一次**有类型**的活动条目（`thinking` / `assistant` / `tool`），类别变化时先 push 一个空 `text("")` 叶子再 push 本条 —— notice / step / shell 等无类型条目既不更新状态也不触发间隔（「不算边界」）。
- **间隔空行的 meta**：取**新类型那一行**的 `rowMeta`（`kind` 改写为 `"plain"`）——行号身份指向新内容行，且不参与回复组 / 工具组分组。
- **与 step 分割行的交互**：实时 step 头是 tool-kind 行（文本 `hh:mm:ss #N`），归「工具」类；`flushToolRun` 原有的 `absorbActivityBlank()`（吸收分割行前拖尾空行）会吞掉刚插入的间隔空行 → 加身份判据 `activityLeaves[last] !== gapBlank` 跳过吸收，使空行稳定落在分割行**之前**。
- **行数口径**：活动 pane 的可视行数与滚动上限按实际渲染行数计算（`activityMaxScroll = 活动内容行数 − activityH`，layout 侧），间隔空行自动计入，无需额外同步。

## 验证

- `npm run check`（TUI 单包）：通过。
- `npm run test:tui`：**1283 通过 / 0 失败**（新增 6 例；4 处既有用例按新口径更新：紧凑模式行数、双轨「已偏离」、step 分割行空行、焦点帧基线重生成）。
- `npm run build`（TUI）：通过（dist 已更新）。
- **真机验证项（待人工确认）**：① 一个回合内 reasoning → 正文切换处出现 1 行空行；② 正文 ↔ 工具、思考 ↔ 工具互切同样有空行；③ 同类连续（多行思考 / 多段正文 / 工具 run 内部）只在边界插一次；④ notice / step 头附近不额外插空行；⑤ 活动区高度吃紧（内容超出可视行）时无残留、滚动上限正确。

## 过程记录

- 实现期发现 `absorbActivityBlank` 会吞掉「思考 → step 头」的间隔空行（step 头前空行被当作拖尾锚点吸收）→ 用 `gapBlank` 身份判据保留；`tests/layout4.test.ts` 原「分割行前不显示空行」用例随之改为「分割行前为类型间隔空行」（有意变更）。
- `tests/content-mapping.test.ts` 的双轨对照（冻结旧实现）无法整行等价 → 按该文件既有先例改成「双轨（已偏离）」：剔除空行后逐行等价 + 显式断言只多 1 行空行。
- `tests/fixtures/focus-frame-legacy.json` 为该仓库既有的**可重生成快照**（`scripts/freeze-focus-frame.mts` 调当前 `buildFrame` 写出，勿 `format`），故直接原地重生成（15 场景，32 行位移）。
- 紧凑模式（`/verbose off`）也按同一规则插空行：条目行数 = 条目数 + 间隔数（SPEC §15.5 详略两态小节口径已随之注明）。
