# 面板分窗滚动 / 声音提醒 / 两条缺陷（BACKLOG: TUI#3.2.1, TUI#3.2.2, TUI#3.2.3, TUI#3.2.7, TUI#3.4.1, TUI#3.4.2, TUI#3.4.3, TUI#3.5.2, TUI#3.5.3）

状态：关闭　　开启：2026-09-26　　关闭：2026-09-26

本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

一次接取三组共 9 条：

- **A 组（面板渲染族）**：3.2.1 统一交互面板的描述区/选项区分窗滚动 + Tab 切焦点；3.2.2 面板首行类型标识；3.2.3 选项与解释分行、标记只在选项首行；3.2.7 面板内「自定义回答」编辑时显示光标。
- **B 组（声音提醒）**：3.4.1 需交互（审批 / 问答面板弹出）时也响铃；3.4.2 一次 run 结束只响一声（去双响）；3.4.3 需交互长时间无操作时每秒响一次直至有操作。
- **C 组（缺陷）**：3.5.2 demo 冒烟 `titlebar-mode-icons` 期望字形码位过期；3.5.3 根 `npm run test:tui` 包装脚本在本机挂住。

## 调研

来源：源码阅读（本仓库 `TUI/src`）、BACKLOG 条目原文、既有归档追踪文档。

### 现状（A 组相关）

- **问答面板**（`src/app/components/QuestionPrompt.ts`）：题干 / detail / 选项 + 自定义兜底项拼成**单一 pool**（`pool` + 平行 `poolColor`），整段共享 `maxBody = height - 1` 的**一个**滚动窗口；窗口起点只看 `item.optionIndex`（`following` 判定），高亮在首项时起点固定 0 → 长题干 / 长 detail 时选项被挤出可视区。
- **审批面板**（`components/ApprovalPrompt.ts`）：`lines.slice(0, maxBody)` **硬截断**，长草稿无法查看。
- **选项行形态**：`wrapPrefixed(" > 标签 解释", avail, contIndent)` —— 解释与标签同行，折行续行靠 6 列缩进辨认；解释长时与选项正文混在一起。
- **标题行**：问答 ` △ 请回答（第 n/m 题）` / plan-review ` △ 计划审批（第 n/m 题）`（默认前景色）；审批 `△ 等待审批`（黄、非粗）。类型（单选 / 多选 / 审批）无标识。
- **焦点与光标**：`frameFocus(rows, inputFocus)`（`layout.ts:2694`）扫描帧行取第一个带 `caret` 的行；`buildFrame` 以 `!modalOpen` 作 `inputFocus`（`layout.ts:2685`）→ 面板态恒 `CURSOR_HIDE`。`caret` 目前只有底部输入框（`components/TextInput.ts`）产出；面板走 Box 树（`box.ts` 的 `NodeBase` 无 caret 字段）。
- **状态**（`state.ts`）：`QuestionPanelItem` 只有 `optionIndex / selected / custom`；reason 层 `question-move`（↑/↓ 移项）`question-nav`（←/→ 切题）`question-select` `question-custom`；`question-transition.ts` 的 `questionKeyDecision` 把 Tab 归入 `none`（吞掉）。
- **面板摊平**：`layout.ts:1577` `buildActivePanelBox(state, activityH, activityTextW)` → `fillPanelBox` → `modalPanel`，逐行 `activityPaneSegs(rr)` 拼进帧。
- **注**：`StatusPanel`（`components/StatusPanel.ts`）自带居中窗口（`index - floor(maxBody/2)`），是第三份局部实现。

### 现状（B 组相关）

- `index.ts:821 onTurnEnded()`：turn-end 且 `bellEnabled` 时响一声（`BEL`），随后 `setTimeout(idleBellMs)` 到点再响一声（`index.ts:254-258` 的 `idleBellTimer` / `idleBellMs`，默认 8000，来自 `deps.notify.idleThresholdMs`）。→ 一次 run 结束 8s 内无输入即两声（3.4.2 现象）。
- `handleKey` 入口无条件 `clearIdleBellTimer()`（`index.ts:1288`）。
- 审批 / 问答事件分支（`index.ts:977` 起）只开面板，不响铃（3.4.1）。

