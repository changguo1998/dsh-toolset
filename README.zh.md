[English](README.md) | 中文

# dsh-toolset

DSH（DeepSeek Harness）进程内集成插件集：以 cordis bundle 方式挂载进 DSH 会话进程的一组 TypeScript 插件，补齐任务树、知识库与记忆、目标契约、指标循环等能力；另含一套自研终端 UI（TUI），是 Web UI / CLI 之外的第三种交互方式。

面向 agent 的协作规范见根目录 `AGENTS.md`；跨插件共享的 DSH 契约研读笔记见 `docs/host/DSH-CTX-API.md`（只读参考；最近一次逐条复核基于 `dsh-v0.1.7-rc.2`；`0.2.1-rc.2` / `0.2.1-rc.3` / `0.2.1-rc.5` 对照确认本项目消费面无变化，`0.2.2-rc.1` 则有多处接口面变化，见 `docs/host/HOST-UPGRADE-0.2.2-rc.1.md`（上一份 `docs/host/HOST-UPGRADE-0.2.1-rc.5.md`））。

## 组成

仓库含 `TUI/` 终端界面包与 37 个进程内集成插件，均为独立 npm 包（`@dsh-toolset/*`）：

| 包 | 功能 |
|----|------|
| **TUI**（`TUI/`，`@dsh-toolset/tui`） | 终端 UI：会话/回合区/状态列/输入区四区布局，事件化渲染、slash 命令、会话切换与清理、模型/审批面板；**零第三方运行时依赖**（源码零第三方 import，仅复用本仓 `clock-base` 的时钟探测，颜色走 manual ANSI） |
| **clock-base** | 定时器统一面：服务 `clock`（`now()` + `scope(ctx)` 返回的 `schedule(delayMs, cb)` / `interval(delayMs, cb)`；撤销动作登记在调用方 `ctx.effect` 上，插件卸载不留活定时器，句柄默认 `unref`），另导出可手控的 `ManualClock`（推进时间、按到期顺序触发）供测试用。与宿主 `cordis-plugin-timer` 并存、不包装：宿主无 `schedule`、不支持 `unref`、mixin 需硬 `inject`，包装代价更大 |
| **herdr-integration** | herdr 面板桥：agent 状态经 unix socket 上报 herdr 面板，并桥接 blocked 事件（ask-user 提问、approval 审批、turn 阻塞三类信号源） |
| **herdr-use** | herdr 终端读写：十个模型侧工具 `herdr_list` / `herdr_read` / `herdr_info` / `herdr_wait` / `herdr_create` / `herdr_close` / `herdr_label` / `herdr_text` / `herdr_key` / `herdr_run`（无 `action` 参数）；一个终端 = 一个 tab + 自带 root pane，`terminal_id` 取 root pane id，模型不接触 pane / tab / workspace；前台 lane 继承父 herdr 会话，后台 lane 落在 `dshbg` 会话并在缺会话时自动拉起 headless server；每个 dsh 会话按 lane 严格绑定一个 workspace；另向进程内提供 `herdrUse` 服务面，与工具面共用同一 registry 与同一把锁；写类工具过 read-only 沙箱闸与 security-guard 登记 |
| **task-engine** | 任务树引擎：Frame 状态机、`decompose`/`implement`/`execute`/`stop`/`status` 工具族、机械+语义双重门禁与 RET 验收路由 |
| **session-paths** | 宿主会话目录编码的仓内唯一事实源：逐字符复刻 `@deepseek-ai/dsh-session-persistence-jsonl` 的 `encodeSegment` / `projectKey` / `projectDir` / `sessionDir`，以服务 `sessionPaths` 供其他插件共用（`root` / `projectKey` / `projectDir` / `sessionDir` / `sessionDirFor` / `ensureSessionDir`）。纯函数不落盘；`sessionDirFor(sessionId)` 经宿主 `sessions` 服务取 `header.cwd`（可选读取，不写进 `inject`） |
| **shell-parse** | 仓内唯一的 shell 命令词法层：`splitCommandSegments`（按 `;` `\|` `&` 与换行切段，引号内不切）/ `tokenizeSegment`（引号串整体一个词，粘引号先断开）/ `commandPositions`（剥离 `sudo` / `env` / `timeout` / `xargs` / `uv run` / `npx` / `pnpm exec` / `bundle exec` 等包装器后取命令位，并对 shell `-c`、`eval`、`$(...)` 与反引号递归，深度封顶）/ `commandWords` / `isDynamicCommand` / `substitutionBodies` / `WRAPPERS`。纯函数 + 同实现的 `shellParse` 服务；无配置、不注册工具、不落盘 |
| **memory-base** | 分层记忆存储：S / P / U 每层一个 SQLite 库（惰性创建，S 层存放位置经 `sessionPaths.sessionDirFor`）与每分类双 FTS5 索引。只做存储：注册 kind 即建表、写入与删除经返回的作用域句柄（`writableTiers` + `preWrite`），查询全局可用（跨 kind / 跨层 `search` 与 `list`）；模型侧只有一个只读工具 `memory_query` |
| **goal-contract** | goal 会话契约起草：interview 式提问导出「目标 + Done-when 验证条款」（schema 对齐 task-engine 三级验收），落 dsh-goal 事件源 |
| **metric-loop** | 指标驱动自动循环：测量命令解析单个数字、plateau 平稳停止、轮数/时间/token 边界、cadence 自动唤醒 |
| **output-compress** | 大输出压缩：超阈值命令/工具输出的确定性摘要 + 切片索引写入自持的每会话 `digest.db`（每会话一个文件，经 `sessionPaths.sessionDirFor` 推导）；`is_error` 摘要另经写入作用域句柄进 memory-base（`kind: "digest"`、`tier: "session"`），原始大输出不进模型上下文 |
| **fs-digest** | 上下文感知文件读取：`outline`/`signatures`/`pruned` 三模式返回最小充分上下文，替代整文件 `read` |
| **hash-edit** | LINE:HASH 锚定编辑：读取得到每行内容哈希锚点，编辑按锚点定位，内容过期（stale）整批拒绝、防脏写 |
| **ast-tools** | 基于 ast-grep 的 AST 结构搜索、结构化替换、文件大纲与 YAML 规则执行（经系统 CLI 子进程，零运行时依赖）；注册模型侧工具 `ast_query`（AST 搜索 / 大纲 / 规则）与 `ast_replace`（默认 dry-run） |
| **md-logic** | Markdown 逻辑结构（单文件，读 + 按节改写）：节树（每节带 `L{起}-{止}` 行范围）、块清单（列表 / 表格 / 代码块 / 引用 / frontmatter / html / hr，带嵌套层数与表格行列数）与链接 / 图片 / 引用式定义清单；注册模型侧工具 `md_logic`（读面 `structure` / `blocks` / `links`，写面 `replace` 按节整节替换 / 删除），解析基于 `marked` |
| **md-map** | Markdown 项目级结构与引用分析（文档版的 `code-map`）：索引 `**/*.md` 的标题锚点、文档间链接（`internal`）、wiki 链接、行内代码路径引用（`kind:ref`）、代码 / 文件 / 目录引用与站外链接，以及被引计数，查询面 `callers` / `impact` / `orphans` / `report`（含断链与断锚点）；注册模型侧工具 `md_map`，单文件解析复用 `md-logic` |
| **security-guard** | 安全守卫：危险命令黑名单 + 敏感文件保护策略层，挂在宿主**单调守卫** `ctx.tools.guard`（已拒的调用不能被后续监听器翻回放行），宿主无该面时回退 `tools/pre-execute` waterfall |
| **code-map** | 代码结构地图：文件节点 + import 图索引，`callers`/`callees`/`cycles`/`impact` 查询与项目/模块报告（引用为候选：`callers` 的语义精度需官方 LSP 三件套，而 profile 不分发它，故回落 `structural`）；经 `link:` 依赖 `@dsh-toolset/ast-tools`（挂载时需一并安装） |
| **context-report** | 会话上下文与用量报告：host-only 投影 `sessionContext` 只折官方空缺的部分（token 分桶），回合/步与墙钟读官方 `sessionStats` 投影；工具 `context_report` 合成 token-meter 即时压力与模型容量读数 |
| **rule-engine** | 规则触发的自动注入：按关键词/正则/内置谓词匹配模型正文、工具调用与回合边界，命中后作为独立新回合（`followup`）、挂到最近 pre-step 并唤醒（`steer`）或不唤醒（`inject`）注入 user-role 消息；提供按节点的消费者注册面（`registerConsumer`，`sources` 缺省 `turn-end`，同步询问、统一注入）与只读 `evaluate` |
| **behavior-correction** | 行为纠正（`tools/pre-execute` 上的 rule-engine guard 消费者）：在工具执行前按自身 config 的规则表比对工具名 + 参数字符串，命中即拒绝该调用、理由写明该改用的专用工具。缺省规则拦下 `bash` 里含 `herdr` 的命令并指向 `herdr_run` / `herdr_text` / `herdr_key`（写类）与 `herdr_read` / `herdr_list`（查看类），另一条缺省规则经 `@dsh-toolset/shell-parse` 解析命令位、拦下命令位跑解释器（python / node / ruby / perl / php / lua / deno / bun 等）并指向 `script_run`；`rules` 给即整体替换，空数组 / `enabled: false` 不拦；`ruleEngine` 是硬依赖（写进 `inject`），运行期服务缺席只告警、不拦截 |
| **symbol-normalizer** | 符号规范：模型正文符号的展示层归一（别名替换）+ 回合审查（人类 notice / 模型反馈），以 rule-engine 消费者形式接入；provide `symbolNormalizer` 服务供 TUI 消费 |
| **ponytail** | ponytail 模式（2026-10-05 起缺省开启；`enabled: false` 关闭）：会话起始注入「懒资深工程师」7 级决策阶梯（YAGNI → 复用 → 标准库 → 平台特性 → 已装依赖 → 一行 → 最少代码）。 |
| **md-table-check** | 回复正文表格列数检查（`assistant-text` 上的 rule-engine 消费者）：逐行比对表头 / 分隔行 / 数据行的单元格数，不一致时注入一条汇总提示（表头行号 + 摘录 + 期望与实际列数），要求模型更正后重新回复。只报不改：不改写回复正文与任何文件；列数一致的表格、宽度退回的表格与伪表格都不报 |
| **auto-approve** | 审批链自动裁定：作为 `approval/request` 应答者按优先级阶梯（拒绝名单 → 会话指纹 → 形态覆盖层 → 只读类 → 路径 / 命令白名单 → 沙箱升级白名单 → LLM 灰区审查）给出 `allowed-once` / `rejected`，未命中交 TUI 审批面板；**人工放行学习**：把面板放行沉淀为同会话的形态覆盖（引号串 / 长 hex / 数字抹值，第二次成功观测才做最小泛化，LLM 准入审阅，重启从会话日志回填），命令面 `learn off|on|list|undo|clear`；审计双写（会话 JSONL + memory-base `approval_audit`，不记参数原文）；`/autoapprove status|mode|on|off|log|clear-fingerprints`；关闭或未挂载时行为与宿主原生一致 |
| **session-channel** | 跨会话消息通道（专用 Redis 实例 + unix socket）：`peers`/`send`/`inbox`/`status`，消息注入目标会话的下一回合（形如 `[CHANNEL](来源) 正文`）；provide `sessionChannel` 服务（含别名、共享 KV：last-value + 版本号，以及跨会话委托：`channel_delegate`/`channel_task`/`channel_task_result` + 任务表 + 结果自动/显式回传） |
| **session-title-cutoff** | 会话标题 provider：触发保持 all-prompts，参考窗口改为「最近一次 `git commit` 之后」的人类消息（无提交/窗口为空回退全量）；接管 `ctx.sessionTitle` 唯一 provider，需在 profile 禁用官方 all-prompts 实现 |
| **preference-analysis** | 偏好分析：订阅 `session/event` 抽三条结构化信号（重复约束 / 纠正加权 / 审批拒绝），按 3-gram 相似度并入跨会话账簿（唯一状态源），达高置信自动写入 memory-base 项目层并经一个 rule-engine 消费者注入；模型提议一律落候选待审，撤销 / 退休 / 老化都记抑制键。首期零 TUI 改动 |
| **command-template** | 模板体系：把提示词流程写成 `.md` 模板（YAML 子集 front-matter）并统一经一个 slash 命令调用（`/playbook <模板> [参数]`，另有 `list` / `show` / `reload` 子命令）——双源目录（随包 `templates/` + 用户 `~/.dsh/command-templates`，同名用户优先）、步骤 `prompt`（注入当前会话）与 `agent`（一次性子代理，可覆盖模型且仅本次生效）、`{{stepId}}` 串链、`bestOf` + `judge` 裁判 |
| **script-interpreter** | 模型侧脚本解释器：`script_run` 执行一段**已启用语言**的脚本（首期 Python；bash 后端随包实现但缺省不启用）。脚本正文经 stdin 交给解释器（不落临时脚本文件），每次调用都是新进程；非零退出码回执 `[exit code: N]`、不是工具错误；输出过长保留尾部并把全文落到 `0600` 文件；执行前经 `ctx.sandboxPolicy` + `ctx.sandbox` 围栏，拿不到可强制后端即 fail-closed `SANDBOX_UNAVAILABLE`；三个可选服务经 `ctx.get` 受保护读取（cordis 对未 inject 的服务直读会抛） |
| **background-daemon** | 面向「agent 会话投递」的进程内调度：选择器 `after_seconds` / `at` / `every_seconds` / `daily` / `weekly`（首期无 `cron`）；两条渠道 —— `deliver`（user 消息经 `agent.followup`，再以 `sessions.flush` 作 L2 确认）与 `command`（slash 命令，执行前过引擎侧 `security-guard` 复查）；重启补算（周期任务只补最近一次错过的时点，一次性任务 24 h 窗口内仍触发）、单 timer、不重试；`/daemon` 子命令 + `daemon_task` 模型工具；记录落 memory-base（`daemon_task` / `daemon_run`）并带本地 JSON 降级 |
| **agent-group** | 群组编排：组 / 成员 / 主从连接（含等级）/ 指令与回报；`check` 时懒判定结算（成功 / 失败 / 受阻 / 超时 / 已移除），移除逐层下推，拒绝带原因与下一步；依赖 session-channel（传输）与 session-paths（状态存放位置） |
| **coagent** | 长驻 agent 拉起与收尾：经 `herdrUse` 服务面建终端、在其交互 shell 里发 `fffdsh`、用 session-channel 的 `peers` 认领新会话，回执 `terminal_id` / `session_id`；职责只到拉起与收尾，派任务与编排分别归 session-channel 与 agent-group；拉起失败回滚终端并落 `failed` 记录（含失败码与屏摘要） |
| **tool-consult** | 工具咨询与按需揭示：模型描述要做什么，`consult_tools` 按关键词索引返回名称 + 一句话并揭示给当前会话（宿主 `tools.restrict` 遮罩 + 单条活动 mask 替换）；缺省只留 9 个核心工具；咨询即授权，揭示在会话内只增不减（`revealScope: session`）或仅本回合（`turn`，带 `ttlTurns` / `pin`）；调用被遮罩的工具返回「先咨询」的可行动文案；任一路径失败（无 agent 作用域 / `restrict` 抛错 / 名单失配 / 空交集）降级为「不遮罩」而不中断会话 |
| **term-check** | 回复正文术语检查：`assistant-text` 上的 rule-engine 消费者，按 `docs/GLOSSARY.md`「禁止术语」表扫描回复里的旧称，命中时注入一条更正提示（`followup`，每会话只注入一次），要求模型按表里的「应当使用」更正后完整重发。术语表以构建期快照随包发布（`pnpm run gen:glossary`，解析复用 `check:docs` 同一份 `loadGlossary`），故非本仓项目也能审查；条件型术语（模块 / 工具集 / 收口）、带豁免标记的行（原名 / 旧称 / 历史对照 / 不再使用）与已知误配（「夺回归属」里的「回归」）跳过。按决策不做代码段掩码：引用旧称做示例可能被提示一次，注入文案已写明这类情况可忽略。只报不改：不改回复正文，也不改任何文件 |
| **pin-note** | 跨压缩上下文保持：模型用 `pin_note` 把要点（≥ 20 字）登记进本会话记忆库；每次 `agent/pre-step` 先经 `session.deriveMessages()` 读当前上下文，同一段正文已在上下文里就跳过注入（老宿主回退到投影上的 payload 比对），否则折叠进 `decision.messages`（user 消息，自定义 `source: pin-note`）并在 `agent.inbox` 只留一条。压缩把这条消息移出上下文后，下一步重新插入——这就是「跨压缩在场」，长回合里也只会看到一段。`note_list` / `note_remove` 管理条目；合计建议 < 10K 字符（只提示不硬限）；作用域只有会话层，随会话结束失效。`ctx.memory` 缺席或 `pin` 分类注册失败时降级为一条告警 |
| **flow-track** | 标准流程固化（只提示不拦截）：经 rule-engine 消费者在 `turn-start` + `user-message` 注入八阶段模板（目标 / 调研 / 决策 / 规划 / 实现 / 测试 / 审查 / 收尾，每阶段单动作 spec + 验收口径 + `deps` 链 + mechanical / human 门禁），但仅当进程内开关打开（缺省关闭、只在内存，`/flow-track on|off|status` 或 `flow_enable` 切换）且 memory-base 里存在最新阶段不是「收尾」的流程记录时才注入；`flow_record` / `flow_status` / `flow_enable` / `flow_remove` / `flow_rollback` 读写开关/删/回退各阶段推进（memory-base 项目层，kind `flow`，标题 `<slug>@<阶段>`）；写入按八阶段顺序逐 slug 判定（首条必须是「目标」，只能更新当前阶段或新增下一阶段，跳过与倒回被拒，回退走 `flow_rollback` 清掉后续阶段；删可按 id 或 slug）；当前阶段由只读的 `taskEngine.query()` 快照推导（帧栈末位 → 标题 → 阶段），另挂 `session/event` 数写类工具调用，改了文件却没有任何流程记录时给一条合规提示。不拦截任何工具调用；开关关闭时不注入任何内容；`taskEngine` 缺席只给记录，`memory` 缺席则恒不注入 |
| **escalation-hint** | 沙箱升级提示补齐：订阅宿主 `tools/post-execute`，在「调用被沙箱拒绝、但宿主没有渲染 `[sandbox: escalation available …]` 提示」时（`denied` 由英文 stderr 签名判定，本地化报错必然漏判）经 `additionalContexts` 追加一条 user 消息，提示模型对同一调用加 `sandbox_permissions` + `justification` 重试一次；三层判据（已有提示 → 跳过；命中宿主 `[sandbox: file access denied under <mode> mode]` / `FS_SANDBOX_DENIED` → 补；否则用结构化 `exitCode` + `sandbox.mode` + 写形状命令兜底）覆盖 `bash` / `pwsh` 与 `write` / `edit` / `str_replace_editor`；只提示、不拦截 |
各包 `package.json` 均携带 `dsh.bundle` 集成契约与 `cordis.patch.yml`；功能细节见各包 `README.md`，开发状态见 `docs/STATUS.md`。

