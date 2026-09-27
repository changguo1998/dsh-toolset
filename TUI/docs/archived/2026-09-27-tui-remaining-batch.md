# TUI 剩余条目打包实现（BACKLOG: TUI#1, TUI#2, TUI#5, TUI#7, TUI#10, TUI#12, TUI#14, TUI#16, TUI#17, TUI#18）

状态：关闭　　开启：2026-09-27　　关闭：2026-09-27
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

按用户 2026-09-27 指令：把 `TUI/docs/BACKLOG.md` 中除 **#8** 以外的全部条目**打包实现**（一个任务、一份追踪文档）；#8 仅作提醒、不做实现。

接取范围（10 条；#16 为人工复核项，随本批验证阶段执行）：

| 条目 | 一句话 |
| --- | --- |
| #1 | 新增 `/continue` 命令（当前目录最近退出的会话）+ `/session` 列表改按编辑时间降序 |
| #2 | CLI 启动参数 `--resume <sessionId>` 与 `-c` / `--continue` |
| #5 | 兜底项合并（「其它」类预设并入自定义回答） |
| #7 | `/help` 持续增长（超一屏 + 依赖行数的脆弱断言） |
| #10 | `/agents` 刷新方式（现 2s 定时 + `r`，待宿主事件面） |
| #12 | 切会话后 `state.usage`（最近一次调用）未清零 |
| #14 | demo 冒烟失败信号失效（`SMOKE_OK` 无条件打印、失败不落退出码） |
| #16 | 真机复核四项：#3 缩进观感 / #9 `/stats` 双口径 / #4 审批面板标题 / #11 flash·chat·reasoner 表现（人工项） |
| #17 | TUI 支持 `source.form:'notice'` 渲染（项目级 #46 的 TUI 侧） |
| #18 | TUI 符号纠正改为 rule-engine 消费者（项目级 #43 的 TUI 侧） |

不在范围：**#8**（herdr pane 尺寸——外部问题，仅提醒、不做实现，待 herdr 修复后回归）。

## 调研

来源：本仓库源码与测试、宿主 dsh 0.1.7-rc.2 安装包（`~/.local/share/fnm/.../@deepseek-ai/dsh/node_modules/@deepseek-ai/*`）、`docs/host/` 笔记、`rule-engine/` 包源码、本机 `~/.dsh/sessions` 磁盘实况。基线：改动前 `npm run check` 通过、`npm run test` 1155 通过 / 0 失败；`npm run demo -- --smoke` 全绿、退出码 0。

### #1 `/continue` + `/session` 排序

- 命令面单一来源：`src/app/commands.ts` 的 `SlashRoute`（L150-184）与 `LOCAL_COMMANDS`（L188-311）、`routeSlashCommand`（L318）；App 侧 `handleSlash` switch（`src/app/index.ts` L2153+，`case "session"` L2189，`/session clean` 分支已存在）。
- 列表数据：`adapter.listSessions`（`src/app/adapter/dsh.ts` L2524-2581）**原样透传宿主顺序**；宿主契约只给 `header{id,createdAt,cwd}`（`src/app/adapter/types.ts` L935-942），宿主实现按 `header.createdAt` 降序（宿主包 `dsh-session-query/lib/index.js:308`；README 亦写 latest-first）。宿主 `SessionHeader` **无 updatedAt**（`dsh-session/lib/types/types.d.ts:58-102`）。
- 结论：**「编辑时间」必须 TUI 侧派生**。可行口径 = 持久化日志文件 mtime（会话目录 `<root>/<slug>/<id>/session.v4.jsonl.zstd`，本机实况已确认；`src/app/adapter/session-paths.ts` 已有 `locateSessionDir` 可复用，需新增 stat 取最大 mtime）；live 会话非可续对象，可回退 `createdAt`。
- 恢复链：`openHistory` → `resumeToSession`（index.ts L2621-2730）→ `adapter.resumeTo`（dsh.ts L3193-3244，先 dispose 旧 handle 再 `agents.resume({resumeSessionId})`）。
- 「当前目录」口径：`currentProjectCwd`（state.ts L243-249）+ `historyVisibleRecords`（L303-310，scope=project 时按 `r.cwd===cwd` 过滤）。「最近退出」= 非 live + persisted + cwd 命中 + recency 最大。

### #2 CLI 参数

