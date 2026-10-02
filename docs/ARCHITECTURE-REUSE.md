# 本仓插件与官方包的复用审计（基线 DSH 0.2.0-rc.2）

> 职责：回答「本仓 18 个包（TUI + 17 插件；`md-logic` 于 2026-10-02 晚于本审计新增，未纳入下表）里，哪些能力官方已经有了、哪些该改用官方包、哪些该保留或并存」
> 不负责：接口怎么用（见 `docs/host/DSH-CTX-API.md`）、有哪些官方包（见 `docs/host/HOST-PACKAGES.md`）、升级差异（见 `docs/host/HOST-UPGRADE-0.2.0-rc.2.md`）
> 过期条件：官方发布新的「文件摘要 / 知识记忆 / 行级锚定编辑」类能力，或本仓新增 / 删除包时重做

> 口径：官方基线 `dsh 0.2.0-rc.2`（安装树 277 个 `dsh-*`；fff 已挂 102 个官方行，2026-10-02 实测）；本仓 18 包 = TUI + ast-tools / code-map / command-template / context-report / fs-digest / goal-contract / hash-edit / herdr-integration / knowledge-base / metric-loop / output-compress / rule-engine / security-guard / session-channel / session-title-cutoff / symbol-normalizer / task-engine。
> 判据：① 能力是否重合（同一诉求）；② 官方是否有等价物；③ 我们是否已在复用官方底座。三者交叉后给「改用 / 保留 / 并存」。
> 结论分布（2026-10-02）：**改用 0 / 保留 12 / 并存 6**。改造点见 §4。**本文件经子代理审阅后修订一轮**（见 §7）：三处事实性修正是——官方**有**文件级读后改前守卫、官方**有**会话日志 FTS5 检索（缺省关闭）、「双重截断」风险不存在。

## 0. 结论总表

