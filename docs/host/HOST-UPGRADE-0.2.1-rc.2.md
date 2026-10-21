# HOST-UPGRADE：0.2.0-rc.2 → 0.2.1-rc.2 对照记录

> 产出：2026-10-20（条目「检查官方 deepseek-harness 更新」调研，主会话）。
> 基线口径：本仓当前基线 `dsh-v0.2.0-rc.2`（2026-10-02 升级，见 `HOST-UPGRADE-0.2.0-rc.2.md`）。
> 任务验收：给出「官方最新版本 vs 0.2.0-rc.2」结论；接口有变动则逐项增删改清单与本仓影响判定；结论落盘。

## 结论

- 官方最新版本：**`0.2.1-rc.2`**（npm `@deepseek-ai/dsh` dist-tags `latest` = `0.2.1-rc.2`；GitHub release `dsh-v0.2.1-rc.2`，2026-10-17 发布，prerelease）。另 `alpha` 线最新 `0.2.1-alpha.5`。
- 基线 `0.2.0-rc.2` 发布于 2026-09-29。**官方有新版本（rc 系从 0.2.0 推进到 0.2.1）。**
- 接口面：有变动，含数项**破坏性**变更（见下表），亦有若干新增工具 / 能力可与本仓既有面发生关系。本仓 29 模块对破坏项的**直接消费为空**（实测 grep），预计升级对本仓代码的直接冲击小；升级前仍须按表复核 `HOST-PACKAGES.md` 实挂行与 profile 装载。
- 是否升级基线：**已升级（2026-10-21 执行，见追踪文档 `docs/archived/2026-10-21-host-upgrade-0.2.1-rc.2.md`）**：全局安装 `0.2.1-rc.2`、`scripts/install.sh` 默认版本与版本引用 `0.2.0-rc.2 → 0.2.1-rc.2`、`HOST-PACKAGES.md` 实挂行已重生成、逐项复核见追踪文档。
- 实施新发现（2026-10-21）：`fff` profile 挂载面含 `invariants`（`@deepseek-ai/dsh-invariants`，2026-10-02 挂载扩张加入），恰为 0.2.1 变更 #1 移除的插件 → 升级时已从 profile patch 删除该行（两处目录）。其余复核结论见追踪文档「调研」节。

## 官方发布渠道与版本实证

- npm：`https://registry.npmjs.org/@deepseek-ai/dsh` → `dist-tags": { latest: "0.2.1-rc.2", alpha: "0.2.1-alpha.5", next: "0.2.1-rc.2" }`（2026-10-20 直查 registry）。
- GitHub：`deepseek-ai/deepseek-harness` releases —— `dsh-v0.2.1-rc.2`（2026-10-17T08:16Z）、`dsh-v0.2.1-rc.1`（2026-10-17T05:22Z，汇总「自 v0.2.0-rc.2 以来的主要用户和开发者相关变更」）、`dsh-v0.2.0-rc.2`（2026-09-29）。
- **git 级核对（2026-10-20 补）**：GitHub compare `dsh-v0.2.0-rc.2...dsh-v0.2.1-rc.2` → `ahead_by = 1925` 个提交（base `639ed01` = 0.2.0-rc.2 release merge，head `687f282` = 0.2.1-rc.2）。变更量级确认，release notes 恰为这一区间（0.2.0-rc.2 → 0.2.1-rc.1）的官方汇总；下表基于该汇总 + 关键面 grep。逐提交/逐文件全量 diff（1925 提交）不在本条目首轮范围，升级前如需可再取 patch 全量比对。

## 与宿主接口面相关的变更清单（0.2.0-rc.2 → 0.2.1-rc.1/2）

