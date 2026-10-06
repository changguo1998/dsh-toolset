# 会话区 ↑/↓ 撞物化窗口顶时不再多翻十几行（接取条目：`TUI/docs/BACKLOG.md`「会话区 ↑/↓ 撞物化窗口顶时多翻十几行（不是半屏）」）

状态：暂停　　开启：2026-10-07　　关闭：—（暂停中，未关闭）
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

↑/↓ 标称半屏（`dialogueHalfPage(viewportH)` = `max(1, floor(viewportH/2))`），但「撞到渐进物化窗口顶」的那一次会猛跳十几行。目标：**撞顶那次也只多物化、不多滚** → ↑/↓ 恒等于半屏。

## 调研（2026-10-07，源码）

1. **现状次序（根因）**：`state.ts` 的 `scrollDialogue`（`:3471-3510`）先算位移、后判扩窗：
   - `:3478` `moveDialogueAnchor(state.scrollAnchor, delta, g)` 用**移动前**几何裁剪——`layout.ts:307` `maxTop = Math.max(0, geom.rows - geom.height)`，`layout.ts:309` `next = clamp(cur - delta, 0, maxTop)`；
   - `:3482-3490` **之后**才用 `top`/`margin` 判 `nearTop` 并 +`WINDOW_GROW_STEP` 组；
   - `:3500-3506` 返回新锚点 + 新 `windowGroups`。
     ⇒ 撞顶那次位移被旧 `maxTop` 夹到窗口首行（= **折叠占位行** `DIALOGUE_MARKER_SEQ`，`layout.ts:166`/`:1647`）；随后扩窗，`dialogueTopIdx`（`layout.ts:243-268`，把占位行视为不可达，`:252`）把视口顶**重钉到新窗口第一条真实内容** → 一次跳掉整批新物化的行（实测跨 ~15 行，应为 4 行）。
1. **几何来源**：`DialogueGeometry`（`layout.ts:175`）由**布局期**产出，经 `FrameScrollReport.dialogueGeometry`（`:1668`）交回 state（`state.ts:2056` 的 action）。reducer 内**无法**自己按新的 `windowGroups` 重算几何（行数取决于折行宽度）。
1. **但 App 层可以**：`index.ts:394-400` 的 `paneMaxes()` 以 `this.state` 身份为缓存键，state 一变就 `buildFrame(...)` 重算 → **先 apply 扩窗、再取 `paneMaxes().dialogueGeometry` 即得扩窗后的几何**（同文件 `:2074` 的既有用法）。
1. ↑/↓ 分派点：`index.ts:2060-2082` —— 无焦点/历史焦点走 `scroll` action（`:2075-2081`），`delta = dir * dialogueHalfPage(viewportH)`，`geom` 取自 `paneMaxes()`。
1. 扩窗常量与判据：`WINDOW_GROW_STEP`（`state.ts`，+N 组）、`nearTop = top <= margin || g.rows <= g.height`（`state.ts:3486-3487`，`margin = max(1, floor(height/2))`）、窗口组数上限 `turnGroupStarts(buffer).length`。

## 决策

**D1｜修在哪一层？** → **App 层两段式**（`index.ts` 的 ↑/↓ 分支）：先判「是否需要扩窗」并 apply 扩窗，再取 `paneMaxes().dialogueGeometry` 作为**扩窗后**的几何，最后 apply `scroll`。
理由：reducer 拿不到扩窗后的几何（行数依赖折行宽度），而 App 层既有「state 变 → `paneMaxes()` 重算」的现成机制；相比「给 reducer 传几何 provider / 传两份几何」，两段式改动最小、语义最直白（就是条目写的「先扩窗、再按扩窗后的几何施加位移」）。

**D2｜判据复用** → 把「是否需要扩窗」抽成**导出纯函数**（如 `dialogueNearWindowTop(state, geom): boolean`，实现 = 现 `state.ts:3482-3487` 的 `top`/`margin`/`nearTop` 计算），App 与 `scrollDialogue` 共用一处真相；`scrollDialogue` 内既有的扩窗分支**保留**（其它调用方与既有单测继续可用；两段式下它通常判 false → 不会二次扩窗）。