| 包 | 官方最接近的面 | 重合度 | 结论 | 一句话理由 |
|---|---|---|---|---|
| `hash-edit` | `tool-fs`（`read`/`edit`）+ **`fs-observation-policy`**、`tool-str-replace-editor` | 中 | **并存** | 官方已有**文件级**「读后改前 + 版本守卫」（变更即拒 `FS_STALE_VERSION`，base 缺省挂载）；`hash-edit` 的差异化是**行级 LINE:HASH 锚点定位与漂移检测 + 整批原子拒绝**，而不是「官方没有陈旧校验」 |
| `fs-digest` | `tool-fs` / `fs` / `fs-local`（缝） | 低 | **保留** | 官方**没有**文件摘要 / 结构视图工具（277 包描述扫描 + 官方模型工具名全表均无 outline / digest / summary），`fs_digest` 的 outline / signatures / pruned 三模式无对应物 |
| `session-title-cutoff` | `session-title-llm` / `session-title-all-prompts-llm` | 高（同 provider 位） | **并存** | 同占 `ctx.sessionTitle` 唯一 provider；「裁剪窗口到最近一次 git commit 之后」官方没有；已复用官方 `session-title-llm` 的生成策略（按约定路径动态 import 官方模块） |
| `command-template` | `commands`、`workflow` / `tool-workflow` | 中 | **并存** | 「人面模板目录 + 模板级模型选择 + 多步编排」官方没有（官方只有模型侧 workflow 脚本与裸命令注册）；执行侧已复用宿主 subagents / workflow / ptc |
| `context-report` | `session-stats`、`session-turn-outline`、`session-telemetry` | 中 | **并存（需收窄）** | 本包**自折叠** turns / 墙钟（`fold.ts:19,201,242`），而官方 `sessionStats` 的口径（turns/steps + llm/tool 墙钟 + 首 token / decode）几乎逐项对应 → 应复用官方投影；token 与上下文占用仍是官方空缺 |
| `session-channel` | `session-query`、`session-reference`、**`experimental-agent-team`** | 低 | **保留** | 官方两个读写面都是**只读**（查询 / 快照引用）；**同会话**持久 peer mailbox 官方有实验实现（`experimental-agent-team`，未挂），**跨会话 / 跨进程写**（消息、委托、共享 KV、任务回传）仍无等价物 |
| `output-compress` | `spill` / `spill-local` / `spill-policy`、`compaction-tool-result-pruner` | 中 | **并存（互补）** | 官方阈值管**模型可见面**（超预算转 preview + locator）并做 surface 裁剪；我们**读取 spill 通知与文件**做摘要入库。我们从不回写事件 → 不存在「双重截断」；要做的是把分工与阈值语义写进 DESIGN |
| `rule-engine` | `agent-instructions`、`hook-protocol`、`hooks-*`、**`repeat-tool-reminder`** | 中 | **保留** | 官方有 `agent-instructions`（静态指令文件）、`repeat-tool-reminder`（**单点**内置提醒）与外部 agent 的 hooks 接入；**规则表 + 多节点注入 + 消费者框架**官方无 |
| `symbol-normalizer` | `agent-instructions` | 低 | **保留** | 符号规范（展示归一 + 回合审查）是项目约定；官方只负责加载指令文件 |
| `knowledge-base` | `storage` / `storage-domain` / `storage-json`、**`session-query-sqlite`** | 中 | **保留** | 官方**有**检索面，但只覆盖**会话日志**（FTS5 搜索，base 已挂载、缺省 `openAt: never` 未开启）；缺的是**知识条目 / 持久记忆语义**：写穿入库、重要度、合并 / 淘汰 / 巩固与隐私过滤 |
| `task-engine` | `workflow` / `tool-workflow`、`tool-todo`、`plan-mode` | 中 | **保留** | 官方 workflow 是模型侧脚本编排、todo / plan 是轻状态；**门禁 + 验收（RET）+ 帧状态机 + 执行后端**官方无；执行侧已复用宿主 subagents / workflowEngine / ptcRuntime（reflect 可选读）与 approval / tokenMeter / agentDefaultModel |
| `goal-contract` | `goal` / `tool-goal`、`userQuestions` | 中 | **保留** | 官方 goal 只有状态与生命周期；「Done-when 契约起草 + 可验证条款」是扩展，且已复用官方 goals / userQuestions |
| `metric-loop` | **`tool-ralph`**、**`goal-round-driver`**、`schedule`（未挂）、`workflow` | 中 | **保留（有缺口）** | 官方已有**循环 / 自主续跑**面：`tool-ralph`（模型面 fresh-agent 循环，直到完成 / 受阻 / 轮数上限）与 `goal-round-driver`（带竞态护栏的自主续跑），两者 fff 均已挂载；`metric-loop` 不可替代的是**测量命令驱动的指标循环 + plateau / 边界停止 + 状态文件跨进程** |
| `security-guard` | `sandbox-policy`、`permission-presets`、`experimental-auto-review` | 中 | **并存** | 官方管「沙箱等级 + 审批预设（+ 实验性逐工具 LLM 审查，未挂）」；我们在 `tools/pre-execute` 做**命令 / 路径模式拦截**（该点官方无竞争监听，deny 可达；「先于官方策略」是当前实现事实，无显式顺序契约） |
| `md-logic`（2026-10-02 新增包） | `tool-fs`（`read`）、`tool-fs-search`、官方无「文件结构视图」类包 | 低 | **保留** | Markdown 逻辑结构（节树 / 块 / 链接清单，带行范围），官方无等价物；与 `fs-digest` 的分工是「轻量快览 vs 真实解析深查」 |
| `herdr-integration` | 无 | 无 | **保留** | 本机 herdr 面板桥，官方无对应物 |
| `TUI` | `client-ui-*`（53 包，Web / 桌面） | 低 | **保留** | 官方客户端是浏览器 / 桌面面；终端 TUI 是不同形态，且本项目「只用 TUI、走 profile 全局组合」是既定口径 |
| `ast-tools` | `tool-fs-search`（`grep` / `glob`）、`code-map` | 中 | **保留** | 官方检索是**文本级**，AST 形态查询（ast-grep）官方没有；**已注册模型侧工具** `ast_query`（search / outline / rules）+ `ast_replace`（默认 dry-run），`inject: ["tools"]`（2026-10-02 落地） |
| `code-map` | `lsp`、`tool-fs-search` | 低 | **保留** | 项目级结构索引 / 影响面 / 候选调用图官方没有；**LSP 语义层已接线但当前不可达**（LSP 三件套不随包分发，见 §5） |

## 1. 保留项（12）的共同理由

