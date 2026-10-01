# TUI 待办与开放项

> 职责：TUI 包的**未完成**待办（TUI 的变更优先写在本目录）；跨包待办见 `docs/BACKLOG.md`，TUI 现状见 `TUI/docs/STATUS.md`
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用（追踪文档按条目标题引用，见 `docs/WORKFLOW-STANDARD.md` §6/§7）；**每次整理时按当前顺序从 1 起重新编号**（故 `TUI/src`、`TUI/tests` 注释中的 `TUI#n` 仅作历史线索）；本文件的 `#n` 与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 本文件只列未完成项；已完成项见 git 历史与 `TUI/docs/archived/`，不在此重复。
> 组织：按主题分组（组内按编号）；条目统一结构——现象 / 现状 → 期望 →（可选）复现 / 疑似范围 / 接取时裁定 → 落点 → 验收 → 来源·状态·优先级。

## 待办

> 临时分组（2026-10-01 收尾整理后：已完成条目已清理，余项按当前顺序从 1 起重编）：
> ② 结构与行为 #7、#8　③ 渲染与排版 #6　④ 暂停 / 待取证 #3。

### ② 结构与行为

> 改数据产生方式、投递通道或快捷键

#### 命令命名

- **待办** **#7 `/verbose` 更名为 `/collapse`（活动区详略两态命令改名）**：
  - **现状**：活动区详略两态命令是 `/verbose on|off`（缺省 on；off = 紧凑模式，每条目压 1 行 + 行尾 `…`）。旧名散布在：命令表 `commands.ts`（`name: "verbose"` / `route: "verbose"` + 命令联合类型）、分发与文案 `index.ts`（`case "verbose"` → `handleVerboseCommand`、`usage: /verbose on|off`、结果提示、`/help` 条目 `cmd: "/verbose on|off"`）、文档（`README.md`、`DESIGN.md`、`SPEC.md` §6.8 / §15.5.1、`COMMANDS.md`、`docs/design/NOTICE-LEVELS.md`）与测试（`app.test.ts`、`activity-verbose.test.ts`、`help.test.ts`）。
  - **期望（用户 2026-10-01 指令）**：命令更名为 **`/collapse`**，语义与参数不变（`on|off`；缺省 on；off = 紧凑）；内部状态字段（`activityVerbose` / action `activity-verbose`）与 `tui-state.json` 快照键**不动**（跨会话快照与恢复路径兼容）。
  - **旧名归属**：`/verbose` **不删除**——改指**活动区输出内容过滤**（`think` / `tool` / `step` 三档，见 **#8**）；本条只负责把「活动区详略」改名为 `/collapse`，旧名保留占位、**不**归为未知命令。
  - **落点**：`TUI/src/app/commands.ts`（name / route / 联合类型）、`TUI/src/app/index.ts`（分发 case、`handleVerboseCommand` 与用法/结果文案、`/help` 条目）、文档同步（`TUI/README.md`、`TUI/docs/DESIGN.md`、`TUI/docs/SPEC.md`、`TUI/docs/COMMANDS.md`、`TUI/docs/design/NOTICE-LEVELS.md`；`TUI/docs/STATUS.md` 由用户择时更新、流程内不改）、测试同步（`TUI/tests/{app,activity-verbose,help}.test.ts`）。
  - **验收**：真机——① `/collapse off` 进紧凑、`/collapse on` 回完整，无参 / 非法参数只提示用法且不动状态；② `/help` 与命令补全只列新名；③ 会话状态快照仍按原键读写（切会话 / 重启后详略状态恢复正常）；④ 旧名 `/verbose` 按「待定」口径处理（暂不报未知命令），新功能定义补入后一并核对。单测：命令分发与用法文案断言改名、既有详略两态用例回归。
  - **来源·状态·优先级**：用户 2026-10-01 指令（「现有的 `/verbose` 命令改成 `/collapse` 命令」；旧名新用途见下一条说明）。**未接取**。优先级 P2，工作量约 0.5 h。

