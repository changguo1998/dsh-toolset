# TUI 待办与开放项

> 职责：TUI 包的**未完成**待办（TUI 的变更优先写在本目录）；跨包待办见 `docs/BACKLOG.md`，TUI 现状见 `TUI/docs/STATUS.md`
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用（追踪文档按条目标题引用，见 `docs/WORKFLOW-STANDARD.md` §6/§7）；**每次整理时按当前顺序从 1 起重新编号**（故 `TUI/src`、`TUI/tests` 注释中的 `TUI#n` 仅作历史线索）；本文件的 `#n` 与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 本文件只列未完成项；已完成项见 git 历史与 `TUI/docs/archived/`，不在此重复。
> 组织：按主题分组（组内按编号）；条目统一结构——现象 / 现状 → 期望 →（可选）复现 / 疑似范围 / 接取时裁定 → 落点 → 验收 → 来源·状态·优先级。

## 待办

> 临时分组（2026-10-01 收尾整理后：已完成条目已清理，余项按当前顺序从 1 起重编）：
> ① 内容归属 #1　② 结构与行为 #2　③ 暂停 / 待取证 #3。

### ① 内容归属

> 决定哪些正文进历史区 / 面板来源段取哪一段（与解析口径相关）

#### 历史区内容

- **待办** **#1 正文被思考/工具行打断时只有最后一段进历史区，前段被丢**：
  - **现象**：一条回复的正文若被思考行（或工具 / notice 行）打断成多段，**只有最后一段**进历史区；前面的正文段先留在活动区，下一次用户输入触发 `turn-begin(clearActivity=true)` 时被整类清除 → 永久丢失。真机实例（2026-10-01）：回复首行 `## 机制本体…` 之后出现一句思考 `Let me write it.`，该首行此后再未出现在历史区。
  - **现状**：`state.ts:1075-1095` 的 `markFinalSummary`（`turn-end` 调用）只把「本回合最后一段连续 assistant 行」标 `final: true`；`state.ts:1136-1149` 的 `appendTurnSeparator(clearActivity=true)` 会 `filter` 掉 `thinking` / `tool` / `notice` / **非 final 的 assistant** 行；`build-box.ts:298` 按 `line.final` 分流两个 pane。三者叠加即「前段正文永久消失」。与 `state.ts:835` 的既定口径（思考 / 正文分属活动区与历史区两个窗口 = 正文应进历史区）不一致。
  - **期望（用户 2026-10-01 两次裁定后的最终口径）**：历史区只放**最后的总结与正式回复**；工具调用前后的简短说明不进历史。**分块边界 = `[step 变化 | 工具调用行]`**（thinking / notice / 空行**不**切割），**取最近一块的正文**移入历史区（整块全部行，不再受「≤6 行」或「连续段」限制）；更早的块留在活动区（下回合随活动区清空）。因 thinking 不再是边界，原「被思考打断即丢前段」的问题自然消失。
    - **实现含义**：buffer 行需带 step 标（append 时取当前 `state.stepGroup.step`，`step/start` 已在维护）；`markFinalSummary` 改为「按 `[step 变化 | 工具调用行]` 切块 → 取最近一块的全部 assistant 行标 `final`」（比"末步"更准：同一步内工具调用之后的正文会切成新块）。
    - **边界**：① 最近一块只有宿主补发的 `"\n\n"` 空锚点时无内容可移（正常）；② 正式回复若跨两个 step（中途夹工具调用），只有最后一块进历史（用户已认可）。
  - **同源问题（2026-10-01 并入本条，同日按同一口径定稿）**：问答面板顶部「提问前正文」来源段（`state.ts:3115-3133` `recentQuestionSource`，面板见 `components/QuestionPrompt.ts`）——改为**同一分块口径**：按 `[step 变化 | 工具调用行]` 切块，**取最近一块的正文**（不限 6 行、thinking / notice 不切割）；本回合取不到时**按回退链**取「上一回合的最近一块」（**先回退、不加相关性闸门**，用户 2026-10-01 裁定）；显示时加 **`- 上文 -` 标记**（与题干之间保留空行分隔）；**行数与滚动沿用现有实现，不改**（来源段仍进描述窗 `descRows` 顶部，受既有 `descMaxRows` 分配与 `descScroll` ↑/↓ 滚动约束）。
  - **落点**：`TUI/src/app/state.ts`（`BufferLine` 补 step 标、`appendStream` 落 step、新增分块函数供 `markFinalSummary` 与 `recentQuestionSource` 共用、`appendTurnSeparator` 的过滤集保持＝非 final 正文仍随回合开始清掉）、`TUI/src/app/layout/build-box.ts:298`（`line.final` 分流不变）、`TUI/src/app/components/QuestionPrompt.ts`（仅加 `- 上文 -` 标记；行数与滚动不改）。
  - **验收**：真机——① 一段被 reasoning 打断的正式回复，历史区含**完整**正文（不再只剩尾段）；② 工具调用之前的说明句不进历史、工具调用之后的正文块进历史；③ `"\n\n"` 空锚点不产出空行；④ 再发一条消息后正文仍完整留在历史区；⑤ 面板来源段取到最近一块全文并带 `- 上文 -`，长来源段的滚动表现与现状一致；本回合无正文时按回退链取上一回合的最近一块；真没有则整段不显示。单测补分块函数（step 变化切 / 工具行切 / thinking-notice 不切）、`markFinalSummary` 与 `recentQuestionSource` 的最近块用例与回退链用例。
  - **来源·状态·优先级**：用户 2026-10-01 真机报告（「机制本体那一行没被加到历史区，后面还有一句思考内容」）。**未接取**。优先级 P2，工作量约 1 h。

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

