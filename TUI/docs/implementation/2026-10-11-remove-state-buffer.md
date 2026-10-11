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

## 段 B 实现前审阅（2026-10-11，子代理，只读 ≤5 次工具调用）

**审阅结论：原计划（新增 `state.local` 字段、分两轮落地）不成立，改用「一次性改名」。**

### 一、原预研清单不完整（审阅补正）

| 项 | 原文档 | 审阅补正 |
| --- | --- | --- |
| 写侧复制点 | 只列 6 处 | 漏 `:1253`（`appendTurnSeparator`）、`:1299`（`numberTurnSeparator` 的 `slice`）、`:1480-1485`（`dropContentWrites` 的 filter）、`:1863`/`:1892`（`history-restore` / `history-resume` 整体替换 `rows → buffer`）；且 `:1167`/`:1202`/`:1221` 是**引用型**写点（真正改行时才复制） |
| 分支口径 | 「约 10 个内容分支」 | 偏粗：notice 三个独立函数（`:873`/`:965`/`:1005`）、shell `:1031`、step 头 `:1067`、retry `:1865`/`:1894` 内联 |
| 语义承载点 | 未提 | `:1253-1261` 与 `:1481` 按 kind 清 **notice/tool** 本地行（旧口径「否则 toast 一直挂着上一回合的提示」）→ 搬移后这两处 filter 必须跟着改源 |
| 裁剪不对称 | 「`nextSeq`/裁剪/上限一起动」 | 上限（`MAX_BUFFER_LINES` 2000）**只能裁内容侧**，否则本地行先被挤掉（本地行应长留） |
| 读侧 | 只列 3 处 | 漏 `index.ts:524`（`deliverBufferTail` 本体）、`index.ts:1703`（`tailBefore`）、`layout.ts:2417`（footer notice 折叠**直接遍历 buffer**）、`layout/pipeline/frame.ts:239-248`（按缓冲身份 memo 重放）、`layout.ts:203-209`（`sectionGroupCount` 按 kind/final 判据）、`build-box.ts` 的 notice/shell 分支 |
| 不必改 | — | 会话状态落盘走快照、`/copy` / `/council` / 问答来源走节模型（只有测试/嵌入经 `sectionsOf` 回退碰缓冲） |

### 二、原「最小落地顺序」不成立

1. **① 单独落地 = 复现故障**：`deliverBufferTail` 读 `state.buffer`，本地行一旦不写进去，桥接的那批事件（notice / subagent / hook / feedback / retry / compaction）立刻投不出块 —— 即注释里记过的「回合区不显示警告」。
   → **① 与 ② 必须同一个提交**。
1. **「回退处合并读 `local` + 旧 `buffer` 残留」是伪需求**：① 之后 `buffer` 恒空。
1. **真正需要「合并」的是按 `seq` 归并**：`sectionsOf` 回退若分居两数组，`[...local, ...buffer]` 会打乱行序（`frame.ts:247` 重放与 `sections.ts` 都依赖行序）→ 必须按 `seq` 排序合并。
1. 中间态会读空的点：`layout.ts:2417` footer、`deliverBufferTail`、`frame.ts` 重放、`build-box` 的 notice/shell 渲染、`sectionGroupCount`（`layout.ts:203`）、`appendTurnSeparator:1268` 的 `buffer.length === 0` 早退。
1. 双投递风险：`index.ts:3281/3287` 一带先 `reduceState(notice)` 落缓冲、再 `deliverLocal` 投块 → 搬移时必须明确「本地行只走一条交付路径」，否则双行。
1. 测试影响面比原清单大：除 6 个缓冲契约用例，还有 `build-box` / footer notice 折叠 / `state` 的 notice/shell 断言 / `layout4` 剩余动作。

### 三、裁定：一次性改名（推荐方案）

- **做法**：`state.buffer` → `local`（保留 `BufferLine` 类型名、`nextSeq` 共享），写侧 + 读侧 + 测试在**同一个提交**改完，用 `tsc --noEmit` 当遗漏检测器。
- **理由**：工作量与「新增字段」相同，但**改名会让每个漏改点变成编译错误**；新增字段的漏改只会静默变成运行时问题（读空、投不出块）—— 正是本任务最易踩的坑。
- **代价**：diff 覆盖全部缓冲相关测试、不可分批；无「两字段并存」过渡期（而过渡期本身就是故障源）。
- **不采纳**：新增 `local` 字段（多一次迁移）、双写再切读（双投递 + `nextSeq` 双计，风险最高）、保留只读别名（编译器发现不了漏读点，段 C 还得再扫）。