| # | 官方变更项 | 官方口径 | 本仓直接消费 | 影响判定 |
| --- | --- | --- | --- | --- |
| 1 | 移除运行时 invariant 插件及各包 `./invariant` 导出（breaking） | 诊断入口移除，扩展/自定义 profile 需调整 | 无（`grep '\./invariant' TUI src 各包` 零命中） | 低，升级前复扫全仓 |
| 2 | 子路径插件不再读取独立 `package.json`，文本/图标须走子路径导出 | 插件清单口径变化 | 无子路径插件 | 低 |
| 3 | 第三方插件兼容性优先按 `engines.dsh` 判断 | 装载判定变化 | `cordis.patch.yml` / `install.sh` 判定链可复核 | 低-中（升级时核对） |
| 4 | 输入区统计扩展拆为 `activity` 与 `usage` 两个注册 ID | 覆盖旧 `stats` 整行的插件需改 | 无（TUI 自带 `/stats` 命令，未覆盖宿主 stats 扩展位） | 低 |
| 5 | Agent Team 消息直投目标 Inbox，移除独立 outbox / 自动重试 / 重发去重 | 配置与结果字段需迁移 | 不消费官方 team/\*（`agent-group` 自建通道） | 低 |
| 6 | 移除工具展示的 `both` 混合展示模式，仅 `native` / `ptc` | 旧配置与 API 调用需更新 | 无 | 低 |
| 7 | 移除 `agent-instructions` 逐行 `dshHome` 配置，指令目录改从 `DSH_HOME` 读取 | 配置面变化 | 无 | 低 |
| 8 | Python PTC 接入 Session 文件沙箱策略；自定义组合需提供 `sandbox` / `sandboxPolicy` 服务 | 组合契约变化 | `script-interpreter`（模型侧解释器）是否受 PTC 组合契约影响需复核 | 中（升级时复核） |
| 9 | Azure 提供方名称统一为 `azure`，旧 `azure-openai-responses` 需迁移 | 提供方命名 | profile 未用 | 低 |
| 10 | 新增 `working_directory` 工具；TS/Python SDK 提供会话工作目录读写接口 | 工具面新增 | 与 `session-paths` 的目录语义存在概念重叠（互不依赖） | 低-中（观察） |
| 11 | 新增实验性 Session 状态记录接口（插件写/读自己的会话记录） | 服务面新增 | `memory-base` / `context-report` 的会话读取可评估是否采纳 | 低（可选采纳） |
| 12 | 自动化任务改为 Web 内置能力；提醒工具按模式提供（标准/创造/PTC 可用，极简/子代理不可用） | 自动化面内置化：`schedule` 服务投递与会话内 follow-up 不依赖 Web；模型四工具（`schedule_create` 等）为 preset-owned，**无 preset 的 TUI 组合不自动出现**，需显式挂 `tool-schedule` 进全局组合；Automation tasks 管理页为 Web 客户端专属 | 与本仓 `background-daemon` 的进程内调度/投递定位叠加；本仓 TUI-only + 无 preset + 未挂 `tool-schedule` → 官方 automation 非开箱即用，background-daemon 自建链路无此门槛。升级时按需求裁决（官方四工具+订阅 vs 本仓 command 投递 + memory 底座 + 重试语义） | **中（重点复核）** |
| 13 | pi-ai 更新 1.0.2，模型目录更新；适配 DeepSeek-V4.1-Flash-1017；DeepSeek Search / Fetch API（网页搜索设置开启） | 模型面 | 与 fff profile 的 tollgate 别名（`ds4f` / `ds41f` 等）及 `UNKNOWN_MODEL` 排查语境相关；model-discover 复用 profile headers | 中（profile 侧核对） |
| 14 | 全局指令支持共享 agents 目录 `AGENTS.md`（`DSH_AGENTS_HOME`） | 指令装载面 | 与本仓 AGENTS.md 规范无冲突（本仓为项目级 AGENTS.md） | 低 |

## 本仓影响初判

- **代码面**：29 模块不消费上表 #1/#2/#4/#6/#7 的破坏面（已实测 grep）；#5 与官方 team 无关；直接改代码的必要性低。
- **装载面（升级时必查）**：`engines.dsh` 判定（#3）；`script-interpreter` 在 PTC 组合契约下的 `sandbox`/`sandboxPolicy`（#8）；`HOST-PACKAGES.md` 实挂行清单整体重对一遍。
- **叠加/观察面**：#12 自动化内置 vs `background-daemon`、#11 Session 状态接口 vs memory-base / context-report、#13 模型目录 vs profile 别名、#10 `working_directory` vs `session-paths` —— 属可选采纳或兼容核对，不构成升级阻塞。

