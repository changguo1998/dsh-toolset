# MCP 脚本化（mcpScript）：调研与决策

状态：设计定稿（建议：**不立项**；最终裁定待人工；未收尾）　　开启：2026-10-22　　关闭：—
接取条目：项目级 `docs/BACKLOG.md` §2「6. MCP 脚本化（mcpScript）」
本文件是本任务唯一的过程记录与文档变更落点；本阶段的计划外文件不改。

**协作约定（2026-10-23）**：本包可**写自己包目录内的代码与文档**（含包内 `docs/`），以及**自己的追踪文档**；共享文档（两级 BACKLOG、`TUI/docs/SPEC.md`、两份 README、`COMMANDS*.md`）与根级接线（根 `package.json`、`AGENTS.md`、`profiles/example/cordis.patch.yml`、用户 profile）**只由主分支代理回写**，见项目级 `docs/BACKLOG.md` §2「7. 共享文档与根级接线」。

## 结论摘要

- **建议不立项**（最终裁定待人工）：不新建 MCP 脚本化包（脚本运行时），也不扩展 `script-interpreter`；固定步骤批处理的 `mcp_batch` 只是条件预案，本任务不实现。
- 宿主 0.2.1-rc.2 已提供三段可组合能力：`dsh-mcp-client`（把 server 工具注册进 `ctx.tools`）、`dsh-mcp-resources`（资源发现与读取的三个共享工具）、`dsh-tools` 的 PTC mode（`run_code` 脚本编排宿主工具）。
- 「MCP 工具多步编排」与「资源读取脚本化」不是两套机制：资源读取本身已建模为三个普通工具，PTC 启用后与其它工具走同一套脚本绑定。
- 现状缺口不是「缺少脚本面」，而是「没挂 `mcp-client`」与「`tools.mode` 仍是 native」——两项都是部署与配置动作。
- 若将来确需在 native 模式下批量调用 MCP（不切全局 PTC），最小形态是一个薄批处理工具（暂名 `mcp_batch`），不是脚本解释器；本任务不实现。
- TUI 补充（Q6）：PTC 能只靠一行 profile patch 打开，base 的 provider 与服务前提齐全；但它是**全 agent** 生效，并把嵌套工具与人工等待压进 `run_code` 的 120s/600s。推荐保持 native，固定多步需求走新薄包 `mcp_batch`；真脚本化才考虑 PTC。

## 目标与边界

本阶段只做调研与设计，回答五问并补 TUI 路径（Q6）：目标场景归属、与 `script-interpreter` 的关系、是否挂 `dsh-mcp-client`、凭据与权限边界、失败与超时语义；结论允许是「不立项」。

边界：不实现 MCP server 端；不改宿主 `mcp-resources` 的既有行为；不写实现代码；不动 profile 与共享文档；不关闭条目；不改两级 BACKLOG 与 STATUS；不做真机验收。

## 调研

### 事实基线（宿主 0.2.1-rc.2）

| 事实 | 证据 |
| --- | --- |
| `dsh-base` 只挂 `mcp-resources`，未挂 `mcp-client` | `dsh-base/cordis.patch.yml:492-493` |
| 宿主 MCP / 编排相关包：`dsh-mcp-client` 0.2.1-rc.2 未挂、`dsh-mcp-resources` 已挂、`dsh-ptc-runtime-node` 已挂、`dsh-tools` 已挂 | `dsh-base/cordis.patch.yml:397-398`、`:492-493`、`:499-501` |
| `ptc-runtime-node` 已挂，提供 `ctx.ptcRuntime` | `dsh-base/cordis.patch.yml:397-398` |
| `tools` 行无 `config`；注释明确 native 是 schema 缺省 | `dsh-base/cordis.patch.yml:496-501` |
| `mcp-client` 每个实例连一台 server，默认不启用任何 server | `dsh-mcp-client/README.zh.md:12` |
| 工具公共名固定为 `mcp__<serverName>__<rawName>` | 同上 `:12`、`:75` |
| `mcp-client` 只 inject `tools`，自身不请求审批 | `dsh-mcp-client/lib/index.js:763` |
| 每次调用按 `toolCallTimeoutMs`（缺省 60s）与 `exec.signal` 发往 server | `dsh-mcp-client/lib/index.js:145`、README `:61` |
| 连接成功后把资源提供方注册给 `ctx.mcpResources` | `dsh-mcp-client/lib/index.js:733` |
| 没有已配置 server 时，资源三工具、提示词段与 PTC 声明都不存在 | `dsh-mcp-resources/README.zh.md:34`、`:90` |
| 资源三工具清单：`list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource` | `dsh-mcp-resources/README.zh.md:12`、`:38` |
| PTC mode 下只有 `run_code` 可直接调用；SDK 绑定覆盖全部可见工具 | `dsh-tools/README.zh.md:68`、`:130` |
| `run_code` 缺省 120s、上限 600s，含嵌套调用与审批等待 | `dsh-tools/README.zh.md:136` |
| MCP 工具定义未声明并发安全分类，按 exclusive 调度 | `dsh-mcp-client/lib/index.js:179-188`；`dsh-tools/lib/types/index.d.ts:159-171`、`:717-724` |