- `src/main.ts` 的 `apply(ctx, config)`（L176+）是插件入口，**当前完全不解析 argv**；初始会话在 L260 `agents.create({sessionId:"tui-"+uuid, meta:{cwd}})` 创建。
- 宿主启动器只解析自有 flag，其余原样交给 app；经 `provideCmdline` 暴露 `ctx.cmdlineArgs.get()`（宿主 `dsh/lib/bin.js:11-23`、`dsh-cmdline/lib/index.js:25-30`、`dsh/lib/profile-boot-*.js:276`）——`dsh --profile fff --resume abc` → `["--resume","abc"]`；`-c` 不在启动器 flag 表内（`dsh/lib/bin.js:104`），同样可透传。
- resume 语义与 `adapter.resumeTo` 同源（`agents.resume` + 同一 `setup/agentOptions`，见 main.ts L249-259 的 `makeSetup`）。FFf profile 未装规则引擎等（与本条无关）。

### #5 兜底项合并

- 选项入口：`openQuestion`（`src/app/state.ts` L2746-2788）`options: q.options ?? []`，无任何归一；自定义兜底项是列表末位（`optionIndex ∈ 0..options.length`，state.ts L585 注释）。
- 渲染：`components/QuestionPrompt.ts` L285 `自定义回答${custom==="" ? "" : "："+custom}`；解释行缩进常量 L55。
- 按键：`question-transition.ts` L23-27 `isOnCustom`；自定义项上空格/字符=输入、退格=删字符（L57-76）；`buildQuestionAnswers`（L93-108）空回退**只对预设选项**生效 → 高亮在自定义项且无文本时提交空答案（现状）。
- 结论：改造点集中在 `openQuestion`（标记词命中则从 options 摘除、把被并选项文案存入自定义项解释字段）+ 渲染 + SPEC 约定 + 单测。

### #7 `/help`

- 文本：`App.helpLines()`（index.ts L3553-3679，31 条命令、双列表格、超宽命令拆行）；渲染路径 `case "help"`（L2154-2163，notice + lines）。
- 现状已可滚动：Tab 切焦点到活动区后 ↑/PgUp 翻（测试 `tests/app.test.ts` L3766-3825，断言写成「多按几次直到首行」的幂等式，不依赖行数）。
- 依赖 help 的断言：app.test.ts L3556-3570（尾部脚注行可见 + info 蓝）、L2085-2103（compact 模式尾部可见、不截断）；`tests/help.test.ts` 用自造行、无行数依赖。
- 冻结基线：`scripts/freeze-focus-frame.mts` → `tests/fixtures/focus-frame-legacy.json`；脚本场景未含 /help 正文（只有补全候选含 help 名），但 `COMMANDS-SPEC.md` §5（L79）要求 help 行变化 → 重跑 freeze + diff 审查 + smoke 全绿。

### #12 切会话后 `state.usage` 未清零

- 字段：`usage`（最近一次调用，state.ts L407-413）与 `usageTotals`（L414-421）；切换 reducer `history-resume-ok`（L1563-1589）与 `session-switch`（L1590-1610）只清 `usageTotals`（L1588 / L1609）。
- 显示：状态栏 `layout.ts` L1844/L1926-1943（`usage` 缺失 → 保留 `—` 占位）；`/stats` `handleStatsCommand`（index.ts L3095-3114，`usage` 缺失 → 「暂无 token 用量数据」单行提示）。
- 修法：两个 reducer 增加 `usage: undefined`；`/stats` 文案是否改为「四行 + 最近一次为 `—`」待裁定（BACKLOG 原文倾向 `—` 占位）。

### #14 冒烟失败信号

- `demo/main.ts`：`fail()` 已设 `process.exitCode = 1`（L114-119），但结尾**无条件**打印 `SMOKE_OK`（L612-617）后 `typeLine("/quit")`；退出经 `renderer.close()` → **`process.exit(0)`**（`src/renderer/index.ts` L286）覆盖 exitCode → 失败仍以 0 退出（根因确认）。
- 断言现状：本批基线全绿；COMMANDS-SPEC 记「SMOKE_PASS 36 项」。
- 修法候选：统计失败数、失败时不打印 `SMOKE_OK`（打印 `SMOKE_FAIL n=…`）并 `process.exit(1)`；或让 `renderer.close()` 尊重 `process.exitCode`（改动 `src/renderer/index.ts`，在计划清单外，需裁定）。

