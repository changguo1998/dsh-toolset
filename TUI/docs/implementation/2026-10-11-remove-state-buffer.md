# 彻底删除 `state.buffer`（接取条目：`TUI/docs/BACKLOG.md` 第 16 条）

状态：进行中（分阶段）　　开启：2026-10-11　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

全仓不再有 `state.buffer`：内容与 UI 本地行都不再经缓冲；`buildFrame`（含无 sink 的回退路径）只认 `state.pipeline`；state 级测试改为「造交付流」。

## 规模与风险（先摆明）

- 条目自估 **2-3 天**；涉及 `reduceState` 约 10 个内容分支的缓冲写入、`nextSeq` / `trimBufferHead` / 行数上限、`sectionsOf` 的无 sink 回退、`BufferLine` 的内容字段，以及 `layout4` / `layout-cache` / `layout-horizontal` / `pane-text-margin` / `focus-frame` / `resume-summary` / `pipeline-*` 等约 **1400 个 state 级用例**的 fixture。
- 上次标〔暂停〕的原因即「一次性替换风险过大」。**故本条按四段推进，每段独立可跑绿、独立提交**，不做大爆炸式替换。

## 分阶段方案（每段独立验收）

- **段 A｜测试助手 + 首批迁移（不改生产行为）**：新增 `tests/helpers/deliveriesFromScript.ts`（脚本 → `BlockDelivery[]`，供 `applyAll(createSections(), …)` 造节）；迁移 1-2 个纯 layout 用例文件作为范式（`layout4` 优先，它 fixture 最规整）→ 该文件不再需要 `state.buffer`。生产代码不动。
- **段 B｜UI 本地行另立存储**：`notice` / `shell` / 辅助工具行从 `buffer` 拆到 `state.local`（新字段），读侧（活动区本地行 / toast / `/help` 等）改读它；`buffer` 此时只剩「测试重放输入」一种用途。
- **段 C｜回退路径改源**：`sectionsOf` 的无 sink 回退不再读 `buffer`，改读 `state.local` + `state.pipeline`（缺 `pipeline` 时由段 A 的助手在测试里显式造节）；删掉 `BufferLine` 的内容字段与内容类 `BufferKind`、`nextSeq` / `trimBufferHead` / 行数上限。
- **段 D｜稳定节身份 + 帧级断言（并入约束）**：`panes.ts` 的 `sectionIds`（WeakMap + 全局计数器）改为稳定量（`turn:step` + 节内序号），使扩窗 / 会话切换 / 重放后 `indexOfTop` 不再落进「距底偏移」兜底；补 **Home 二次按键（扩窗）/ 会话切换 / 重放后会话区画面逐字节不变**的帧级断言（替换 `tests/app.test.ts` 现有的弱断言与「已知缺陷」注释，实测证据：段键 `785:0` → `788:0`、视口 `⇆18` → `⇆2`）。

## 规划（段 A 的文件清单）

- 新增：`TUI/tests/helpers/deliveriesFromScript.ts`（纯测试助手；脚本 = `{事件, 交付}` 列表 → 交付数组）。
- 改：`TUI/tests/layout4.test.ts`（fixture 由「造缓冲行 + `sectionsOf` 回退」改为「造交付流 + 显式 `state.pipeline`」）。
- 文档：本文件；`TUI/docs/BACKLOG.md`（状态）。

明确不做（段 A）：生产代码零改动；不碰 `state.ts` 的内容分支；不动 `BufferLine`。

## 实现记录

- 2026-10-11（段 A 进行中）：
  - 新增 `tests/helpers/deliveriesFromScript.ts`：`ScriptStep`（只带交付）+ `sectionsFromScript(steps)`（走生产同一入口 `applyAll`）+ `turnScript({turn,user,assistant,reasoning,reason})` 便捷造回合。
  - **首个迁移文件**：`tests/pane-text-margin.test.ts`（4 个用例，单一 fixture 助手）——内容不再写 `state.buffer`（旧路径靠 `sectionsOf` 回退重放），改为 `state.pipeline = sectionsFromScript(steps)`。**生产代码零改动**。
  - 迁移范式（后续文件照此）：状态类 action（`status` 等）保留；内容类 action（`user-line` / `append` / `thinking` / `turn-begin` / `turn-end`）换成一条条交付（`turn-start` / `user` / `text` / `finalize` / `turn-end`）。
