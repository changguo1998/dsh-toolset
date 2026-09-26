# 审批交互族 + 提问上下文（BACKLOG: TUI#3.2.4, TUI#3.2.5, TUI#3.2.6, TUI#3.2.10, TUI#3.3.1, TUI#3.3.2, TUI#3.3.3）

状态：关闭　　开启：2026-09-26　　关闭：2026-09-26

本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

一次接取 7 条（用户 2026-09-26 指定「3.2、3.3 一起做，同一追踪文件」）：

- **3.2.4** 审批面板改单选列表（批准 / 拒绝两项，`←/→` 切换标记，`y`/`n` 直答）
- **3.2.5** 拒绝项后显示超时倒计时 `(XXs)`（初始 = `approvalTimeoutMs`，默认 60s，每秒递减）
- **3.2.6** 选项加数字编号，数字键直接标记（单选置唯一 / 多选切换，不提交；含审批选项列表）
- **3.2.10** 提问交互时保留问题前那条非思考正文（题干说明）
- **3.3.1** 审批按键白名单（仅 `y` / `n` / `Esc`，其余无效且提示）；**Esc = 取消审批**（返回 `cancelled`）
- **3.3.2** 审批超时后自动关闭（缺陷：现在超时只 settle，不通知 UI）
- **3.3.3** 审批面板缺工具参数/命令（用 `callId` 关联 `tool/call`，把命令/参数拼进草稿）

## 调研（现状）

- `adapter/normalize.ts` 的 `buildApprovalPrompt` 只输出「允许工具 X 执行?<reason>」→ 草稿恒单行，审批者看不到命令（3.3.3）。
- `adapter/dsh.ts` 的 `tool/call` 归一（约 L1593）emit `{ type: "tool-call", name, summary }`，**未带 callId**；`summarizeToolArguments` 已提供「路径 / 命令 / 查询词」启发式摘要，可复用作草稿明细。
- `adapter/dsh.ts` 的 `approve(id, allow)` → `settle(id, allow ? "allowed-once" : "rejected")`，无 `cancelled` 路径（3.3.1 需要）。
- 超时分支只 `settle(id, "cancelled")`，**不向 UI 发事件**（3.3.2：面板仍开着，用户再按 y 时该 id 已裁定 → 静默失败）。
- `index.ts` 审批分支只认 `y` / `n`，其余按键吞掉（含 `Esc`）；`hints.ts` 的 `APPROVAL_HINT_LINE` 已写 `[Esc]退出`——与实现不一致（3.3.1）。
- 审批面板（`components/ApprovalPrompt.ts`）只有标题 + 描述窗（3.2.1 已支持滚动与滚动条），无选项列表、无倒计时。
- 问答面板选项无编号；`questionKeyDecision` 把数字键在预设选项上吞掉（3.2.6）。
- 问答面板打开时活动区被整体替换，agent 提问前输出的正文在面板期间不可见（3.2.10）。

## 决策