本仓现状：30 个插件中无 MCP 相关代码；profile 未挂 `mcp-client`、未改 `tools.mode`（`~/.dsh/profiles/fff/cordis.patch.yml` 无相关条目）。

### Q1 目标场景：工具编排还是资源读取？

两个候选场景：

- A「MCP 工具脚本化多步编排」：模型写一段程序，一次调用多个 MCP 工具，中间值在程序内流转，回传聚合后的结构化结果。
- B「资源读取脚本化」：一次列举/展开模板/读取多个 MCP 资源，聚合结果。

事实：`mcp-resources` 对外就是三个普通工具——`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`（`dsh-mcp-resources/README.zh.md:12`、`:38`）；配置 server 后它们在 native 与 PTC 下都有声明与绑定（`:90`）。因此从脚本视角看，B 是 A 的子集：`read_mcp_resource` 就是一个可绑定工具，不是另一种资源 API。

判定：目标场景取 **A（工具多步编排）** 为一般形态，**不为资源读取单独建设脚本面**。只做 B 等于给三个已存在的工具再造一层专用脚本接口，收益为零；资源读取若只是「读一份文档」，直接调工具即可，脚本化没有额外价值。

补充：A 的真实收益是减少模型往返、把中间态留在执行局部而非上下文；不是并行加速（见 Q5 串行性）。

### Q2 与 `script-interpreter` 的关系：扩展还是新包？

结论：**两者都不做**（本任务建议不立项）；若将来必须落代码，**选新包，不选扩展 `script-interpreter`**。

不扩展的四条理由：

1. **执行对象不同**：`script-interpreter` 把脚本正文经 stdin 交给 OS 解释器（`script-interpreter/README.md:16-26`、`:58-62`），脚本进程与 `ctx.tools` 之间没有通道。要在其中加工具调用，得自带绑定、结果编解码与调度，等于在包内重造 PTC。
2. **权限与审计模型不同**：`script-interpreter` 的脚本正文整段过 `security-guard` 命令黑名单（`security-guard/README.md:21`、`:142`），执行受 `ctx.sandbox.confine` 文件围栏；工具调用要过 `tools/pre-execute` / `execute` / `post-execute`，并落 `tool/ptc-dispatch` 事件供审计。两套模型混在一个工具里，会让「这段文本是命令还是工具调用」不可判定。
3. **能力重复**：PTC 已具备绑定生成、并发上限、超时/取消、结构化结果与子调用持久化；在 `script-interpreter` 里重造会形成第二套语义、第二套审计。
4. **定位冲突**：`script-interpreter` 明确不做 REPL 与跨调用状态保持（`:12`），而脚本化 MCP 的核心恰恰是「一次程序内多步与中间值」；把它扩成编排器会推翻既有边界。

若将来要 native 模式批处理：新薄包只做「按序调用 `mcp__*` + 聚合结构化结果」，不引入通用脚本语言（预案见「决策」）。

### Q3 是否挂载 `dsh-mcp-client`？

判定：**要用 MCP 就必须挂**；但「脚本化」本身不需要额外挂载。挂载属于部署与凭据决策，本任务不动 profile。

- base 只挂 `mcp-resources` 仍能工作，是因为它是惰性的：没有 provider 时不注册任何工具与提示词（`dsh-mcp-resources/README.zh.md:34`）。
- 挂载后自动获得：`mcp__<server>__<tool>` 工具（含 schema、描述、输出约定）、三个资源工具、`MCP resource servers` 提示词段、服务器指令段（`dsh-mcp-client/README.zh.md:12`、`:159-167`、`:191-199`）。
- PTC 呈现模式有两个入口：部署级 `tools.mode: ptc`（`dsh-tools/README.zh.md:68`），或 preset 内的 `dsh-agent-tool-presentation`（该包 README「使用本包」）。本仓不使用 preset（`AGENTS.md`「本项目只用 TUI，不配置 agent preset」），所以只能走部署级——等于**所有 agent** 的工具面从「每个 schema」变成「只有 `run_code` + 生成的 SDK」。
- 代价：base 注释明确 native 是缺省（`dsh-base/cordis.patch.yml:496-501`）。TUI 已能渲染 `tool/ptc-dispatch-start` / `tool/ptc-dispatch`（`TUI/src/app/adapter/dsh.ts:2741-2757`），但这不改变另一点：30 个插件的工具可调用面与提示词会一起变，依赖直接工具调用的命令模板与工作流也要重新验证。这不是一个「顺手打开」的开关。

