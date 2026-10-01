# `/verbose` 改为活动区输出内容过滤：think / tool / step 三档（接取条目：`TUI/docs/BACKLOG.md`「`/verbose` 改为活动区输出内容过滤」）

状态：已完成　　开启：2026-10-01　　关闭：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`/verbose` 由「详略两态」改名让位给 `/collapse`（#7）后，改指**活动区输出内容过滤**（只作用于活动区，历史区不变）：

- `/verbose think`（缺省）= 思考 + 正文 + 工具调用（调用行 / 参数 / 结果 / 辅助行全显示）；
- `/verbose tool` = 正文 + 工具调用（**去思考行**）；
- `/verbose step` = 正文 + 工具调用的**第一行**（结果行 / 辅助行整条去掉；调用行只取首个物理行＝去参数续行；**step 头与 notice 保留**）。

用户裁定（2026-10-01，两问两答）：`step` 档＝每个工具调用只留「调用行」（长行仍按窗宽折行、内容不截）；`step` 档**保留** step 分割头与 notice。缺省 `think`；无参 / 非法参数只提示用法与当前档位、不动状态。

## 计划改动文件清单

代码：

- `TUI/src/app/state.ts`：`ActivityLevel` 类型；`activityVerbose: ActivityLevel`（缺省 `"think"`）+ action `activity-verbose{level}`；原「详略」字段更名 `activityCompact`（**极性对齐**：true = 紧凑）与 action `activity-compact{on}`。
- `TUI/src/app/layout/build-box.ts`：`BuildBoxOptions.activityLevel`；thinking 分支按档位跳过；tool 分支 step 档只留调用行首行（`isToolCall` / `isStepHeader` 判据）。
- `TUI/src/app/layout.ts`：`activityCompact: state.activityCompact`（极性修正）、`activityLevel: state.activityVerbose`；标题栏 verbose 图标取 `!state.activityCompact`。
- `TUI/src/app/index.ts`：`handleVerboseLevelCommand` + 分发 `case "verbose"`；`/collapse` 处理器极性改写（on = 紧凑）；快照写两个键；ui-flags 分列 `collapse` / `verbose` 回填；`/help` 增 `/verbose` 行。
- `TUI/src/app/commands.ts`：`SlashRoute` 增 `"verbose"`；`LOCAL_COMMANDS` 增 `/verbose` 条目。
- `TUI/src/app/adapter/{types,session-ui-state,dsh}.ts`：ui-flags 事件与快照字段拆分为 `collapse: boolean`（紧凑）与 `verbose: ActivityLevel`；**旧布尔 `verbose` 读取时迁移**（`collapse = !verbose`）。

测试：

- `TUI/tests/activity-level.test.ts`（新增 6 例）：三档过滤矩阵、step 只取调用行首行、命令切换与用法提示、与 `/collapse` 正交。
- 既有用例按新语义更新：`app.test.ts`（`/collapse` 极性、ui-flags 回填、快照落盘）、`activity-verbose.test.ts`、`title-bar.test.ts`、`session-ui-state.test.ts`（新增迁移用例）、`adapter.dsh.test.ts`、`completion.test.ts`、`help.test.ts`。

文档：

- `TUI/docs/SPEC.md` §15.5（详略两态极性修正 + 新增「输出内容三档」小节）、§6.8 两态说明；`TUI/docs/DESIGN.md` 活动区一句；`TUI/README.md` 命令表（`/collapse` 极性 + 新增 `/verbose` 行）；`TUI/docs/design/NOTICE-LEVELS.md`（usage 与回执文案两行）。
- `TUI/docs/BACKLOG.md`：#8 条目标进行中 + 收尾清理。
- 本文件。

## 设计

- **两条正交轴**：`activityCompact`（每条目是否压 1 行，`/collapse`）× `activityVerbose`（显示哪些内容类型，`/verbose`）。两者都在 `build-box.ts` 构建期生效，互不覆盖（`compute` 各分支独立判断）。
- **极性对齐**：`/collapse on` = 紧凑 → 状态字段 `activityCompact: true`（原 `activityVerbose: boolean` 是「完整显示」语义，改名时一并取反；快照键 `collapse` 同极性）。
- **step 档判据**：`isStepHeader(text)` 保留（时间轴）；`isToolCall(text)` 保留但**只取首个物理行**（`text.split("\n")[0]`，去参数续行）；其余（结果行 / 辅助行）整条跳过。与 #5 的类型间隔兼容：被过滤的行不参与类型判定（不会额外插空行）。
- **快照迁移**：`tui-state.json` 的 `verbose` 键历史上是布尔（详略）→ 读时 `collapse = !verbose`；新值改为档位字符串写在同一个 `verbose` 键上。写盘同时写 `collapse` 与 `verbose`。

## 验证

- `npm run check`（TUI 单包）：通过。
- `npm run test:tui`：**1290 通过 / 0 失败**（新增 6 例；既有 7 例按新语义更新）。
- `npm run build`（TUI）：通过（dist 已更新）。
- **真机验证项（待人工确认）**：① `/verbose think|tool|step` 切换后活动区分别是「思考+正文+全部工具行」「正文+全部工具行」「正文+工具调用首行（含 step 头）」，历史区不受影响；② 无参 / 非法参数只提示用法与当前档位；③ 档位与 `/collapse`（紧凑）叠加正常；④ 旧快照（`verbose: true/false`）能恢复出正确的详略状态、档位回落 `think`；⑤ 切会话 / 重启后档位恢复。

## 过程记录

- 命名冲突处理：`/verbose` 与「详略两态」原本同名，实现时把详略字段改名为 `activityCompact` 并**取反极性**（命令名与字段名同向：`on` = collapse = 紧凑），避免 `activityCollapse: true` 却表示「未折叠」的误导；随之修正标题栏 verbose 图标（取反）、快照键与 5 处测试断言。
- 术语订正：tool / step 档对**调用行自身**的处理以「首个物理行」为准（宿主把参数续行并进同一 buffer 行，用 `\n` + 2 空格缩进表示）；结果行与带状态前缀的辅助行整条去掉。