#### 输出内容档位

- **待办** **#8 `/verbose` 改为活动区输出内容过滤：`think` / `tool` / `step` 三档**：
  - **现状**：活动区**按时间顺序混合显示**全部过程行（thinking / 工具调用与结果 / notice / 非 final 正文 / step 头 / shell / subagent 等，见 `layout.ts` 活动区构建与 `build-box.ts` 各分支），没有任何「按内容类型过滤」的开关；`/verbose` 现名仍指详略两态（改名见 #7）。
  - **期望（用户 2026-10-01 指令 + 三问三答裁定）**：① `/verbose think` = **思考过程 + 正文 + 工具调用**（调用行 / 参数摘要 / 结果行 / 辅助行全显示，即现状全量）；② `/verbose tool` = **正文 + 工具调用**（同上，**去掉思考行**）；③ `/verbose step` = **正文 + 工具调用的第一行**（**去掉**参数摘要 / 结果行 / 辅助行）；④ 作用范围**只活动区**（历史区始终只显示最终正文，不变）；⑤ **缺省档 = `think`**；无参 / 非法参数只提示用法 + 当前档位、不动状态（沿用现有口径）；⑥ 档位随会话状态快照持久化（沿用 `tui-state.json` 口径）。
  - **与 `/collapse` 的关系**：正交（`/collapse` = 每条目是否压成 1 行；`/verbose` = 显示哪些内容类型），可叠加；实现时确认叠加表现（如 `step` 档 + 紧凑）。
  - **实现细则（建议口径）**：`state.ts` 的 `activityVerbose: boolean` 现表示紧凑开关 → 语义归 `/collapse`（键建议改名为 `collapse` 并兼容读旧键 `verbose`）；新 `/verbose` 档位另开字段（如 `activityVerbose: "think" | "tool" | "step"`），旧布尔快照按「`true`→`think`、`false`→`think` + 紧凑」迁移。
  - **落点**：`TUI/src/app/commands.ts`（参数面）、`TUI/src/app/index.ts`（分发 `verbose think|tool|step`、用法/结果文案、`/help` 条目）、`TUI/src/app/state.ts`（新档位字段 + action + 快照读写与迁移）、`TUI/src/app/layout.ts`（活动区构建按档位过滤行类型）、`TUI/src/app/layout/build-box.ts`（`step` 档「工具调用首行」裁剪）、文档（`TUI/README.md`、`TUI/docs/DESIGN.md`、`TUI/docs/SPEC.md` §6.8 / §15.5.1、`TUI/docs/COMMANDS.md`、`TUI/docs/design/NOTICE-LEVELS.md`）、测试（`TUI/tests/{app,activity-verbose,help,session-ui-state}.test.ts`）。
  - **验收**：真机——① 三档切换后活动区分别是「思考 + 正文 + 全部工具行」「正文 + 全部工具行」「正文 + 工具调用首行」；② 历史区不受影响；③ 无参 / 非法参数只提示用法与当前档位；④ 快照兼容（旧布尔值可读、切会话 / 重启后档位恢复）；⑤ 与 `/collapse` 叠加无异常。单测：三档过滤矩阵（思考行 / 工具参数 / 结果行 / 辅助行的取舍）、快照迁移、命令分发与用法文案。
  - **来源·状态·优先级**：用户 2026-10-01 指令（「verbose 命令改为控制输出内容。/verbose think 输出思考过程，正文和工具调用，/verbose tool 输出正文和工具调用，/verbose step 输出正文和\<工具调用的第一行>」）。**未接取**。优先级 P2，工作量约 1.5 h。

### ③ 渲染与排版

> 活动区 / 历史区的行间距与分组显示

#### 表格

