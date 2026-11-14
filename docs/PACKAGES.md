# 包清单与职责

> 职责：42 个包（TUI + 41 个插件）的一句话职责、TUI 目录要点、`DESIGN.md` 轻重包口径
> 不负责：各包的详细用法 / 配置 / 契约（见各包 `README.md` 与其 docs/）；面向人的能力表见根 `README.md` 的 `Composition` 一节
> 过期条件：新增 / 删改包时随仓库维护

本仓 42 个包 = `TUI/` 终端界面包 + 41 个进程内集成插件（`clock-base` / `herdr-integration` / `herdr-use` / `task-engine` / `memory-base` / `goal-contract` / `metric-loop` / `output-compress` / `fs-digest` / `hash-edit` / `ast-tools` / `md-logic` / `md-map` / `security-guard` / `code-map` / `context-report` / `rule-engine` / `behavior-correction` / `symbol-normalizer` / `session-channel` / `session-title-cutoff` / `command-template` / `ponytail` / `md-table-check` / `auto-approve` / `background-daemon` / `preference-analysis` / `session-paths` / `script-interpreter` / `agent-group` / `coagent` / `tool-consult` / `escalation-hint` / `term-check` / `pin-note` / `flow-track` / `cache-hit-monitor` / `shell-parse` / `tool-surface`）。

## TUI

`TUI/src/app/` 状态与纯函数层（state/layout），`TUI/src/renderer/` 终端渲染层，`TUI/src/app/adapter/` 插拔适配层，`TUI/demo/` mock demo。

## 插件（39 个）

