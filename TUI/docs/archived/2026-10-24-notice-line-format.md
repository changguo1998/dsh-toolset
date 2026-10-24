# notice 行统一为 `[hh:mm:ss <来源>] 正文`（接取条目：`TUI/docs/BACKLOG.md`「notice 行统一为 `[hh:mm:ss <来源>] 正文`」）

状态：已关闭　　开启：2026-10-24　　关闭：2026-10-24
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

用户可见的 notice 行统一成 `[hh:mm:ss <来源>] 正文`：

- **时间**：TUI 收到该行的时间，本地时区、24 小时制、逐段补零（复用 `app/clock.ts` 的 `clockHms`）。
- **来源**：正文自带的 `[来源]` 前缀（插件 stderr / rule-engine 总线的既有惯例，如 `[session-channel]`、`[rule-engine]`、`[tui config]`…），前缀被时间戳包住、不再重复出现；无前缀的 TUI 自造提示记 `tui`。
- **正文**：前缀之后的部分逐字保留（`warn:` / `error:` 等分级词不动，tone 配色与判色链不变）。
- **边界**：`/help` 双列表格这类**多行** notice 原样输出（悬挂缩进与列对齐不动）；已带 `[hh:mm:ss …]` 前缀的行幂等返回（同一行会经缓冲与流水线两条交付路径）；恢复历史里的旧 notice 行不加前缀（时间未知，不伪造）。

## 调研

来源：源码阅读（2026-10-24）。

**现状链路**（notice 文本进入活动区 / 流水线的全部入口）：

1. **外部告警行**：`main.ts` 安装 `installStderrBridge`（`TUI/src/app/stderr-bridge.ts`）接管 `process.stderr.write`，按 `\n` 分行后交 `App.appendExternalLog(line, tone)`；rule-engine 总线（`App.ruleEngine()` 订阅 `onNotice`）与配置热更新提示（`main.ts` 的 `configSink.notice`）走同一入口。文本自带各插件的前缀，形如 `[session-channel] 已注入 …`、`[rule-engine] warn: …`；配置热更新提示无前缀。
2. **TUI 自造短提示**：`App.notice(text, tone)`（`TUI/src/app/index.ts`）——slash 命令结果、回合结束「已取消 / 已中断」、符号审查提示、未知命令等；同时双写缓冲（`reduceState` 的 `notice`）与流水线（`deliverLocal`），并落本地旁路日志（`recordLocalLog`）。
3. **adapter 事件型 notice**：`DshEvent` 的 `{type:"notice"}`（`TUI/src/app/adapter/dsh.ts:1399` 一带的 `emit`）——缓冲路径经 `App` 事件处理 `case "notice"`，流水线路径经 `opts.onDelivery` → `pipelineSink.current` → `App.ingestDelivery`。
4. **`/help`**：唯一不经 `App.notice` 的本地提示，直接 `reduceState({type:"notice", lines})` + `deliverLocal({kind:"notice"…})`，多行带悬挂缩进（`noCompact`）。

**结论**：没有单一出口——缓冲与流水线是两条并行交付路径，且 adapter 的 notice 文本在两条路径上各自成行。统一前缀只能落在「文本进入 App 的边界」；纯格式化函数可完全独立（只依赖 `clockHms`），便于幂等重入。

## 决策

决策项 1：时间与来源放在哪一层？
（a）各插件自己写时间戳；（b）TUI 在接收边界统一加；（c）渲染层出帧时加。
选定 **b**。理由：插件遍布 32 个包、且 headless 下 stderr 另有用途（时间戳会污染日志）；渲染层加前缀会让 `/help` 等也在前缀范围内，且底部 notice 视图与活动区两处渲染要各改一遍。

决策项 2：无前缀行的来源名？
（a）留空 `[hh:mm:ss]`；（b）统一记 `tui`；（c）按调用点分别取名。
选定 **b**。理由：无前缀的行都是 TUI 自造（slash 结果 / 回合收尾 / 配置提示），`tui` 与 stderr 里的 `[tui]` 前缀同口径；留空会破坏「方括号里必有来源」的可读性，按调用点取名需改几十处调用。

决策项 3：多行 notice 怎么处理？
（a）每行都加前缀；（b）只在首行加；（c）整段跳过。
选定 **c**。理由：多行 notice 只有 `/help` 与配置类表格，带悬挂缩进与列对齐，加任何前缀都会破版；用户裁定「短提示才纳入统一」。（首行加前缀仍会让双列表格首行与其余行列位错开。）

决策项 4：`warn:` / `error:` 等分级词是否挪进前缀（如 `[hh:mm:ss rule-engine] warn: …` → `[hh:mm:ss rule-engine warn] …`）？
（a）保留在正文里；（b）挪进前缀并去掉。
选定 **a**。理由：`externalLogTone` 靠这些词判 tone 色，挪走需同步改判色链；且 stderr 原文（headless / 日志）与屏幕应当同源，前缀只做「时间 + 来源」这一件事。