- **待办** **#6 历史区表格不截断：格内不再出现 `…`**：
  - **现状**：表格构建期算列宽（`table.ts` `fitCols`）：自然宽放得下 → 原样；放不下 → 水位线压缩列宽、格内文字**折行**（表格变高）；**连最小列宽（`minColWidth = max(3, ⌈自然宽/4⌉)`）也放不下** → 走 `truncate` 分支做**格内省略号截断**（`table.ts:297-299`，被截掉的内容**丢失**）。这个分支并不罕见：例 5 列、各列自然宽 ~40 → minW 10 → 可用宽 < ~50 即触发（常见终端宽度下的宽表格）。
  - **期望（用户 2026-10-01 裁定）**：**格内不截断、不出现 `…`**（内容不得被丢弃）；该分支的展现形态用户明确「不用管这种情况」→ 按既有兜底处理、不新增形态。
  - **落点**：`TUI/src/app/layout/table.ts`（`fitCols` 去掉 `truncate` 路径：`minSum > avail` 时让 `tableBox` 返回 null，沿用「过窄退回普通文本行渲染」的既有降级；随之清理 `cellLeaf` / `rowBox` 的 `truncate` 参数与 `truncateSegs` 的使用）、`TUI/src/app/layout/build-box.ts:471-498`（调用点降级分支不变，仅触发条件放宽）、`TUI/docs/SPEC.md` §3.2 / §15.6（minW 策略与截断口径同步改写）。
  - **验收**：真机——① 宽 / 窄终端的多列表格均**不再出现 `…`**；② 原先被截掉的内容在降级形态（普通文本行）下完整可读；③ 放得下时表格形态与现状一致（自然宽 / 水位线压缩两条路径无回归）；④ 活动区（非 final、有独立宽度预算）同样不截断。单测：`fitCols` 三分支（放得下 / 水位线压缩 / minW 放不下 → 不再 truncate）、`tableBox` 过窄返回 null、既有表格渲染用例回归。
  - **来源·状态·优先级**：用户 2026-10-01 指令（「历史区表格内容不折叠」，追问确认为「格内不截断、不出现 `…`」）。**未接取**。优先级 P2，工作量约 0.5 h。

### ④ 暂停 / 待取证

> 需拍屏或第二客户端取证，暂不接取

#### 问答面板

- **待办** **#3 问答面板上下移动选中时首项上方被复制出一行（排版残留）**：
  - **现象**：退出确认面板（3 项：取消 / 退出 dsh / 重启 dsh（保留会话））用上下键移动选中项时，第一个选项上方多出一行（内容与首项相同），面板排版错位、告警残留可见。
  - **复现**：`fffdsh` 启动 → Ctrl+D 弹出面板 → 上下键移动数次。**tmux 中同样复现**（2026-10-01 用户补充，不限于 herdr 客户端）。
  - **疑似范围**：`TUI/src/app/components/QuestionPrompt.ts` 的选项窗 / 描述窗排版在选中项变化时行数或滚动上界变化，与渲染层「逐行变化游程」部分重绘的交互（该行未落入变化游程，或面板整体高度变化时的行位移未被清除）。tmux 亦可复现 → **herdr 客户端渲染层可排除**，优先按本 TUI 的部分重绘 / 面板高度变化路径排查。
  - **待查**：2 项面板（无重启项）是否同样复现——即是否为「退出确认 · 重启」第三项引入后才暴露的既有缺陷。
  - **验收**：上下键反复移动（含首尾循环、窗口滚动到底）不产生重复行与残留；补渲染帧用例（断言面板区域首项唯一、总行数稳定）。
  - **来源·状态·优先级**：「退出确认 · 重启 dsh」项真机验证发现（2026-09-30）。**暂停**（2026-09-30 晚用户裁定再次搁置：pane 侧 1600+ 帧全干净，现象收窄到 herdr 客户端渲染层；恢复需拍屏证据或第二客户端录制）。**2026-10-01 补充**：tmux 中同样复现 → 该搁置理由（收窄到 herdr 客户端层）不再成立，恢复时先按 TUI 侧部分重绘路径查。取证与续查按追踪文档 `TUI/docs/implementation/2026-09-30-question-panel-residue.md`。优先级 P2。