## 段 C1 完成（2026-10-11 第 76-84 轮，提交 `ef9ae89` / `7da4777` / `2240cb3` / `20e1c22`）

**目标**：把「无 sink 回退」从生产代码剥离——`sectionsOf` 只认 `state.pipeline`，未注入即空节。

**做法（按审阅裁定的变体）**：

1. `replay.ts` 新增**显式助手** `sectionsFromLocal(local)`——把回退实现（含**单槽 memo**，逐行对象身份命中）从 `frame.ts` 原样搬出；注释写明**不要去掉 memo**（节身份与合成序号按对象发号，每帧新建节对象会让发号漂移）。
1. `frame.ts` 的 `sectionsOf` 改为 `return state.pipeline ?? createSections();`（未注入 = 空节）。
1. 依赖回退的测试文件**各自带包装**：新增共享助手 `tests/helpers/frameWithLocalReplay.ts`（导出包装版 `buildFrame`，未注入 `pipeline` 时用 `sectionsFromLocal(state.local)` 补一份）——多数文件只需**改一行导入**；`layout4` / `focus-frame` / `layout-horizontal` 用同款**文件内**包装（先做的三个）。
1. 5 个文件改走**交付流**（`sectionsFromScript`）：`notice-form` / `screen-residue` / `resume-summary` / `activity-verbose` / `layout-horizontal.turnState`。

**依赖面清单（逐文件定向跑出来的，比 grep 猜准）**：

| 类别 | 文件 |
| --- | --- |
| 走交付流（5） | `notice-form`、`screen-residue`、`resume-summary`、`activity-verbose`、`layout-horizontal.turnState` |
| 走包装（5） | `layout4`、`focus-frame`、`layout-horizontal`、`command-panel`、`resume-summary` |
| 不需要（8） | `app`（真实 App，`pipeline` 恒在）+ `ctrl-t-panes`、`focus-cursor`、`footer-notice`、`pane-titles`、`title-bar`、`status-column`（0 内容用法，定向跑绿） |
| 属段 C2 | `buildContentRows` 的缓冲字面量用例（随内容类 `BufferKind` 一并处理） |

**过程中的四次教训（都踩过）**：

1. **顺序**：先删回退再迁测试 → 全量立刻红（踩了两次）→ 正确顺序是「**先给所有依赖文件带包装并逐个验证，最后才删那一行**」。
1. **测量要在同一回合内、且有界**：跨回合的后台全量跑会被回合边界杀掉（文件都没生成）；改用**逐文件定向跑**（每个几秒）→ 才拿到真实清单。
1. **不要用「bash 打补丁 + trap 还原」**：`job_kill` 直接杀 shell，trap 不执行 → 树被留在半改状态；文件修改一律用编辑工具（临时改动也一样）。
1. **命令上限 5 分钟且不增长**：全量套件放**后台跑**（前台只跑逐文件定向，单文件 `app.test.ts` 超 5 分钟也改后台）；一条命令里不要跑两次全量。

**验证**：`tsc` 0 错；定向跑全绿（`layout4` 86/86、`focus-frame` 16/16、`layout-horizontal` 9/9、`command-panel` 23/23、`resume-summary` 8/8、其余 7 个文件全绿）；全量后台跑（`20e1c22` 之后）用于最终确认。

**审阅结论（只读 ≤6 次调用，逐条实证）**：

