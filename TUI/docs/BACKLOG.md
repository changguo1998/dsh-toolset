# TUI 待办与开放项

> 职责：TUI 包的**未完成**待办（TUI 的变更优先写在本目录）；跨包待办见 `docs/BACKLOG.md`，TUI 现状见 `TUI/docs/STATUS.md`
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用（追踪文档按条目标题引用，见 `docs/WORKFLOW-STANDARD.md` §6/§7）；**每次整理时按当前顺序从 1 起重新编号**（故 `TUI/src`、`TUI/tests` 注释中的 `TUI#n` 仅作历史线索）；本文件的 `#n` 与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 本文件只列未完成项；已完成项见 git 历史与 `TUI/docs/archived/`，不在此重复。
> 组织：按主题分组（组内按编号）；条目统一结构——现象 / 现状 → 期望 →（可选）复现 / 疑似范围 / 接取时裁定 → 落点 → 验收 → 来源·状态·优先级。

## 待办

| # | 条目 | 落点 | 工作量 | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | **`npm run demo -- --smoke` 的 `activity-mixed-ordered` 场景恒失败**。现状：该场景把最后一帧按 `\r\n` 切成行（`TUI/demo/main.ts:509-513`），而渲染器自 2026-10-05 起改为**逐行绝对定位**（提交 `647761d`，行间不再输出 `\r\n`）→ 五个子串全部命中第 0 行，`aM > aT` 恒假，实测报错 `SMOKE_FAIL activity-mixed-ordered (idx=0,0,0,0,0,-1)`。已在 HEAD 与 2026-10-06 TUI `/goal` 任务改动后各跑一次，两次均只此一例失败（`SMOKE_FAIL n=1`），属既有缺陷、与命令面无关。期望：帧解析改为按帧内光标定位分段，或复用测试侧的帧解析助手（`TUI/tests/helpers/rowText.ts` 同族）。验收：`npm run demo -- --smoke` 该场景转绿，且 `SMOKE_FAIL n=0`。 | `TUI/demo/main.ts` | 30 min | P3 |

> 来源：2026-10-06 TUI `/goal` 双注册任务收尾时实测（追踪文档 `docs/archived/2026-10-05-tui-goal-command-shadowing.md`，§4「途中发现的新问题」）。