### #10 `/agents` 刷新

- 现机制：`startPanelRefresh`（index.ts L865-905，`setInterval` 2s，agents/workflows 共用）+ `r` 手动刷新（L1592 附近）。
- 宿主面（**修正 BACKLOG 前提**）：`subagent/start` / `subagent/end` 事件存在（`dsh-subagent/lib/types/lifecycle.d.ts:78-80`，发射 `dsh-subagent/lib/index.js:268-320`），且有插件消费先例（`dsh-hooks-claude-code/lib/index.js:309 ctx.on("subagent/start", …)`）；TUI 现无订阅。可行改造 = 订阅这两个事件触发面板刷新 + 保留低频兜底定时。

### #16 真机复核（人工）

- 四项：① #11 flash/chat/reasoner 两阶段锁定-释放表现；② #9 `/stats` 双口径四行文案与数值；③ #4 审批面板标题 ` △ 等待审批`；④ #3 交错缩进（`messageGutter` 4）左右留白观感。步骤均为：`npm run build` → 重启 `dsh --profile fff` → 逐项操作目视；无法在无 TTY/无目视条件下机械验证，需用户执行并回报。

### #17 `source.form:'notice'` 渲染

- 注入形状：`rule-engine/src/inject.ts` L41-52 → `{role:"user", content:[…], source:{kind:"rule-engine", form:"notice", summary}}`；宿主 `ContextForm` 的 `notice` 必带 `summary`（`dsh-llm/lib/types/message.d.ts` L44-90）。`rule-engine` 已在本仓库（`rule-engine/`），但 fff profile 未挂载。
- TUI 现状：live 事件 switch（dsh.ts L1406+）**无 user 消息分支**（用户输入靠本地回显 index.ts L2038-2041）；历史/恢复路径 `normalizeHistoryMessages`（dsh.ts L287-352）把 `user/message`、`agent/inbox/spliced` 一律折成 user 行 → **恢复后按普通用户块渲染**（BACKLOG 描述即此路径；live 下注入内容不显示）。
- 修法候选：历史路径按 `source.form==="notice"` 产出一行提示；live 路径订阅 `agent/inbox/spliced` 只处理 notice 形态（避免与本地回显重复）→ emit 一行 notice。落点 `adapter/dsh.ts`（+`normalize.ts` 若有纯函数可抽）、`SPEC.md`、tests。

### #18 符号纠正消费者化

- TUI 现状：`symbols.ts` 纯函数（治理区/白名单/别名表 L17-363、`normalizeSymbols` L405-459）；App 在流式正文上做展示层归一（index.ts L958-959），turn-end 后对 `unrecommended` 提醒 + `followup`（L1256、L1324 附近，宏任务推迟）。
- rule-engine 现状：provide 面 `ruleEngine` 仅 `list()` / `status()`（`rule-engine/src/main.ts` L104-108、L160-165），**无注册/评估 API**（消费者无从调用判定）；其触发面是自身规则（配置基线 + `rule_*` 工具族）。
- 结论：#18 若按原文「改为消费者」需 **rule-engine 先扩消费者 API**（跨模块、项目级条目）+ 该插件挂载进 profile（项目级 #45 未做）；否则本批只能降级（保留 TUI 现状 + 登记依赖与方案）。待用户裁定范围。

### 共同事实

- 命令新增/改造的硬约定：`COMMANDS-SPEC.md` §1（6 类落点）、§5（help 同步 + freeze + smoke）、§6（测试口径）；notice 分级须同步 `TUI/docs/design/NOTICE-LEVELS.md`。
- 本机 `~/.dsh/sessions/<slug>/<id>/` 目录内容：`session.lock` + `session.v4.jsonl.zstd`（mtime 可作编辑时间来源）。

## 决策

用户裁定于 2026-09-27（6 问 6 答）；未列出的细节按本表执行。