### 现状（C 组相关）

- 3.5.2：`demo/main.ts:361-362` 的 `ICON.box = \u{ED95}` / `boxClosed = \u{ED75}`；`layout.ts:1231 TITLE_ICON` 已是 `boxClosed = \u{F03D7}` / `boxOpen = \u{F03D6}`；`demo/main.ts:372` 的 `titlebar-mode-icons` 断言在帧文本里找 demo 自己的旧码位 → 恒失败（本任务实测：冒烟输出 41 × `SMOKE_PASS` + 1 × `SMOKE_FAIL titlebar-mode-icons`，随后仍打印 `SMOKE_OK`）。
- 3.5.3：`npm run test:tui` = `sh TUI/scripts/test.sh`（无参 → `node --experimental-transform-types --test "tests/*.test.ts"`，**无** `--test-force-exit`）本机 120s 未结束；对照 `cd TUI && node --experimental-transform-types --test --test-force-exit tests/*.test.ts` 2.5s、1031 pass / 0 fail。→ 差异集中在 `--test-force-exit`（待 C 组执行者定位确认）。

## 决策

### A 组

1. **两窗高度分配**：`maxBody = height - 1`（标题占 1 行）拆为「选项窗」+「描述窗」。选项窗行数 = `min(选项行数（含自定义兜底项）, max(1, floor(maxBody / 2)))`，描述窗 = `maxBody - 选项窗行数`。理由：两窗恒同屏（backlog 要求长题干时选项仍可见），选项最多占半屏、描述至少占半屏，覆盖「长题干 / 长 detail」这个主要痛点；选项少时描述窗自动拿到剩余行，不浪费。
   - 审批面板无选项列表（选项列表属 3.2.4，不在本批）→ 描述窗独占 `maxBody`。
1. **焦点窗**：新增 `QuestionPanelItem.focus: "desc" | "options"`（缺省 `"options"`，与现状一致：↑/↓ 直接移选项）。**Tab 在 `desc` / `options` 间切换**（Backlog 3.2.1 指定 Tab；`questionKeyDecision` 现在吞掉 Tab，可直接赋语义）。焦点态反映在底部提示区（`hints.ts` 的 `questionHintLine` 按焦点窗给不同文案）。
1. **↑/↓ 分派**：焦点在 `options` → 现状语义（`question-move`）；焦点在 `desc` → 描述窗逐行滚动（新增 `question-desc-scroll`）。
1. **描述窗滚动偏移落 state**：`QuestionPanelItem.descScroll: number`（按题独立，切题不串）。上界依赖折行（与宽度相关），state 层不知道宽度 → **由 App 在按键时用当前几何算上界并随 action 传入**（`{ type: "question-desc-scroll"; delta; max }`）：`frameGeometry(state, renderer.getSize())` 取 `activityH` / `activityTextW`，调 `QuestionPrompt` 导出的 `maxDescScroll(item, height, width)` 得精确上界。理由：避免「state 溢出累积导致反向按键无反应」的体验缺陷，也不把宽度塞进 state。
1. **选项窗滚动**：不落 state，渲染时推导（避免冗余状态）：锚点 = 焦点在 `options` 时取 `optionIndex`；焦点在 `desc` 时取「首个已标记项的索引」（无标记则回退 `optionIndex`）→ 保证**已标记项始终可见**（backlog 硬要求）。窗口起点由共用工具 clamp。
1. **共用窗口工具**：`layout/panel.ts` 新增 `windowStart(count, windowRows, anchor, mode)`（纯函数：起点计算 + 边界 clamp）。问答选项窗、问答描述窗、审批描述窗、StatusPanel 四处统一改用它，替换三处局部实现（backlog 落点要求）。
1. **3.2.2 类型标识**：标题行加黄色类型段 `[单选]` / `[多选]` / `[审批]`，其余文字与第 n/m 题导航保持现状（问答默认前景色、审批准黄色）。判定同源：`item.multiSelect` 决定单选/多选；`item.intent.kind === "plan-review"` 与审批面板 → `[审批]`。多选标记 `+`、单选 `*` 与 `markFor` 同源。
1. **3.2.3 解释分行**：选项首行只放 ` ${cursor}${mark} ${label}`（按 `avail` 折行、续行仍 6 列缩进）；`description` 存在时**另起一行**，缩进 4 列（= 选项正文起点列），按 `avail - 4` 折行。`>` / `*` / `+` 标记只在选项第 1 行（现状续行本就不重复，此处显式固定）。
1. **3.2.7 caret**：面板层不扩 `Box` 模型（避免动 measure/fill 全链路）：`QuestionPrompt` 导出 `questionCaret(panel, height, width)`（面板内 0 基行 + 0 基列），仅在「焦点在自定义兜底项**且**该项在可见窗口内」时返回；`layout.ts` 在拼活动区行（`activityPaneSegs`）时把该 caret 写到对应帧行；`frameFocus` 的 `inputFocus` 改为 `!modalOpen || 面板内编辑焦点存在`。条件「焦点在自定义项」即当前实现里唯一可编辑文本的面板态（与 `questionKeyDecision` 的 custom 分支同源判定）。