## 目录结构

```
dsh-toolset/
├── TUI/                  # 终端 UI 包（src/app 状态层、src/renderer 渲染层、src/app/adapter 适配层、demo/ mock）
├── clock-base/           # 定时器统一面（服务 clock：now + schedule / interval，随调用方 fiber 释放，带手控假时钟）
├── herdr-integration/    # herdr 面板桥
├── herdr-use/            # herdr pane / tab 读写（交互式命令驱动）
├── task-engine/          # 任务树引擎
├── session-paths/        # 会话目录编码（宿主编码复刻 + sessionPaths 服务）
├── shell-parse/          # shell 命令词法（切段 / 分词 / 剥离包装器 / 命令位 + shellParse 服务）
├── memory-base/       # 知识库与持久记忆
├── goal-contract/        # Done-when 契约起草
├── metric-loop/          # 指标循环
├── output-compress/      # 大输出摘要入库
├── fs-digest/            # 文件摘要（outline/signatures/pruned）
├── hash-edit/            # LINE:HASH 锚定编辑
├── ast-tools/            # AST 搜索/替换/大纲/规则
├── md-logic/            # Markdown 逻辑结构（节树 + 块 + 链接，带行范围，模型工具 md_logic）
├── md-map/              # 文档版 code-map（锚点 / 引用 / 影响面 / 断链，模型工具 md_map）
├── security-guard/       # 危险命令与敏感文件防护
├── code-map/             # 代码结构地图（符号/import 图、查询与报告）
├── context-report/       # 会话上下文/用量报告（sessionContext 投影 + context_report 工具）
├── rule-engine/          # 规则触发的自动注入（规则 / 消费者面 + 注入器）
├── behavior-correction/  # 行为纠正（rule-engine 的 tools/pre-execute guard 消费者；缺省拦 bash 里的 herdr）
├── symbol-normalizer/    # 符号规范（展示归一 + 回合审查，rule-engine 消费者）
├── ponytail/             # ponytail 模式（决策阶梯注入；rule-engine 消费者；缺省开启）
├── md-table-check/       # 回复正文表格列数检查（rule-engine 消费者；缺省开启，只报不改）
├── auto-approve/         # 审批链自动裁定（approval/request 应答者；审计双写）
├── background-daemon/    # 面向会话投递的进程内调度（/daemon + daemon_task；记录落 memory-base）
├── session-channel/      # 跨会话消息通道（专用 Redis 实例 + unix socket）
├── session-title-cutoff/ # 会话标题 provider（all-prompts 触发不变，参考窗口=最近一次 git commit 之后）
├── command-template/     # 模板体系（slash 命令模板 + 模板级模型选择，双源模板目录）
├── script-interpreter/   # 模型侧脚本解释器（script_run：单次执行 Python；围栏 + 溢出落盘 + 审批开关）
├── preference-analysis/  # 偏好分析（行为归纳 + 账簿 + 自动应用；rule-engine 消费者）
├── agent-group/          # 群组编排（组 / 成员 / 主从连接 / 指令与回报）
├── coagent/              # 长驻 agent 拉起与收尾（herdrUse 终端 + fffdsh + 会话认领；只管拉起与收尾）
├── tool-consult/         # 工具咨询与按需揭示（关键词索引 + tools.restrict 遮罩；咨询即授权）
├── escalation-hint/      # 沙箱升级提示补齐（tools/post-execute + additionalContexts；只提示不拦截）
├── term-check/           # 回复正文术语检查（rule-engine 消费者；术语表快照；只报不改）
├── pin-note/             # 跨压缩上下文保持（pin_note / note_list / note_remove；按上下文去重注入）
├── flow-track/           # 标准流程固化（开关控制的注入 + flow_record / flow_status / flow_enable / flow_remove / flow_rollback；只提示不拦截）
├── profiles/             # profile 配置示例（example：清单 + 用户层 patch + pnpm 三件套；见 profiles/README.md）
├── scripts/              # install.sh（新机器一键安装）；测试调度脚本
├── docs/                 # 状态表、待办清单、agent 面组合说明、架构对照与宿主包清单
├── archive/              # 已归档：完成的任务清单与历史调研记录
├── AGENTS.md             # 面向 agent 的协作规范（语言/命令/格式化/构建部署/变更流程）
├── docs/host/DSH-CTX-API.md        # 跨插件共享研读笔记（只读）
└── package.json          # 根脚本：委托全部子包的 check/build/test
```