### ③ 暂停 / 待取证

> 需拍屏或第二客户端取证，暂不接取

#### 问答面板

- **待办** **#3 问答面板上下移动选中时首项上方被复制出一行（排版残留）**：
  - **现象**：退出确认面板（3 项：取消 / 退出 dsh / 重启 dsh（保留会话））用上下键移动选中项时，第一个选项上方多出一行（内容与首项相同），面板排版错位、告警残留可见。
  - **复现**：`fffdsh` 启动 → Ctrl+D 弹出面板 → 上下键移动数次。**tmux 中同样复现**（2026-10-01 用户补充，不限于 herdr 客户端）。
  - **疑似范围**：`TUI/src/app/components/QuestionPrompt.ts` 的选项窗 / 描述窗排版在选中项变化时行数或滚动上界变化，与渲染层「逐行变化游程」部分重绘的交互（该行未落入变化游程，或面板整体高度变化时的行位移未被清除）。tmux 亦可复现 → **herdr 客户端渲染层可排除**，优先按本 TUI 的部分重绘 / 面板高度变化路径排查。
  - **待查**：2 项面板（无重启项）是否同样复现——即是否为「退出确认 · 重启」第三项引入后才暴露的既有缺陷。
  - **验收**：上下键反复移动（含首尾循环、窗口滚动到底）不产生重复行与残留；补渲染帧用例（断言面板区域首项唯一、总行数稳定）。
  - **来源·状态·优先级**：「退出确认 · 重启 dsh」项真机验证发现（2026-09-30）。**暂停**（2026-09-30 晚用户裁定再次搁置：pane 侧 1600+ 帧全干净，现象收窄到 herdr 客户端渲染层；恢复需拍屏证据或第二客户端录制）。**2026-10-01 补充**：tmux 中同样复现 → 该搁置理由（收窄到 herdr 客户端层）不再成立，恢复时先按 TUI 侧部分重绘路径查。取证与续查按追踪文档 `TUI/docs/implementation/2026-09-30-question-panel-residue.md`。优先级 P2。