| 包 | 一句话职责 |
| --- | --- |
| clock-base | 定时器统一面：服务 `clock` 的 `now()` 与 `schedule(delayMs, cb)` / `interval(delayMs, cb)`，排期随调用方 fiber 卸载撤销、默认 `unref`，另带手控假时钟 `ManualClock`；与宿主 `cordis-plugin-timer` 并存、不包装 |
| task-engine | 任务执行引擎（Frame 状态机、工具族、双重门禁、RET 三级路由） |
| session-paths | 会话目录编码：复刻宿主的 `encodeSegment` / `projectKey` / `projectDir` / `sessionDir`，以服务 `sessionPaths` 供其他插件共用；纯函数不落盘，`ensureSessionDir` 是唯一写盘入口 |
| shell-parse | shell 命令词法：切段（引号内不切）/ 分词 / 剥离包装器（`sudo` / `env` / `timeout` / `xargs` / `uv run` / `npx` / `pnpm exec` / `bundle exec` 等）/ 命令位解析，并对 shell `-c`、`eval`、`$()` 与反引号递归；纯函数 + 服务 `shellParse`，供 `security-guard` / `auto-approve` / `behavior-correction` 共用 |
| tool-surface | 工具说明注册表：注册前把定义换成短说明 + 宽松占位，全文与完整 schema 收进 catalog，派发前按全文严格校验；只读服务面 `toolSurface.lookup(name)` / `list()` 供 `tool-consult` 揭示后投递；依赖宿主 `@deepseek-ai/dsh-tools` 精确版本 |
| memory-base | 知识库与记忆（分层 S/P/U 记忆、检索、巩固 / 淘汰） |
| herdr-integration | herdr 面板桥 |
| herdr-use | 终端读写：模型侧十个具名工具 `herdr_list` / `herdr_read` / `herdr_info` / `herdr_wait` / `herdr_create` / `herdr_close` / `herdr_label` / `herdr_text` / `herdr_key` / `herdr_run`；一个终端 = 一个 tab + 自带 root pane；另提供进程内服务面 `herdrUse`，与工具面共用同一 registry 与锁 |
| goal-contract | Done-when 契约起草 |
| metric-loop | 指标驱动自动循环 |
| output-compress | 大输出摘要入库 |
| fs-digest | 文件摘要（outline / signatures / pruned） |
| hash-edit | LINE:HASH 锚定编辑，读写经 `ctx.fs` |
| ast-tools | AST 搜索 / 替换 / 大纲（`ast_query` / `ast_replace`），写面经 `ctx.fs` |
| md-logic | Markdown 逻辑结构：节树 + 块 + 链接，带行范围；`replace` 按节整节替换 / 删除，读写经 `ctx.fs` |
| md-map | 文档版 code-map：锚点 / 引用 / 影响面 / 断链 |
| security-guard | 危险命令与敏感文件防护 |
| code-map | 代码结构地图（符号 / import 图、callers / callees / impact） |
| context-report | 会话上下文 / 用量报告 |
| rule-engine | 规则触发的自动注入与消费者框架（`registerConsumer` + `evaluate`） |
| behavior-correction | 行为纠正：rule-engine 的 `tools/pre-execute` guard 消费者，拦「该用专用工具却走 shell」的调用并指路（bash 里跑 herdr → `herdr_*` 工具，命令位跑解释器 → `script_run`，`grep` 起头纯检索 → `grep` 工具）；服务缺席降级不拦 |
| symbol-normalizer | 符号规范：展示归一 + 回合审查 |
| session-channel | 跨会话消息通道（专用 Redis 实例 + unix socket）、alias / 共享 KV / 跨会话委托 |
| session-title-cutoff | 会话标题 provider：all-prompts 触发不变，参考窗口改为最近一次 `git commit` 之后 |
| command-template | 模板体系：slash 命令模板 + 模板级模型选择，双源模板目录 |
| ponytail | ponytail 模式：会话起始注入「懒资深工程师」决策阶梯；rule-engine 消费者；缺省开启，显式 `enabled: false` 关闭 |
| md-table-check | 回复正文表格列数检查：`assistant-text` 上的 rule-engine 消费者，只报不改 |
| script-interpreter | 模型侧脚本解释器：`script_run` 在当前 worktree 内受控执行 Python 等脚本，单次执行、不保状态 |
| agent-group | 群组编排：组 / 成员 / 主从连接（含等级）/ 指令与回报，懒判定结算；只读面 `agentGroup.summary(sessionId)` |
| auto-approve | 审批链自动裁定：拒绝名单 → 会话指纹 → 只读类 → 白名单 → 沙箱升级 → LLM 灰区逐次裁定，未命中交 TUI 面板；审计双写 |
| background-daemon | 面向会话投递的进程内调度：`/daemon` 子命令 + `daemon_task` 工具，记录落 memory-base |
| preference-analysis | 偏好分析：三条信号 → 跨会话账簿 → 高置信自动写 memory-base 并经 rule-engine 消费者注入；模型提议一律候选待审 |
| coagent | 长驻 agent 拉起与收尾：经 `herdrUse` 建终端发 `fffdsh`，用 session-channel `peers` 认领新会话；派任务与编排分别归 session-channel 与 agent-group |
| tool-consult | 工具揭示：全量短清单常驻，初始工具保留完整定义；揭示写授权并登记 `pinNotes.hold` 投递全文；未揭示由 `tools/pre-execute` 拒绝；白名单外条件工具静态 deny |
| escalation-hint | 沙箱升级提示补齐：订阅 `tools/post-execute`，宿主没给升级提示时经 `additionalContexts` 补重试指引；只提示不拦截 |
| term-check | 回复正文术语检查：`assistant-text` 上的 rule-engine 消费者，按术语表快照比对旧称并注入更正提示；只报不改 |
| pin-note | 跨压缩上下文保持：`pin_note` 登记要点到会话层记忆库，`agent/pre-step` 去重后折叠进本步；配套 `note_list` / `note_remove` |
| flow-track | 标准流程固化（流程定义方）：八阶段定义经入口工具 `flow_start` 一次建树（内部调 task-engine `composeFromNodes`），树级注入已退役；`flow_record` / `flow_status` / `flow_remove` / `flow_rollback` 记推进；只提示不拦截，顺序强制由 task-engine 按流程定义执行 |
| plan-mode | plan 三段流程定义（探索 / 计划 / 实施，各可再拆 + 顺序强制；计划段 human 门禁）与入口工具 `plan_start`，与 flow-track 平级；插件 id 为 `plan-mode-track`（官方 plan-mode 占 id） |
| flow-arbiter | 流程选择仲裁：会话级「当前选中流程」（内存），入口工具恒注册、`tools/pre-execute` 只拦流程入口（`flow_start` / `plan_start`），未选中或选别的即拒；切换不破坏缓存 |
| cache-hit-monitor | 缓存命中率监控：请求前按前缀重叠粗估可命中率、收到 `usage` 后算实际命中率，偏差超 `tolerance` 判缓存失效（首次无基线按 0、显示黄、豁免偏差判定）；判定经 `cacheHitMonitor.summary(sessionId)` 供 TUI 状态行既有 cache 段着色；只读订阅、不改 /stats |

## DESIGN.md 口径（2026-10-04 裁定）

有独立架构与机制沉淀的包必须有 `DESIGN.md` —— 现有 `TUI` / `task-engine` / `memory-base` / `session-channel` / `code-map` / `rule-engine` / `symbol-normalizer` / `output-compress` / `ponytail` / `command-template` / `md-logic` / `md-map` / `preference-analysis` / `agent-group` / `coagent`；**轻量包只留 `README.md`（`BACKLOG.md` 按需）**：`ast-tools` / `context-report` / `fs-digest` / `goal-contract` / `hash-edit` / `herdr-integration` / `metric-loop` / `security-guard` / `session-title-cutoff` / `md-table-check` / `herdr-use` / `auto-approve` / `background-daemon` / `session-paths` / `script-interpreter` / `behavior-correction` / `clock-base` / `escalation-hint` / `tool-consult` / `term-check` / `pin-note` / `flow-track` / `cache-hit-monitor` / `shell-parse` / `tool-surface`（能力面已在 README 讲清，另写 DESIGN 只会重复；某包机制变厚——出现跨组件协议 / 状态机 / 时序契约——时再补）。
