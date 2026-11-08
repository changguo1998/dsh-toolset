# security-guard 宿主工具面清单过期同步（接取条目：docs/BACKLOG.md「security-guard 宿主工具面清单过期同步」）

状态：已完成　　开启：2026-11-08　　关闭：2026-11-08
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. 按 rc.1 实际安装树重跑 `scripts/tool-surface-check.mjs`, 用新输出核对登记表。
2. 更新 `security-guard/README.md` 的「已知多报 / 覆盖边界」清单：`schedule_*` 改名（`schedule_update` → `schedule_edit` 等）、`list_agents` 并入 `dsh-tool-subagent-control`（`list-agents` 行移除）、工具执行器拆分（`tool-executor-native` / `tool-executor-ptc`）。
3. 有漏拦则补登记（可与「apply_patch 写面覆盖」条目一并处理, 同涉 security-guard 登记表与 README）。

## 决策（2026-11-08 用户批准）

| 编号 | 决策项 | 结论 |
| --- | --- | --- |
| 1 | 扫描口径 | 维持「安装树」口径, README 写明含未挂载包 |
| 2 | 数字与清单 | 全量按本次输出重写（34 包 / 62 工具 / 需关注 13 / 未解析 5 / 零工具包 4） |
| 3 | `terminal_send` 的 `text` | 记多报, 注「包未挂载, 挂载时须登记命令面」 |
| 4 | `terminal_open` 的 `cwd` | 记多报, 注「挂载时须登记路径面」 |
| 5 | `str_replace_editor` | 记多报, 注「挂载时只登记 `path`, `command` 不进命令层」 |
| 6 | 其余 9 项 | 逐条写进「已知多报」表并给判定理由 |

## 计划改动文件清单

- `security-guard/README.md`（「覆盖边界」段 + 「已知多报」段改为表格; 旧数字与 `schedule_update` 清除）
- `docs/implementation/2026-11-08-security-guard-tool-surface-sync.md`（本文件）
- `docs/BACKLOG.md`（条目关闭并重排编号）

## 实现记录

1. 在 rc.1 安装树上重跑 `node security-guard/scripts/tool-surface-check.mjs --root <dsh 安装树>`, 实测: 34 个含工具定义的包 / 62 个工具 / 已覆盖 9（含新登记的 `apply_patch`）/ 需关注 13 / 名称未解析 5 / 零工具包 4, `exit 1`。
2. `security-guard/README.md`「覆盖边界」改为 2026-11-08 复核口径: 写明「扫安装树而非 profile 挂载组合」, 换上新数字, 并点名三个未挂载包（`dsh-tool-terminal` / `dsh-tool-session-query` / `dsh-tool-str-replace-editor`）。
3. 「已知多报」由两段散文改为**逐项表格**（10 行覆盖 13 项）: 每行给包名、脚本报的键、真实语义、判定。清掉已不存在的 `schedule_update`。
4. 逐项语义核实来源（宿主源码）:
   - `dsh-tool-schedule/lib/index.js:27-39`（`TARGET_SCHEMA`）→ `target` 是投递目标对象;
   - `dsh-tool-session-query/lib/index.js:984-1009` → 参数是 `...targetSessionParameter` + 整数;
   - `dsh-tool-terminal/lib/index.js:277-341` → `terminal_open` 的 `cwd`、`terminal_send` 的 `sessionId` / `text` / `submit` / 条件 `run_in_background`;
   - `dsh-tool-executor-ptc/lib/index.js:1,319` → 工具名常量即 `run_code`;
   - `dsh-tool-subagent/lib/index.js:374-383` → `cwd` 是子代理初始工作目录。
5. 未改登记表源码: 三个「挂载时须登记」的候选都属未挂载包, 现在登记只增误报面, 故按决策只落文档义务。

## 验证

- 差异检查脚本在 rc.1 树上跑通, 输出与 README 新清单逐项对齐（13 项 = 表格 10 行）。
- `pnpm run check:docs`: 错误 0 / 警告 0。
- README 旧值现已无残留: `grep "27 包|49 工具|schedule_update" security-guard/README.md` 无命中。

## 未覆盖

- 未改 `scripts/tool-surface-check.mjs` 的扫描口径（决策 1 选 A）, 因此它仍会列出未挂载包的「需关注」项。
- 三个未挂载包的登记义务只写在 README, 没有对应代码改动 —— 挂载时须按表登记, 否则是静默缺口。