| # | 维度 | 选项 → 选定 | 理由 |
|---|------|------------|------|
| D1 | #1/#2「编辑时间」取数（用户裁定） | 日志 mtime / createdAt / **`sessionQuery.listEvents(id)` 末条事件 `time`** | 宿主契约面（`SessionEventRecord.time`，升序、轻量），对 live 也准；调用失败或空日志 → 回退 `createdAt` |
| D2 | #1 排序落点 | App 层 / **adapter.listSessions 内计算 `updatedAt` 并降序排序**（并列 `createdAt` 降序、再按 id） | 单一数据源；面板/reducer 拿到即已排序，无需改共享面板 |
| D3 | #1 `/continue` 选择 | — → **cwd 精确匹配（与 /session project 同口径）+ `persisted && !live` + `updatedAt` 最大**；无匹配 → notice 提示 | 与条目「等价于 /session 自动选中」一致；live 会话本就不可续 |
| D4 | #2 参数来源 | `process.argv` / **`ctx.cmdlineArgs.get()`** | 与宿主「app 自解析内层参数」设计一致（`provideCmdline`），可注入单测；服务缺失回退空列表 |
| D5 | #2 参数语法 | — → **`--resume <id>` / `--resume=<id>`；`-c` / `--continue`；`--resume` 优先于 `-c`；未知/缺值忽略（参数不消费，多插件共享）**；resume 失败 → stderr warn + 回落 `agents.create`；`-c` 无匹配 → 静默新建 | 无 UI 阶段只能 stderr 提示；回落保证总能起会话 |
| D6 | #5 合并规则 | 只并末项 / **任何命中标记词表的选项都摘除并合并**（多命中按「、」并入解释文字）；标记词表 = 自定义 / 其它 / 其他 / 例外 / 以上都不是 / 都不对；自定义项新增 `customHint`（取自被并文案），渲染 `自定义回答（<hint>）：<输入>`；维持「须输入文字才算作答」（无空回退、不可标记） | 判据可判定、无模型调用；与条目原文一致 |
| D7 | #7 策略（用户裁定） | 分层 / 压缩 / **只做加固与例行收尾**：加 /continue 行、检查并加固断言、重跑 freeze 脚本 + diff 审查 + smoke；不改 help 结构 | 滚动已可用（Tab + ↑/PgUp）；避免大范围文案变动 |
| D8 | #12 修法 | — → **两处切换 reducer 置 `usage: undefined`**；`/stats` 保持四行口径，`usage` 缺失时「最近一次调用：—」、上下文/命中率 `—`/`n/a`（不再回落「暂无数据」单行提示） | 与条目「显示 — 占位更诚实」一致；切换后语义已是「本会话无调用」 |
| D9 | #14 修法（用户裁定） | 只改 demo / **demo 统计失败 + renderer 尊重 exitCode（两处都改）**：失败不打印 `SMOKE_OK`、打印 `SMOKE_FAIL n=…`；`renderer.close()` 改 `process.exit(process.exitCode ?? 0)` | 根因是 renderer 覆盖退出码；同时修对其它退出路径也正确 |
| D10 | #10 改造 | 保持定时 / **事件驱动 + 兜底**：订阅 `subagent/start`、`subagent/end` 即时刷新（面板 kind=agents 打开时），保留既有 2s 定时 | 宿主事件存在且有消费先例；兜底防作用域差异（真机验证项） |
| D11 | #17 落点 | 只历史 / **双路径**：历史归一按 `source.form==='notice'` 产出单行提示（新 role → buffer kind，灰 log 级、不占用户块）；live 订阅 `agent/inbox/spliced`（及 `user/message`）仅处理 notice 形态 → 单行 notice；`summary` 缺失时取正文首行截断 | 达成「提示人」语义；只处理 notice 形态避免与本地回显重复 |
| D12 | #18 范围（用户裁定） | 消费者改造 / **本批降级**：TUI 不改代码；追踪文档登记依赖（rule-engine 需提供消费者 API + 挂载 fff profile），项目级 BACKLOG 追加新条目交其他 agent；TUI#18 条目保留「进行中」 | rule-engine provide 面只有 `list()`/`status()`，无判定 API；跨模块改造超范围 |
| D13 | #16 执行（用户裁定） | 保留 / **出逐项复核清单，用户真机执行并回报**；回报前 TUI#16 保持「进行中」 | 人工目视不可机械验证 |

## 规划

任务拆分（按依赖与风险排序，逐条实现后各自补测试）：

