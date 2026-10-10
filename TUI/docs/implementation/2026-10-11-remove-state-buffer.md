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
- 待迁移（段 A 余量）：`layout4`（2800+ 行、fixture 最规整，但用例多）、`layout-cache`（10 例）、`focus-frame` 等。

## 测试与证据

- 迁移后 `tests/pane-text-margin.test.ts` 4/4 通过；全量 `npm test` **1444 / 1444 通过**；`npm run check` 干净。
- **反向验证**：把助手里 `pipeline: sectionsFromScript(steps)` 抽掉（其余不动）→ 该文件 4 例中 **2 例失败**（依赖长文本铺满的断言拿不到内容）→ 证明帧内容确实来自节模型，而非缓冲回退。

## 测试与证据

（待补）

## 审阅记录

（待补）

## 收尾

（待补）