1. **审批选项列表（3.2.4）**：审批面板固定两项「批准 / 拒绝」，标记项放 `state.approvalFocus: "approve" | "reject"`（缺省 `approve`，`←/→` 切换，不循环）；`Enter` 提交标记项；`y`/`n` 直答（等价于选中并提交）。选项行沿用问答面板的形态（编号 + 光标 + 标记 + 文本），并复用 3.2.1 的两窗分配（描述窗（草稿）+ 选项窗（两项））。
1. **倒计时（3.2.5）**：`state.approvalDeadline: number | null`（epoch ms）在审批打开时置为 `Date.now() + approvalTimeoutMs`；渲染时按当前时间算剩余秒数，挂在**拒绝项**行尾 `(XXs)`；每秒重绘复用既有 `statusTicker` 的 tick（无 ticker 时按帧渲染的当前时间计算，不新增定时器）。剩余 ≤ 0 时不显示负数。
1. **数字编号（3.2.6）**：选项行前加编号（宽度按该列表最大编号位数自适应，1 位或 2 位），数字键 `1..9` 直接标记对应项（单选置唯一、多选切换），**不提交**；超出编号范围的数字键吞掉。审批列表同样编号（`1` = 批准、`2` = 拒绝，等价于标记，不直接提交？——**决策：直接提交**，因为审批只有两项且 y/n 已是直答语义；在提示区写明）。
1. **按键白名单（3.3.1）**：审批态只接受 `y` / `n` / `Esc` / `←` / `→` / `Enter`（选项交互）与数字键 `1` / `2`；其余按键吞掉并**在提示区给出「无效键」提示**（复用底部提示区：临时把提示行换成 `[无效键] 仅 y/n/Esc…`），任意有效键后恢复正常文案。`Esc` → `adapter.cancelApproval(id)` → `cancelled`。
1. **超时自动关闭（3.3.2）**：超时与 abort 两条路径都要**向 app 发事件**（`approval` 事件的 `null` 关闭 + 一条 notice「审批已超时取消」），并顺带修正「按 y 时已被裁定」的竞态（settle 后若面板仍在则关闭）。
1. **草稿带参数（3.3.3）**：`tool/call` 归一带上 `callId`；adapter 内维护 `Map<callId, {name, detail}>`（容量上限，审批结束/超时后清理）；`buildApprovalPrompt(req, detail)` 首行保留现文案，detail 存在时追加「工具名 + 命令/参数」多行（命令取 `command` 字段原文，其余取单行摘要）。
1. **提问上下文（3.2.10）**：`question-open` 时从活动区 buffer 取**最近一条 `assistant` / `plain` 正文块**（连续行合并、截断到 ~6 行），存 `state.question.source`；面板渲染时置于描述窗顶部（灰、随描述窗一起滚动，末尾空行与题干分隔）。取不到时（如刚清空）不显示，不报错。

## 规划

计划改动文件清单：

- `src/app/adapter/normalize.ts`（`buildApprovalPrompt` 支持多行明细）
- `src/app/adapter/dsh.ts`（`tool/call` 带 callId + `callId → 明细` 表 + `cancelApproval` + 超时/abort 通知 UI）
- `src/app/adapter/types.ts`（`DshAdapter` 增 `cancelApproval`；`ApprovalRequest` 或事件类型如需扩展）
- `src/app/state.ts`（`approvalFocus` / `approvalDeadline` / `question.source` + reducer/action + 超时关闭 action）
- `src/app/components/ApprovalPrompt.ts`（选项列表 + 倒计时 + 编号 + 草稿多行）
- `src/app/components/QuestionPrompt.ts`（编号 + 来源正文段）
- `src/app/question-transition.ts`（数字键 → 标记）
- `src/app/index.ts`（审批按键白名单 / Esc 取消 / 数字键 / 超时事件与 notice / 无效键提示）
- `src/app/layout/hints.ts`（审批提示文案与无效键提示）
- `tests/`（新增 `tests/approval-panel.test.ts`；更新 `tests/app.test.ts`、`tests/question-*`）
- `tests/fixtures/focus-frame-legacy.json`（基线重跑）
- `docs/SPEC.md` §7.1、`docs/IMPLEMENTATION.md`（审批交互章节）

不做（明确范围）：审批策略/权限预设改动（`/policy` `/permission` 面板保持现状）、问答面板的其它按键调整、`3.5.1` 与 `3.6.1` / `3.7.x`（未接取）。

## 实现记录

