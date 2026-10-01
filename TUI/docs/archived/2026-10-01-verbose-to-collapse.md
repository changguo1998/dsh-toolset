# `/verbose` 更名为 `/collapse`（接取条目：`TUI/docs/BACKLOG.md`「`/verbose` 更名为 `/collapse`（活动区详略两态命令改名）」）

状态：已完成　　开启：2026-10-01　　关闭：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

活动区详略两态命令 `/verbose on|off` **更名为 `/collapse on|off`**：语义与参数不变（缺省 `on`；`off` = 紧凑模式：每条目 1 行 + 行尾 `…`）；内部状态字段（`activityVerbose` / action `activity-verbose`）与 `tui-state.json` 快照键**不动**（跨会话快照与恢复路径兼容）。

用户裁定（2026-10-01）：改名；`/verbose` 将改指**输出内容过滤**（三档，见 BACKLOG #8）——故本条**不删除**旧名，只是临时不再响应；#8 落地后 `/verbose` 恢复可用并带新语义。

## 计划改动文件清单

代码：

- `TUI/src/app/commands.ts`：`SlashRoute` 的 `"verbose"` → `"collapse"`；`LOCAL_COMMANDS` 条目改名（name/route/desc）。
- `TUI/src/app/index.ts`：分发 `case "collapse"`；`handleVerboseCommand` → `handleCollapseCommand`（含用法 / 结果文案与 `/help` 条目 `cmd: "/collapse on|off"`）。
- 注释中的命令名随改：`state.ts`、`layout.ts`、`build-box.ts`、`adapter/{dsh,types,session-ui-state}.ts`（均只改 `/verbose` 字样，字段名 `activityVerbose` 不动）。

测试：

- `TUI/tests/app.test.ts`、`TUI/tests/activity-verbose.test.ts`、`TUI/tests/help.test.ts`：命令名与断言随改（`/help` 字母序、补全候选）。
- `TUI/tests/completion.test.ts`：补全候选补 `collapse`（按名称长度 + 字典序落位）。

文档：

- `TUI/README.md`、`TUI/docs/DESIGN.md`、`TUI/docs/SPEC.md`、`TUI/docs/design/NOTICE-LEVELS.md`：命令名 `/verbose` → `/collapse`（仅命令字样；「开关名 verbose」等状态字段表述保留）。
- `TUI/docs/BACKLOG.md`：#7 条目标进行中 + 收尾清理（#8 条目保留，继续接取）。
- 本文件。

## 设计

- **只改命令面**：沿用同一 `SlashRoute`（改名而非新增），路由表、补全、帮助三处自动跟随；App 侧处理器更名以匹配语义，行为零变化。
- **旧名处理**：#7 与 #8 连续实施，故不做「临时别名」（避免一段用完即弃的路由），`/verbose` 在 #8 落地即恢复——已在 #8 的落点里锁定。
- **不动状态字段与快照键**：`activityVerbose`、`action type: "activity-verbose"`、`tui-state.json` 的 `verbose` 键全保持，跨会话恢复不变（#8 才会引入新档位字段）。

## 验证

- `npm run check`（TUI 单包）：通过。
- `npm run test:tui`：**1283 通过 / 0 失败**（改名后修正 3 处既有断言：`/help` 字母序、补全候选、帮助文本）。
- `npm run build`（TUI）：通过（dist 已更新）。
- **真机验证项（待人工确认）**：① `/collapse off` 进紧凑、`/collapse on` 回完整折行；② 无参 / 非法参数只提示用法且不动状态；③ `/help` 与命令补全只列 `/collapse`；④ 会话状态快照仍按原键读写（切会话 / 重启后详略恢复正常）。

## 过程记录

- 采用「命令字样全量替换 + 状态字段不动」的边界：`sed` 只替换带斜杠的 `/verbose` 与处理器名 `handleVerboseCommand`，避免误改 `verbose` 开关名（标题栏图标 / 快照字段等仍是 verbose 语义）。
- 改名牵动 `/help` 字母序（`collapse` 排到 `help` 之前）与补全候选（`/co` 多出一项）→ 两处断言同步更新。