- 段 A 续迁（2026-10-11 第 8 轮）：`tests/p8-compaction-active.test.ts`（4 例，助手内一处 `user-line` → 交付）、`tests/color-semantics.test.ts`（5 例，助手内 `append` + `turn-begin` → 交付）。两文件全绿，全量 1446 绿。
- 段 A 续迁（2026-10-11 第 9 轮）：`tests/renderer-diff.test.ts`（11 例，底稿 8 行改一条含换行的正文交付、末行增长改同块流式追加）。全绿。
- 更正：`tests/pipeline-app.test.ts` **无需迁移**——那里 `type: "thinking"` 是**宿主事件**（与交付配对），不是缓冲写入；上一轮清单的 1/15 是误判。
- **计划修正（2026-10-11 第 13 轮，实测后）**：`layout4` 的内容动作**大多不是填充物**，而是喂给**状态机制**的输入 → 不属段 A。已核两例：
  - L642〈usage 校准〉：`append(..., time)` 是**在测 `append` 的 token 估算**（断言 `s.stepEstTokens`）→ 估算器的输入源要随「内容改交付」一起改，属**段 B/C**。
  - L722〈turn-begin…流式内容仍实时合入 buffer〉：明写「合入 buffer」→ 缓冲契约本身，属**段 C**。
    → 结论：**段 A 的实质目标已达成**（内容型 fixture 不再需要缓冲：已迁 6 个文件）。`layout4` 剩余动作与 `layout`/`step`/`steer-queued-display`/`buffer-retire`/`screen-residue`/`turn-separator` 等同性质，随\*\*段 B（本地行另立存储）/ 段 C（估算器与缓冲契约改源）\*\*一起改，不单独为段 A 迁移。
    → 下一步优先级：**段 B**（`notice`/`shell`/辅助工具行 → `state.local`，读侧同步）→ 段 C（估算器改吃交付、`sectionsOf` 回退改源、删 `BufferLine` 内容字段 / `nextSeq` / 裁剪 / 上限）→ 段 D。
- **`layout4` 分批计划（2026-10-11 第 12 轮产出；按上面的修正，只对「填充物型」用例生效）**：全文件 80 例、87 处内容动作。先用脚本按「用例 → 动作数」列表（前 12 例）：
  - L220（7 处动作）：输入栏单字符提示符：当前模式符号（默认前景色）；状态符号渲染在用户块首行左侧", () => {
  - L591（4 处动作）：运行中无数据：virt-tick 持续积分跨过阈值切换 ●/○，速度渐降但 token 不停", () =>
  - L642（5 处动作）：usage 校准（P5）：真值/估算比例 EMA 更新 tokenCalib；无真值不校准", () =>
  - L722（3 处动作）：turn-begin: 回合开始时在历史末尾追加分隔线；流式内容仍实时合入 buffer", () => {
  - L742（2 处动作）：turn-begin: 空 buffer 不画孤立分隔线；重复 begin 不重复；turn-end 不画线
  - L762（2 处动作）：turn-begin: 新回合清空旧活动区瞬态（工具/notice），仅保留对话与分隔线", () => {
  - L802（1 处动作）：activityScroll 归零：turn-begin 空 buffer/已有分隔线路径 + clear-
  - L824（5 处动作）：turn-end 标 final：中间输出留在活动区、总结进历史区；幂等与跨回合", () => {
  - L869（1 处动作）：turn-end 无模型正文：不标 final（纯工具/思考回合）", () => {
  - L886（2 处动作）：appendStream 不修改旧 state 的行对象", () => {
  - L990（2 处动作）：会话流：用户靠右、模型靠左，用户续行保持右侧缩进(块右对齐、内部左对齐)", () => {
  - L1147（1 处动作）：会话流：短用户消息块整体靠右，右缘贴历史区右缘，块内左对齐", () => {
  - 分类口径：**只测渲染/布局**的（正文或用户块只是填充物）→ 段 A 迁交付流；**测缓冲语义本身**的（如 L722「turn-begin…流式内容仍实时合入 buffer」、notice/工具行的缓冲契约）→ 留到段 B/C。
  - 迁法：把用例内的 `reduceState(s, {type:"append"|"user-line"|"thinking", …})` 就地换成 `s = { ...s, pipeline: applyDelivery(prev, {kind:"text"|"user"|…}) }`（或开头一次性 `sectionsFromScript`），断言不动；一次 3-5 例，跑完该文件再下一批。