- **拆两段**：C1 = 读侧/元数据改源（不动数据结构：`frame.ts:231-249` 的回退判据与**模块级单例 `replayEntry`**、`index.ts:513-560` 的 `deliverBufferTail` 只吃本地行、估算器输入）+ 测试逐文件显式造节；C2 = **原子不可分**（删 `bufferRetainsContent` / `CONTENT_ACTIONS`(`state.ts:1449-1463`) / `dropContentWrites`(派发点 `:2611`、字段 `:2762`、赋值 `:2090-2092`) / `nextSeq` / `trimBufferHead` / `MAX_BUFFER_LINES` 与 6 个裁剪点 / `BufferLine` 内容字段与内容类 `BufferKind`(`state.ts:115-135`)，同步改 4 个测试文件与文档）—— 理由：删字段会让全部写点 tsc 报错、删开关会让写点回灌内容，只能一次落。
- **`nextSeq` 在 src 里没有任何读点**；`BufferLine.seq` 的读点只有 `replay.ts:62`、`build-box.ts:308`、`rows.ts:332-340`。
- **防错断言**：notice / shell / 工具行按设计**永久**留在 `local`（toast 与补投依赖 `index.ts:524`）→ 验收要断言 **kind 收敛**（`local.every(l => ["notice","shell","tool","plain"].includes(l.kind))`），**绝不能**写 `local === []`。
- 测试处置：`buffer-trim.test.ts` **整体删**（本地行若仍需上限，C2 另立新契约）；`buffer-retire.test.ts` 保留 3 例本地行语义、删内容口径与 `nextSeq`/缺省 true（可更名 `local-lines.test.ts`）；`state-history-blocks.test.ts` 先核对 `pipeline-*` 是否已覆盖再删；`pipeline-frame.test.ts` 保留整帧对拍骨架、`oldState` 改「空 local + 显式节」。
- 必补**反向断言**（段 A 验证过的手法）：抽掉 `pipeline`/`pipelineSink` 后帧内不再出现 assistant 段 ⇒ 直接证明内容不经缓冲。

**本地测量（第 64 轮）**：

- **回退依赖面 = 15 个测试文件**（`activity-verbose` / `app` / `command-panel` / `ctrl-t-panes` / `focus-cursor` / `focus-frame` / `footer-notice` / `layout4` / `layout-horizontal` / `notice-form` / `pane-titles` / `resume-summary` / `screen-residue` / `status-column` / `title-bar`）；段 A 已迁 6 个。判据 = 同文件既用 `reduceState` + `buildFrame`/`renderStatusColumn`，又未用 `deliveriesFromScript` / `sectionsFromScript` / `pipelineSink`。
- **「估算器改吃交付」这项无需改**：`state.ts:947` 的 `estimateOutputTokens(clean)` 吃的是**流式文本**（`clean` = 本 action 去标记后的文本），不是缓冲 → 原计划该子项自动满足（`stepEstTokens` / `tokenCalib` 链路也不读缓冲）。

## 段 B 完成（2026-10-11 第 62 轮，提交 `3566488`）

**第 65 轮精化（重要）**：15 个「依赖回退」的文件里，**只有 9 个真的构造内容**，7 个是零内容用法（只碰本地行 → 到 C2 也不用迁）：

| 文件 | 内容类用法次数 | 处置 |
| --- | --- | --- |
| `layout4` | 118 | 主战场（整帧对拍骨架，逐块迁） |
| `app` | 65 | 多数是 `adapter.push({type:"stream"})`＝**真实交付**（本就走流水线）→ 预计只需少量清理 |
| `layout-horizontal` | 10 | 迁 |
| `activity-verbose` / `screen-residue` / `resume-summary` / `focus-frame` | 5 / 4 / 4 / 4 | 迁 |
| `notice-form` | 3 | 迁（最小，先做） |
| `title-bar` / `status-column` / `pane-titles` / `footer-notice` / `focus-cursor` / `ctrl-t-panes` / `command-panel` | **0** | **无需迁**（只断言本地行，C2 后依然成立） |

判据 = 在「依赖回退」集合内再统计 `"append"|"user-line"|"thinking"|type: "stream"|kind: "assistant"|kind: "user"|history-resume-ok|"step"` 的出现次数。
→ C1 的真实工作量落在 **7 个文件**（`layout4` 与 `app` 另计），比原先按 15 个估的要小。

**做法**：仍是一次性改名，但把规则**分类精确**施加（不再用上一轮那种「全局正则 + 按报错行自动修补」的循环）：

| 类 | 规则 | 说明 |
| --- | --- | --- |
| ① 字段访问 | `\.buffer\b(?!Retains)` → `.local` | `\b` + 负向断言保证不误伤 `bufferRetainsContent` |
| ② 行首键 | `^(\s*)buffer:` → `\1local:` | 对象字面量 / 结构类型成员 / 接口字段（含 `buffer: Buffer;` 声明） |
| ③ 简写属性 | `,\s*buffer\s*[},]` → `, local: buffer…` | **键改名、值保留同名局部变量** |
| ④ 内联键 | `([{,]\s*)buffer\s*:` → `\1local:` | `state.ts` 的 `{ ...state, buffer: next }` 一族 |

