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
- 缺陷有**两种形态**（审阅实测指出，第一版只覆盖了前者）：
  1. **独立空 item**：`\n\n` 自成一个 box（如同一节该 source 的唯一条目）→ pane 层入项口认领；
  1. **同源合并的边缘空行**（真机最可能）：`sections.ts:207-212` 按 `source` 合并流式文本，宿主每步补发的 `"\n\n"` 会并进相邻正文，成一个**非空 box**（文本 `"正文一\n\n"`）→ pane 级 `trim()` 判空对其无效，回合区与会话区都仍出不可见行（旧口径 `absorbActivityBlank` 会吸收）。故第二版在**行层**（`rows.ts` 文本 → 行）补：非 user 文本剥掉前导 / 拖尾空行，整段全空则不产出行。
- 帧级**可以**隔离该缺陷（原判断作废）：`reduceState(s, {type:"pipeline-state", pipeline})` + `buildFrame` 即可构造；本条目最终证据用**交付驱动等价用例**（`tests/pipeline-frame.test.ts`：「同源合并的前导 / 拖尾空行不产出可见行」，比较「有空行」与「无空行」两条交付流的回合区 + 会话区行）。
- 用户报告的现象（BACKLOG 原文）：回合区出现看不见内容、只占行的空正文，疑似全为换行 / 全空的 reasoning 或 assistant 段。

## 决策

- **D1 口径**：文本 `trim()` 后为空即**整段丢弃**（含首尾换行、纯空白）。
- **D2 范围**：仅 `kind === "content"` 且 `source !== "user"` 且 `shape ∉ {code, tool}`——代码块 / 表格 / 工具批有各自结构（文本字段可能为 undefined），用户块带块身份与符号语义，均不参与丢弃。
- **D3 两个 pane 同口径**：判定放在唯一入项口 `push()`，会话区 / 回合区一致（避免只修回合区、会话区仍留空行）。
- **D4 顺带删死代码**：新规则覆盖 `absorbEmptyNotice` 的原有场景（紧接工具批 / step 头前的空 notice）→ 该函数与其两处调用（`push` / `buildPanes`）成为 no-op，按上一条目沉淀的判据（零活读者 → 删）删除。审阅三方对照实测：`"\n"` / `"\n\n"` notice + 工具批，改前 3 行 = 改后 3 行，而「守卫与 absorb 都删」为 4 行 → 删除安全，守卫确为替身。**同时记两处加宽**（行为变更，非纯超集）：① 纯空白 notice（如 `" "`）改前保留一行、改后丢弃；② 不在工具批 / step 头之前的空 notice，改前保留、改后丢弃。二者均无测试锁定（`tests/layout4.test.ts:2037/:2133` 的「吸收空 notice」实际来自 `rows.ts` 的拖尾剥离，不是被删函数，故不是该机制的回归见证）。
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
  - 第二版（审阅折叠，同 2026-10-10）：`rows.ts` 的文本 → 行补「非 user 文本剥前导 / 拖尾空行」——空白判定含零宽字符（U+200B/U+200C/U+2060/U+FEFF，`trim()` 不删但列宽为 0），整段全空则返回空数组（该 box 不产出行）；`notice` / `shell` 的拖尾剥离成为其特例。
  - `state.ts` 未改：状态层不需要变化。

## 测试与证据

- `tests/pipeline-panes.test.ts` 新增用例：一条 section 里放 `reasoning "\n\n"`、`reasoning "（想）"`、`assistant "\n\n\n"`、`assistant "中间正文"`、`assistant "\n\n"`（中间 + 尾部各一例），断言回合区 pane 项里**没有**「文本 trim 后为空」的内容项，且非空正文照常产出。**修复前实测失败**（`全空正文段不应产出回合区项`）→ 修复后通过（反向可验证）。
- `npm run check`：干净；`npx tsc --noEmit --noUnusedLocals`：0 条；`npm test`（TUI）：**1423 / 1423 通过**（改动前 1420 + 新增 3：pane 契约 1 + 交付驱动等价 1 + Home/End 条目带入的空会话 1）。
- 交付驱动等价用例（`tests/pipeline-frame.test.ts`）：`"正文一"` 与 `"正文一" + "\n\n"` 两条交付流（同 `source` / `step` / `index` → 合并）产出的回合区 + 会话区行**逐项相等**——修复前该用例失败（边缘空行占行），修复后通过。
- 未做 / 已知未覆盖：① 真机目视（本机沙箱禁写 `~/.dsh`，起不了真机——建议用户真机复核回合区无可视空行）；② U+00AD（软连字符）仍漏（其列宽为 1，`displayWidth` 判据同样漏）；③ 带结构装饰的空条目（`> ` 引用 → 仅竖线行、`- ` 列表 → 项目符号行）旧新一致，**不算**「全空正文」。

## 收尾

- 关闭：条目「回合区没有清理『全空的正文』」2026-10-10 完成，已从 `TUI/docs/BACKLOG.md` 移除。
- 口径回答条目原文的「待确认」：覆盖**独立空段**与**同源合并的边缘空行**两种形态；来源 = reasoning / assistant / notice（`user` 保留、`code` / `tool` 无文本字段而豁免）；live 与恢复重放同口径（都经同一入项口 + 行层）。**「拖尾段」这一支已并入本次范围**（原计划只做整段）。
- 回写文档：`README.md` / `DESIGN.md` / `SPEC.md` 无需改（六步分层描述与新实现一致；审阅确认没有旧机制描述行）。`STATUS.md` 按流程不由本任务改。
- 判据沉淀：判空只在 **box 级**不够——凡「空内容不该占行」的规则都要同时在**行层**落一条（流式合并会把补发文本并进相邻 box）。
- 归档：本文件移入 `TUI/docs/archived/`。
- 提交链：`1c37b19`（第一版实现）→ 收尾提交（行层修复 + 交付驱动用例 + 审阅折叠 + 归档 + BACKLOG 收尾）。
