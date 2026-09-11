# TUI 提示信息分级总表（NOTICE-LEVELS）

> 依据：notice/tone **4 级语义 5 色值**权威口径（用户 2026-09 定稿，见项目记忆 MEMORY.md / `src/app/adapter/types.ts` NoticeTone 注释）。
>
> | 级 | 色 | 判定标准 |
> | --- | --- | --- |
> | `error` | 红 | 用户操作失败、会话中断、必须修复才能继续；**用户输入命令的结果一律 error**（可重敲绕开也不降级） |
> | `success` | 绿 | 用户操作成功，仅重要的操作才报（命令成功结果落 result 级） |
> | `warn` | 黄 | 命令运行错误但可绕开/修复、任务仍可进行；有其他副作用或属危险操作的警示；服务不可用 |
> | `info` | 蓝 | 需要用户了解的提示信息 / 主动索取的信息展示 |
> | `log` | 灰 | 展示运行进度与状态，无需用户关注 |
>
> - 核查日期：2026-09-09。比对基准：`dsh-v0.1.2-rc.1`（DSH 宿主契约不变）。
> - 范围：全部 tone 通道——App 层 `index.ts` notice()、适配层 `adapter/dsh.ts`、reducer 层 `state.ts`。
> - 「核对结论」：`一致` = 与标准相符；`修正` = 本次核查发现不符、已改（见文末修正记录，与 commit diff 一一对应）；`静默/低调` = 有意不升 success 级（高频行成功降噪）。
> - 渲染侧 `NOTICE_TONE_COLOR` 映射（layout.ts）：log 灰 / info 蓝 / warn 黄 / error 红 / success 绿，本次未改动。

## A. App 层 notice()（src/app/index.ts）

| 提示信息 | 来源（函数/命令） | 等级 | 核对结论 |
| --- | --- | --- | --- |
| live 会话不可续（仅 persisted 会话可切换） | handleHistoryCommand（/session） | warn | 一致 |
| 无效命令: \<line> | handleSlash（语法无效） | error | **修正**（原无 tone → 红） |
| /help 帮助内容 | handleSlash（/help） | info | **修正**（原无 tone → 蓝） |
| goal/todo 详情见右侧信息栏 | handleSlash（/goal） | info | 一致 |
| \<model 命令错误文本> | handleModelCommand（/model） | error | 一致（命令结果） |
| model command failed: \<err> | handleModelCommand（/model） | error | 一致（命令结果） |
| usage: /theme [light|dark|toggle] | handleThemeCommand（/theme） | info | 一致 |
| theme: \<name> | handleThemeCommand（/theme） | success | 一致（重要操作成功） |
| 历史会话服务不可用（宿主未挂载 sessionQuery） | handleHistoryCommand（/session） | warn | 一致（服务不可用） |
| 会话切换不可用（宿主未配置会话持久化） | resumeToSession | warn | 一致（服务不可用） |
| 已切换到会话「\<title>」 | resumeToSession | success | 一致 |
| 没有可复制的模型回复 | handleCopy（/copy） | warn | 一致（条件不满足） |
| 已复制最后一条回复到剪贴板 | handleCopy（/copy） | success | 一致 |
| no available models (llm service missing…) | openModelPicker（/model） | warn | 一致（服务不可用） |
| already on current model \<label> | handleModelCommand（/model） | info | 一致 |
| current model -> \<label> | handleModelCommand（/model） | success | 一致 |
| 审批策略服务不可用（×4 处） | handlePolicy（/policy） | warn | 一致（服务不可用） |
| 审批策略：ask（每次工具调用询问） | handlePolicy（/policy） | success | 一致 |
| 审批策略：never（工具调用自动放行） | handlePolicy（/policy） | success | 一致 |
| 用法：/policy [ask|never] | handlePolicy（/policy） | info | 一致 |
| 权限预设服务不可用（×3 处） | handlePermission（/permission） | warn | 一致（服务不可用） |
| agent 预设服务不可用（×5 处） | handlePreset（/preset） | warn | 一致（服务不可用） |
| agent 预设服务不可用：\<arg>（×2 处） | handlePreset（/preset） | warn | 一致（服务不可用） |
| agent 预设：已切换为 \<id>（×2 处） | handlePreset（/preset） | success | 一致 |
| jobs 服务不可用（×4 处） | handleJobs（/jobs） | warn | 一致（服务不可用） |
| job \<id> 取消请求已发送 | handleJobs（/jobs） | success | 一致 |

## B. 适配层 notice 归一化（src/app/adapter/dsh.ts）