官方在这 12 个诉求上**没有等价能力**（表中逐条给了最接近的官方面，或为「无」）：文件摘要 / 结构视图、行级锚定编辑（官方只有文件级）、知识条目与记忆语义、AST 形态检索、项目级结构地图、规则表 + 多节点注入 + 消费者框架、任务门禁与验收、Done-when 契约、指标驱动的循环、跨会话写入、符号规范、终端 TUI、herdr 桥。

两处「看起来像但没有替代」的对照：`metric-loop` 的循环诉求官方有 `tool-ralph` / `goal-round-driver`（区别在「指标测量 + 边界判定 + 跨进程状态」）；`knowledge-base` 的检索诉求官方有会话日志 FTS5（区别在「知识 / 记忆语义」）。

## 2. 并存项（6）的边界

| 并存对 | 谁负责哪一段 | 模型面 / 人面处理 |
|---|---|---|
| `hash-edit` ⇄ 官方 `read` / `edit`（`tool-fs` + `fs-observation-policy`） | 官方：文件级「读后改前 + 版本守卫」（`FS_STALE_VERSION`）；`hash-edit`：**行级**锚点定位与漂移检测、一次提交多条编辑且任一条失效整批拒绝 | 两者都在模型工具面；分歧点是**粒度与原子性**，靠工具描述区分（先例：`fs_digest` 与 `code-map` 并存） |
| `context-report` ⇄ `session-stats` / `session-turn-outline` | 官方投影：轮次 / 步数 / 墙钟 / 回合大纲；`context-report`：token 与上下文占用（`sessionContext` 折叠）、三档报告 | 只有 `context_report` 在模型面；官方投影是服务面，供我们读取（§4 A） |
| `output-compress` ⇄ `spill-policy` / `compaction-tool-result-pruner` | 官方：**模型可见面**的超预算处理（preview + locator）与 surface 裁剪；我们：以 spill 为上游输入做**有损摘要入库 + 分片**（知识库可检索），不回写事件 | 官方两行已挂载；要做的是**阈值语义的文档口径**（§4 B），不是修冲突 |
| `command-template` ⇄ `commands` / `workflow` / `tool-workflow` | 官方：命令注册表 + 模型侧 JS 编排；我们：**人面** `/playbook` 模板目录、模板级模型选择、步骤编排 | 模型面 `workflow` 官方独占；我们不注册同名工具，只注册 slash 命令 |
| `security-guard` ⇄ `sandbox-policy` / `permission-presets` | 官方：沙箱等级与审批预设；我们：危险命令 / 敏感文件的模式拦截（`tools/pre-execute`，命中即 deny） | 若将来启用 `experimental-auto-review`，需先划界（谁拥有最终否决权，见 §5） |
| `session-title-cutoff` ⇄ `session-title-*` | 官方 provider：全量 / 首条消息；我们：裁剪窗口后的 provider | `ctx.sessionTitle` 只允许一个 provider → fff 显式 `disabled: true` 关掉官方 all-prompts（设计结果，不是冲突） |

**内部边界补充（二）**：`md-logic` ⇄ `fs-digest`（同一文件的结构视图，2026-10-02 起两处并存）——范围口径一致，分歧仅在解析精度（setext / HTML 块 / 缩进代码块 / 懒续行 / `html`·`hr` 两种新 kind），两个 README 互相指路：快览用 `fs_digest`，深查（链接 / 定义 / 嵌套 / 表格维度）用 `md_logic`；改 Markdown 仍用 `hash_edit`。

**内部边界补充（一）**：`knowledge-base` ⇄ `output-compress` **共用同一个 `dbPath`**（profile patch 指定），`output-compress` 经共享写入器直写知识库、不经过 `knowledge-base` 的入库规则与隐私过滤（`persistRules`）。这是设计取舍（避免依赖循环），但两包写入口径必须同步——见 §4 观察项。

## 3. 已复用的官方面（按代码实测重写，2026-10-02）

形态：`inject`（硬依赖）/ `get`（执行期惰性读）/ `reflect`（可选读）/ 事件（订阅或应答）/ `import`（按约定路径动态 import 官方模块）。