建议顺序（交主分支与用户裁）：

1. 先挂一台只读 server，保持 native，验证凭证、权限与失败回执；
2. 出现稳定的多步编排需求后，再单独评估 PTC 全局切换；
3. 没有 server 时不做脚本化设计（本任务即此态）。

明确不做：不在 `profiles/example/cordis.patch.yml` 写示例 server（共享文件归主分支），不写用户 profile。

### Q4 凭据与权限边界

**凭据注入面（两处）**：

- stdio：`env`（显式合并）+ 清洗后的父环境。清洗规则是删除匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的环境名与全部 `DSH_*`（`dsh-mcp-client/README.zh.md:137`）。所以父进程的 `GITHUB_TOKEN` 不会被继承，必须显式写进 `env`。
- Streamable HTTP：`headers`（同上 `:51-52`）。
- 该桥未提供 OAuth 与交互登录流程，只有静态 env 与 headers 两种注入方式（同上 `:55-67`；HTTP 侧只把 headers 交给 SDK 传输，`lib/index.js:46`）。

**配置落点**：profile 的 `cordis.patch.yml`。示例 profile 是提交物，禁止写真实密钥；用户 profile 用 `!!js process.env.X` 间接引用（同上 `:43`、`:52`）。本仓 `profiles/example/cordis.patch.yml` 只保留注释行。

**服务器进程的信任边界**：stdio server 由宿主直接 spawn（`mcp-client` 自己的 transport），**不经过** `ctx.sandbox.confine`；它以当前用户身份运行，文件访问不受 DSH 沙箱策略约束。只挂可审计的 server。

**不可信文本进入上下文**：服务器指令以字面文本进入系统提示词（每台上限 `maxInstructionBytes` 32KB，超限连接失败，同上 `:62`、`:191`）；工具名、描述与输入 schema 进入每次请求（`:159-167`）。server 可以借此做提示词注入，必须按「不可信来源」对待。

**工具调用权限**：走 `tools` 管道，但 `mcp-client` 只 inject `tools`、自身不请求审批（`lib/index.js:763`）。默认没有逐次人工确认。

- `security-guard`：`mcp__*` 属运行时注册、不可静态枚举（`security-guard/README.md:191-199`）。缺省 `unknownToolPolicy: "allow"` 直接放行；若改 `check` / `deny`，需把 `mcp__*` 放进 `unknownToolAllowlist`，否则会按「未登记工具」保守拦（`:166-180`）。放行等于放弃参数层扫描，这是有意识的取舍。
- `auto-approve`：`deny.tools: ['mcp__*']` 只表达「永不自动批」（`auto-approve/README.md:70`），它只在审批请求链上生效；上游没有 `ask` 时，这条不会产生逐次确认。要真正做到「每个 MCP 调用都问人」，需要上游策略发 `ask`，不是只配这一条。

**PTC 叠加**：`run_code` 的 `sandbox_permissions` 只影响程序自身的文件访问，不改变 MCP server 端权限；嵌套工具调用各自保留策略与审批（`dsh-tools/README.zh.md:136`）。子调用落 `tool/ptc-dispatch` 供审计（`:130`）。

**结果面**：MCP 返回值是模型可见内容；server 想泄什么就泄什么。图片在能力证明后进入上下文，音频与嵌入资源只留诊断文本（`dsh-mcp-client/README.zh.md:85-87`、`:177-181`）。资源二进制不进模型，但程序化调用方（PTC）能拿到 base64（`dsh-mcp-resources/README.zh.md:104`、`:123`）。

### Q5 失败与超时语义

本表来源：`dsh-mcp-client/README.zh.md:55-67`、`:85-93`、`:208-213`；`dsh-tools/README.zh.md:136`；`dsh-ptc-runtime/README.zh.md:55`。