| 提示信息 | 来源（事件/函数） | 等级 | 核对结论 |
| --- | --- | --- | --- |
| turn/end reason = error → `✗ <code>: <message>`（message 空时兜底`✗ 输出错误`） | turnEndNotice | error | 一致（会话中断须修复） |
| 输出达 token 上限 | turnEndNotice（max-tokens） | warn | 一致（可绕开） |
| 已取消 | turnEndNotice（aborted） | info | 一致（需用户了解） |
| 已中断 | turnEndNotice（interrupted） | info | 一致（需用户了解） |
| 已阻塞（等待审批） | turnEndNotice（blocked） | warn | 一致（等待中） |
| completed / 未知 reason | turnEndNotice | — | 静默（有意） |
| （模型输出已中断） | assistant/message.interrupted | info | 一致（需用户了解） |
| invalid slash command: \<line> | runCommand（parse 失败） | error | 一致（命令结果） |
| commands 未就绪，无法执行 /\<name> | runCommand（无注册表） | warn | 一致（服务不可用） |
| /\<name> 执行出错：\<err>（×2 处：同步抛错/异步 reject） | runCommand（execute 失败） | error | 一致（命令结果） |
| 未知命令，输入 /help 查看可用命令。 | finish（注册表未命中） | error | **修正**（原无 tone → 红，保留 error:true） |
| 命令 \<commandId> 执行出错：\<text> | finish（kind=error） | error | **修正**（原无 tone → 红，保留 error:true） |
| [\<commandId>] \<text>（命令成功输出） | finish（kind=success） | success | **修正**（原无 tone → 绿，命令结果落 result 级） |

## C. reducer 层活动区行（src/app/state.ts）

| 提示/行 | 事件 | 等级 | 核对结论 |
| --- | --- | --- | --- |
| `✓ <detail>` 工具结果成功 | tool/result ok | 低调（✓ 前缀绿、正文默认） | 静默/低调（有意，高频降噪） |
| `✗ <error.name>: <message>` 工具结果失败 | tool/result fail | error | 一致 |
| 正在压缩上下文... | compaction start | info | 一致（需用户了解） |
| 压缩完成 | compaction end | success | 一致 |
| 压缩完成：\<text 首行>（压缩摘要 toast） | compaction-summary | success | 一致 |
| 压缩：已剪除 N 个节点 (~X tok) | compaction-prune | log | 一致（进度/状态） |
| 重试 X/Y (Zs): \<CODE> \<msg> | retry | warn | 一致（可绕开/进行中） |
| `↻ 重试中 (N)` | retry-started | log | 一致（进度） |
| `@ <label> <os\|ct>` 子代理行 | subagent | info | 一致（需用户了解） |
| `⚑ <name>` / `⤷ <label>` workflow 运行行 | workflow run-start / agent-start | info | 一致 |
| `↩ #N success` workflow 成员结束 | workflow agent-end | success | 一致 |
| workflow 结束（toast） | workflow run-end | success | 一致 |
| `/> <name>` 命令运行行 | command run | log | 一致（进度） |
| `✗ /<name>: <text>` 命令失败行 | command done fail | error | 一致（命令结果） |
| 命令成功 | command done ok | — | 静默（有意；结果由命令自身 notice 呈现） |
| `⇥ <name>` run_code 子派发 | code-dispatch start | log | 一致（进度） |
| `✗ <name>` 子派发失败 | code-dispatch settle fail | error | 一致 |
| 子派发成功 | code-dispatch settle ok | — | 静默（有意） |
| `⌗ <point>` hook 调用行 | hook invoked | log | 一致（进度） |
| hook/result 通过 | hook result ok | log | 一致（成功不显 success 绿，降噪） |
| hook/result 拒绝：\<point> | hook result fail | error | 一致 |
| 计划提醒触发 | schedule dispatch | log | 一致（进度/状态） |
| 反馈已记录 | feedback | success | 一致（操作成功确认） |
| 计划提醒（/plan 行为提示） | plan 提醒 | log | 一致 |

## 修正记录（与 commit diff 一一对应）

| # | 位置 | 原 | 现 | 依据 |
| --- | --- | --- | --- | --- |
| 1 | index.ts handleSlash（无效命令） | 无 tone（默认） | error 红 | 用户输入命令结果一律 error |
| 2 | index.ts handleSlash（/help） | 无 tone（默认） | info 蓝 | 主动索取的信息展示 = 需用户了解 |
| 3 | dsh.ts finish（注册表未命中） | 无 tone（仅 error:true） | error 红 | 用户命令失败结果 |
| 4 | dsh.ts finish（kind=error） | 无 tone（仅 error:true） | error 红 | 用户命令失败结果 |
| 5 | dsh.ts finish（kind=success） | 无 tone | success 绿 | 用户输入命令的成功结果落 result 级 |

配套断言：`tests/app.test.ts`（「本地 slash 分级：/help 内容 info 蓝、无效命令 error 红」）+ `tests/adapter.dsh.test.ts`（未知命令/执行出错→error、commands 未就绪→warn、命令成功输出→success）。

## 边界说明

- 高频行的「成功」不进 success 级（tool settle、command done ok、hook 通过均静默/低调），与「success=重要的操作成功」一致。
- `error: true`（旧失败标记）仍驱动的输入栏红色属输入状态子系统，不在本条 notice 行分级内，本次保留未动。
- demo/mock（`demo/mockAdapter.ts`）为演示夹具，随真实通道同步，不单独列入本表。
- 对账口径：以 **tone 调用点**（notice()/appendToolLine/appendNotice/带 tone 的 emit）为粒度全部入表；command/help 等通知的**正文内容**（如 /help 各条、命令错误包装文本）属已列 notice 的内容，不单列；历史面板 error 态、stderr 诊断、面板标题、工具参数摘要非 notice 通道，不在表内。
- DSH 宿主版本已随 `DSH-CTX-API.md` 基线更新至 `dsh-v0.1.5-rc.2`（tone 分级语义不变，本表 2026-09-09 核对结论仍适用；0.1.5 起 `code-dispatch*` → `ptc-dispatch*` 更名）。