- `adapter/types.ts`：`tool-call` 事件加 `callId?`；新增 `approval-closed`（`reason: timeout | abort`）事件；`DshAdapter` 增 `cancelApproval(id)`。
- `adapter/normalize.ts`：新增 `ApprovalDetail`；`buildApprovalPrompt(req, detail?)` 支持多行（首行原文案 + 「命令：」全文 + 「参数：」摘要），无明细退化为单行。
- `adapter/dsh.ts`：`tool/call` 归一登记 `callId → ApprovalDetail`（LRU 上限 64，裁定/超时/abort 后清理）；`approvalAnswerer` 取明细生成草稿；`settle(id, outcome, reason?)` 在宿主侧裁定时发 `approval-closed`；`cancelApproval` 实现。
- `state.ts`：新增 `approvalFocus` / `approvalDeadline` / `approvalHint` 字段与初值、`focusApproval` / `setApprovalHint` 两个纯函数、三个 action 与 reducer 分支；`QuestionPanelState.source`（可选）与 `recentQuestionSource(buffer)`；`question-open` 带 `source`；`question-move.delta` 放宽为 number。
- `components/ApprovalPrompt.ts`：重写为「描述窗 + 选项窗」（2/3 分配规则、滚动条沿用 3.2.8 口径）；选项固定「批准 / 拒绝」带编号与焦点标记（选中行黄）；拒绝项行尾倒计时 `(XXs)`；`ApprovalView`（focus / deadline / now）为渲染参数；`maxApprovalScroll` 上界改按描述窗上限。
- `components/QuestionPrompt.ts`：选项编号（宽度按最大编号位数自适应，续行缩进 = 文本起点 + 2）；描述窗顶部插入来源段（灰、`panel.source`，与题干空行分隔）。
- `question-transition.ts`：新增 `{ kind: "digit"; n }` 决策（数字键 1-9；自定义项上仍按文本）。
- `index.ts`：`approval` 事件带 `deadline`（`APPROVAL_TIMEOUT_MS = 60_000`）；新增 `approval-closed` 处理（关面板 + notice）；审批按键改为白名单（y/1、n/2、Enter、←/→、↑/↓、Esc；其余 → `approval-hint` 无效键提示）；`question-open` 带 `recentQuestionSource`；`handleQuestionKey` 增 `digit` 分支（move + select，不提交）。
- `layout.ts`：审批面板调用传 `{ focus, deadline }`；`layout/hints.ts`：审批提示行更新为白名单口径、审批态优先显示无效键提示、问答提示改 `[空格/1-9]标记`。
- `demo/mockAdapter.ts`：补 `cancelApproval`。
- **计划外文件（已在本文记录）**：`demo/main.ts` 的冒烟场景依赖旧契约（Esc 不关面板 → 随后 `y` 应答），新契约下 `y` 会落入输入框；已改为「Esc 取消 → 重开一条 → y 直答」，并更新提示行断言语、新增「取消回执」断言、选项着色断言改为带编号前缀（` 1.>  生产`）。

## 测试与证据

- 新增 `tests/approval-panel.test.ts`（10 例）：两窗渲染与编号、焦点切换、倒计时（60s/30s/1s/无 deadline/过期）、描述窗 2/3 上限与滚动上界、滚动条贴底、数字键决策（含自定义项文本输入）、标记不改提交语义、白名单与无效键提示清理、`recentQuestionSource`、来源段渲染。
- `tests/adapter.dsh.test.ts` 新增 3 例：草稿带命令全文（callId 关联 + 裁定后清理退化单行）、无 callId 退化单行 + `cancelApproval → cancelled`、超时发 `approval-closed`（timeout）且不重复通知。
- 既有断言按新契约更新：`tool-call` 事件带 `callId`（5 处）、审批 Esc 契约用例重写为「白名单 + Esc 取消」、问答提示 `[空格/1-9]标记`、选项行断言按编号前缀（`1.> `）、折行缩进断言（6 → 8 列）、审批滚动条用例按两窗结构。
- 全量 `node --experimental-transform-types --test tests/*.test.ts`：**1134 pass / 0 fail**（含新增 13 例）。
- `npm run check` / `npm run build` 通过；`npm run demo -- --smoke`：**43 pass / 0 fail**；冻结基线重跑（22 行变化：审批面板选项行 + 问答编号/提示行）。

## 收尾

- 7 条（3.2.4 / 3.2.5 / 3.2.6 / 3.2.10 / 3.3.1 / 3.3.2 / 3.3.3）标「完成」；文档回写 `docs/SPEC.md` §7.1（审批交互族 / 提问上下文 / 数字键直标 / 选项行形态）与 `docs/IMPLEMENTATION.md` 面板章节；本追踪文档归档 `TUI/docs/archived/`。
- 未做：审批策略与权限预设面板不动；`/help`（3.5.1）与 herdr（3.6.1）等未接取条目不在本次范围。
- 人工验收要点：审批面板两项 + 倒计时 + 数字直答 + Esc 取消 + 无效键提示 + 超时自动关闭 + 草稿含命令全文；问答面板编号 + 数字键标记 + 来源正文段。
