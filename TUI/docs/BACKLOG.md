# TUI 待办与开放项

> 职责：TUI 包的**未完成**待办（TUI 的变更优先写在本目录）；跨包待办见 `docs/BACKLOG.md`，TUI 现状见 `TUI/docs/STATUS.md`
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用（追踪文档按条目标题引用，见 `docs/WORKFLOW-STANDARD.md` §6/§7）；**每次整理时按当前顺序从 1 起重新编号**（故 `TUI/src`、`TUI/tests` 注释中的 `TUI#n` 仅作历史线索）；本文件的 `#n` 与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 本文件只列未完成项；已完成项见 git 历史与 `TUI/docs/archived/`，不在此重复。
> 组织：**按依赖 → 工作量排序**（2026-10-06 起取代「按主题分组」）：无前置项在前、同层按工作量升序、同工时缺陷优先于行为改动；有前置项排在各自前置之后；**〔暂停〕项沉到表尾**（挂着未完成的前置、本轮不接取）。条目统一结构——现象 / 现状 → 期望 →（可选）复现 / 疑似范围 / 接取时裁定 → 落点 → 验收 → 来源·状态·优先级。

## 待办

| # | 条目 | 落点 | 工作量 | 优先级 |
| --- | --- | --- | --- | --- |
| 13 | **终端探测 + 按终端自动切换字符宽度文件**。现状：实测宽度表是**单文件**（`<profile>/tui-width-table.json`），终端身份只有文件内 `term = TERM|TERM_PROGRAM|COLORTERM` 一个字段（`layout/width-table.ts` `terminalKey`）→ 不匹配就**整表作废、全会话重测**（kitty ↔ tmux ↔ iTerm 来回切换即反复丢表重测）；且身份只看 3 个 env——tmux 会把 `TERM` 改写成 `tmux-256color` 掩掉真实终端，kitty 的 `KITTY_WINDOW_ID` 与主动应答查询（DA1 `ESC[c`、kitty 键盘协议 `ESC[?u`）均未用。期望（用户 2026-10-08）：启动时探测当前终端（env 初筛：`TERM` / `TERM_PROGRAM` / `COLORTERM` / `KITTY_WINDOW_ID` / `TMUX` / `ZELLIJ` / `SSH_CONNECTION` + 应答查询确认；env 可继承可伪造，以应答为准），按探测结果**自动切换宽度文件**——一终端一份实测表（如 `tui-width-table.<key>.json`），换终端不丢表、不整表重测；探测失败回落现状口径。**接取时裁定**：① 探测时机与缓存（启动一次 per 进程；应答查询的超时上限与降级）；② tmux 嵌套是否经 `ESC Ptmux;` 透传向下游终端再查一轮（表记 tmux 自身还是下游模拟器）；③ 旧单文件迁移（读到旧文件 → 归入首个终端 key 还是仅作回落）；④ 文件名 key 的口径（`terminalKey` 升级版：含 tmux / kitty 标记）；⑤ 与 `markdown.ts` 实测记账的衔接不变量。落点：`TUI/src/app/layout/width-table.ts`（`terminalKey` 升级 + 文件选择）、新探测模块、`TUI/src/app/index.ts`（启动注入）、必要时 `TUI/src/app/layout/markdown.ts`；文档 `TUI/docs/SPEC.md`。验收：探测单测（env 矩阵 + 应答序列桩）；同一 profile 下两终端各持一份表互不覆盖（文件断言）；旧单文件回落不回归；真机 kitty + tmux 切换各目视一次。 | `TUI/src/app/layout/width-table.ts`、新探测模块、`TUI/src/app/index.ts` | 2-4 h | P2 |
| 15 | **重新设计回合区工具块的显示格式**（2026-10-10 用户提出, **占位条目: 详细内容待开工时与用户讨论后再补**）。已知锚点（供后续讨论定位）：工具批的盒组装在 `pipeline/boxes.ts` 的 `toolBox`（`:331-340` 判 `isBatch`）, 行文本由 `layout/tool-line.ts` 的 `toolCallLine` / `toolResultLine` 生成, 状态层落行为 `state.ts` 的 `appendToolLine`（`:1052-1070`）, 渲染形制见 `SPEC.md:115-121` 一带; 相邻条目：〈同节内「辅助行 → 工具调用」顺序会让辅助行消失〉（辅助行与工具批同槽的顺序缺口）、〈辅助行独立成段（不与工具批共用同一段）〉、〈恢复的记录要能区分输入 / 正文 / 工具调用（现工具调用位置是空行）〉（恢复路径只剩 step 摘要行）——工具段的显示格式改动很可能与这三条一并裁定。待定：新形制（参数 / 结果 / 折叠 / 配色 / 多调用合并与截断口径）、是否与 `step` 头 / 辅助行统一、是否影响恢复路径与 `stepOf` 回解。 | 待定 | 待定（占位） | 待定 |

> 排序注记（2026-10-10 重排）：全表按**依赖 → 工作量**——无前置项在前、同层工作量升序、同工时缺陷优先于行为改动、占位与〔暂停〕沉底。**唯一由依赖而非工作量决定的次序**：〈辅助行独立成段（不与工具批共用同一段）〉是〈同节内「辅助行 → 工具调用」顺序会让辅助行消失〉的前置，故后者排在 1-2 h 层之后。正文里的交叉引用一律用**标题**（编号每次重排都会变）。**17、18、20、21、22、23、24 为 2026-10-10 新增；25-28 为 2026-10-11 真机复核新增**（17 = 条目 2 实现期审阅发现；18 = 条目 3 实现期探针发现；20 = 条目 6 实现期查明的根因；21 = 条目「孤儿步骤分隔线」实现期发现；22 = 条目「辅助行独立成段」收尾审阅发现。七条待下次整理并入排序）。

- **恢复路径的历史工具行没有 diff 摘要（`HistoryRow` 不带 `meta`）**（来源，2026-10-12 第 3 条收尾发现）：实时线已修（`tool-result` 交付透传宿主 `data.meta`，提交 `5adf125`；冒烟 `tool-meta-diff` 已转绿，整体 42 PASS / 0 FAIL），但恢复路径的工具行由 `replay.ts` 从 `HistoryRow` 造交付，而 `HistoryRow` 没有 `meta` 字段 → 恢复出来的会话里编辑类工具的结果行看不到 `(+N/-M)`。**修法**：`HistoryRow` 加 `meta?`，`adapter/dsh.ts` 的 `normalizeHistoryMessages` 产工具行时带上 `data.meta`，`replay.ts` 透传给交付。**落点**：`src/app/state.ts`（`HistoryRow`）、`src/app/adapter/dsh.ts`、`src/app/layout/pipeline/replay.ts`。**验收**：单测（日志里带 meta 的 `tool/result` → 恢复后结果行含摘要）+ 真机 `/resume` 目视一轮。**估时**：1-2 h。**优先级**：P3。〔待办：2026-10-12 登记，尚未修〕