## 详细接口调研（2026-10-20 二次补充，源码级）

方法：上游 `deepseek-harness` shallow 克隆（`--filter=blob:none`，标签 `dsh-v0.2.0-rc.2` / `dsh-v0.2.1-rc.2`，diff 1925 提交）＋逐包取 npm tarball `lib/types` 与本机已装 0.2.0-rc.2 同包 `lib/types` 比对（26 个消费面包）＋关键载荷定点核对。

### 消费面包类型名级比对（0.2.0-rc.2 → 0.2.1-rc.2）

覆盖：`dsh-tools` / `dsh-session` / `dsh-subagent` / `dsh-llm` / `dsh-settings` / `dsh-sandbox` / `dsh-session-query` / `dsh-jobs` / `dsh-skill` / `dsh-workflow` / `dsh-goal` / `dsh-schedule` / `dsh-session-title-llm` / `dsh-session-projection` / `dsh-user-questions` / `dsh-web` / `dsh-command-goal` / `dsh-commands` / `dsh-permission-presets` / `dsh-agent-preset-registry` / `dsh-workspace` / `dsh-agent` / `dsh-agent-loop` / `dsh-session-persistence-jsonl` / `dsh-command-compact` / `dsh-agent-tool-presentation`。

**结论：26 包导出类型名集合全部「只增无删」**（无任何删除名；新增名如 `dsh-tools` +96、`dsh-subagent` +96、`dsh-llm` +139、`dsh-schedule` +99、`dsh-session` +64、`dsh-session-query` +53 等，均为新增 API / 选项 / 配置类型）。既有消费面签名未见破坏性收缩。

### 关键载荷 / 服务面定点核对（0.2.0-rc.2 vs 0.2.1-rc.2 lib/types 直接 diff）

| 面 | 结果 |
| --- | --- |
| `tools/pre-execute` 的 `ToolExecution` 载荷 | **零结构 diff**（仅一条注释口径变化：presentation projection 「仅顶层调用」→「native 与嵌套调用」） |
| `sessions` 服务（create/send/prompt/flush/list/get/fork 签名集） | 相同 |
| `sandboxPolicy` 的 `resolve` 面（resolve/check/approve/escalate 签名集） | 相同 |
| `llm` 服务 + `model/selection` 事件面 | 相同 |
| 会话格式（`dsh-session-persistence-jsonl`） | 类型面仅增（+58），无删除名 |

### 与 release notes 破坏项的对位

本仓不消费：`./invariant` 导出、`stats` 扩展位、`both` 展示模式、`agent-instructions` 逐行 `dshHome`、Azure 旧名、官方 team outbox —— 均已在 §变更清单判定为「低/无直接消费」。桩点核对（`dsh-session-persistence-jsonl` 等）未发现对本仓读取会话日志路径的破坏。

### 残余与后续

- 上述结论基于「类型名级」比对与定点载荷 diff，未做 26 包全量「逐类型体」diff；升级前如需极致保险可再全量 diff 类型体（当前判断价值低，因零删除名 + 定点点位相同）。
- `tools` 模型可见工具集合（默认组合）是否增删：涉及官方 client 装配，未逐枚举；工具名新增项（如 `working_directory`）见 §变更清单 #10。
- 升级裁定仍待用户决定（升级则按「复核/升级路径」执行）。

## 0.2.1 新增面明细（2026-10-20 补充，以官方升级指南口径为准）

依据：本地克隆 `~/GithubRepos/deepseek-harness`（`dsh-v0.2.1-rc.2`）`docs/upgrade-guide/v0.2.1-alpha.*/` 各指南。

### 高相关（会影响本仓既有面）

