# 插件开发状态追踪

> 职责：模块与宿主基线的现状快照（状态的唯一来源）
> 不负责：细节与待办（见 `docs/BACKLOG.md` 与各包 `README.md`）
> 过期条件：无（状态变化即更新）

> 本表只记状态, 不记细节：功能与边界见各包 `README.md`, 未完成项见 `BACKLOG.md`；已完成的实施清单归档在 `archive/`（如 `TUI-REFACTOR-TASKS.md`）, 仅作历史记录。
> 状态取值：未开始 / 进行中 / 阻塞 / 完成 / 已取消 / 暂缓。
> 单测数为 `npm test` 实测值（`node --test` 用例数, 2026-10-24 全绿）。

## 总览

- TUI 侧现状见 `TUI/docs/STATUS.md`（完成情况、命令面、宿主升级适配）, 待办与开放项见 `TUI/docs/BACKLOG.md`——本文件不复述 TUI 细节。
- **32 个插件全部完成并合入 main**（清单见根 `README.md`「组成」）; TUI 单测 1748 例。
- 宿主基线：本地安装 dsh **`0.2.1-rc.2`**（2026-10-21 由 `0.2.0-rc.2` 升级; `scripts/install.sh` 的默认版本同此）。官方包清单与分类见 `docs/host/HOST-PACKAGES.md`, 升级对照见 `docs/host/HOST-UPGRADE-0.2.1-rc.2.md`。
- profile（`~/.dsh/profiles/fff`）挂载 **33 个 `@dsh-toolset/*` 包**（TUI + 32 插件）, 合计 34 个 bundle（dsh-base + 33）。
- 已取消 / 不再立项：`rate-guard`（pi 侧已移除, dsh 侧由官方 `llm-retry` 覆盖）、GitHub 仓库克隆、PDF 提取 / 视频理解、密文扫描、安全 issue 上报、近期改动代码审查、preset 机制迁移评估、`llm-router`（改用现成开源网关）；裁定记录见 `docs/BACKLOG.md` §1 与 `archive/PI-DSH-FEATURE-COMPARISON.md`。
- 未建插件与在办条目见 `docs/BACKLOG.md` §2（当前为空）; 真机验证欠账已清零（清单归档在 `docs/archived/2026-10-23-real-machine-verification.md`）。

## 状态表