决策项 5：本地旁路日志（`tui-local.jsonl`）记带前缀还是原文？
（a）记带前缀的展示文本；（b）记原文。
选定 **b**。理由：旁路日志每行已带 `ts` 与 `kind` 字段，再写一遍 `hh:mm:ss` 是重复；模型侧 `tui_local_log` 要的是可读原文。

## 规划

任务拆分：a1-research（本文件调研与决策）→ a1-impl（格式化函数 + 接线）→ a1-test（单测与 App 用例）→ a1-doc（DESIGN 回写）。

### 计划改动文件清单

- `TUI/src/app/notice-format.ts`（新增：纯格式化函数 `formatNoticeLine` 与来源常量）
- `TUI/src/app/index.ts`（接线：`appendExternalLog` / `notice` / `shortNotice` / `paintExitNotice` / adapter 事件 `case "notice"` / 流水线 sink；本地日志记原文）
- `TUI/tests/notice-format.test.ts`（新增：单测）
- `TUI/tests/helpers/noticeText.ts`（新增：测试口径——`stripNoticePrefix` / `flatRows`，长 notice 折行后逐字断言用）
- `TUI/tests/app.test.ts`（配色断言改为「色码 + 前缀 + 正文」正则；滚动用例首行归一；新增 3 例 App 端到端：外部行来源、短提示记 `tui`、多行跳过）
- `TUI/tests/clean-quit.test.ts`、`command-panel-agents-tools.test.ts`、`config-edit.test.ts`、`contract-notice.test.ts`、`group-notice.test.ts`、`settings-fork.test.ts`（长 notice 断言改扁平化）
- `TUI/tests/focus-keep.test.ts`、`startup-resume-history.test.ts`（首行 / 缓冲文本归一为去前缀）
- `TUI/tests/local-log.test.ts`（旁路日志记原文的负向断言）
- `TUI/demo/main.ts`（冒烟断言：`混合 notice 提示` 在 80 列下折行 → 只探 `混合 notice`）
- `TUI/docs/DESIGN.md`（「运行期告警显示」补 C 节：行格式统一口径与接线点）
- `TUI/docs/BACKLOG.md`（条目状态与关闭注记）
- 本文件

## 实现

- `app/notice-format.ts`：`formatNoticeLine(text, nowMs)`——空白 / 多行 / 已带前缀原样返回；否则取行首 `[来源]`（无则 `tui`），输出 `[hh:mm:ss 来源] 正文`（时间非法时省略时间片段）。正文逐字保留。
- `App.appendExternalLog`：入挂起队列**前**格式化（补发不再重算时间）。
- `App.notice` → 新增 `shortNotice`（缓冲 + 流水线双写、文本统一前缀）；`notice` 在其上补本地日志与重绘。直接双写的四处短提示（审批超时/取消、控制字符过滤、steer 降级、无效命令）统一改走 `shortNotice`。
- adapter 事件 `case "notice"`（缓冲 + 本地日志原文）与 `pipelineSink.current`（流水线）各自格式化一次（幂等）；`paintExitNotice` 也格式化（退出清理提示）。
- `/help` 不走上述入口（`reduceState` 的 `lines` + `deliverLocal` 多行）→ 天然不受影响。

## 验证

- `cd TUI && npm run check`：通过。
- `cd TUI && npm run build`：通过。
- `npm run test:tui`：1760 例全过（含新增 9 例单测 + 3 例 App 端到端；改动前 1748 例，17 例因前缀折行/配色夹层失败，已按新口径修断言）。
- `npm run demo -- --smoke`：42 项 SMOKE_PASS、SMOKE_OK，无失败（断言随折行改为探 `混合 notice`）。

### 收尾补充（关闭前复验，2026-10-24）

- **补漏**：`deliverBufferTail`（事件驱动补块投递）里的 reducer 直落 toast（compaction「正在压缩上下文.../压缩完成」、retry、compaction-summary、workflow 结束、schedule「计划提醒触发」、feedback「反馈已记录」）原先不经 `formatNoticeLine` → 真机发现「压缩会话开始时的蓝色提示」无前缀后统一在此补格式化（幂等）。相应 App 用例 `compaction/retry → toast notice 文本` 追加前缀断言。
- **demo 脚本**：`demo` 不再内嵌 `npm run build`（构建写 dist 会触发 profile 的 hmr 行级重载、打断运行中会话），拆出 `demo:build`。冒烟断言随新前缀与视口截断调整（compaction-summary toast 探 `tui]压缩完成`）。
- 复验：`npm run check`、`npm run test:tui`（1760 例全过）、`node TUI/dist/demo/main.js --smoke`（42 PASS + SMOKE_OK）。

### 观测到的副作用（记录，不在本任务处理）

前缀占 16 列左右，窄窗格（如 80 列左右分栏时的 Turn pane）里较长 notice 会更早折行；现有断言已按「折行后拼接」口径写（`tests/helpers/noticeText.ts`）。若后续认为折行不可接受，可考虑悬浮缩进（续行对齐正文列）或窄窗格降级格式，另开条目。