1. **#12**：两处 reducer 清 `usage` + `/stats` 占位文案 + 测试（最小、独立）。
1. **#5**：`openQuestion` 合并归一 + `customHint` 渲染 + SPEC 约定 + 测试。
1. **#14**：demo 失败统计/汇总 + renderer 退出码 + 人工用变异断言自测。
1. **#17**：`normalize` 纯函数（notice 判定/摘要）+ 历史路径 + live 路径 + SPEC + 测试。
1. **#10**：adapter 订阅 subagent 事件 + App 面板刷新接线 + 测试。
1. **#1 + #2 + #7**：`listEvents` 取 `updatedAt` 与排序、`/continue` 命令与选择函数、`cmdlineArgs` 解析与启动 resume/continue、help 加行与断言加固；命令文档/README 同步。
1. **#16**：出真机复核清单（进「测试与证据」）。
1. **#18**：降级登记（追踪文档 + 项目级 BACKLOG 新条目）。
1. 测试与收尾：`npm run check` / `npm run test` / `npm run demo -- --smoke` / freeze 脚本 diff 审查 / `npm run build` + 人工确认。

计划改动文件清单（细化；**计划外文件一律不改**）：

- 启动与命令（#1/#2/#7）：`TUI/src/main.ts`、`TUI/src/app/commands.ts`、`TUI/src/app/index.ts`
- 适配层（#1/#10/#17）：`TUI/src/app/adapter/dsh.ts`、`TUI/src/app/adapter/types.ts`、`TUI/src/app/adapter/normalize.ts`
- 面板与状态（#5/#12/#17）：`TUI/src/app/state.ts`、`TUI/src/app/components/QuestionPrompt.ts`（必要时 `TUI/src/app/question-transition.ts`）
- 渲染与冒烟（#14/#17）：`TUI/demo/main.ts`、`TUI/src/renderer/index.ts`、必要时 `TUI/src/app/layout.ts` / `TUI/src/app/layout/*`
- 测试：#1/#2/#5/#10/#12/#17 各补用例（`TUI/tests/app.test.ts`、`adapter.dsh.test.ts`、`stats-rename.test.ts`、`question-transition.test.ts`、`question-window.test.ts` 等，新建文件按需）；`TUI/tests/fixtures/focus-frame-legacy.json`（重跑 `scripts/freeze-focus-frame.mts` 后按 diff 决定是否更新）
- 文档：`TUI/docs/COMMANDS.md`、`TUI/docs/COMMANDS-SPEC.md`、`TUI/docs/SPEC.md`、`TUI/docs/DESIGN.md`（按需）、`TUI/docs/IMPLEMENTATION.md`（按需）、`TUI/docs/design/NOTICE-LEVELS.md`（如新增 notice 调用点）、`TUI/README.md`、`TUI/docs/BACKLOG.md`
- 跨层登记：`docs/BACKLOG.md`（#18 依赖 + 新条目）
- 过程文档：本追踪文档（关闭时移入 `TUI/docs/archived/`）

明确不做：**TUI#8**（仅提醒）；TUI#18 的 TUI 侧代码改造；`rule-engine/**` 代码改动；profile `fff` 改动；`STATUS.md`；条目文本之外的顺手改动。

## 实现记录

（按时间追加，含关键命令与结果）

1. **#12 会话切换清零 `state.usage`**：`state.ts` 两处 reducer（`history-resume-ok` / `session-switch`）增加 `usage: undefined` + 字段注释；`index.ts` `handleStatsCommand` 改为双口径恒四行（无 usage → `最近一次调用：—` / `上下文：—` / `缓存命中率：n/a`）；测试同步（`stats-rename.test.ts` 改「无 usage」用例 + 双口径用例补两处清零断言）；文档同步 `IMPLEMENTATION.md` / `design/NOTICE-LEVELS.md`。
   验证：`npm test -- stats-rename.test.ts` → 10 pass / 0 fail；`npm run check` 干净。
1. **#5 兜底项合并**：`state.ts` 新增标记表 `FALLBACK_OPTION_MARKERS` + 纯函数 `isFallbackOption(label)`；`openQuestion` 归一（命中项从预设列表摘除、原文并入 `customHint`，多命中按「、」连接；`QuestionPanelItem.customHint?`）；`QuestionPrompt.ts` 把 `customHint` 作为自定义项解释行渲染；SPEC §7.1 增加「兜底项合并 + 提问方约定」；测试 `question-window.test.ts` 新增用例（摘除 / 解释行 / 无空回退 / 无命中不动）。
   验证：`npm test -- question-window.test.ts` → 18 pass / 0 fail；`npm run check` 干净。