| 环节 | 计时器 / 缺省 | 上限 / 可调 | 失败表现 |
| --- | --- | --- | --- |
| server 初始连接与工具发现 | MCP SDK 请求超时 60s，无独立旋钮 | 60s | `failOnStartupError: false`（缺省）→ harness 照常启动、该 server 无工具、日志报错；`true` → 拒绝插件激活 |
| 单次工具 / 资源调用 | `toolCallTimeoutMs` 60s | 每 server 配置 | 调用失败（工具错误）；`isError: true` → 失败；无效结果 → 失败；task-required → 拒绝 |
| 断线重连 | 500ms 起、每次翻倍 | `maxDelayMs` 30s、`maxAttempts` 10 | 断线期工具仍在列表但调用失败；预算耗尽后移除工具并停止重连；持续连接超过 `maxDelayMs` 重置预算 |
| 工具列表刷新 | 每次同步整代交换 | — | 获取失败保留上一代；注册冲突整代回滚 |
| 资源读取 | 同 `toolCallTimeoutMs` | — | 表现为失败的资源工具调用；无订阅与更新通知，需重新 list/read |
| PTC 外层 `run_code` | 120s | 600s（`timeoutMs`） | `result.error.kind = timeout`；含嵌套调用与审批等待 |
| PTC 取消 | 调用方 signal | — | `kind = abort`；嵌套调用收到取消 |
| PTC 其它失败 | — | — | `exception` / `worker-exit` / `invalid-output` / `output-limit` / `protocol` / `sandbox-unavailable`（`dsh-ptc-runtime/README.zh.md:55`） |

- **程序内错误映射**：子调用抛出或拒绝 → `Error: <message>`（`dsh-tools/README.zh.md:215`），程序可 try/catch；未捕获 → 外层 `Error: code run failed (<kind>): <message>` 并附捕获输出；成功只返回程序打印行与呈现后的返回值。
- **副作用**：不自动重放、不回滚；嵌套调用已经发生的效果保留，重试前先检查（`:136`）。
- **串行性（关键）**：MCP 工具定义没有 `isConcurrencySafe`，按 exclusive 调度（`dsh-tools/lib/types/index.d.ts:159-171`、`:717-724`）。`maxParallelSubCalls` 对它们不起作用，脚本里的多步 MCP 调用是串行的，墙钟约等于各调用之和。默认 120s 只够大约两次满额 60s 调用；要跑更多必须显式抬 `timeoutMs`，而 600s 上限把满额调用限制在十次左右。所以脚本化的收益是**减少模型往返与上下文中间态**，不是并行加速。
- 资源与工具共用一个超时旋钮：同一 server 上两者共享 `toolCallTimeoutMs`。
- 启动失败是「静默降级」：缺省不阻塞 harness，只是工具不出现，排障要看日志。`failOnStartupError: true` 把问题前移到激活期，适合「这台 server 必需」的部署。

### Q6 TUI 环境下的实现路径（2026-10-23 补充）

前面的「PTC 可承担」只是能力面推论。TUI 不使用 preset，只有一个部署级组合，`tools.mode` 缺省 native；本节单独回答：A 能否只靠 profile patch 打开 PTC、B 打开后 MCP 怎么调用、C 不打开时脚本化落在哪、D 推荐哪条路。

#### 6.1 A：只靠 profile patch 打开 PTC

`tools` 是 base 已插入的行（`dsh-base/cordis.patch.yml:499-501`，fff profile 未覆盖）。用户层按 id 覆盖即可，**不要写 `name`**（写了会被当成改指向；新增行才用 `- insert:`）：

```yaml
- id: tools
  config:
    mode: ptc
```

依据：base patch 注释说明后层按 id 命中、整个 `config` 替换（`dsh-base/cordis.patch.yml:1-11`）；用户层只写 id + config 的实例见 `~/.dsh/profiles/fff/cordis.patch.yml:24-26`；新增行必须走 `- insert:` 见 `profiles/example/cordis.patch.yml:124-135`。`config` 是整键替换，若还要改 `maxParallelSubCalls` 必须一并重述。

`dsh-tools` 的 Config schema 把 `mode` 限定为 `native` / `ptc`、缺省 native（`dsh-tools/lib/index.js:2763`），构造时 `defaultMode = config.mode ?? "native"`（`:2800`）。复核注记：任务书里的 `:1863` 实际是 py-types 的区域注释、`:948-1074` 是 ptc.js 模块开头；请求裁剪与直呼拒绝的实际代码在 `wireSchemas`（`:2932-2945`）、`view`（`:3075`）、`collapses`（`:3196`）。

依赖链（base 已全部具备）：