### B 组

1. 抽 `ringBell()` 私有方法（`bellEnabled` + `disposed` 双检查），turn-end 与「需交互」事件共用（3.4.1）。
1. **3.4.2 处置**：先按 3.4.2 要求复现定位（写出实验与结论），默认处置 = **去掉 idle 补响**（`idleBellTimer` / `idleBellMs` / `clearIdleBellTimer` 的调用点相应收敛），一次 run 结束只响一声；催促职责交给 3.4.3 的重复响铃。
1. **3.4.3 重复响铃**：新增 `startRepeatingBell()` / `stopRepeatingBell()`（`setInterval` 每秒一次），触发条件 = 面板（审批 / 问答）打开且超过 `notify.idleThresholdMs` 无按键；**一次交互最多进入一次**（进入后即置标志，用户操作停止后不重启）；任意按键（`handleKey` 入口，含无效键）停止；面板关闭（提交 / 取消 / 超时）与 `dispose` 必须清理。idle 空闲（turn 结束后）不触发。
1. 3.4.1 即时响铃与 3.4.3 计时协同：面板弹出即响一声（3.4.1）并启动 3.4.3 的「无操作超阈值」计时；同一交互内即时响铃不重复。

### C 组

- 委派 C 组执行（独立于 A/B 的文件面：`demo/main.ts`、`scripts/*`），根因与改法以执行者实测为准，回填至本文件「实现记录」。

## 规划

### 不做（明确范围）

- 3.2.4（审批改单选列表）、3.2.5（倒计时）、3.2.6（选项编号 + 数字键）、3.3.1（审批按键白名单）：审批仍只有「描述窗 + ↑/↓ 滚动 + y/n 应答」；审批选项列表与按键白名单留待下一批，本批只保证接口可衔接。
- 3.1.4（排版性能）：已被用户裁定退回，不接取。
- 3.6.1 / 3.7.x：外部依赖与机制类开放项，不在本批。
- 3.4.x 不新增配置项（复用 `notify.enabled` 与 `notify.idleThresholdMs`）。

### 计划改动文件清单

A 组：

- `src/app/state.ts`（`QuestionPanelItem` 加 `focus` / `descScroll`；reducer 加 `question-focus`、`question-desc-scroll`；`openQuestion` 初始化字段）
- `src/app/question-transition.ts`（Tab → 切焦点决策；↑/↓ 按焦点窗分派）
- `src/app/components/QuestionPrompt.ts`（两窗渲染、类型标识、解释分行、caret 计算、导出 `maxDescScroll` / `questionCaret`）
- `src/app/components/ApprovalPrompt.ts`（类型标识 + 描述窗滚动）
- `src/app/components/StatusPanel.ts`（改用共用窗口工具）
- `src/app/layout/panel.ts`（共用 `windowStart` 工具）
- `src/app/layout/hints.ts`（问答提示文案按焦点窗分列 Tab 提示）
- `src/app/layout.ts`（面板 caret 写入帧行；`frameFocus` 的 `inputFocus` 合并面板编辑焦点）
- `src/app/index.ts`（`handleQuestionKey` 分派 `focus` / `desc-scroll` 决策并计算滚动上界）
- `tests/question-wrap.test.ts`、`tests/focus-cursor.test.ts`（3.2.7 caret 集成用例；**本任务追加**：句柄泄漏根治 `t.after(close)`，见「实现记录」C 组）、新增 `tests/question-window.test.ts`（分窗与 caret 断言）
- `docs/SPEC.md` §7、`docs/DESIGN.md` 面板章节、`docs/IMPLEMENTATION.md` 面板 / 渲染章节

