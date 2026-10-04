# TUI 待办与开放项

> 职责：TUI 包的**未完成**待办（TUI 的变更优先写在本目录）；跨包待办见 `docs/BACKLOG.md`，TUI 现状见 `TUI/docs/STATUS.md`
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用（追踪文档按条目标题引用，见 `docs/WORKFLOW-STANDARD.md` §6/§7）；**每次整理时按当前顺序从 1 起重新编号**（故 `TUI/src`、`TUI/tests` 注释中的 `TUI#n` 仅作历史线索）；本文件的 `#n` 与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 本文件只列未完成项；已完成项见 git 历史与 `TUI/docs/archived/`，不在此重复。
> 组织：按主题分组（组内按编号）；条目统一结构——现象 / 现状 → 期望 →（可选）复现 / 疑似范围 / 接取时裁定 → 落点 → 验收 → 来源·状态·优先级。

## 待办

### 1. `/collapse` 的命令描述与帮助文案把 on/off 写反

- **现状**：`src/app/commands.ts` 的命令表与 `src/app/index.ts` 的 `/help` 行都写「on=完整折行 / off=紧凑」，而实现与运行时提示是 **on=紧凑（每条目 1 行 + 行尾省略号）/ off=完整折行**（`index.ts` 的 `/collapse` 分支、`activity-compact` reducer；`tests/activity-level.test.ts`、`tests/activity-verbose.test.ts` 按 on=紧凑断言）。
- **期望**：两处文案与实现一致（on=紧凑 / off=完整折行）。
- **落点**：`TUI/src/app/commands.ts`、`TUI/src/app/index.ts`（**用户可见字符串**，属行为面文案，不能当纯注释改）。
- **验收**：`npm --prefix TUI run check` 与相关用例全绿；`/help`、命令补全、运行时提示三处口径一致。
- **来源·状态·优先级**：2026-10-04 文档刷新（TUI 文档域子代理报告）；未接取；P3。
