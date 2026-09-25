# TUI 提示信息分级总表（NOTICE-LEVELS）

> 职责：提示信息分级约定（level 与呈现口径）
> 不负责：各命令的具体行为（见 `TUI/README.md`）
> 过期条件：无

> 依据：notice / tool 行 tone 的**4 级语义 5 色值**权威口径，见 `src/app/adapter/types.ts` 的 `NoticeTone` 注释。
> 对账口径：以 **tone 调用点**（`notice()` / `appendNotice` / `appendToolLine` / 带 tone 的 emit）为粒度全部入表；命令与 help 的**正文内容**属已列 notice 的内容，不单列；面板标题、工具参数摘要、历史面板 error 态、stderr 诊断非 notice 通道，不在表内。

| 级 | 色 | 判定标准 |
| --- | --- | --- |
| `error` | 红 | 用户操作失败、会话中断、必须修复才能继续；**用户输入命令的结果一律 error**（可重敲绕开也不降级） |
| `success` | 绿 | 用户操作成功，仅重要的操作才报（命令成功结果落 result 级） |
| `warn` | 黄 | 命令运行错误但可绕开 / 修复、任务仍可进行；有其他副作用或属危险操作的警示；服务不可用 |
| `info` | 蓝 | 需要用户了解的提示信息 / 主动索取的信息展示 |
| `log` | 灰 | 展示运行进度与状态，无需用户关注 |

- 范围：App 层 `index.ts` 的 `notice()`、适配层 `adapter/dsh.ts`、reducer 层 `state.ts`。
- `—` = 有意静默 / 低调（高频行成功降噪）或无语义分级。
- 渲染侧映射 `NOTICE_TONE_COLOR`（`layout/content-rules.ts`）：log 灰 / info 蓝 / warn 黄 / error 红 / success 绿。

## A. App 层 notice()（src/app/index.ts）

### A1 服务不可用与降级（warn）

| 提示信息 | 来源（函数 / 命令） |
| --- | --- |
| 历史会话服务不可用（宿主未挂载 sessionQuery） | openHistory（/session） |
| 会话删除不可用（宿主未挂载 sessionQuery） | confirmDeleteRecord / confirmClean（/session 面板 d、x） |
| 会话切换不可用（宿主未配置会话持久化） | resumeToSession（无持久化能力） |
| no available models (llm service missing or no adapter registered) | openModelPicker（/model） |
| 审批策略服务不可用 | handlePolicy / commitStatusPanel（/policy） |
| 权限预设服务不可用 | handlePermission / commitStatusPanel（/permission） |
| agent 预设服务不可用 / agent 预设服务不可用：\<id> | handlePreset / commitStatusPanel（/preset 无参与带参失败） |
| jobs 服务不可用 | handleJobsCommand（/jobs 打开与取消路径） |
| sessionTitle 服务不可用 | handleRenameCommand（/rename） |
| \<label> 服务不可用（label = skills / tools / subagents / taskEngine / guard / knowledge / metricLoop / workflowEngine / settings / sessions / web） | 列表面板命令的入口、详情、定时刷新路径（openListPanel / showPanelDetail / showGuardPolicy / startPanelRefresh） |
| council 不可用（宿主无子代理启动面） | handleCouncilCommand（/council） |
| 契约解析不可用 | handleContractCommand（/contract，adapter 无解析面） |

### A2 用法与信息展示（info）