B 组：

- `src/app/index.ts`（`ringBell()` / 重复计时器 / 事件分支 / `handleKey` 停止 / `dispose` 清理）
- `tests/notify-bell.test.ts`
- `docs/IMPLEMENTATION.md` §声音提醒、`README.md`（`notify` 说明）

C 组：

- `demo/main.ts`（图标码位对齐 `TITLE_ICON`，复核其余码位）
- `TUI/scripts/test.sh`、`TUI/package.json`、根 `scripts/test-parallel.sh`（按根因定，最小改动）

## 实现记录

### A 组：面板分窗与编辑光标（3.2.1 / 3.2.2 / 3.2.3 / 3.2.7）

- `layout/panel.ts`：新增共用窗口工具 `windowStart(count, windowRows, anchor, mode)`（`center` / `tail`）（`WindowMode` 类型同文件导出）。
- `state.ts`：`QuestionPanelItem` 加 `focus` / `descScroll`；`AppState` 加 `approvalScroll`（审批描述窗偏移，打开 / 关闭归零）；reducer 新增 `question-focus`、`question-desc-scroll`（带 `max`）、`approval-scroll`（带 `max`）；`openQuestion` 初始化新字段。
- `question-transition.ts`：Tab → `{ kind: "focus" }`；`↑/↓` 按 `item.focus` 分派 `move` / `desc-scroll`。
- `components/QuestionPrompt.ts`：改为单一排版函数 `layoutQuestionPanel`（标题 + 两窗可见行 + caret + `maxDescScroll`），导出 `maxDescScrollFor` / `questionCaretFor`；标题加黄色类型标识；选项解释另起一行（4 列缩进）；caret 列按显示宽度算。
- `components/ApprovalPrompt.ts`：标题加 `[审批]`；描述窗按 `scroll` 滚动（不再硬截断），导出 `maxApprovalScroll`。
- `components/StatusPanel.ts`：选项窗口改用 `windowStart(..., "center")`（行为与原地实现一致）。
- `layout.ts`：`buildActivePanelBox` 传 `state.approvalScroll`；活动区行拼装时把面板 caret 写成帧行 `caret`（列 = 前缀段实测宽 + 活动区列偏移 + 面板内列）；`frameFocus` 的 `inputFocus` 改为 `!modalOpen || 帧内出现 caret 行`。
- `layout/hints.ts`：`questionHintLine` 按焦点窗给 `[↑/↓]滚动` / `[↑/↓]选项` 与 `[Tab]描述` / `[Tab]选项`。
- `index.ts`：`handleQuestionKey` 分派 `focus` / `desc-scroll`；新增 `questionDescScrollMax()` / `approvalScrollMax()`（用 `frameGeometry(state, renderer.getSize())` + 面板导出的上界函数算 `max`）；审批分支在 y/n 之外支持 `↑/↓` 滚动（白名单其余部分仍留 3.3.1）。

### B 组：声音提醒（3.4.1 / 3.4.2 / 3.4.3）

- **3.4.2 先复现定位**：旧 `tests/notify-bell.test.ts` 的用例「等待用户输入超阈值 → 补响一次（阈值可配）」以 20ms 阈值断言 `bells === 2`，复现了双响；`adapter/dsh.ts` 的 `turn/end` 归一化是**单次** `emit({ type: "turn-end" })`（`src/app/adapter/dsh.ts:1567-1574`，无重复路径）→ 结论：双响 = 「turn-end 一声 + `idleBellTimer` 超时补响一声」**叠加**，不是事件重入。默认处置（去掉 idle 补响）即按此结论执行。
- `index.ts`：删 `idleBellTimer` / `clearIdleBellTimer`，新增 `pendingBellTimer` / `repeatBellTimer` 与 `ringBell()` / `beginInteractiveBell()` / `clearInteractiveBell()`；`onTurnEnded()` 只 `ringBell()` 一次；审批 / 问答事件分支调 `beginInteractiveBell()`；`handleKey` 入口与 `dispose()` 改调 `clearInteractiveBell()`；`apply()` 在「approval/question 由有变无」时停止催促（覆盖提交 / 取消 / 超时全部关闭路径）。`idleBellMs` 保留，语义改为「需交互无操作阈值」（复用 `notify.idleThresholdMs`，不新增配置项）。
- `tests/notify-bell.test.ts`：契约定稿重写为 8 例（见「测试与证据」）。