1. **#14 冒烟失败信号**：`demo/main.ts` 增加失败计数（`fail()` 累加）与结尾分支（失败 → 汇总 `SMOKE_FAIL n=…`、不打印 `SMOKE_OK`）；`src/renderer/index.ts` `close()` 改 `process.exit(process.exitCode ?? 0)`（不再硬 exit 0 覆盖失败码）；文件头注释同步。
   验证（含人造失败）：正常 `npm run demo -- --smoke` → 43 pass / 0 fail、`SMOKE_OK`、exit 0；临时把 `question-rendered` 断言判据改坏后 → exit 1、`SMOKE_FAIL question-rendered` + `SMOKE_FAIL n=1`、无 `SMOKE_OK`；随后已从备份复原并复跑绿（exit 0），临时文件已清理。
1. **#17 `source.form:'notice'` 渲染**：`normalize.ts` 迁入/新增 `extractTextBlocks` + `noticeSummaryOf`（summary 优先、缺省取正文首个非空行、截断 120）；`dsh.ts` 历史归一（`user/message`、`agent/inbox/spliced` 的 notice 项 → `role:'notice'` 摘要行）与 live 路径（同两类事件，`renderedNoticeIds` 按消息 id 去重，emit `{type:"notice", tone:"log"}`）；`commands.ts` `surfaceToBuffer` 支持 notice 行（log 灰、空白不产出）；`types.ts` 扩 `HistoryMessage.role` 与 `SessionEventType`（+`agent/inbox/spliced`）；`state.ts` `history-resume-ok.rows` 类型扩 notice + tone。文档：SPEC §3.1 新增「注入 notice 行」、NOTICE-LEVELS B 表新增一行。
   验证：`npm test -- notice-form.test.ts` → 3 pass；`npm test -- adapter.dsh.test.ts` → 172 pass / 0 fail（含新增 3 条 TUI#17 用例：历史归一 ×2、live 去重与普通消息不渲染）；`npm run check` 干净。
1. **#10 `/agents` 事件驱动刷新**：adapter 订阅宿主 `subagent/start` · `subagent/end`（`runtime.on`，随 dispose 解绑）→ 新 DshEvent `subagent-activity`；App 在 `/agents` 面板打开时调用 `panelRefreshTick()` 即时重拉（2s 定时保留为兜底）。文档：COMMANDS-SPEC §4、IMPLEMENTATION「面板保鲜」、README 命令表同步（并修正 BACKLOG 原「宿主无事件面」前提）。
   验证：`npm test -- command-panel-agents-tools.test.ts` → 16 pass / 0 fail（新增事件驱动用例：未开面板不刷、打开后事件 → 恰好刷新一次）；`npm test -- adapter.dsh.test.ts` → 173 pass / 0 fail（新增 subagent 事件转发用例）；`npm run check` 干净。
1. **#1 / #2 / #7（命令与启动）**：
   - #1 数据面：`adapter/dsh.ts` 把会话列表归一化抽成模块级 `listSessionRecords`（标题 / 空会话探针 + `updatedAt` = `sessionQuery.listEvents(id)` 末条事件 `time`，缺失回退 `createdAt` + 按 `updatedAt` 降序排序），adapter `listSessions` 改为薄封装；新增纯函数 `pickRecentSession(records, cwd)`（同目录 + persisted + 非 live + 编辑时间最大）；`types.ts` 的 `SessionInfo.updatedAt?` 与 `SessionQueryLike.listEvents?` 补契约。
   - #1 命令面：`commands.ts` 加 `SlashRoute "continue"` + `LOCAL_COMMANDS` 条目；`index.ts` 加 `case "continue"` 与 `continueRecentSession()`（复用 `resumeToSession` 路径；无匹配 → info，服务缺失 → warn，读取失败 → warn）。
   - #2：`main.ts` 新增纯函数 `parseTuiStartupArgs`（`--resume <id>` / `--resume=<id>` / `-c` / `--continue`；`--resume` 优先、未知与缺值忽略）+ `readCmdlineArgs(ctx.cmdlineArgs)`；`apply()` 按启动参数走 `agents.resume`（同一 setup/route），失败/无效 id → stderr `[tui] warn` + 回落 `agents.create`；`-c` 无匹配 → 静默新建；`sessionQuery` 读取提前复用到 adapter 选项。
   - #7：`/help` 加 `/continue` 行；按裁定未改 help 结构。
     验证：`npm run check` 干净；全量 `npm test` → **1169 pass / 0 fail**（新增：`main.config.test.ts` 解析 11 断言、`adapter.dsh.test.ts` updatedAt 排序 + `pickRecentSession`、`app.test.ts` `/continue` 两例；既有断言按新排序/补全目录修正 3 处）；`npm run demo -- --smoke` → 43 pass / 0 fail / `SMOKE_OK` / exit 0；`scripts/freeze-focus-frame.mts` 重跑 → `tests/fixtures/focus-frame-legacy.json` **无 diff**（help 正文不在冻结场景内）。