| 提示信息 | 来源 |
| --- | --- |
| /help 帮助内容 | handleSlash（/help） |
| goal/todo 详情见左侧信息栏 | handleSlash（/goal） |
| usage: /\<name> (no argument; opens the picker) | handleModelFocus（/provider、/effort 带参） |
| usage: /theme [light|dark|toggle] | handleThemeCommand（/theme 非法参数） |
| usage: /verbose on|off（当前：…） / usage: /symbol-unify on|off（当前：…） | handleVerboseCommand / handleSymbolUnifyCommand（无参或非法参数） |
| 用法：/policy [ask|never] | handlePolicyCommand |
| 用法：/rename \<标题> | handleRenameCommand（缺参） |
| already on current model \<label> | handleModelCommand（/model 带参） |
| 暂无 token 用量数据（本回合尚未发生模型调用）/ 用量三行（tokens 分解 / 上下文 / 缓存命中率） | handleStatsCommand（/stats） |
| 设置读取结果（`ns：value` 多行，secret 脱敏）/（无设置项） | handleSettingsCommand（/settings） |
| 知识库概要多行（就绪 / 路径 / chunk·source）/ 知识库尚未就绪 | handleMemoryCommand（/memory） |
| 契约概览多行（目标 + Done-when 条款摘要） | handleContractCommand（/contract） |
| 二次意见汇总多行（council 计数 + 每行意见首行） | handleCouncilCommand（/council） |
| 详情多行（skill / 工具 / 任务 / 循环正文）与 \<name>（无详情） | showPanelDetail（面板 Enter） |
| 策略快照多行（启用 / 黑名单 / 敏感文件 / 拦截计数）/（无策略快照） | showGuardPolicy（/guard Enter） |
| 搜索结果来源 URL | showPanelDetail（/search Enter，payload = url） |
| 该条目不可中断（无可用会话 id）/ 该条目无详情载荷 | handleKey Enter（diagnostic 行、无载荷行） |
| AGENTS.md 已存在，跳过初始化 | runInit（/init） |

### A3 命令结果（success / error / warn）

| 提示信息 | 来源 | 等级 |
| --- | --- | --- |
| 已切换到会话「\<title>」 | resumeToSession（/session Enter） | success |
| 已复制最后一条回复到剪贴板 | handleCopy（/copy） | success |
| theme: \<id> (\<palette>) | handleThemeCommand | success |
| 活动区：verbose on（完整折行）/ off（紧凑…） | handleVerboseCommand | success |
| 模型输出符号统一：on（替换 + 提醒）/ off（原样） | handleSymbolUnifyCommand | success |
| current model -> \<label> | handleModelCommand | success |
| 审批策略：ask（每次工具调用询问）/ never（工具调用自动放行） | handlePolicyCommand | success |
| agent 预设：已切换为 \<id> | handlePresetCommand | success |
| 已重命名为「\<title>」 | handleRenameCommand | success |
| 已分叉新会话 \<id>（新会话与当前不同时附 /session 提示） | handleForkCommand | success |
| 已请求中断子代理 \<id> | interruptAgent（/agents Enter） | success |
| job \<id> 取消请求已发送 | handleJobsCommand（/jobs Enter） | success |
| 无效命令: \<line> | handleSlash（语法无效） | error |
| \<model 命令错误文本>（模型未找到 / 多 provider 歧义 / 用法） | handleModelCommand | error |
| model command failed: \<err> | handleModelCommand / handleModelFocus | error |
| 标题不能为空 / 标题不能包含换行 | handleRenameCommand（本地拒绝，不发服务调用） | error |
| 中断失败（子代理可能已结束或不可中断） | interruptAgent（/agents Enter） | error |
| 没有可复制的模型回复 | handleCopy | warn |
| usage: /search \<query> | handleSearchCommand（缺 query） | warn |
| 分叉失败：\<原因>（5 个 SessionForkErrorCode 映射中文） | handleForkCommand | warn |
| 当前无活动目标/契约（无 goal 快照） | handleContractCommand | warn |
| \<符号规范>（建议用推荐符号或文字）（替换 / 警示合并反馈） | 符号统一（turn 结束后 warnModel） | warn |

### A4 会话面板结果（historyNotice：面板内留痕 + notice 同通道）

| 提示信息 | 等级 |
| --- | --- |
| 当前项目 / 全部目录没有可清理的空会话 / 没有可标记的会话 / 当前没有批量删除标记 | info |
| 当前活跃会话不可删除 / live 会话不可删除（仅可删除已持久化的非活跃会话）/ 该会话未持久化，没有可删除的文件 | warn |
| 删除失败：\<原因> | error |
| 已删除会话「\<label>」 | success |
| 已删除 N 个会话 / 已删除 N 个会话（M 个失败） | success / warn |
| 清理失败：没有会话被删除 | error |
| 已清理 N 个空会话 / 已清理 N 个空会话（M 个失败） | success / warn |

### A5 后台清理与渲染保护