## 快速开始（构建与测试）

仓库根 `package.json` 委托全部子包：

```sh
pnpm run check   # 全部子包类型检查（tsc --noEmit；与 test 同款并行调度）
pnpm run build   # 全部子包编译到 dist/（并行；code-map / md-map 排在第二批）
pnpm run test    # 全部子包测试并行运行（scripts/test-parallel.sh）
pnpm run demo    # TUI 构建并运行 mock demo（无 DSH 依赖）
pnpm run demo -- --smoke   # TUI 冒烟检查（帧断言 SMOKE_PASS）
pnpm run test:tui          # TUI 单包测试快捷入口（可接名字正则/文件名过滤）
pnpm run test:smoke        # goal-contract / metric-loop / output-compress / security-guard 的真机 smoke
```

`test:smoke` 委托 `scripts/run-smoke.sh`：把 `DSH_HOME`、`TMPDIR` 与日志都收进仓库 `tmp/`，因此在沙箱里也能跑（不写 `~/.dsh`）。模型缺省走本机 tollgate 网关（`TOLLGATE_API_KEY=local`、provider `tollgate`、model `qwen38`），可用 `TOLLGATE_API_KEY` / `TOLLGATE_BASE_URL` / `SMOKE_PROVIDER` / `SMOKE_MODEL` 覆盖。

