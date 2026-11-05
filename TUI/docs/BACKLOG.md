# TUI 待办与开放项

> 职责：TUI 包的**未完成**待办（TUI 的变更优先写在本目录）；跨包待办见 `docs/BACKLOG.md`，TUI 现状见 `TUI/docs/STATUS.md`
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用（追踪文档按条目标题引用，见 `docs/WORKFLOW-STANDARD.md` §6/§7）；**每次整理时按当前顺序从 1 起重新编号**（故 `TUI/src`、`TUI/tests` 注释中的 `TUI#n` 仅作历史线索）；本文件的 `#n` 与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 本文件只列未完成项；已完成项见 git 历史与 `TUI/docs/archived/`，不在此重复。
> 组织（2026-10-13 整理起）：**用户手动指定的顺序优先**；否则〔进行中〕条目置顶 → 其余按依赖 → 工作量升序（无前置项在前、同层按工作量升序、同工时缺陷优先于行为改动；有前置项排在各自前置之后；〔暂停〕项沉到表尾）。条目统一结构——现象 / 现状 → 期望 →（可选）复现 / 疑似范围 / 接取时裁定 → 改动位置 → 验收 → 来源·状态·优先级。
> 顺序与并行分组见项目级 `docs/BACKLOG.md` §2「实现顺序与并行分组」（按组串行、组间并行，组内按工作量升序）。
> 写入范围（2026-10-23）：并行任务只写自己的代码 / 测试与**自己的追踪文档**；本文件的状态与关闭注记、`SPEC.md`、`README.md`、`COMMANDS*.md` 由主分支代理统一回写。

## 待办

- **会话区右缘框列去空白占位**〔进行中: 2026-11-05〕
  - 现象 / 现状: 上下排列时会话区右侧多 1 列空白, 回合区没有; 根因是 `grid.ts` 的 `rightEdgeGlyph`: body 行（会话区普通内容行）右缘框列落空白占位 `" "`, activity 行（回合区）落 `null`; 而 `focus-frame.ts:151-161` 的 `emphasize` 只对**既有框线字形**改色, 空白占位非框线 → 会话区聚焦时该列也变不成边框, 占位纯冗余。纵向排列下 `dialogueTextW = activityTextW = contentW`（`geometry.ts:398-399`）, 差异只在外缘框列这一格。
  - 期望: body 行右缘框列改为 `null`（不落字形、不拼该列, 与 activity 行一致）; 聚焦会话区时也不画右缘竖线（右缘无既有框线, `emphasize` 天然 no-op）; 横线行（border）仍铺满 `─` 到最右列（不留缺口）; `FRAME_RIGHT_COLS` 宽度扣除保持不变（区域右缘仍留 1 列, 只是内容行不落占位字形）。
  - 改动位置: `TUI/src/app/layout/grid.ts`（`rightEdgeGlyph` body 分支）, 配套 `TUI/README.md` / `TUI/docs/SPEC.md` / `TUI/docs/DESIGN.md` 口径, `TUI/tests/` 帧断言。
  - 验收: 上下排列时会话区右缘与会话区/回合区对齐、无多余空白列; 聚焦会话区不新增右缘竖线; 横线行满宽; `pnpm run check` / `pnpm run test:tui` 全绿。
  - 来源: 2026-11-05 用户提出（「现在聚焦时右侧也没有边框, 不要这个了」）; 依据 `TUI/src/app/layout/grid.ts` / `focus-frame.ts` / `top-region.ts` / `geometry.ts`。