| 插件 | 状态 | 说明 | 单测 |
| --- | --- | --- | --- |
| herdr-integration | 完成 | herdr 面板桥：agent 状态上报 + ask-user / approval / turn 三类 blocked 事件桥接; seq 闸门 + 周期重发 | 57 |
| herdr-use | 完成 | 把 herdr 终端当可控伪终端层：10 个模型侧工具（`herdr_create` / `close` / `label` / `text` / `key` / `run` / `read` / `list` / `info` / `wait`）; 前台 lane 继承父会话, 后台 lane 落 `dshbg`（缺会话自动拉起 headless server; 只拉起不关闭）; 与进程内 `herdrUse` 服务面共用 registry 与写锁 | 135 |
| clock-base | 完成 | 定时器统一面：服务 `clock`（`now()` + `schedule` / `interval`, 随调用方 fiber 释放, 默认 `unref`）; 另导出 `ManualClock` 供测试 | 24 |
| task-engine | 完成 | Frame 状态机、`decompose` / `implement` / `execute` / `stop` / `status` 工具族、双重门禁、RET 三级路由、fan-out 就绪池、叶子执行后端 | 142 |
| session-paths | 完成 | 复刻宿主会话目录编码（`encodeSegment` / `projectKey` / `projectDir` / `sessionDir`）, 以 `sessionPaths` 服务供各包共用 | 24 |
| memory-base | 完成 | 分层记忆存储：S / P / U 每层一个 SQLite 库 + 每分类双 FTS5 索引; 存储面（作用域句柄）与只读工具 `memory_query` | 82 |
| goal-contract | 完成 | interview 式 Done-when 契约起草, 落 dsh-goal 事件源并回读比对 | 41 |
| metric-loop | 完成 | 指标循环引擎与计划续排（plateau / 轮数 / 时间 / token 边界、cadence 唤醒） | 46 |
| output-compress | 完成 | 大输出确定性摘要 + 切片索引写自持的每会话 `digest.db`; `is_error` 摘要经句柄推 memory-base | 57 |
| fs-digest | 完成 | 上下文感知文件读取：`outline` / `signatures` / `pruned` 三模式 + Markdown 结构视图 | 66 |
| hash-edit | 完成 | LINE:HASH 锚定编辑（逐锚点校验, stale 整批拒绝） | 53 |
| ast-tools | 完成 | ast-grep 的 AST 搜索 / 结构化替换 / 大纲 / 规则执行; 模型工具 `ast_query` / `ast_replace` | 45 |
| md-logic | 完成 | Markdown 逻辑结构：节树（带行范围与内容 hash）+ 块清单 + 链接清单; 工具 `md_logic`（含 `replace` 按节改写） | 57 |
| md-map | 完成 | 文档版 `code-map`：锚点 / 跨文档链接 / wiki / 行内代码路径引用 / 断链 / 影响面; 工具 `md_map` | 49 |
| md-table-check | 完成 | 回复正文表格列数检查（`assistant-text` 上的 rule-engine 消费者）; 只报不改; bundle 默认 `enabled: false`（已停用） | 73 |
| security-guard | 完成 | 危险命令黑名单 + 敏感文件保护; 挂在单调守卫 `ctx.tools.guard`, 无该面时回退 `tools/pre-execute` | 135 |
| code-map | 完成 | 结构索引（符号表 + import 图）+ `callers` / `callees` / `cycles` / `impact` + 报告; LSP 语义层缺省不可达 | 24 |
| context-report | 完成 | 会话上下文与用量报告：host-only 投影 `sessionContext`（token 分桶）+ 官方 `sessionStats` 读数 + `context_report` 工具 | 41 |
| rule-engine | 完成 | 规则触发的自动注入 + 按节点消费者注册面（`registerConsumer` / `evaluate`） | 173 |
| behavior-correction | 完成 | 行为纠正：`tools/pre-execute` 上的 rule-engine guard 消费者, 缺省拦 `bash` 里的 herdr 命令并指向专用工具（服务缺席降级不拦） | 28 |
| symbol-normalizer | 完成 | 符号规范的展示归一 + 回合审查（rule-engine 消费者）; provide `symbolNormalizer` | 43 |
| ponytail | 完成 | 会话起始注入「懒资深工程师」7 级决策阶梯（缺省开启） | 5 |
| auto-approve | 完成 | 审批链自动裁定（拒绝名单 → 指纹 → 形态层 → 只读类 → 白名单 → 沙箱升级白名单 → LLM 灰区）; 人工放行学习（形态表 / 最小泛化 / LLM 准入 / 回填 / `learn` 命令面）; 未命中交 TUI 面板 | 157 |
| background-daemon | 完成 | 面向会话投递的进程内调度（`/daemon` + `daemon_task`）; 记录落 memory-base 或本地 JSON | 165 |
| session-channel | 完成 | 跨会话消息通道（专用 Redis + unix socket）：消息 / 别名 / 共享 KV / 委托与任务表 | 71 |
| session-title-cutoff | 完成 | 会话标题 provider：all-prompts 触发不变, 参考窗口 = 最近一次 `git commit` 之后; 0.2.1 helper 按 execute 形态适配、配置按执行控制 / 措辞拆分 | 15 |
| preference-analysis | 完成 | 偏好分析：三条结构化信号 → 跨会话账簿 → 高置信写 memory-base 并经 rule-engine 注入 | 68 |
| command-template | 完成 | 模板体系：`/playbook` 统一入口 + 双源模板目录 + 两步类型 + `bestOf` / `judge` | 33 |
| script-interpreter | 完成 | 模型侧脚本解释器 `script_run`（Python 首期; 经 stdin 送脚本, 沙箱围栏 fail-closed） | 94 |
| agent-group | 完成 | 群组编排：组 / 成员 / 主从连接 / 指令与回报; 懒判定结算 | 63 |
| coagent | 完成 | 长驻 agent 拉起与收尾：经 `herdrUse` 建终端、交互 shell 发 `fffdsh`、用 session-channel `peers` 认领新会话; 只管拉起与收尾 | 31 |
| tool-consult | 完成 | 工具咨询与按需揭示：关键词索引 + `tools.restrict` 遮罩, 咨询即授权; 揭示会话内常驻或仅本回合 | 49 |

## 依赖关系（影响排期）

- `code-map` 经 `link:` 依赖 `@dsh-toolset/ast-tools`（profile 挂载 code-map 时必须同时挂载 ast-tools）。
- `md-map` 经 `link:` 依赖 `@dsh-toolset/md-logic`（单文件解析复用）。
- `preference-analysis` 依赖 memory-base（存储）与 rule-engine（注入通道）; `agent-group` 依赖 session-channel（传输）与 session-paths（状态落点）; `background-daemon` 的 memory-base 记录底座与 `security-guard` 命令复查均为可选面（缺失即降级）。
- `coagent` 依赖 `herdr-use` 的 `herdrUse` 服务面（建终端与读写）与 `session-channel` 的 `peers`（认领新会话）, 无 npm 依赖。
- `behavior-correction` / `md-table-check` / `symbol-normalizer` 依赖 rule-engine 的消费者通道, `tool-consult` 依赖宿主 `tools` 注册面; 服务缺席各自降级。
- `clock-base` 无 npm 依赖; `session-paths` 为纯函数库。
- `output-compress` 与 `memory-base` 无 npm 依赖：本地 `digest.db` 自持, 只有 `is_error` 摘要经 `ctx.get('memory')` 句柄写入。
- 其余包彼此独立, 跨插件通信只经宿主 ctx 服务面。