| 提示信息 | 来源 | 等级 |
| --- | --- | --- |
| 已自动清理 N 个空会话 | 启动清理 | success |
| 已自动清理 N 个空会话（M 个失败）/ 自动清理空会话失败：N 个删除未生效 | 启动清理 | warn |
| 正在清理 N 个空会话... | 退出清理 | info |
| 已自动清理 N 个空会话（M 个失败）（Xms） | 退出清理 | success / warn |
| 清理空会话失败：N 个删除未生效 | 退出清理 | error |
| 退出清理异常：\<err> | 退出清理（异常兜底） | error |
| 已过滤 N 个非打印控制字符（渲染保护） | warnStrippedChars（turn 结束后兜底） | warn |

## B. 适配层 notice 归一化（src/app/adapter/dsh.ts）

| 提示信息 | 来源（事件 / 函数） | 等级 |
| --- | --- | --- |
| turn/end reason = error → `✗ <code>: <message>`（message 空时兜底 `✗ 输出错误`） | turnEndNotice | error（会话中断须修复） |
| 输出达 token 上限 | turnEndNotice（max-tokens） | warn（可绕开） |
| 已取消 | turnEndNotice（aborted） | info |
| 已中断 | turnEndNotice（interrupted） | info |
| 已阻塞（等待审批） | turnEndNotice（blocked） | warn（等待中） |
| completed / 未知 reason | turnEndNotice | —（静默，有意） |
| （模型输出已中断） | assistant/message.interrupted | info |
| invalid slash command: \<line> | runCommand（parse 失败） | error（命令结果） |
| commands 未就绪，无法执行 /\<name> | runCommand（无注册表） | warn（服务不可用） |
| /\<name> 执行出错：\<err>（同步抛错 / 异步 reject） | runCommand（execute 失败） | error（命令结果） |
| 未知命令，输入 /help 查看可用命令。 | finish（注册表未命中） | error |
| 命令 \<commandId> 执行出错：\<text> | finish（kind = error） | error |
| [\<commandId>] \<text>（命令成功输出） | finish（kind = success） | success（命令结果落 result 级） |

## C. reducer 层活动区行（src/app/state.ts）

| 提示 / 行 | 事件 | 等级 |
| --- | --- | --- |
| `✓ <detail>` 工具结果成功 | tool/result ok | —（低调：✓ 前缀绿、正文默认，高频降噪） |
| `✗ <name>: <detail 首行>` 工具结果失败 | tool/result fail | error |
| 正在压缩上下文... | compaction start | info |
| 压缩完成 | compaction end | success |
| 压缩完成：\<text 首行>（压缩摘要 toast） | compaction-summary | success |
| 压缩：已剪除 N 个节点 (~X tok) | compaction-prune | log（进度 / 状态） |
| 重试 X/Y (Zs): \<CODE> \<msg> | retry | warn（可绕开 / 进行中） |
| `↻ 重试中 (N)` | retry-started | log |
| `@ <label> <os\|ct>` 子代理行 | subagent | info |
| `⚑ workflow: <name>` / `⤷ <label>` workflow 运行行 | workflow run-start / agent-start | info |
| `↩ #<detail>` workflow 成员结束 | workflow agent-end | success |
| workflow 结束（toast，携 stopReason） | workflow run-end | success |
| `/> <name>` 命令运行行 | command run | log |
| `✗ /<name>: <text>` 命令失败行 | command done fail | error |
| 命令成功 | command done ok | —（静默：结果由命令自身 notice 呈现） |
| `⇥ <name>` 子派发（PTC） | ptc-dispatch start | log |
| `✗ <name>` 子派发失败 | ptc-dispatch settle fail | error |
| 子派发成功 | ptc-dispatch settle ok | —（静默，有意） |
| `⌗ <point>` hook 调用行 | hook invoked | log |
| hook/result 通过 | hook result ok | log（成功不显 success 绿，降噪） |
| `✗ <point> (<decision>)` hook 拒绝行 | hook result fail | error |
| 计划提醒触发 | schedule dispatch | log |
| 反馈已记录 | feedback | success |

## 边界说明

- 高频行的「成功」不进 success 级（tool settle、command done ok、hook 通过均静默 / 低调），与「success = 重要的操作成功」一致。
- `error: true`（旧失败标记）仍驱动输入栏红色，属输入状态子系统，不在本条 notice 行分级内。
- demo / mock（`demo/mockAdapter.ts`）为演示夹具，随真实通道同步，不单独列入本表。