**D3｜新增 action** → `state.ts` 增 `{ type: "grow-dialogue-window" }`：`windowGroups = min(totalGroups, windowGroups + WINDOW_GROW_STEP)`，已到上限则原样返回（不产生无谓的 state 变更 / 重绘）。App 仅在 `delta > 0 && dialogueNearWindowTop(...)` 时先派发它。

**D4｜验收与测试**：

- 单测（reducer 级）：模拟「3 组窗口撞顶」的一次 ↑ —— 先 `grow-dialogue-window`、再用**扩窗后几何** dispatch `scroll`，断言锚点只上移 `floor(viewportH/2)` 行、**不跨回合**、且锚点**不是**折叠占位行（`seq !== DIALOGUE_MARKER_SEQ`）；同时补一条反向用例：**不分两段**（旧次序）在同样输入下会跳更多行 → 锁住「先扩窗」的必要性。
- 回归：`tests/layout4.test.ts` 翻页区、`tests/app.test.ts` 的「上滚越顶」用例按新行为核对（预期**不变**：它们的场景未撞顶；若变则按 D4 口径更新并在追踪文档记明）。
- 真机：连续 ↑ 每次半屏、无跳变（用户侧顺带确认）。

**明确不做**：`dialogueTopIdx` / `moveDialogueAnchor` 的既有 clamp 语义（D1 通过次序解决，不改判据）；`PgUp/PgDn`（`index.ts:2085-2126`，其注释已承认「跳转只在物化窗口内找目标」）；`Home/End`（条目 TUI#7 专管，本轮不动）；窗口组数上限 / `WINDOW_GROW_STEP` 数值。

## 规划（计划改动文件清单）

1. `TUI/src/app/index.ts`：↑/↓ 历史分支改两段式（判据 → 扩窗 → 取新几何 → 位移）。
1. `TUI/src/app/state.ts`：新增 `grow-dialogue-window` action；把 `nearTop` 判据抽成导出纯函数（`scrollDialogue` 改为调用它，行为不变）。
1. `TUI/tests/scroll-anchor.test.ts`（或同族）：新增「撞顶一次只走半屏 + 锚点非占位行」与「旧次序会多跳」两条用例。
1. `TUI/docs/SPEC.md` / `TUI/docs/DESIGN.md`：若其中写明「上滚撞顶 → 扩窗」的次序，补一句「先扩窗、再位移」；`TUI/README.md` 键位表若含 ↑/↓ 半屏口径则同步。
1. `TUI/docs/BACKLOG.md`：条目标〔进行中〕→ 关闭时移除（余下条目按编号口径重编）。
1. 本追踪文档：建 → 关闭时移入 `TUI/docs/archived/`。

## 实现记录

- 2026-10-07：接取条目并标〔进行中〕；建本追踪文档；**决策阶段子代理审阅（`e2275f9c`）：有异议 1 条（严重）**——两段式下 reducer 的 `nearTop`（`state.ts:3487`）在扩窗后几何上仍可为真 → **一次按键内二次扩窗**，而锚点已按中间几何算完 → 占位行重钉（实测 `wg 3→9`、一次 ↑ 上移 17~18 行，比现状更差）；另 3 条中/轻（断言口径、验收不需要 App 层、`window-groups` 与新增 action 重复、`SPEC.md:676` 必改）。**已按建议修订**：`scroll` action 增 `grow?: boolean`（App 传 `false` 禁止二次扩窗）、复用既有未被派发的 `window-groups` 做预扩窗、抽 `dialogueNearWindowTop` 公共判据。
- 已实施（**尚未提交**）：
  - `state.ts`：`scroll` action 增 `grow?: boolean`；`scrollDialogue(state, delta, geom?, grow = true)` 增加禁止扩窗分支；抽出并导出 `dialogueNearWindowTop(state, geom)`（`scrollDialogue` 改为调用它，行为不变）；函数文档注释补「先扩窗再位移」的次序说明。
  - `index.ts`：↑/↓ 历史分支改两段式——判 `dialogueNearWindowTop` → `window-groups` 预扩窗（`min(total, wg + WINDOW_GROW_STEP)`）→ 取 `paneMaxes().dialogueGeometry`（扩窗后几何）→ `scroll` 带 `grow: false`。
  - `npm run check` ✓（tsc 无输出）。