| 前提 | 证据 | 结论 |
| --- | --- | --- |
| PTC 运行时 provider | `ptc-runtime-node` 已挂（`dsh-base/cordis.patch.yml:397-398`） | 提供 `ctx.ptcRuntime`：language=`typescript`、isolation=`process`、per-call 的 programFormat=`function-body`（`dsh-ptc-runtime-node/lib/index.js:1408-1420`） |
| provider 的服务依赖 | 它 inject `fs` / `subprocess` / `sandbox` / `sandboxPolicy`（同上 `:1408-1413`） | base 挂 `fs-sandbox`（`:518-519`，提供 `ctx.fs`，见 `dsh-fs-sandbox/README.zh.md:2`）、`subprocess-local`（`:234-235`）、`sandbox-local`（`:240-241`）、`sandbox-policy`（`:243-247`） |
| 工作目录 | `run_code` 需要 `workingDirectory`（`dsh-tools/lib/index.js:2881-2892`） | base 挂 `working-directory`（`:166-167`） |
| 沙箱策略 | `run_code` 需要 `sandboxPolicy`（同上 `:2889-2892`） | base 默认 workspace-write（`:243-247`） |
| 语言与 SDK 渲染 | `SDK_RENDERERS` 含 typescript（`dsh-tools/lib/index.js:2615-2618`） | 缺 runtime 或语言时 `requirePtcRuntime` 明确抛错（`:2960-2969`）；`sdkSection` 按 scope 渲染（`:2840-2857`） |
| 可执行文件与 exec 权限 | 默认 `process.execPath`（`dsh-ptc-runtime-node/lib/index.js:642-646`），经 `ctx.subprocess.resolveExecutable`（`:1139`）与 `ctx.sandbox.confine`（`:1147`）启动 | 本机 bwrap 0.9.0 可用；`workspace-write` 下若无沙箱后端则 fail-closed `sandbox-unavailable`（`:1080`、`:1189`） |

`workflow-ptc`（`dsh-base/cordis.patch.yml:400-401`）是 workflow 的消费者，不是 `tools.mode: ptc` 的前提；`run_code` 只依赖 `ptc-runtime`。

装配期事实：mode=ptc 时 `wireSchemas` 只把 `run_code` 放进请求（`dsh-tools/lib/index.js:2932-2945`），`view` 在可见集里追加 `run_code`（`:3075`），模型直呼其它工具被 `collapses` 拒绝（`:3196`）。

**A 的结论**：技术上可以只靠一行 profile patch 打开，base 的 provider、服务依赖、语言与沙箱前提都在位；「正常起来」只在装配层成立。未实机 boot：本任务不改 profile；本会话的 `--dump-config` 因要写 profile 的 `cordis.yml` 被沙箱挡住，正式启用前应在隔离 profile 试跑一次。

#### 6.2 TUI 的三类全局副作用与渲染现状

`mode` 是部署级默认：`modeFor(scope)` 逐层找 scope 声明，找不到就回落 `defaultMode`（`dsh-tools/lib/index.js:2862-2872`）。本仓不用 preset，没有 scope 级 `presentAs`（它要求 `agent.ctx`，`dsh-tools/lib/index.js:2911-2926`），所以 patch 一开，**主 agent、subagent、task-engine 的 audit/entail 子代理、workflow 子代理全部**切到 ptc。

1. **长工具与人工等待被外层 120s/600s 封顶**。`run_code` 的超时包含嵌套工具与审批等待（`dsh-tools/README.zh.md:136`；`dsh-ptc-runtime-node/README.zh.md:50`、`:92`）。native 下这些工具各有自己的时限或后台交接：
   - `ask_user_question` 缺省 legacy，无限期等回答（`dsh-tool-ask-user/lib/index.js:181-196`、`:212-214`）；放进 run_code 后受外层时限。
   - `bash` 超时会转后台任务（`dsh-tool-bash/README.zh.md:51`、`:66`）；外层 run_code 超时会取消整段程序，后台交接语义不再成立。
   - `agent_group.send` 缺省等待 30 分钟（`agent-group/README.md:17`）；`subagent`、`task_execute`、`workflow`、`script_run` 都可能跑很久。外层默认 120s，模型必须每次显式抬 `timeoutMs`，上限 600s（可经 `ptc-runtime` 行抬高 `maxTimeoutMs`，但仍是有限值）。
   - `exit_plan_mode`、`task_stop` 的人工审批同理（`task-engine/README.md:37`）。
2. **`/tools` 面板失真**。TUI 的 `/tools` 用 `svc.schemas()` 全局视图（`TUI/src/app/adapter/dsh.ts:3667-3674`）；ptc 下 `schemas()` 仍返回全部可见工具加 `run_code`（`dsh-tools/lib/index.js:3116-3120`、`:3075`），而模型只能直呼 `run_code`（`:2932-2945`、`:3196`）。面板会列出模型实际不能直接调用的工具，需要 TUI 侧过滤或标注。
3. **提示词、模板与子代理迁移**。PTC 把 30 个插件的工具说明、参数与输出类型塞进生成的 SDK（`:2840-2857`），每个 agent 的上下文都变大；`command-template` 的模板只有 prompt/agent 步骤（`command-template/README.md:10`），里面若直接点名工具，需要改成 run_code 写法；subagent 与 task-engine 的提示词同理。PTC 的固定成本不承诺比 native 低（`dsh-tools/README.zh.md:205`）。
4. **TUI 渲染本身可用，不是阻塞点**。`tool/ptc-dispatch-start` / `tool/ptc-dispatch` 已处理（`TUI/src/app/adapter/dsh.ts:2741-2757`），子调用成功静默、失败红行（`TUI/src/app/state.ts:2135`）；`run_code` 走通用卡片，标题取 description（`dsh-tools/lib/index.js:1533-1538`）。阻塞不在渲染，在语义与权限。