随后只剩两类残错，逐条处理：**类型 1**（13 行）参数键改名后函数体仍叫 `buffer` → 定点改名；**类型 2**（5 处）上一轮定点循环**过度改名**（把同名局部变量也改了）→ 逐条回退。
**教训固化**：改名脚本只做「一类规则一次」，绝不在同一轮里混用多种规则 + 自动修补（上一轮就是这样把 `nextSeq: buffer.length + 1` 改成双冒号语法错的）。

**证据**：31 文件、`tsc` **0 错**、全量 **1463 / 1463 通过**、`check` 与 `build` 干净；残留 `buffer` 引用经检查**全是同名局部变量**（合法）；`BufferLine` 类型名、`nextSeq`、`trimBufferHead` / `MAX_BUFFER_LINES` / `bufferRetainsContent` **语义未动**（按裁定留给段 C）。

## 段 B 首次实施尝试失败（2026-10-11 第 41 轮，已整体回退）

**做法**：按审阅裁定做一次性改名 —— ① `state.ts` 的声明 `buffer: Buffer` → `local: Buffer`；② 全局正则 `.buffer` → `.local`（28 文件 151 处）；③ 再用 tsc 报错行**自动定点**修正剩余（结构类型键名、简写属性、过度改名）。

**结果**：错误数 150 → 39 → 23 → 13 → 15 → 2 → 5（反复震荡），最后**全量测试挂住**（疑似 `nextSeq` / 裁剪相关语义被改坏），遂 `git checkout -- TUI` **整体回退**，仓库恢复 1461 全绿。

**教训（下轮必读）**：

1. **不要用「按 tsc 报错行自动改写」的循环** —— 它把 `nextSeq: buffer.length + 1` 改成 `nextSeq: local: buffer.length + 1`（双冒号语法错），也把简写属性改出 `local: buffer: buffer`；错误数会震荡而非单调下降。
1. **各类改名要分开、按类型精准**：字段访问 `.buffer`（可正则）、结构类型的**键名** `buffer:`（要人工确认每个键都属于 AppState 形状）、**简写属性** `{ …state, buffer }`（要改成 `local: buffer`，不能只改标识符）、以及**局部变量同名** `const buffer = state.local`（应一并改名为 `local` 以保持一致）。
1. **推荐做法**：先在 `state.ts` 改声明 + 该文件内所有用法 → 再**逐文件**用 `read` + `edit`（按原文替换）推进，每改 2-3 个文件跑一次 `tsc`；不要全局脚本 + 自动修补。
1. 段 B 仍未开始（仓库当前状态 = 段 A 完成、段 B 未动）。

## 原段 B 预研（2026-10-11 第 14 轮，保留供对照；结论已被上节取代）

**写侧**（`src/app/state.ts`）：UI 本地行由这些分支写入缓冲——`notice` / `shell` / `tool-call` / `tool-result` / `command` / `feedback` / `hook` / `subagent` / `step` / `retry` / `compaction*`（约 10 个内容分支）；实现形态是**写时复制**：`const buffer = state.buffer.length ? [...state.buffer] : [];`（实测出现在 `state.ts:893 / 976 / 1013 / 1038 / 1067 / 1167` 等，至少 6 处），随后 `nextSeq` / `trimBufferHead` / 行数上限一起动。

**读侧**（3 处，都要同步改）：

- `src/app/index.ts:512`——`deliverBufferTail` 逐行交付（按 `state.buffer.slice(before)`）。
- `src/app/index.ts:1653`——记录 `tailBefore` 配合上一处。
- `src/app/layout.ts:1321 / 2385`——`sectionsOf` 的无 sink 回退（测试 / 嵌入式用法）逐行重放。

**段 B 的最小落地顺序（下一轮照做）**：

1. `state.ts` 加 `local: BufferLine[]`（UI 本地行专用），把上面 10 个分支的写入从 `buffer` 改到 `local`（写时复制形态照旧，先机械搬移，不改语义）。
1. 读侧 3 处改读 `local`；`sectionsOf` 回退先合并读（`local` + 旧 `buffer` 残留）以便分批。
1. 跑全量；`steer-queued-display` / `layout` / `step` / `buffer-retire` / `screen-residue` / `turn-separator` 这些**缓冲契约用例**随本段改写到 `local` 上。
1. 确认无残留写入后，段 C 才删 `buffer` 字段与 `BufferLine` 的内容 kind。

