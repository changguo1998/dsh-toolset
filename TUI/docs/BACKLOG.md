# TUI 待办与开放项

> 职责：TUI 包的**未完成**待办（TUI 的变更优先写在本目录）；跨包待办见 `docs/BACKLOG.md`，TUI 现状见 `TUI/docs/STATUS.md`
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用（追踪文档按条目标题引用，见 `docs/WORKFLOW-STANDARD.md` §6/§7）；**每次整理时按当前顺序从 1 起重新编号**（故 `TUI/src`、`TUI/tests` 注释中的 `TUI#n` 仅作历史线索）；本文件的 `#n` 与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 本文件只列未完成项；已完成项见 git 历史与 `TUI/docs/archived/`，不在此重复。
> 组织：按主题分组（组内按编号）；条目统一结构——现象 / 现状 → 期望 →（可选）复现 / 疑似范围 / 接取时裁定 → 落点 → 验收 → 来源·状态·优先级。

## 待办

> 临时分组（2026-10-01 收尾整理后：已完成条目已清理，余项按当前顺序从 1 起重编）：
> ② 结构与行为 #2、#4、#7、#8　③ 渲染与排版 #5、#6　④ 暂停 / 待取证 #3。

### ② 结构与行为

> 改数据产生方式、投递通道或快捷键

#### 启动自检 kickoff

- **待办** **#2 启动自检 kickoff 的发送通道由 `followup` 改为 `steer`**：
  - **现状**：三种场景——启动新会话、启动恢复会话（`-c` / `--resume`）、`/new` 补发——都汇到 `App.submitBootstrapKickoff()` → `adapter.sendBootstrapKickoff()` → `activeAgent.followup(...)`（`TUI/src/app/adapter/dsh.ts:2531`），即 **next-turn 队列 + 唤醒**：kickoff 要等一个**新回合**才被领取；启动竞态下若已有回合在跑，还要排到当前回合之后。
  - **期望**：kickoff 改走 `steer`（next-step 队列 + 唤醒，投递到最近 step 边界——当前回合的下一步；会话空闲时立刻起回合），与「尽快驱动模型发起首个工具调用完成解锁」的意图一致；宿主无 `steer`（旧宿主）时回退 `followup`（降级不丢，日志可见）。
  - **落点**：`TUI/src/app/adapter/dsh.ts` 的 `sendBootstrapKickoff()`（口径可复用 `canSteer()`：优先原始宿主 agent、回退 `followup`）；必要时 `TUI/src/main.ts:455-465` 的瘦 `agentLike` 补 `steer` 转发；`TUI/src/app/adapter/types.ts:337` 契约注释同步。App 侧回显（`user-line`）与门控（`shouldAutoKickoff` / `kickoffForNewSession`）不变。
  - **范围**：仅启动自检 kickoff 这一条链；`/init` 是用户命令、走普通输入通道，不在本条。
  - **验收**：三种场景真机核对——会话记录里 kickoff 走 next-step 队列（`agent/inbox/spliced{target:"next-step"}`）且在当前回合内被领取（空闲时立刻起回合）；无 `steer` 的宿主上仍能发出（回退 `followup`）；适配器单测断言调用 `steer` 并覆盖回退分支。
  - **来源·状态·优先级**：用户 2026-10-01 指令（「不同场景下的 kickoff 全部改成 steer」）。**未接取**。优先级 P2，工作量约 0.5 h。

#### steering 排队输入