结论：PTC 的「一行开关」是**技术可行**，不是**产品无痛**。对 TUI 最硬的两条是「所有 agent 一起切」和「长工具/人工等待被封顶」；`/tools` 与模板迁移是可控的后续工作。

#### 6.3 B：MCP 工具与资源三工具在 PTC 下怎么调用

挂载：`mcp-client` 不在 base（`dsh-base/cordis.patch.yml:492-493` 只有 mcp-resources）；每台 server 一行，必须走 `- insert:`：

```yaml
- insert:
    - id: mcp-github
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: github
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-github']
        env:
          GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN
```

配置面见 `dsh-mcp-client/README.zh.md:28-67`；`serverName` 是本地命名空间，工具名固定为 `mcp__<serverName>__<rawName>`（`:12`、`:75`），有损规范化会追加 12 位 hash（`dsh-mcp-client/lib/index.js:76-101`）。

进入 SDK：ptc 下 `sdkSchemas` 把所有可见工具（除 run_code）连同输出 schema 投影给 TS renderer（`dsh-tools/lib/index.js:3123-3135`、`:1820-1845`）；MCP 工具与三个资源工具都在内，资源工具只在有 client provider 时出现（`dsh-mcp-resources/README.zh.md:34`、`:90`）。模型写法：

```ts
const issue = await tools.mcp__github__create_issue({ title: "..." });
const doc = await tools.read_mcp_resource({ server: "github", uri: "..." });
return { issue, doc };
```

MCP 工具名允许 `-`，不是合法 JS 标识符时 SDK 要求引号访问 `tools["mcp__server__my-tool"](args)`（`dsh-tools/lib/types/ts-types.js:9-13`、`:237`）。

返回什么：MCP 工具在 PTC 下拿到规范值 `{content, structuredContent?}`（`dsh-mcp-client/README.zh.md:133`），不是 native 的文本投影；图片在能力证明后投影，含图子结果在外层结果之后追加（`dsh-tools/README.zh.md:215`；`dsh-mcp-client/README.zh.md:177-181`）。资源读取返回 JSON，二进制 `blob` 以 base64 留给程序化调用方（`dsh-mcp-resources/README.zh.md:104`、`:123`）。

已知限制：

- 单次 MCP 调用 60s（`toolCallTimeoutMs`，`:61`）；工具没有 `isConcurrencySafe`，按 exclusive 串行（`dsh-tools/lib/types/index.d.ts:159-171`、`:717-724`），多步墙钟为各调用之和；外层 120s/600s 见 6.2。
- 要求 task-based execution 的 MCP 工具会被拒绝（`:213`）；资源订阅与更新通知不支持（`dsh-mcp-resources/README.zh.md:122`）。
- 工具列表刷新是整代原子交换（`:110`），`tools/change` 会改变 SDK 前缀与 KV cache；server 指令与工具 schema 仍是不可信提示词文本（`:191`、`:159-167`）。
- `security-guard` / `auto-approve` 的边界与 native 相同（`mcp__*` allowlist / 仅审批链），不因 PTC 变好或变坏。
- 中间值没有统一字节上限（`dsh-ptc-runtime/README.zh.md:132`），只有外层结果受 `maxOutputBytes` 限制（`dsh-ptc-runtime-node/README.zh.md:52`）；大 MCP 结果应在程序内裁剪。

**B 的结论**：技术可行，未发现硬阻塞；代价是串行时间预算、全局 PTC 副作用，以及 SDK 类型对复杂 MCP schema 可能退化为 `unknown`（TS renderer 对不支持构造回落 unknown，`dsh-tools/lib/types/ts-types.js:206-218`）。

#### 6.4 C：不启 PTC 时，手写脚本化落在哪

先分清需求：

- **固定步骤批处理**（按序调 N 个 MCP 工具，聚合结果，步骤间用简单引用传值）：可以做，成本可控。
- **真脚本化**（任意循环、条件、错误恢复、动态拼参数）：不启 PTC 没有便宜的落点；自建脚本运行时等于重造 PTC 的绑定、SDK、进程、超时与审计，不建议。