## 段 C1 收尾：测试侧迁移套路与现状（2026-10-11 第 110-119 轮）

删掉无 sink 回退后，凡「自建 App 未传 `pipelineSink`」或「用 `reduceState` 造内容再出帧」的测试都看不到内容。三套已验证有效的补法：

| 场景 | 补法 | 涉及文件（本轮） |
| --- | --- | --- |
| `new App({ renderer, adapter })` | 追加 `pipelineSink: {}`（生产 `main.ts` 同款） | `council-notice`、`stats-rename`、`settings-fork`、`memory-notice`、`memory-review`、`contract-notice`、`permission`、`command-panel-{agents-tools,search,task,loop,guard,workflows}` |
| 各文件本地 `class TrackedApp` | 构造函数里 `const sink = deps.pipelineSink ?? {}` → `super({...deps, pipelineSink: sink})`，并给共享 `FakeAdapter` 接 `mirrorTo = sink` | `session-delete`、`steer-queued-display`、`injection-display`、`exit-confirm`、`startup-resume-history`、`activity-level`、`policy`、`jobs-panel`、`title-bar` |
| 断言读 `state.local` / 直接 `buildFrame` | 改断言**节缓存**（`JSON.stringify(app.sections).includes(...)`，同步安全、形状无关）或换用 `helpers/frameWithLocalReplay.ts` 的包装 `buildFrame` | `steer-queued-display`、`app.test.ts`、`layout-cache`、`tool-call-wrap` |

**结果**：全量失败 79 → 28 →（子代理批量迁移中）。已复跑转绿：`council-notice`、`stats-rename`、`settings-fork`、`memory-notice`、`contract-notice`、`command-panel-agents-tools`、`injection-display`、`exit-confirm`、`activity-level`、`steer-queued-display`、`app`（177/177 且退出码 0）。

**顺带修掉的两处**：① `rows.ts` 工具结果行折叠（结果行不保留换行，与旧缓冲口径一致）；② `index.ts` 的符号归一改到**交付入口** `ingestDelivery` 做一次（原先只在事件分支改缓冲文本 → 流水线看不到，`/symbol-unify` 在真机没有效果），并删掉事件分支里的重复归一。

**裁定（用户 2026-10-11）**：**取消「新回合清空活动区」语义**——内容持续可见；〈活动区生命周期〉用例已按此改写。

## 段 C2 计划（原子删除，未开工）

删除面（只读盘点，2026-10-11 第 122 轮统计）：

| 符号 | 位置数 | 说明 |
| --- | --- | --- |
| `BufferKind`（内容类成员） | 6（定义 `state.ts:115`） | 收敛后只留 `notice` / `shell` / `tool` / `plain` |
| `bufferRetainsContent` | 10 | 开关与闸门/回写一起删 |
| `CONTENT_ACTIONS` | 2 | 内容类动作集合 |
| `dropContentWrites` | 2 | 内容写入丢弃逻辑 |
| `nextSeq` | 19 | 缓冲序号（内容专用） |
| `trimBufferHead` / `MAX_BUFFER_LINES` | 7 / 4 | 裁剪点 6 处 + 上限 |

顺序：一次改完（删字段会让全部写点 tsc 报错、删开关会让写点回灌内容，只能一起落）→ `npx tsc --noEmit` 的报错即完整入口清单 → 同步改 4 个测试文件（`buffer-trim` 整体删；`buffer-retire` 保留本地行语义；`state-history-blocks` 先核对覆盖；`pipeline-frame` 保留整帧骨架、`oldState` 改「空 local + 显式节」）→ 文档（`SPEC.md:522-523`、`DESIGN.md:175/698`）。验收断言：`local.every(l => ["notice","shell","tool","plain"].includes(l.kind))` + 反向断言（抽掉 pipeline 后帧内不再出现 assistant 段）。

**删除面收敛（2026-10-11 第 125 轮复核）**：`nextSeq` 全部集中在 `src/app/state.ts`（19 处），测试侧只有 3 个文件各 1 处引用（`state-history-blocks` / `pipeline-frame` / `buffer-retire`）；`trimBufferHead` = 定义（`state.ts:69`）+ 6 个调用点（`:942/:984/:1024/:1046/:1075/:1291`），同在 `state.ts`。即 **C2 的代码改动几乎全在这一个文件内**，测试改动面 4 个文件。

## 收尾

（待补）