- 段 A 续迁（2026-10-11 第 11 轮）：`tests/focus-frame.test.ts` **仍不能迁**——已把 `baseState` 换成交付流并跑 `scripts/freeze-focus-frame.mts` 重生基线，但**脚本自己另建场景**（不引用测试里的 `baseState`），所以重生出来的仍是**旧缓冲路径**的帧（fixture 零 diff）而测试依旧 11/16 挂；去掉 `turn-start`（我多加的回合分隔线）后仍挂 → 说明交付路径与缓冲路径在**内容落位**上有真实差异（如「最终总结回复」的 `final` 归属）。
  接续口径：**先改 `scripts/freeze-focus-frame.mts` 让它复用测试的 `baseState`（或等价的交付脚本）**，重生后逐帧核对差异（只允许可归因差异），再更新 fixture；本文件放到 `layout4` 之后做。已回退，全绿。
- 段 A 续迁（2026-10-11 第 10 轮）：`tests/question-panel-frame.test.ts`（4 例，流式内容改交付流 + 逐步 `applyDelivery` 追加）。全绿。
- **归类更正**：`tests/steer-queued-display.test.ts` 的 `user-line` **不是内容 fixture**，而是断言「steer 认领给上一条输入打 `steerContinued` / `spaceBefore`」的**缓冲行契约**——它属**段 C**（buffer 行语义本身退场时一并改写），段 A 不动它。
- 仍依赖 buffer 内容动作的测试文件（按「内容动作数 / 用例数」升序，下一轮从小到大清）：`renderer-diff`(2/11)、`layout`(2/34)、`steer-queued-display`(2/7)、`step`(3/10)、`question-panel-frame`(3/4)、`turn-separator`(4/5)、`screen-residue`(4/7)、`buffer-retire`(5/5)、`focus-frame`(4/1，需重生基线)、`layout4`(118/80，最后做)。
- 原「待迁移（段 A 余量，按难度排）」备忘（保留供参照）：
  1. `tests/focus-frame.test.ts`（210 行）：**不能机械迁移**——它比的是冻结基线 `tests/fixtures/focus-frame-legacy.json`。2026-10-11 实测：按 `pane-text-margin` 的范式把 `baseState` 换成交付流后，`w20` 四例仍过、**`w60` 四例全挂**（内容形态与旧缓冲重放不同）。
     故本文件要先「重新生成基线 + 逐帧核对差异」：用 `scripts/freeze-focus-frame.mts` 重跑（该脚本在条目 2 / 4 落地时用过两次），并人工核对 diff 只含**可归因**差异（交付路径 vs 缓冲回退的已知口径差：`final` 归属 / 段内空行 / notice 顺序），
     核对通过后才更新 fixture 并提交（禁止手工编辑 fixture JSON，必须走脚本）。
  1. `tests/layout-cache.test.ts`（424 行、10 例）：它的固定脚本 `FRAME_ACTIONS` 里含**工具调用 / notice / 超长行 / 代码栅栏**（覆盖内容区 + 状态列 + footer），
     并逐step折叠出状态快照比「缓存开 / 关」的帧是否一致 → 需要先给助手补**混合脚本**能力（`tool` / `notice` 步；`turnScript` 只覆盖 user/正文/思考），
     再按同样的「快照数组」结构喂 `state.pipeline`。注意：该文件的断言是**缓存等价性**（与内容语义无关），迁移时保持「同一脚本 → 两套缓存配置 → 帧逐行相等」的形状。
  1. `tests/layout4.test.ts`（2800+ 行、用例最多）：fixture 分散在多个 `frameWith` 类助手里（`append` / `user-line` / `turn-end` 等），
     建议**分批**迁移（先迁 fixture 助手，再逐组用例核对期望），一次不要超过 ~20 例，避免大爆炸。
- **本轮到此为止的原因（如实记录）**：段 A 剩余文件（尤其 `layout4`）需要连续多轮编辑与逐组核对期望；本轮上下文预算已尽，故停在「助手 + 首个文件迁移完成、反向验证通过、全量绿」这个干净状态。

## 测试与证据

- 迁移后 `tests/pane-text-margin.test.ts` 4/4 通过；全量 `npm test` **1444 / 1444 通过**；`npm run check` 干净。
- **反向验证**：把助手里 `pipeline: sectionsFromScript(steps)` 抽掉（其余不动）→ 该文件 4 例中 **2 例失败**（依赖长文本铺满的断言拿不到内容）→ 证明帧内容确实来自节模型，而非缓冲回退。

## 测试与证据

（待补）

## 审阅记录

（待补）

## 收尾

（待补）