单个子包内直接运行各自的 `pnpm run check / build / test / demo`（TUI 另有 `bench`、`smoke:pty`）。命令细节、并行调度参数与过滤用法见 `AGENTS.md`。

## 接入 DSH profile 使用

新机器一键安装（装 dsh → 构建全部插件 → 建 profile 挂载 38 个包：TUI + 37 个插件）：

```sh
git clone <本仓库> && cd dsh-toolset
scripts/install.sh                 # profile 名默认 fff；同时生成 fff-test
scripts/install.sh --help          # --profile/--profile-test/--no-test-profile/--mode/--plugins/--dsh-version/--skip-dsh/--skip-build/--force/--sync/--take-over-title/--dry-run/--skip-verify
```

一次运行生成**两个** profile，只有插件链接方式不同：

| profile | 依赖 | 是否跟仓库改动 | 用途 |
| --- | --- | --- | --- |
| `fff`（主） | `file:` 快照 | 不跟；重跑 `scripts/install.sh --profile fff --sync` 才刷新 | 正在跑的会话 / 验收 |
| `fff-test` | `link:` 符号链接 | `pnpm run build` 后立即生效 | 新窗口实时开发 |

主 profile 是真实副本：pnpm 对 `file:` 目录依赖默认用硬链接，脚本会再整包复制一次断开这些链接（否则仓库里的原地改写——如 `tsc` 输出——会顺着同一个 inode 串到 profile）。刷新靠脚本在安装前删掉 pnpm 的「已是最新」标记（pnpm 不跟踪 `file:` 目录的内容变化，已实测）。伴随 profile 直接复用主 profile 的成品 `dsh.profile.bundles` / `cordis.patch.yml` / `pnpm-workspace.yaml`（后者照抄时剥掉 copy 模式的 overrides 生成区，否则嵌套 `link:` 依赖会被钉成 `file:` 快照），只把依赖值改成 `link:`。`--no-test-profile` 只装主 profile，`--profile-test <名>` 改伴随名，`--mode link` 让主 profile 也用软链接。

