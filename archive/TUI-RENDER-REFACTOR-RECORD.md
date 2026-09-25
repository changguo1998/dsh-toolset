# TUI 渲染管线重构实现记录（已归档）

> **归档说明**：本文档记录 2026-09 渲染管线重构（主线 A 契约迁移 + 主线 B Box 排版模型）的实施过程与踩坑，供追溯历史决策。当前实现口径见 `TUI/docs/IMPLEMENTATION.md`，设计见 `TUI/docs/DESIGN.md`，规格见 `TUI/docs/SPEC.md`。
> 原实施清单见同目录 `TUI-REFACTOR-TASKS.md`，命令扩展实施清单见 `TUI-COMMANDS-TASKS.md`。

## 主线 A：RenderLine → FrameRow 契约迁移（已完成）

3 个独立可回归提交（行为不变：570 单测（当时值）+ 36 smoke 帧断言为回归标准）：

- **契约类型**（98e9efd）：`theme.ts` ColorName 增 `"code"` 槽位（dark #434343 / light #E8E8E8，历史值；现由主题 `semantics` 解析）；
  `screen.ts` 并存新增 `FrameStyle`/`FrameSegment`/`FrameRow` + `segStyle`/`serializeFrameRow` 纯函数
  （相邻同 style 合并、异 style 先 close 前段再 open 新段、open 顺序 bold→italic→underline→strike→fg→bg、
  行尾 SGR 复位回主题基底、未知名色名回退基底、`#hex` 直用、close 逆序）。
- **markdown 收敛**（d0d28d6）：`InlineSegment` → 公共 `FrameSegment`，`style.bg:"code"`（hex 常量迁 theme）；
  决策：不整体重排 markdown.ts，仅定向契约收敛（零宽表 / 块识别顺序不动）。
- **原子翻转**（b35826d）：`screen.ts` render/renderDelta 收 `FrameRow[]`（内部 `serializeFrameRow`）；
  `renderer/index.ts` delta 按序列化文本 + caret 比较、主题切换清空 previous frame（全帧重绘）；
  `layout.ts` 排版层全面段化（`wrapSegs` 返回 `FrameRow[]`、modeBlock/statusBlocks/renderStatusLine/buildFrame
  全改段数组、`colorFor` 烘焙 → style 字段）；components 8 文件同步；`markdown.ts` wrap\* 系列去序列化返回
  `FrameSegment[][]`；删 `RenderLine`/`renderSeg`/`CODE_BG`。

迁移踩坑（已修复）：

- **选项级着色语义**：状态列 `add()` 各选项按自身语义色高亮（policy ask 绿 / auto 红），段化时误改为整行单色且逻辑取反；且选项间分隔空格应独立无色段，否则 SGR 后带前导空格破坏 `[..mauto` 断言。以 smoke policy-badge-ask/auto 帧断言回归兜住。
- **delta 主题**：FakeRenderer / renderer 需随 `setTheme` 切换序列化主题，否则 `/theme light` 后颜色断言用 dark 色板。
- **测试迁移**：按测试意图迁移而非统一 ANSI 序列化掩盖——布局断言用 `rowText(row)` / segments / style；颜色语义断言检查 `segments[].style`；仅 renderer / screen 回归用 `serializeFrameRow` 的 ANSI；FakeRenderer 的 `lastRender` 用 `rowAnsi(row, themeId)`（保留 ANSI 供 SGR 断言，纯文本断言再 strip）；新增「所有 FrameSegment.text 不含 `[`（ESC 序列）」不变量断言。

## 主线 B：Box 排版模型（已完成）

三波推进，行为不变基线：686 单测（当时值）+ 36 smoke 帧断言 + 冻结 fixture。

- **接口冻结**（cc743d7）：`box.ts` 定义 `Box`/`Paragraph`/`NodeBase`/`Width` 类型与 `measure`/`allocate` 签名；同步修订 `SPEC.md` §6 契约歧义（SizeTable.root / separator 仅纵向 Box / Paragraph 总宽含 indent + prefix）。
- **measure / allocate**（eea8196）：`measure.ts` 纯函数；两轮修复——spacer 轴显式互斥、多 ratio 归一、min > max、fill max 截断回流、v 过度约束压缩顺序。
- **内容映射**（b84d4b5）：`build-box.ts` + `fill.ts` + `content-rules.ts` 取代 `wrapBufferLines`；双轨对照冻结 fixture + cutover。
- **依赖基元迁移**（fd96d27）：抽 `layout/primitives.ts`（seg / rowWidth2 / truncateSegs / truncateToWidth / wrapLine / wrapLines），measure / layout.ts 共用，避免双向依赖。
- **接线汇合**（19ca9bb 及后续）：`focus-frame.ts` 焦点框全局覆写（setCell 不切 CJK / code-point、styleEqual 全字段、focusedPanel 空不覆写）+ `panel.ts` 场景原语 + 7 面板改 `buildXxxBox`；buildFrame 末尾单次 `focusFrame`；冻结 fixture 对照 16 场景逐行等价。
- **复核修正**（d74e8ec）：7 面板 render 薄包装（`buildXxxBox` → `fillBoxTree` 单一数据源）；panel 原语 styled 基础（wrap:false 默认、bold 可选）；layout 清理 17 个未用 import。
