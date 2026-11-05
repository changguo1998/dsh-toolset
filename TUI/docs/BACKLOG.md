# TUI 待办与开放项

> 职责：TUI 包的**未完成**待办（TUI 的变更优先写在本目录）；跨包待办见 `docs/BACKLOG.md`，TUI 现状见 `TUI/docs/STATUS.md`
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用（追踪文档按条目标题引用，见 `docs/WORKFLOW-STANDARD.md` §6/§7）；**每次整理时按当前顺序从 1 起重新编号**（故 `TUI/src`、`TUI/tests` 注释中的 `TUI#n` 仅作历史线索）；本文件的 `#n` 与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 本文件只列未完成项；已完成项见 git 历史与 `TUI/docs/archived/`，不在此重复。
> 组织（2026-10-13 整理起）：**用户手动指定的顺序优先**；否则〔进行中〕条目置顶 → 其余按依赖 → 工作量升序（无前置项在前、同层按工作量升序、同工时缺陷优先于行为改动；有前置项排在各自前置之后；〔暂停〕项沉到表尾）。条目统一结构——现象 / 现状 → 期望 →（可选）复现 / 疑似范围 / 接取时裁定 → 改动位置 → 验收 → 来源·状态·优先级。
> 顺序与并行分组见项目级 `docs/BACKLOG.md` §2「实现顺序与并行分组」（按组串行、组间并行，组内按工作量升序）。
> 写入范围（2026-10-23）：并行任务只写自己的代码 / 测试与**自己的追踪文档**；本文件的状态与关闭注记、`SPEC.md`、`README.md`、`COMMANDS*.md` 由主分支代理统一回写。

## 待办

- **区域右缘框列宽度改为 0**〔进行中: 2026-11-05〕
  - 现象 / 现状: 上一轮去掉内容行右缘空白占位后, 会话区 / 回合区内容行右侧仍各留 1 列空白——区域右缘外框列 `FRAME_RIGHT_COLS = 1`（`frame-rows.ts:116`）经 `regionColumnWidth`（`frame-rows.ts:119-122`）扣除, `contentW = historyWidth − 1`, 两个 pane 正文右缘落在屏幕右数第 2 列; 右数第 1 列（外缘框列）只服务横线行（border 补 `─` 满宽）, 内容行不落字形 → 恒空白。
  - 期望: `FRAME_RIGHT_COLS` 改为 0, `contentW = historyWidth`, 会话区 / 回合区内容文字铺到屏幕最右列; 横线行（标题下划线 / 回合区分隔线 / 状态行边框）仍满宽到 `cols`（与 contentW 无关, 不变）; 焦点框矩形右缘本就按 `cols` 算（`frame-build.ts:141-142`）, 不受影响; 窄窗 `rightFrame` 判定（`geometry.ts:419`）改 0 后恒真, 语义不变（现状 1 列时也恒真）。
  - 改动位置: `TUI/src/app/layout/frame-rows.ts`（`FRAME_RIGHT_COLS = 0`）+ 连带重冻帧基线 / 复核窄窗行宽断言（`pane-text-margin` / `ctrl-t-panes` / `layout4` / `grid`）; 文档同步 `TUI/README.md` / `SPEC.md` / `DESIGN.md`。
  - 验收: 两 pane 内容右缘贴屏幕最右列, 右侧无冗余空白; 横线 / 焦点框 / 窄终端（16 / 20 列）不破; `pnpm run check` / `test:tui` / `demo -- --smoke` / `check:docs` 全绿; 帧基线重冻并记录原因。
  - 来源: 2026-11-05 用户提出（「回合区文字右侧也有一列空白, 是否正常」→ 裁定改为 0）; 承接 `8427fb7a`（去内容行右缘占位, 已关闭）。