脚本幂等：配置文件默认保留（`--force` 才覆盖），且仅在内容确有变化时写入并备份（`.bak.<时间戳>`），反复 `--sync` 不会堆积备份。只写 `$DSH_HOME`（默认 `~/.dsh`）与本仓库。`--sync` 按当前选择集刷新本仓库插件（已不在选择集的本仓库条目移除，用户自加条目保留），且不改写 `cordis.patch.yml` 的标题 provider 配置：禁用官方 all-prompts provider 是显式选择（`--sync --take-over-title`），不带开关时只在检测到冲突时提示。`--sync --force` 组合被拒（会覆盖 patch 并丢掉生成的接管片段）。生成片段按 patch 内容重建，带开关重跑只补缺；删除以 `# install.sh generated: title-takeover-` 开头的行即放弃接管。

插件构建并行执行（GNU parallel，缺则 `xargs`，再退回串行）：`BUILD_JOBS` 覆盖并发数（默认 CPU 核数），`BUILD_RUNNER=parallel|xargs|serial` 强制调度器。依赖安装仍串行；`code-map` / `md-map` 因 import 对应包的构建产物，排在 `ast-tools` / `md-logic` 之后构建。

手工配置时各插件以 cordis bundle 方式挂载到 DSH profile。示例（`~/.dsh/profiles/fff`，详见 `TUI/README.md`）：