### C 组：两条缺陷（3.5.2 / 3.5.3）

- 委派独立执行（文件面与 A/B 不重叠：`demo/main.ts`、`TUI/scripts/test.sh`、`TUI/package.json`）。
- **3.5.2**：`demo/main.ts` 删掉自带 `ICON` 表，改为直接 `import { TITLE_ICON } from "../src/app/layout.ts"`，断言与 SGR 用例统一取源码常量（同一来源，源码改字形不再让 demo 假失败）；同文件其余图标码位一并复核（`policyAsk` / `policyNever` / `plan` / `preset` 等已全部改为常量引用，文件内不再有硬编码私有区码位）。本任务复核：映射正确（原 `ask` → `policyAsk` U+F1739、原 `route` → `plan` U+EDA6、`box/boxClosed` → `boxOpen/boxClosed` U+F03D6/F03D7）。
- **3.5.3**：执行者定位到根因 = **测试侧句柄泄漏**——`tests/focus-cursor.test.ts` 有 3 个用例 `createRenderer({...})` 后从不 `close()`，而 renderer 按设计 `stdio.on("data") + stdio.resume()` 持有 stdin（只有 `close()` → `pause()` 释放）→ 该文件子进程用例跑完也永不退出，默认并发下还占满调度槽位，整轮卡死（实测：该文件 12s 超时被杀而 5 用例 133ms 已全过）。执行者先在包装脚本层兜底（`--test-force-exit --test-concurrency=1`，并修好裸文件名参数、`package.json` 的 `test` 转发到同一脚本）；**本任务收口时进一步发现**：force-exit 会把「全绿」变成假象——node v24.16.0 在并行文件模式下强制退出子进程会**静默丢尾部结果**（根 `npm test` 汇总 TUI 为 `pass 1073`，而真值 1115），故最终改法回到**根治**：
  1. `tests/focus-cursor.test.ts`：`collector(t)` 内 `t.after(() => renderer.close())`，句柄不再泄漏；
  1. `TUI/scripts/test.sh`：去掉两个 flag，保持默认并发 + 自然退出（脚本头注释保留完整实测数据，防止后人再加 force-exit）；
  1. `TUI/package.json`：`test` 仍转发 `sh scripts/test.sh`（保留执行者的这项改进：本包 `npm test` 与根 `npm run test:tui` 同一条命令，flags 只有一处定义）。
     修复后：全量自然结束 **1115 pass / 0 fail（6.6~6.7s）**，根 `npm test` 的 TUI 行同为 `pass 1115 fail 0`（与真值一致）。
- 途中发现的新问题已按流程登记 BACKLOG **3.5.4**（测试句柄泄漏 + 评估恢复并行），交其他 agent；不并入本任务范围。

## 测试与证据

### 最终验证（A + B + C 全部改动就位后）