| 包 | 复用的官方底座 |
|---|---|
| `TUI` | inject `agents`；get `agentDefaultModel` / `agentPresets` / `commands` / `jobs` / `llm` / `permissionPresets` / `profileContext` / `sessionQuery` / `sessions` / `sessionTitle` / `settings` / `skills` / `subagents` / `tools` / `web` / `workflowEngine`；事件 `approval/request`（以应答者身份挂在 waterfall 链上，**不是**用 `ctx.approval`）、`session/event` |
| `task-engine` | inject `tools`；get `subagents` / `workflowEngine` / `approval` / `agentDefaultModel` / `tokenMeter`（执行期惰性解析；`subagents` / `workflowEngine` 在 apply 期不可见属已知） |
| `command-template` | inject `commands`；import `dsh-subagent`（按约定路径解析后动态 import） |
| `context-report` | inject `sessionProjections` / `sessions` / `tools`；get `tokenMeter` |
| `goal-contract` | inject `tools` / `userQuestions` / `goals` |
| `session-title-cutoff` | inject `sessionTitle` / `llm`；import `dsh-session-title-llm`（复用官方生成策略） |
| `session-channel` | inject `tools` / `agents` / `sessions` |
| `rule-engine` | inject `agents` / `sessions`；事件 `session/event`、`agent/pre-step` 等注入节点 |
| `knowledge-base` | 事件 `session/event`（写穿入库白名单）、`compaction/end`、`compaction/summary`（巩固触发） |
| `output-compress` | reflect 可选读 `ptcRuntime`（宿主沙箱后端）；事件 `session/event` 的 `tool/result`（只读，不回写） |
| `security-guard` | inject `tools`；事件 `tools/pre-execute`（拦截点） |
| `code-map` / `fs-digest` | inject `tools`；get `lsp`（**当前不可达**，见 §5） |
| `hash-edit` / `ast-tools` | inject `tools`（`ast-tools` 2026-10-02 起注册 `ast_query` / `ast_replace`，同时保留库 / 服务面） |
| `md-logic` | inject `tools`（注册 `md_logic`：structure / blocks / links）；解析用 `marked` 实例，不消费宿主服务 |
| `metric-loop` / `herdr-integration` / `symbol-normalizer` | inject `tools` / `agents` / —（`symbol-normalizer` 消费本仓 `ruleEngine` 服务） |

## 4. 可执行改造清单（未立项，用户择时）

| # | 改造 | 落点 | 工作量 | 依赖 / 前置 |
|---|---|---|---|---|
| A | `context-report` **改用已挂的 `sessionStats` / `turnOutline`** 提供轮次 / 墙钟 / 大纲，去掉自己的同类折叠（保留 token / 上下文占用口径） | `context-report/src/{fold,main}.ts` | 1 h | 官方两行已于 2026-10-02 挂载；需先对齐单位与「首 token / decode」口径 |
| B | `output-compress`：把与官方 `spill-policy` / `compaction-tool-result-pruner` 的**分工与阈值语义**写进 DESIGN，并记录「spill 文件 + 知识库」双份存储的取舍 | `output-compress/docs/DESIGN.md` | 0.2-0.5 h | 无（**不是**修双重截断——实测不存在） |
| C | `metric-loop` 唤醒链缺口：挂 `@deepseek-ai/dsh-schedule`（提供 `schedule_create` 等模型工具），或把提示改为不依赖宿主 schedule | 仓库外 profile / `metric-loop/src/engine.ts` | 0.5-1 h | **需用户裁定**：挂它等于**新增模型工具面**（与上一批「只挂服务 / 投影面」口径不同）；另一条路是评估「改用 `tool-ralph` / `goal-round-driver` 承担循环、metric-loop 只留指标测量」 |
| D | `hash-edit` / `fs-digest` 可选改用 `ctx.fs` 读（沙箱一致，替代直接 `node:fs`） | 两包 `src/**` | 1 h | **含行为变更**：`ctx.fs` 后端是 `fs-sandbox`，hash-edit 的**写**会从「node:fs 直写（当前绕开沙箱）」变为受 workspace-write 围栏；且 `ctx.fs` 的版本守卫是文件级，**不能**替代行级锚点语义。宜与 `hash-edit/docs/BACKLOG.md` #1（render 缺陷）同批 |
| E | 把「可挂但不该挂」清单（§5）落到**非生成型**文档（`docs/BACKLOG.md` 观察项 / `profiles/example/cordis.patch.yml` 注释）——不要写进 `HOST-PACKAGES.md`（升宿主后重生成会被覆盖） | `docs/BACKLOG.md` / `profiles/example` | 0.2 h | 无 |