```jsonc
// <profile>/package.json
{
  "dependencies": { "@dsh-toolset/tui": "file:<本包路径>" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@dsh-toolset/tui"] } }
}
```

依赖值二选一：`file:` 为稳定安装（安装时留副本，重跑安装才刷新），`link:` 为实时开发（构建产物经 symlink 立即可见）。正式发布形态为 `dsh plugin --profile <p> add <包名>`。核对组合树用 `dsh --profile <p> --dump-config`，启动用 `dsh --profile <p>`。

仓库内 `profiles/example/` 是可直接复制的 profile 三件套示例（清单 + 用户层 patch + pnpm 配置），演示 `- id:` 覆盖与 `- insert:` 新增两种方言、`!!js` 表达式，以及权限预设表覆盖（自定义沙箱 + 审批捆绑预设）；部署步骤与边界见 `profiles/README.md`。

### agent 面组合（不使用 preset）

本项目只用 TUI，agent 面由 profile 的全局组合提供（`dsh-base` + 本项目 bundles + `cordis.patch.yml`），**不配置也不加载 agent preset**：官方设计里 TUI 是"没有 preset 的单组合面"，`/preset` 提示「agent 预设服务不可用」属正常。要改工具 / 提示 / 人格请落 profile 用户 patch；需要多套组合用多个 profile。官方依据、本机验证与 0.1.7 版本断层见 `docs/host/AGENT-COMPOSITION.md`。