- `npm run check`（tsc --noEmit）：通过。
- `npm run build`：通过。
- 全量测试 `npm run test:tui`（= `sh TUI/scripts/test.sh`，默认并发 + 自然退出）：**1115 pass / 0 fail，6.7s**（含新增 `tests/question-window.test.ts` 9 例、`tests/notify-bell.test.ts` 8 例、`tests/focus-cursor.test.ts` +2 例）。
- 包装脚本四条用法：全量 `1115/0`（6.7s）／名字过滤 `npm run test:tui -- 窗口` `81/0`／单文件裸名 `npm run test:tui -- notify-bell.test.ts` `8/0`／组合 `"分窗" question-window.test.ts` `1/0`。
- 根 `npm test`（13 包并行）：全部 OK，11s；**TUI 行 `pass 1115 fail 0`**（修复前因 force-exit 截断显示 1073）。
- `npm run demo -- --smoke`：**33 × `SMOKE_PASS`、0 × `SMOKE_FAIL`**，末行 `SMOKE_OK ... interrupts=1`（`titlebar-mode-icons` 已修复）。
- 冻结基线重跑 `node --experimental-transform-types scripts/freeze-focus-frame.mts`：`tests/fixtures/focus-frame-legacy.json` 仅 6 行变化，全部预期（审批标题加 `[审批]`、问答标题加 `[单选]`、问答提示行改序并加 `[Tab]描述`），无布局 / 几何漂移。
- **计数口径警示**（写入脚本注释与 BACKLOG 3.5.4）：本套件在「并行 + `--test-force-exit`」下的报数（1006~1091）**低于真值 1115**，此前记录的 1028 / 1031 / 1080 等均为截断假象；评估测试规模请以自然退出或 `npm run test:tui` 为准。

### 关键验收点对应

- 3.2.1：`tests/question-window.test.ts` 的「分窗」「描述窗滚动 + clamp」「Tab / ↑↓ 分派」「已标记项可见」「审批滚动」5 例；`tests/app.test.ts` 的 plan-review 分窗可见性 + Tab 切窗用例。
- 3.2.2：类型标识用例（`[单选]` / `[多选]` / `[审批]`）+ 冻结基线中的标题行。
- 3.2.3：解释另起一行 / 缩进 4 列 / 标记只在首行用例。
- 3.2.7：`questionCaretFor` 行列用例 + `tests/focus-cursor.test.ts` 的面板编辑态 caret 与「无编辑焦点仍隐藏」反例（含真实 renderer 定位到面板编辑行）。
- 3.4.1：审批 / 问答弹出即响用例。
- 3.4.2：一次 run 结束只一声（20ms 阈值下 80ms 内 `bells === 1`）；有输入 / 无输入都不出现第二声。
- 3.4.3：mock 计时器用例（阈值内不响 → 超阈值每秒一次 → 任意键停止且不重启 → 面板关闭停止 → dispose 清理）。
- 3.5.2：冒烟中 `SMOKE_PASS titlebar-mode-icons`，且期望值改为取源码 `TITLE_ICON`（同类假失败不会再出现）。
- 3.5.3：`npm run test:tui` 从「420s / 120s 不结束」变为 **6.7s 正常结束**，四条用法全过，根 `npm test` 不再卡住。

### 待人工确认

- `npm run demo -- --smoke` 已 SMOKE_OK；面板分窗 / Tab / caret / 响铃的**观感**需人工在 `npm run demo` 或 `dsh --profile fff` 中确认（尤其：两窗高度在窄终端下是否合用、描述窗滚动是否跟手、面板编辑光标位置是否正确）。

### 人工确认记录（2026-09-26，用户实测）

- **长题干分窗 / 焦点可见性 / 滚动条 / 标题符号 / 右侧留白**：两轮长题干（约 2200 字、1000 字）实测通过；期间发现并修掉「焦点标记滚出视野」「两个黄色标记混淆」「右侧留白偏多」三点（见 3.2.8 追踪文档）。
- **声音提醒（3.4.1 / 3.4.3）**：问答面板实测通过——面板弹出响一声、此后无操作约 8 秒开始每秒一次催促、任意按键与应答都能立即停止且不再重启。
- **审批面板**：经「沙箱提权重试」路径实测弹出 `△ [审批] 等待审批`，`n` 拒绝生效（覆盖审批标题、推荐符号、应答路径）；长草稿滚动因宿主给的草稿恒为一行（`buildApprovalPrompt` 只输出工具名）暂无法真机验证，已登记 BACKLOG 3.3.3。
- **面板内容三项（3.2.7 / 3.2.3 / 3.2.2 多选分支）**：实测通过——多选标题显示 ` △ [多选] 请回答（…）`，选项说明另起一行并与正文左对齐，焦点在「自定义回答」时硬件光标停在文字末尾并跟随输入。
- **补充确认通过**（用户 2026-09-26 实测）：一次交互只催促一次（3.4.3）、turn-end 单响（3.4.2）、思考中光标仍停在输入框（3.1.3 回归）、其它面板（补全 / 历史 / 模型选择）提示文案回归、状态列与标题栏与焦点框线回归。
- **脚本类验收（B9 / B10）由 agent 运行登记**（2026-09-26，人工确认清单编号见会话）：
  - **B9** `cd TUI && npm run demo -- --smoke`：`SMOKE_PASS` **42** 条、`SMOKE_FAIL` **0** 条、末行 `SMOKE_OK`（exit 0）。
  - **B10** `npm run test:tui`（句柄泄漏修复后的包装脚本）：全量 **1119 pass / 0 fail，6.6s**（修复前 420s 不结束）；四条用法全部通过——全量 `1119/0`、名字过滤 `"窗口"` `81/0`、裸文件名 `notify-bell.test.ts` `8/0`、组合 `"分窗" question-window.test.ts` `1/0`；根 `npm test` 13 包全 OK（TUI 行 `pass 1119 fail 0`）。