- **会话工作目录 + `working_directory` 工具**（`tool-working-directory`，`working-directory` 指南）：会话当前执行目录成为独立状态（与 `Session.header.cwd` 分离、持久化）；工具读/改目录、返回绝对路径可传给其它工具；**新子代理开始请求新增 `cwd`**（提供则用、否则捕获父会话当前目录）；同时移除 `{{cwd}}` 内置提示变量与 `dsh-subagent-acp` / `dsh-subagent-dsh-sdk` 的 cwd 配置键。本仓影响：`session-paths`（目录语义重叠观察）、**`task-engine`**（此前 `SubagentStartRequest` 无 cwd 字段 → 现可能解除，worktree 隔离或可对 subagent 后端落地）。
- **session-title adapters 注册**（`session-title-adapters` 指南）：模型标题路由改经 `ctx.llm.prepareCall()` 生成，组合须注册 adapter；自定义 adapter 须按**推理努力递增序**列可选档；标题策略经配置函数选首项。本仓影响：`session-title-cutoff`（经 llm 生成标题，升级需补 adapter 注册）。
- **Python PTC 共享文件沙箱**（`python-ptc-sandbox` 指南）：`ptc-runtime-python` 需 `sandbox` + `sandboxPolicy`，每程序按共享策略约束，受限失败报 `sandbox-unavailable`。本仓影响：`script-interpreter` 若涉及 ptc 组合契约须复核（官方 Node 运行时不受影响）。
- **JobId 身份变化**（`job-id-identity` 指南）：后台任务 id 从 `<kind>-N` 改 `<kind>-<16 位短 uuid>`，`job/registered` + `job/settled` 同一 id，移除 `executionId`。本仓影响：消费 `jobs` 服务的面（`task-engine` 等按 id 关联逻辑）。

### 模型 / 目录 / profile 面

- **模型发现空目录规则**（`deepseek-model-discovery` / `pi-ai-model-discovery` 指南）：凭证缺失 / malformed 时返回**空目录**（不再列配置模型）。本仓影响：fff tollgate 别名不受影响，`model-discover` 类复用 profile headers 的面须保证凭证在位。
- **`engines.dsh` 兼容性判定**（`plugin-engines-dsh` 指南，变更清单 #3）。
- **agent-instructions 目录改 `DSH_HOME`**（`instruction-home-override` 指南，变更清单 #7）。
- **Agent Team 直投 Inbox**（`team-direct-inbox` 指南，变更清单 #5）：`send_message` 只回 `{sent:true}`、无 message id / queued / 重试保留，`maxPendingMessagesPerMember` 移除。本仓不消费官方 team（`agent-group` 自建），低。

### 中低 / 装卸面

`tool-presentation-mode`（both 移除，变更清单 #6）、`subagent-activations` / `subagent-preset-composition` / `native-subagent-bundle-tools`、`experimental-package-composition`、`plugin-option-placement` / `plugin-install-over-installed`、`jsonl-persistence-plugin`、`new-session-generations` / `mock-messages-events`、`stored-credentials-precedence` / `deepseek-account-identity-watch` / `pi-ai-azure-provider`（azure 统一，变更清单 #9）、`web-listener-trust-config`、`terminal-command-labels`、`ssh-helper-launch`、`from-default-profile-replaces-target`、`sdk-minimal-image-compaction`。

### 新增观察点（可采纳）

- experimental Session 状态记录接口（release notes 提及，具体面待细查；与 `memory-base` / `context-report` 的会话读取为候选采纳对象）。

## 复核/升级路径（若有需）

1. 用户裁定是否升级基线至 `0.2.1-rc.2`。
2. 若升级：`scripts/install.sh` 默认版本与主要版本引用 `0.2.0-rc.2 → 0.2.1-rc.2`；按 `HOST-PACKAGES.md` 自身流程复核实挂行；对本仓全量跑 `npm run check` + `npm run test`；按上表 #3/#8/#12/#13 逐项复核。
3. 结论注记写入本文件与追踪文档 `docs/implementation/2026-10-19-dsh-update-check.md`。

> 复核时间戳：2026-10-20（主会话，条目「检查官方 deepseek-harness 更新」）；上述「本仓直接消费」为对 `TUI` / `timer` / `agent-group` / `background-daemon` / `script-interpreter` / `memory-base` / `session-channel` / `rule-engine` / `code-map` 等包的源码 grep 结论，非全量 29 包逐一核验——升级前应全量复扫。