## 文档

索引只此一处（`AGENTS.md` 不重复列清单）；维护中的文档开头三行写明「职责 / 不负责 / 过期条件」。

变更流程分两条：标准流程见 `docs/WORKFLOW-STANDARD.md`、小改动快速流程见 `docs/WORKFLOW-FAST.md`，简版见 `AGENTS.md`「内容变更规范」。

**项目级（`docs/`）**

- `docs/ROADMAP.md` — 未来开发方向与完成判据（进度、排期与条目见 `docs/BACKLOG.md` §3 里程碑）。
- `docs/BACKLOG.md` — 可执行条目：跨包功能与缺陷（P0/P1/P2）+ 里程碑 + 插件规划。
- `docs/STATUS.md` — 对照文档：记录已实现的内容（由维护者择时更新）。
- `docs/ARCHITECTURE-REUSE.md` — 复用审计（31 包快照 = TUI + 30 插件，2026-10-22；`coagent` / `tool-consult` / `escalation-hint` 3 包未审；结论分布改用 0 / 保留 22 / 并存 9）：「官方是否有等价物」与「改用 / 保留 / 并存」结论及理由。
- `docs/WORKFLOW-STANDARD.md` — 内容变更规范 · 标准流程（详版）。
- `docs/WORKFLOW-FAST.md` — 内容变更规范 · 快速流程（小改动）。
- `docs/GLOSSARY.md` — 术语表：术语选择与替换表（包 / 插件、追踪文档、符号、界面名等）。
- `docs/implementation/`、`docs/archived/` — 跨包条目的追踪文档（进行中 / 已关闭）。

