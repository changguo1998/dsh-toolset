# 状态列 Agents 块只列运行中 / 存活且无诊断的子代理（接取条目：`TUI/docs/BACKLOG.md`「状态列 Agents 块只列运行中 / 存活且无诊断的子代理」）

状态：关闭　　开启：2026-10-01　　关闭：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

状态列 Agents 块只呈现**当前活跃**的子代理：已结束（`activity: "inactive"`）与全部诊断条目都不显示；`/agents` 面板保持全量（不变）。

## 调研

- 现状（`adapter/dsh.ts#refreshAgents`）：状态列切片现只过滤 `kind === "diagnostic" && reason === "unavailable"`，其余照单全收 → 已结束的一次性子代理（目录不清、`activity: "inactive"`）与其它诊断（corrupt 等）以 `○` / `!` 行滞留（真机 8 条；用户两处指出）。
- 宿主语义（`dsh-subagent` 源码）：条目的 `activity = sessions.get(id) === undefined ? "inactive" : "running"`——即「**会话是否还活着**」；continuable 空闲（仍 live）恒为 `running`，投影 / 已结束恒为 `inactive`。故 `activity === "running"` 正好等于「存活」，无需别的会话判据。
- 两处数据面：同一入口同时喂 `/agents` 面板（`command-panel-data`）与状态列（`agents-changed`）——过滤只加在**状态列切片**，面板保持全量（TUI#56 既定口径）。
- 折叠规则（`layout.ts` 状态列）：超窗时「先隐藏非运行中（L1）」——过滤后行 `status` 恒为 `running`，该分支自然不再命中（不改折叠代码）。
- 枚举失败行（`refreshAgents` 的 catch 分支）不是子代理条目，保留（用户指向的是子代理条目）。

## 决策

1. **过滤判据**：`entry.kind !== "diagnostic" && entry.activity === "running"`——已结束项与**全部**诊断（不再只 `unavailable`）都不进状态列；缺 `activity`（未知）按不显示处理（宽容）。
1. `/agents` 面板与枚举失败行不动；折叠规则代码不动（自然失效即可）。
1. 备选（未选）：给状态列加「只显示 N 条 + 更多提示」等展示层折衷——超出本条（先把不该显示的去掉）。

## 规划

计划改动文件清单（**只改这些**）：

1. `TUI/src/app/adapter/dsh.ts`：`refreshAgents` 状态列切片的过滤与注释更新。
1. `TUI/tests/adapter.dsh.test.ts`：更新既有「状态列过滤 unavailable」断言为新规则（只留存活且无诊断）。
1. `TUI/docs/BACKLOG.md`：条目「完成」标记与收尾清理。
1. 本追踪文档。

明确不做：不改 `/agents` 面板数据；不改折叠规则代码；不动枚举失败行；不改 TUI 其它块。

## 实现记录

1. 2026-10-01 `adapter/dsh.ts#refreshAgents`：状态列切片过滤由「只滤 `unavailable`」改为 `entry.kind !== "diagnostic" && entry.activity === "running"`（注释同步：只保留当前活跃，含 TUI#56 的 unavailable 口径）；`/agents` 面板（`command-panel-data`）与枚举失败行未动。
1. 2026-10-01 `tests/adapter.dsh.test.ts`：更新既有用例——状态列快照由 `["child-1","child-2","child-3"]` 改为 `["child-1"]`（child-2 诊断 / child-4 unavailable / child-3 已结束都不显示），用例名与注释同步。

## 测试与证据

- 单测：`npm run test:tui -- adapter.dsh.test.ts` → 180 pass / 0 fail（含更新用例）。
- 全量：`npm run test:tui` → 1228 pass / 0 fail。
- 机械门禁：`npm run check` exit 0；`npm run build` exit 0。
- 真机确认（2026-10-01，点 3 前）：重启后状态列 Agents 块**只显示存活项**——起 25 秒验证子代理只出现该一条（`● sub-… · bash sleep 25`），结束后从块中消失；此前滞留的已结束 / 诊断行不再出现 → 用户确认「通过」。

## 收尾

- 回写：无需（状态列过滤口径已落在代码注释与本追踪文档；`DESIGN.md` 未描述 Agents 块过滤细节）。
- BACKLOG 清理：TUI 条目「状态列 Agents 块只列运行中 / 存活且无诊断的子代理」已按「完成」（2026-10-01）清理移除（空章节「状态列 Agents」一并清理）。
- 归档：本追踪文档移入 `TUI/docs/archived/`。
- 残留检查：`git status` 无计划外文件；`tmp/` 无任务临时文件。
- 遗留项：无。