| 候选落点 | 能覆盖 | 代价 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| 新包 `mcp_batch` | 固定步骤加聚合；只允许 `mcp__*` 与资源三工具 | 新包、单工具、测试、根级接线（主分支）；约 2 至 4 天 | 嵌套 dispatch 的策略/审批/取消/审计；`ToolRunContext` 的 parent/token 语义；与 PTC 部分重叠 | **推荐（有明确固定步骤需求时）** |
| 新包 `mcp_script`（自建受限脚本） | 任意控制流 | 重造 PTC：进程、绑定、SDK、超时、取消、审计 | 高；第二套语义；安全面大 | 不推荐 |
| `command-template` 扩展 | 提示词与子代理步骤，不执行工具（`command-template/README.md:10`） | 要加 tool step、权限、审计 | 把提示词编排与工具执行混层 | 不推荐 |
| 扩展 `session-channel` 任务面 | 跨会话消息与委托（`session-channel/README.md:3`、`:7`） | 要引入工具执行与凭据 | 职责错位；跨会话安全边界复杂 | 不推荐 |
| `script-interpreter` | OS 进程，不通道具（`script-interpreter/README.md:3`、`:58-62`） | 重造 PTC | 见 Q2 | 不推荐 |
| `workflow` | 子代理编排，不是工具级（`dsh-tool-workflow/README.zh.md:12`） | 每步一次模型往返 | 不减少往返 | 不推荐 |

`mcp_batch` 的最小形态：

- 参数 `steps: [{ tool, args }]`，可选 `timeoutMs`、`continueOnError`；`tool` 只接受 `mcp__*` 前缀与 `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource` 白名单。
- 用 `ctx.tools.execute(args, nestedExec)` 按序调用；`nestedExec` 继承调用方的 `agent`、`signal`、`rootCallId`，并设置 `parent`/`token` 以在两种模式下都保持嵌套语义（`dsh-tools/lib/types/index.d.ts:216-242`、`:282-287`；`ToolRunContext` 方法见 `:305-321`）。
- 聚合为 `[{ tool, ok, value?, error? }]`；每步独立超时；失败默认 fail-fast，可选 continue；回执标来源与步号。
- 不做代码求值、不做表达式、条件与循环；需要这些就回到 PTC 或不做。
- `security-guard` 要把 `mcp_batch` 纳入考虑：它不在两张插件登记表里，`unknownToolPolicy: "check"` / `"deny"` 下 `steps[].args` 里的 `command`/`path` 可能被保守拦；要么登记它的参数面，要么放行并接受不扫描。嵌套 MCP 调用仍各自过管线。
- 新包接线（`package.json` 的 `dsh.bundle`、`cordis.patch.yml`、根 `package.json` / `AGENTS.md` / README / profile）由主分支处理，本任务只写追踪文档。

**C 的结论**：固定步骤选新包 `mcp_batch`；真脚本化不启 PTC 没有好方案，应在需求侧降级或回到 PTC。

#### 6.5 D：TUI 环境下的推荐路径

| 阶段 | 推荐 | 说明 |
| --- | --- | --- |
| 现在（无 MCP server） | 保持 native；不实现 | 没有 server 与用例；PTC 的全局副作用不值得为一个未成立的需求承担 |
| 启用 MCP | 用 `- insert:` 挂 `mcp-client`，先只读 server；保持 native | 最小面；凭证/权限按 Q4；先验证工具与资源调用 |
| 出现固定多步需求 | 新包 `mcp_batch`（固定步骤加聚合） | 局部、不动 30 个插件；代价是嵌套 dispatch 与根级接线 |
| 需要任意脚本化 | 只有 PTC 一条路；需人工接受全 agent 切换、120s/600s 默认时限、`/tools` 与模板迁移 | 先隔离 profile 试跑；必要时抬高 `ptc-runtime.maxTimeoutMs`、修 `/tools` |

**一句话**：TUI 下推荐「保持 native + 按需挂 `mcp-client`」；固定多步走新薄包 `mcp_batch`；不推荐为 MCP 单独全局切 PTC，真脚本化才考虑 PTC。

**需要人工定的决策点**：

1. 需求是「固定步骤」还是「任意控制流」？前者 `mcp_batch`，后者只有 PTC。
2. 若选 PTC：能否接受**所有 agent**（含 subagent / task-engine audit / workflow 子代理）一起切？不能接受就不要选。
3. 若选 PTC：能否接受嵌套工具与人工等待受 120s/600s 默认上限（可配置抬高，但有限）？`ask_user_question` / `exit_plan_mode` / `task_stop` 是硬例子。
4. 若选 PTC：谁负责 TUI `/tools` 面板修正、模板与 subagent 提示词迁移、30 插件回归？这是额外工作量，不是一行 patch。
5. 若选 `mcp_batch`：允许的工具白名单、最大步数、单步/总超时、fail-fast 还是 continue、是否支持 PTC 父 token。
6. MCP server 清单、传输、凭据、只读优先、`security-guard` / `auto-approve` 接线（Q4）。
7. 根级接线（包数、README、profile、test-parallel）由主分支承接。