- **B1 / B2 补充确认通过**（2026-09-26，16 选项 + 长题干场景）：标记最后一项后 `Tab` 切到题干、再切回，标记项仍在可见窗口内；题干滚到底时滑块贴底、继续按向下不抖动、按向上立即响应。
- **3.2.11 分窗新规则复验通过**（2026-09-26，重启后）：长题干 + 16 选项下两窗高度比 **2:1**、选项窗溢出滚动与描述窗滚动条同屏；详见 `2026-09-26-question-split-ratio.md`。
- **B3 通过**（2026-09-26 用户实测）：状态选项面板（`/policy` `/permission` `/preset`）滚动仍跟随焦点、无错位。
- **本轮人工验收收口**：可人工确认项全部通过；唯一未验项 **C1**（审批长草稿滚动）受限于宿主草稿恒为一行，需 3.3.3 落地后才能验。
- 未提交：本轮全部改动保留在工作区（用户决定暂不 commit）。

## 收尾

- **接取条目完成**：3.2.1 / 3.2.2 / 3.2.3 / 3.2.7 / 3.4.1 / 3.4.2 / 3.4.3 / 3.5.2 / 3.5.3 共 9 条已在 BACKLOG 标「完成」；途中追加的 3.5.4（测试句柄泄漏 + 并行丢结果）由本任务一并修掉并标「完成」。
- **文档回写**：`TUI/docs/SPEC.md`（新增 §7.1 面板窗口与按键焦点；§11.1 `caret` 注释；§13 不变量 #3）、`TUI/docs/DESIGN.md`（§7 面板章节补两窗与焦点窗）、`TUI/docs/IMPLEMENTATION.md`（「声音提醒事件钩子」改 3.4.1-3.4.3 口径；新增「问答 / 审批面板：两窗滚动与编辑光标」）、`TUI/README.md`（`notify` 说明）。`TUI/docs/STATUS.md` 按流程未改（由用户择时更新）。
- **遗留项**：无未接取项；`node v24.16.0`「并行 + `--test-force-exit` 丢尾部结果」的行为作为知识留在 `TUI/scripts/test.sh` 头注释与 BACKLOG 3.5.4（升级 node 后可复核，若修复亦无收益——本套件已不需要 force-exit）。
- **归档**：本追踪文档移入 `TUI/docs/archived/`；`TUI/docs/implementation/` 随之清空（空目录不预建）。
- **未做**（明确范围外，已在「规划」声明）：3.2.4 / 3.2.5 / 3.2.6 / 3.3.1 / 3.3.2（审批选项列表、倒计时、编号数字键、白名单、超时自动关闭）留给下一批；审批面板本批只新增 ↑/↓ 滚动。
- **人工确认点待办**：面板分窗观感、Tab 切焦点手感、面板编辑光标位置、需交互响铃节奏，需在 `npm run demo` 或 `dsh --profile fff` 中人工确认。

> 注：本文件中的状态标记按 2026-09-26 符号规范记为推荐符号 `△`（BACKLOG 3.2.9；源码原文曾用 U+26A0（旧的面板状态标记），由归一表映射到 `△`）。
