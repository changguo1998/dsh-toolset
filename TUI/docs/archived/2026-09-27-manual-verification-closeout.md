# #16 真机复核项关闭（验证记录，2026-09-27）

状态：关闭　　开启：2026-09-27　　关闭：2026-09-27

本任务只做验证与条目状态记录，不改代码；计划改动文件：`TUI/docs/BACKLOG.md`（#16 状态与计数）、本追踪文档（关闭后归档）。

## 目标

关闭 `TUI/docs/BACKLOG.md` #16（2026-09-27 批次遗留的真机复核四项），记录四项验证结论与证据。

## 复核方式

- ① **#11 模型门控**：读真实会话日志（非隔离环境）判定——`zstdcat ~/.dsh/sessions/<slug>/<id>/session.v4.jsonl.zstd` 提取 `request/header`（reason / tools 数 / model）、`system/message`（长度）与 `developer/message`（tool-addition）。
- ② **#9 `/stats`**：用户真机操作后确认。
- ③ **#4 审批面板标题**：由提权请求触发——当前 sandbox `workspace-write`，对 `echo approval-probe-ok` 发起 `sandbox_permissions: "danger-full-access"` 提权（严格更宽阶梯 `workspace-write → danger-full-access`），经宿主 `approval/request` 进入 TUI 审批面板；用户目视后**拒绝**（命令未执行、无副作用）。
- ④ **#3 缩进观感**：用户目视确认。

## 证据

| 项 | 结论 | 证据 |
| --- | --- | --- |
| ① #11 | 通过 | `tui-c7357599-…`（真实 profile 会话）：`initial tools=2` → `change tools=36` → `resume tools=36`，`system/message` 409 → 2886，`developer/message`（tool-addition）1 条；`tui-a122b99e-…`：`initial tools=2` → `change tools=36`，同前。两阶段锁定-释放（含 resume-safe）在真机完整走通；chat / reasoner 名字已取消、不涉及 |
| ② #9 | 通过 | 用户 2026-09-27 真机确认：四行文案与数值正确，会话切换后「最近一次调用：—」占位符合预期（TUI#12 新行为） |
| ③ #4 | 通过 | 用户 2026-09-27 目视审批面板标题 ` △ 等待审批`（提权请求触发；请求被拒、命令未执行） |
| ④ #3 | 通过 | 用户 2026-09-27 确认历史区交错缩进（`messageGutter` 4）观感无问题 |

## 收尾

- `TUI/docs/BACKLOG.md` #16 标「完成」、计数同步；本文件移入 `TUI/docs/archived/`。
- 不改代码与其它文档；`STATUS.md` 由用户择时更新。
- 提交：至此 2026-09-27 批次（含 #19 / #21 / #16 关闭）验证尽毕，按流程询问用户是否提交。