## 决策

**建议：不立项**（最终裁定待人工）。理由四条：

1. **能力面已覆盖，但 TUI 下 PTC 不是无痛开关**：工具编排 = `mcp-client` + PTC，资源读取 = `mcp-resources` 三工具；Q6 证明 PTC 技术可行，但全 agent 生效、长工具与人工等待受 120s/600s 约束，`/tools` 与模板还要迁移。故当前仍建议不立项。
2. **新脚本包只会重复 PTC**：绑定、SDK、并发、超时、取消、审计都要重造，且必然形成第二套语义（`mcp_batch` 只是固定步骤批处理，见 Q6.4，不是脚本运行时）。
3. **需求未成立**：当前没有任何已配置的 MCP server，也没有具体的多步工作流可优化；先有 server 与用例，才有可验证的设计。
4. **切换 PTC 的代价是全 agent 面的**，不属于一个小包能解决的问题；它应由用户按使用方式决定，而不是被一个脚本化包倒逼。

**TUI 推荐路径（Q6.5 摘要）**：保持 native；按需用 `- insert:` 挂 `mcp-client`；固定多步需求出现时新增薄包 `mcp_batch`；不推荐为 MCP 单独全局切 PTC。只有需要任意控制流、且人工接受全 agent 副作用时，才评估 PTC。

**重开触发条件**（任一成立）：

1. 已挂 server，且出现反复的多步 MCP 工作流，native 模式下的往返成本可量化地高；
2. 需要 native 模式下的批处理或编排，而用户不接受全局切 PTC；
3. 宿主的 PTC 出现与本仓不兼容的硬限制（例如工具 schema 渲染失败、TUI 不可用）且无上游修复；
4. 需要 MCP 特有能力（OAuth、资源订阅、批量模板展开）而宿主不提供。

**重开预案（仅记录，不实现）**：分两档。① 固定步骤：新包 `mcp_batch`（参数 `steps: [{tool, args}]`，只允许 `mcp__*` 与资源三工具，按序 `ctx.tools.execute`，聚合结构化结果，不做脚本语言；细节见 Q6.4）。② 任意控制流：PTC（profile patch `tools.mode: ptc` 加挂 `mcp-client`），但须先接受 Q6.2 的全局副作用；不推荐自建通用脚本运行时。

**对共享文档的建议（本文件不改两级 BACKLOG 与 STATUS）**：条目 6 的最终裁定与关闭由人工与主分支处理，本文件的建议是「不立项」。若用户要启用 MCP，可另立「挂载 `mcp-client` 与安全面接线」配置条目，不要塞回本条。

## 规划

### 计划改动文件清单

- `docs/implementation/2026-10-22-mcp-script.md`（本文件；本阶段唯一改动）
- 不新建包；不改 `script-interpreter`；不改共享文档与根级接线。

### 验收

- 五问（Q1 至 Q5）加 TUI 路径（Q6）逐条有结论与宿主证据；建议为不立项（最终裁定待人工）并给出重开条件。
- 按 task-engine 拆分 q1 至 q6 六个子任务，并以 `task_implement` 回填结论。
- 不改代码、不跑真机 MCP server；文档经 `format` 与 diff 自查。
- 未验证项：真实 server 的启动、调用与重连未实测；PTC 未启用，`run_code` 的 MCP 绑定未实测。
- Q6 的 PTC 装配结论来自源码与样例 patch；未实机 boot，未改 profile；正式启用前需隔离 profile 试跑。

### 偏差与未验证

- 宿主事实来自 0.2.1-rc.2 安装树的 README 与 `lib/index.js` 阅读，未起 server 实测。
- PTC 与 MCP 的组合是「README 明确声明 + 代码路径推断」，不是端到端验证；这也是建议不立项的理由之一（没有 server 与用例）。
- Q6 依 profile patch 写法与 base 依赖链推断 PTC 可装配；`--dump-config` 会写 profile 的 `cordis.yml`，本任务未执行，故未实机验证启动。
- 本机 bwrap 0.9.0 可用是环境事实；换机若 sandbox runner 不可用，PTC 会 fail-closed `sandbox-unavailable`。
- 升级宿主后需复核三处：`dsh-tools` 的 mode 与 PTC 语义、`mcp-client` 的 config 字段、`mcp-resources` 的工具面。