- **待办** **#4 steer 排队项认领进历史时：与上一条输入之间空一行，且上一条输入的状态符号永久改为 `←`**：
  - **现状**：`<`（steer）模式在 agent 运行中提交 → 文本只进排队块（`state.queued`，kind=`steer`，右缘竖线黄，TUI#43）；核心在 step 边界摘除后走 `queued-claim-steer` → `appendStream(..., "user", …, newLine=true)` 直接落一条用户行（`state.ts:1335-1355`）：① 与上一条用户输入紧邻，看不出是插队送达；② 被插队的那条较早输入仍按常规显示状态符号（运行中 ●/○、终态 ✓/✗/■、无终态 `?`，见 `layout.ts:2359-2407`），不体现「它的回合被 steer 续接」。
  - **期望（用户 2026-10-01 指令 + 三问三答裁定）**：steer 排队项被认领转入历史时——① 该输入与**之前的输入之间空一行**（**仅 steer 适用**；followup 的 `queued-claim` 路径行为不变）；② **之前那条输入的状态符号改为 `←`**（不再显示 ✓/✗/■/●/○/`?`，**回合结束（turn-end）后也不恢复终态**，即永久标记「这条输入被 steer 续接过」）。
  - **落点**：`TUI/src/app/state.ts`（`queued-claim-steer`：落用户行时留白 + 给上一条用户行打「被 steer 续接」标记，`BufferLine` 增字段；注意 `appendStream` 的 P5 空白分片丢弃规则 `state.ts:855-859` 会吞掉紧随异 kind 行的纯空白分片，需走显式字段或绕开）、`TUI/src/app/layout.ts`（`userBlockSymbolResolver` / `USER_BLOCK_SYMBOL` 增 `←` 且优先于终态）、必要时 `TUI/src/app/layout/build-box.ts`（按标记渲染留白）。
  - **验收**：真机——① `<` 模式运行中提交 → 认领后历史区该输入与上一条输入之间空一行；② 上一条输入左侧显示 `←`，turn-end 后仍为 `←`；③ followup 排队项认领不插空行、不改上一条输入符号；④ 会话首条即 steer（无上一条输入）时不留白、不标符号。单测：`queued-claim-steer` 的留白与标记、符号解析优先 `←`、followup 路径无回归。
  - **来源·状态·优先级**：用户 2026-10-01 指令（「用户以 steering 形式输入排队的内容，当成功输入后变为正常历史输入，这条输入与之前的输入之间空一行。之前输入的状态符号改为向左的箭头」）。**未接取**。优先级 P2，工作量约 0.5 h。

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

#### 活动区类型间隔

- **待办** **#5 活动区内「思考 / 正文 / 工具」三类互切时插一个空行**：
  - **现状**：活动区里 thinking 行（`┃` 亮紫前缀）、assistant 过程行（`┃` 亮蓝前缀）、工具 run（step 头 + 工具行）三类**紧排**，类型切换处无分隔（`build-box.ts:255-372` 逐行产叶子、不插类型间隔）；数据层的纯空白分片会被 P5 规则丢弃（`state.ts:862-865`：整段仅空白且上一行异 kind → 丢），故空行只能在**渲染层**插。
  - **期望（用户 2026-10-01 指令 + 两问两答裁定）**：① **只活动区**（历史区不变）；② 仅**思考 / 正文 / 工具**三类之间、相邻两行类型不同时插 **1 行空行**（例：reasoning → assistant）；③ notice / step 头 / shell / 已存在的空行**不算类型边界**（不额外插空行、不改现有紧排）；④ 同类连续多行只在边界插一次。
  - **落点**：`TUI/src/app/layout/build-box.ts`（活动区叶子组装：按 kind 归类为「思考 / 正文 / 工具」并记上一类，切换时插入空行节点；工具行是 run 分组，注意 `flushToolRun` 边界）、`TUI/src/app/layout.ts`（活动区可视行数 / 裁剪上限 / 语义锚点的行数口径需同步核对）；不动 `state.ts` 的 P5 丢弃规则。
  - **验收**：真机——① 一回合内 reasoning → assistant 切换处出现 1 行空行；② assistant ↔ 工具、reasoning ↔ 工具 等互切同样有空行；③ 同类连续（多行思考 / 多段正文）只在边界插一次；④ notice / step 头附近不额外插空行、保持现状；⑤ 活动区高度吃紧（内容超出可视行）时无残留、不被挤爆。单测：构建期空行插入的组合矩阵（三类互切插、同类不插、notice / step / shell 不作边界）。
  - **来源·状态·优先级**：用户 2026-10-01 指令（「回合区消息类型变化，比如 reasoning 和 assistant 之间加一个空行」）。**未接取**。优先级 P2，工作量约 1 h。

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
