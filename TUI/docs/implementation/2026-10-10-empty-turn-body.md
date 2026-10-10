# 回合区全空正文段不产出可见行（接取条目：`TUI/docs/BACKLOG.md`「回合区没有清理『全空的正文』」）

状态：进行中（2026-10-10 接取；条目原〔暂停〕，本轮按用户指令解暂停）

## 目标

全空正文段（只含换行的 reasoning / assistant / notice 段）在回合区不产出可见行——与既有的「notice 拖尾换行吸收」「pane 末尾空行裁剪」同族。

## 调研

- 缺陷复现（修复前）：`tests/pipeline-panes.test.ts` 新增用例「⑦ 全空正文段不产出回合区行」在**修复前失败**——`panes.ts` 的入项口 `push()` 对内容 box 不做空判定，文本 `"\n\n"` 的 item 照样进 pane 项，行层再按文本切行 → 回合区出现只占行的空行。
- 既有同族机制（都在别处、不覆盖本缺陷）：
  - `absorbEmptyNotice`（`panes.ts`）：仅吸收「紧接工具批 / step 头之前的**空 notice**」，对 reasoning / assistant 空段无效；
  - pane 末尾空行裁剪（`rows.ts` 的 `renderPane`）：只裁**整 pane 尾部**的空行，管不到中间的；
  - 行缓冲缓存键 / 段表：与本缺陷无关。
- 帧级无法隔离该缺陷（实测）：空白文本若与相邻文本用**同一块身份**（同 `turn` / `step` / `source` / `index`）到达，sections 层按流式追加把它并进相邻块（观测到行文本变成 `┃\n\n（想）`）；换 `index` 也仍是同一逻辑块的增量。故「全空正文段」的可复现形态是**独立 item**，由 pane 层认领；帧行与 pane 项 1:1（`rows.ts` 逐项出段），pane 契约即帧的等价证据。
- 用户报告的现象（BACKLOG 原文）：回合区出现看不见内容、只占行的空正文，疑似全为换行 / 全空的 reasoning 或 assistant 段。

## 决策

- **D1 口径**：文本 `trim()` 后为空即**整段丢弃**（含首尾换行、纯空白）。
- **D2 范围**：仅 `kind === "content"` 且 `source !== "user"` 且 `shape ∉ {code, tool}`——代码块 / 表格 / 工具批有各自结构（文本字段可能为 undefined），用户块带块身份与符号语义，均不参与丢弃。
- **D3 两个 pane 同口径**：判定放在唯一入项口 `push()`，会话区 / 回合区一致（避免只修回合区、会话区仍留空行）。
- **D4 顺带删死代码**：新规则是 `absorbEmptyNotice` 的超集 → 该函数与其两处调用（`push` / `buildPanes`）成为 no-op，按上一条目沉淀的判据（零活读者 → 删）删除。
- **D5 明确不做**：不动 notice 拖尾换行吸收与 pane 末尾空行裁剪的既有行为（它们各自仍有语义）；不为本缺陷新增 state / 行层开关。
- **D6 证据层**：证据落在 pane 契约（新用例）+ 全量回归；帧级隔离不可达（见调研），在本文记录原因。

## 规划

计划改动文件清单：

- src：`TUI/src/app/layout/pipeline/panes.ts`（`push()` 前置空判定 + 删 `absorbEmptyNotice` 与两处调用）。
- tests：`TUI/tests/pipeline-panes.test.ts`（新增「⑦ 全空正文段不产出回合区行（中间 / 尾部各一例）」；修复前失败、修复后通过）。
- 文档：`TUI/docs/BACKLOG.md`（进行中 → 完成）；如 `SPEC.md` / `DESIGN.md` 有 pane 构建口径描述则同步（检查后按需）。

## 实现记录

- 2026-10-10：
  - `panes.ts` `push()` 前置判定：`box.kind === "content" && box.source !== "user" && box.shape !== "code" && box.shape !== "tool" && (box.text ?? "").trim() === ""` → 直接 `return`（该 item 不产出；边界项与 `last` 状态也不受影响，等价于该段从未到达）。
  - 删 `absorbEmptyNotice`（含其 JSDoc）与 `push` / `buildPanes` 两处调用：空 notice 已在入口丢弃，原「在工具批前 pop 空 notice」不再有可 pop 的对象。
  - 未改 `rows.ts` / `state.ts`：缺陷源头在 pane 入项口，行层与状态层无需变化。

## 测试与证据

- `tests/pipeline-panes.test.ts` 新增用例：一条 section 里放 `reasoning "\n\n"`、`reasoning "（想）"`、`assistant "\n\n\n"`、`assistant "中间正文"`、`assistant "\n\n"`（中间 + 尾部各一例），断言回合区 pane 项里**没有**「文本 trim 后为空」的内容项，且非空正文照常产出。**修复前实测失败**（`全空正文段不应产出回合区项`）→ 修复后通过（反向可验证）。
- `npm run check`：干净；`npx tsc --noEmit --noUnusedLocals`：0 条；`npm test`（TUI）：**1421 / 1421 通过**（改动前 1420 + 新增 1）。
- 未做：真机目视（条目验收含「真机无可视空行」；本机沙箱禁写 `~/.dsh`，起不了真机——建议用户真机复核回合区无可视空行）。

## 收尾

（待填）
