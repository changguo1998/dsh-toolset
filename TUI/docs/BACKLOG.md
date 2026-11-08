# TUI 待办与开放项

> 职责：TUI 包的**未完成**待办（TUI 的变更优先写在本目录）；跨包待办见 `docs/BACKLOG.md`，TUI 现状见 `TUI/docs/STATUS.md`
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用（追踪文档按条目标题引用，见 `docs/WORKFLOW-STANDARD.md` §6/§7）；**每次整理时按当前顺序从 1 起重新编号**（故 `TUI/src`、`TUI/tests` 注释中的 `TUI#n` 仅作历史线索）；本文件的 `#n` 与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 本文件只列未完成项；已完成项见 git 历史与 `TUI/docs/archived/`，不在此重复。
> 组织（2026-10-13 整理起）：**用户手动指定的顺序优先**；否则〔进行中〕条目置顶 → 其余按依赖 → 工作量升序（无前置项在前、同层按工作量升序、同工时缺陷优先于行为改动；有前置项排在各自前置之后；〔暂停〕项沉到表尾）。条目统一结构——现象 / 现状 → 期望 →（可选）复现 / 疑似范围 / 接取时裁定 → 改动位置 → 验收 → 来源·状态·优先级。
> 顺序与并行分组见项目级 `docs/BACKLOG.md` §2「实现顺序与并行分组」（按组串行、组间并行，组内按工作量升序）。
> 写入范围（2026-10-23）：并行任务只写自己的代码 / 测试与**自己的追踪文档**；本文件的状态与关闭注记、`SPEC.md`、`README.md`、`COMMANDS*.md` 由主分支代理统一回写。

## 待办

- **daemon 开关状态收进标题栏符号区, 状态列 Daemon 块只在打开时显示且不再带开/关文字**

  - 现象 / 现状: ① `TUI/src/app/components/StatusColumn.ts:365-382` 的 Daemon 块显示条件是 `items.length > 0`（只要有任务就显示）, 块头为 `Daemon 开/关 · running/total`（带上「开/关」文字）; ② daemon 未打开（`enabled === false`）时块仍显示, 占状态列版面; ③ `TUI/src/app/runtime/wiring.ts:253-278` 仅在 `list()` 非空时产出 `next.daemon` 快照, 快照已含 `enabled` 字段。
  - 期望: ① 状态列 Daemon 块只在 daemon **打开**时显示（`enabled === true` 且 `items.length > 0`）, 关闭时整块不出现; ② 块头去掉「开/关」文字, 只保留 `Daemon · running/total`（开/关语义转移到标题栏）; ③ 标题栏左侧符号区（`TUI/src/app/layout/title-bar.ts` 的 `titleBarSegments`）新增一个 daemon 开关符号, **一个符号**表达开/关两态——完全参照既有 `flowTrack` 开关先例（`TITLE_ICON.flowTrack` + `StatusSwitches.flowTrack?` 字段: on 绿 / off 灰, 服务未读到 `undefined` 时整项省略不常灰）。
  - 接取时裁定: ① daemon 符号在标题栏符号组内的位置（建议与 `flowTrack` 相邻, 同为开关类, 放 `flowTrack` 之后）; ② daemon 关闭且有任务是「关闭就不显示块」还是「有任务仍显示块但去掉开/关文字」（建议按用户原话「没有打开则不必显示」: 关闭即整块隐藏）。
  - 改动位置: `TUI/src/app/layout/title-bar.ts`（`TITLE_ICON` 加 daemon 项、`StatusSwitches` 加 `daemon?` 字段、渲染与让位逻辑）、`TUI/src/app/runtime/wiring.ts`（把 `daemon.enabled` 透给标题栏; 状态列快照按 `enabled` 过滤）、`TUI/src/app/components/StatusColumn.ts:365-382`（显示条件加 `enabled`、块头去「开/关」）、相关类型 `TUI/src/app/state/types.ts` / `app-deps.ts`、配套帧测试。
  - 验收: daemon 关闭: 状态列无 Daemon 块, 标题栏 daemon 符号常灰; daemon 打开且有任务: 块头 `Daemon · running/total`（无开/关文字）, 标题栏符号绿; 服务缺失: 标题栏不出现 daemon 符号; 窄宽让位与既有符号组一致; 全量 `pnpm run check` / `test:tui` / `demo -- --smoke` / `check:docs` 全绿。
  - 来源: 2026-11-08 用户提出（「状态列中 daemon 如果没有打开则不必显示; daemon 的打开和关闭状态用一个符号表示, 位置放在标题栏左侧的符号区; 状态列的 Daemon 部分不需要显示开/关」）; 状态: 进行中; 优先级: 中。

- **回合区输出时状态行上边框左段缺横线(增量渲染残留, 待定案)** 〔暂停〕

  - 现象 / 现状: 回合区流式输出 / 快速滚动时, 状态行上边框行左端一段横线消失变空白, 右段横线完好; 缺口固定在该行(不随任何内容滚动), 按 Ctrl+L 全帧重绘恢复; 上下排列与左右排列、不同终端宽度均出现过, 隐藏状态列(Ctrl+S)时最易观察。视觉上更像该段横线被**覆写为空白**(替换/被清掉), 而非内容行溢出后的折行产物。已排除: 内容行超宽折行(观察内容范围正常、缺口为空白而非折入的字符), 布局层每帧生成错误(Ctrl+L 后显示正确, 而布局纯函数无状态 → 每帧都正确)。疑似范围: 增量渲染只重写变化行(`renderer/index.ts` `changedRuns` / `sameRow`, 行 544-556); 状态行上边框行 = status 段首行、紧邻回合区末行, 内容"未变"故不进变化区间; 某一次写入(疑似上段末行写入后定位失效 / 定位被吞, 使写入起点落在该行左段某列, 或该行被上一行写操作波及)把它左段覆写 / 清空后, 该行不再重写 → 残留。取证: `TUI_FRAME_DUMP` 复现回放 stdout 字节可定案(用户暂无复现时机)。
  - 期望: 状态行上边框(及所有"被上一段写操作波及的固定边框行")不再残留缺口; 任意增量场景下画面都能自愈到与全帧重绘一致。
  - 疑似范围 / 接取时裁定: 主嫌疑在渲染层增量区间(`changedIntervals` / `renderRanges`)。**备案方案(防御性)**: `changedIntervals` 任一段有变化行时, 强制把它后一相邻段的首行也加入重写区间(回合区变 → 状态行上边框行也重写; 状态行变 → 输入区首行也重写), 每帧只多写 1 至 2 行、不改视觉。该方案不依赖字节级根因定案, 可先落地止住残留; 根因(定位失效 vs 覆写来源)留待 `TUI_FRAME_DUMP` 复核。
  - 改动位置: 待定(预计 `TUI/src/renderer/index.ts` 的 `changedIntervals` / 或增加渲染层边界行强制重写; 涉及配套帧测试)。
  - 验收: 复现场景(横向 + 隐藏状态列 + 回合区快速滚动)不再现缺口; 全量 `pnpm run check` / `test:tui` / `demo -- --smoke` / `check:docs` 全绿; 若做各项修改, 帧基线按需复核。
  - 来源: 2026-11-05 用户报告（「回合区输出时状态行上边框左边横线缺失, C-l 重绘恢复」）; 状态: 暂停（2026-11-08 用户裁定「6 是暂停, 记录到文档」; 恢复条件: 拿到 `TUI_FRAME_DUMP` 复现帧或用户指定按备案防御方案先落地）; 优先级: 中。