- **阻塞（新发现的既有缺陷，超出条目范围）**：写「撞顶一次恰走半屏」的单测时实测**修好后仍会跳 16 行**。探针（`tmp/probe-grow.ts`，已删）定位到第二处机制：`indexToAnchor`（`layout.ts:271-283`）对 `seq = -1` 的行（**回合分隔线 / 空行 / 用户块留白**都取 `-1`：`layout.ts:194` 的 `r.seq ?? r.line ?? DIALOGUE_MARKER_SEQ`）不唯一——落点若正好是 `-1` 行，锚点写成 `{seq:-1,row:k}`，而 `dialogueTopIdx`（`layout.ts:243-268`）判 `reachable = seq !== MARKER && spans.some(s => s.seq === anchor.seq)`，`-1` 因占位行存在而被判**可达** → `anchorToIndex` 命中的是**窗口首行那个 `-1` 占位行** → 视口塌到物化窗口顶。
  - 探针实测：扩窗后 `rows 16→31`、`cur=16`、目标 `next=12`，而 `spans[12]` 恰为 `-1` 行 → 返回锚点 `{seq:-1,row:0}` → 视口顶落到 0（跨 16 行）。即：**该缺陷与「先扩窗 / 后扩窗」无关，任何一次位移落到分隔行都会触发**，且正是条目现象「多翻十几行」的同类表现。
  - 处置：按流程停止尝试并如实报告（改动留在工作区、未提交；新增用例已从 `tests/scroll-anchor.test.ts` 撤回，避免留红测试）。**待用户裁定**：(A) 扩范围——同修 `-1` 行锚点（最小改法：`indexToAnchor` 落点吸附到最近的真实内容行，或在 `dialogueTopIdx` 把 `-1` 锚点按「吸附到不晚于它的最近真实行」处理）；(B) 先只提交「先扩窗」这一半（无单测，验收打折）；(C) 撤回本条目改动、另开条目专门做 `-1` 行锚点。

## 测试与证据

- 已跑：`TUI` 的 `npm run check` ✓；`./scripts/test.sh scroll-anchor.test.ts` —— 既有 11 例全绿，新增的「撞顶只走半屏」用例**未通过**（实测 16 行），失败原因即上文阻塞项；该用例已撤回。
- 探针证据（`tmp/probe-grow.ts` 输出，已删）：`gBase rows 16`、`k=1`（锚点 `{seq:29,row:0}`）、扩窗 `wg 3→6`、`rows 16→31`、`curInGrown 16`、`indexToAnchor(spans,12)` → `{seq:-1,row:0}` → `topIdx 0`。

## 收尾（暂停，未关闭）

- 2026-10-07 用户裁定：**该区域先暂停**——「排版流程重构」（`TUI/docs/BACKLOG.md` 条目 5：按段缓存 + 先量后裁）先行；本条目改标〔暂停〕、**前置 = 条目 5**，另一处既有缺陷单列为条目 2。
- 处置：**已实现的源码改动全部撤回**（`state.ts` 的 `grow?: boolean` 与判据抽取、`index.ts` 的两段式）——它们是「多量一次」的临时解；重构后「扩窗后有多少行」可直接查缓存求和，不再需要这层兜底。撤回后工作区只余本文件与 BACKLOG 的文档改动。
- 保留：根因四步链、机制 2 的探针证据（`indexToAnchor` 落点压在 `seq = -1` 行 → 锚点塌到窗口顶，实测跨 16 行）与两轮审阅结论（含「一次按键二次扩窗」的实测数据：`wg 3→9`、上移 17~18 行），恢复时按本文件 D1-D6 重做即可（改动面小）。
- 本文件留在 `TUI/docs/implementation/`（暂停 ≠ 关闭，暂不归档）。