**宿主面（`docs/host/`，不参与变更流程，升宿主后必复核）**

官方接口研读与升级文档的集中地——**不限 dsh-base**：任何宿主官方接口（ctx API、各子系统与子包的契约）的研读笔记都放这里。

- `docs/host/DSH-CTX-API.md` — 宿主 ctx 接口研读笔记（跨插件契约，只读参考）。
- `docs/host/HOST-PACKAGES.md` — 宿主官方包与服务字典（生成物，升宿主后重新生成）。
- `docs/host/HOST-UPGRADE-0.2.2-rc.1.md` — 当前升级对照（0.2.1-rc.5 → 0.2.2-rc.1）与实施状态；上一份 `docs/host/HOST-UPGRADE-0.2.1-rc.5.md`（0.2.1-rc.3 → 0.2.1-rc.5）。
- `docs/host/AGENT-COMPOSITION.md` — agent 面组合现状与官方依据（TUI 走 profile 全局组合、不配 preset）。
- `docs/host/AGENT-ARCHITECTURE-ANALOGY.md` — 官方 agent 架构与接口对照（task-engine、memory-base 的设计依据）。

**模块级（`TUI/docs/`、`<包>/docs/`）**

- `TUI/README.md`、`<包>/README.md` — 模块入口：用法、配置、契约、边界。
- `TUI/docs/DESIGN.md`、`<包>/docs/DESIGN.md` — 架构设计与机制取舍（`TUI`、`task-engine`、`memory-base`、`session-channel`、`code-map`、`rule-engine`、`symbol-normalizer`、`output-compress`、`ponytail`、`command-template`、`md-logic`、`md-map`、`preference-analysis`、`agent-group`、`coagent` 有；轻量包只留 `README.md` + `docs/BACKLOG.md`）。
- `TUI/docs/SPEC.md` — 渲染管线规格；`TUI/docs/COMMANDS.md`、`TUI/docs/COMMANDS-SPEC.md` — 命令清单与扩展规格。
- `TUI/docs/design/` — TUI 内部规范：`NOTICE-LEVELS.md`（提示分级）、`AUDIT-colors.md`（配色语义）、`REFACTOR.md`（模块拆分约定）。
- `<模块>/docs/BACKLOG.md` — 模块待办（有未完成项的模块各一份）；`<模块>/docs/STATUS.md` — 模块级对照文档（TUI 已有）。

**协作与历史**

- `AGENTS.md` — 面向 agent 的协作规范（语言、命令、格式化、构建部署、变更流程、内容变更规范简版、结构约定、Git）。
- 根 `archive/` — 根级历史（已完成清单、历史调研、旧版契约快照、完成使命的升级文档）；模块历史进 `<模块>/docs/archived/`。
- 不维护 `CHANGELOG.md`：变更记录以 `git log`（Conventional Commits）与 `docs/host/HOST-UPGRADE-*.md` 为准。