## 测试与证据

命令与结果（2026-09-27，TUI 包内；改动前基线 = 1155 pass / 0 fail）：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run check` | 干净（0 error） |
| 全量单测 | `npm test` | **1169 pass / 0 fail** |
| 冒烟 | `npm run demo -- --smoke` | **43 pass / 0 fail / `SMOKE_OK` / exit 0** |
| 冒烟失败信号（人造失败） | 临时改坏 `question-rendered` 判据后同上 | **exit 1**、`SMOKE_FAIL question-rendered` + `SMOKE_FAIL n=1`、**无 `SMOKE_OK`**；已从备份复原并复跑绿 |
| 冻结基线 | `node --experimental-transform-types scripts/freeze-focus-frame.mts` | 重跑后 `tests/fixtures/focus-frame-legacy.json` **无 diff** |
| 构建 | `npm run build`（随 demo 执行） | 通过 |

### #16 真机复核清单（需真实终端目视后回报）

1. `cd /home/guochang/Projects/dsh-toolset/TUI && npm run build` → 重启 `dsh --profile fff`。
1. **① #11 模型门控**：分别用 flash / chat / reasoner 开新会话发首条消息——观察首请求是否「目录仅 2-3 个工具 + persona-only」，首个 `tool/call` 后是否解锁全量（对照 v4-pro 既有结论）。
1. **② #9 `/stats` 双口径**：发起一次调用后执行 `/stats`，核对四行文案与数值；再 `/session` 切到另一会话后执行 `/stats`，确认「最近一次调用：—」占位（本次 TUI#12 新增行为）。
1. **③ #4 审批面板标题**：触发一次工具审批，目视标题行 ` △ 等待审批`。
1. **④ #3 缩进观感**：历史区交错缩进（`messageGutter` 4）的左右留白是否协调。
1. 回报方式：逐项「通过 / 不通过（现象）」，据此关闭 TUI#16。

### 未验证 / 残留

- #16 四项需人工目视，本批未执行（等回报）。
- #10 的 `subagent/start` · `subagent/end` 事件**真机可达性**只做了合成事件单测；不可达时由 2s 定时兜底，建议在 #16 真机回合顺带打开 `/agents` 面板观察刷新。
- #18 未做 TUI 代码改造（决策 D12）：待 rule-engine 提供消费者 API 后另起任务。

## 收尾

- 回写文档：`TUI/README.md`（启动参数、`/session` 排序、`/continue` 行）、`TUI/docs/COMMANDS.md`（本地命令计数与清单）、`COMMANDS-SPEC.md`（§4 面板保鲜、§5 smoke 计数）、`IMPLEMENTATION.md`（`/continue` 落点、编辑时间与启动参数机制）、`SPEC.md`（TUI#5 兜底项合并约定、TUI#17 notice 行）、`DESIGN.md`（会话生命周期）、`design/NOTICE-LEVELS.md`（`/stats` 文案、注入 notice 行）。
- `TUI/docs/BACKLOG.md`：#1 / #2 / #5 / #7 / #10 / #12 / #14 / #17 标「完成」；**#16 保留「进行中」**（等真机复核回报，清单见上节）、**#18 保留「进行中」**（依赖 rule-engine 消费者 API）；#8 仍为仅提醒。
- 项目级 `docs/BACKLOG.md`：新增条目登记 #18 的消费者 API 依赖（交其他 agent 接取）。
- 构建：`npm run build` 已通过；人工确认（#16 真机目视）待用户回合。
- 本追踪文档移入 `TUI/docs/archived/`。
- 未做：TUI#8（仅提醒）、TUI#18 的 TUI 侧改造、`rule-engine/**` 与 profile `fff` 改动、`STATUS.md`（用户择时更新）。