**新增观察项（本次审阅补出）**：① `knowledge-base` ⇄ `output-compress` 共库直写的隐私边界（两包写入口径需同步）；② 是否用配置开启 `session-query-sqlite` 的 FTS5（`openAt: first-search`）并与知识库做分工验证；③ `rule-engine` 与官方 `repeat-tool-reminder` 的注入重复度评估。

## 5. 判定为「可挂但不该挂」的官方面

| 官方面 | 为什么不挂 |
|---|---|
| `tool-str-replace-editor` | 与官方 `read` / `edit` 功能重叠，再挂等于给模型两套文本编辑器；若将来要挂，应先决定是否用它取代 `read` / `edit` 的一部分 |
| `experimental-auto-review` | 逐工具 LLM 授权审查，与 `security-guard` 拦截层诉求重叠；experimental 且默认关闭，启用前需先划界 |
| `schedule` / `time-context` / `client-ui-schedule` | 与 `metric-loop` 唤醒链相关（§4 C）；是否挂需用户裁定，且会改模型工具面 |
| `hooks-claude-code` / `hooks-codex` | 面向外部 agent 的 hook 协议接入，本项目不用这些外部 agent |
| LSP 三件套（`lsp` / `lsp-stdio` / `tool-lsp`） | **不随包分发**（`HOST-PACKAGES.md` §4）：fff 下 `ctx.get('lsp')` 恒 undefined → `code-map` 的 `precision: "lsp"` 与 `fs-digest` 的 LSP 定位路径当前**不可达**（缺省走 structural 回落）。要用需自行从源码仓库安装 |
| `host-webserver` / `client-ui-*` / `web-frontend` | 用户裁定的排除面（Web / 客户端） |

## 6. 复现命令

```sh
# 官方能力面扫描（关键结论的证据）
D="$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai"
for p in "$D"/dsh-*; do node -p "const j=require('$p/package.json'); [j.name,(j.description||'')].join(' | ')"; done \
  | grep -iE 'digest|summar|outline|search|fts|version-guard|read-before'

# 已挂官方行（对齐 HOST-PACKAGES §1）
dsh --profile fff --dump-config | grep -oE "name: '@deepseek-ai/[^']+'" | sort -u

# 本仓各包实际消费的官方面（§3 的生成口径）
for d in TUI */; do
  echo "== $d"
  grep -rhoE "inject *[:=] *\[[^]]*\]|ctx\.(get|reflect\.get)\(['\"][A-Za-z.]+['\"]\)|loadHost\(['\"]@deepseek-ai/[a-z-]+" $d/src 2>/dev/null | sort -u
done
```

## 7. 修订记录（2026-10-02，子代理审阅后）

| 原结论 | 修正后 | 依据 |
|---|---|---|
| 「官方 `edit` 无陈旧校验」 | 官方**有**文件级读后改前 + 版本守卫 | `dsh-fs-observation-policy` 描述与 README、`dsh-fs-local/lib/index.js:888`（`FS_STALE_VERSION`）、base 缺省挂载 |
| 「官方无检索 / 记忆类包」 | 官方**有**会话日志 FTS5 检索（已挂载、缺省 `openAt: never`）；缺的是知识 / 记忆语义 | `dsh-session-query-sqlite` 描述、base `cordis.patch.yml:145-152` |
| 「`output-compress` 与官方 spill 可能双重截断」 | **不存在**：我们不回写事件，只以 spill 为上游输入做摘要入库；改为「阈值语义文档化」 | `output-compress/src/hooks.ts`（只读订阅）、`trigger.ts`（解析官方 spill 通知） |
| 「§3 已复用官方面」凭印象填写 | 按代码实测重写（删 8 处不存在项、补 4 处漏记，LSP 标为不可达） | §3 的生成命令 |
| 「`metric-loop` 官方只有 schedule」 | 官方还有 `tool-ralph`（循环）与 `goal-round-driver`（自主续跑），均已挂载 | `HOST-PACKAGES.md` 对应行、base patch |
