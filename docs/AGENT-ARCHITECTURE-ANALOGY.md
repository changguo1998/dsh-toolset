# AGENT 设计讨论整理 —— 计算机体系结构类比

> 来源：dsh-toolset 迁移调研期间的设计讨论。
> 主题：用计算机体系结构的视角重新审视 agent 系统的功能划分、执行模型与确定性控制。
> 用途：作为后续 agent 系统设计与迁移实现的架构参考（姊妹文档：`docs/PI-DSH-FEATURE-COMPARISON.md`）。

## 0. 一句话主线

**agent 本质是一台"软件实现的计算机"**：LLM 是 CPU，上下文是存储层次，工具是外设，审批是中断，workflow 是编程语言，会话是进程，glla 是跑在 OS 上的作业管理服务。用这套视角，可以把 agent 里被拆碎的概念重新聚拢、确定层次，并导出确定性控制的实现方案。

## 1. agent 的可用功能域（9 类）

| 功能域 | 内容 |
|--------|------|
| ① 对话与交互层 | 会话生命周期、状态可见性、多模式输入、主题配置 |
| ② 任务控制 | goal（目标）、list（任务队列）、loop（自动循环）、audit（验收），以及 todo、jobs、schedule |
| ③ 子代理与协作 | 单 agent 委派、多 agent 并行、workflow 编排、advisor、跨会话协调 |
| ④ 记忆与上下文 | 持久记忆、会话搜索、知识库、上下文压缩、事件捕获 |
| ⑤ 代码与文件 | 安全文件操作、多层搜索（文本/AST/符号）、LSP、代码索引、项目报告 |
| ⑥ 外部世界接入 | 联网搜索、URL 抓取、MCP、PDF/视频、GitHub |
| ⑦ 安全与治理 | 沙箱、权限预设、审批链、危险命令拦截、凭据、速率控制 |
| ⑧ 模型与运行 | 多 provider、默认模型/路由、token 计量、压缩策略、调度 |
| ⑨ 技能、模板与资产 | skills、slash 命令/提示词模板、persona、主题 |

## 2. 与计算机体系结构的对应（合并后最小划分）

agent 里分得越细的，越是同一硬件资源在扮演不同角色。按硬件部件归并后压到 **4 大类 + 1 软件层**：

| 部件类（硬件） | agent 中被拆开、硬件里同类的东西 | 合并原因 |
|---|---|---|
| **处理器（运算）** | 模型推理 · provider 适配器 · 模型路由 · agent 主循环 · 流式流水线 · 工具执行 · 子代理/council · token 计量 | 同一 CPU 的执行面：流水线、专用执行单元、多核、PMU |
| **控制与保护（CPU 控制面）** | 审批链 · 沙箱/权限预设 · 敏感文件保护 · rate-guard/watchdog · 重复提醒 · audit | 中断/异常、特权级/MMU、看门狗、自检 |
| **存储层次** | 即时上下文 · compaction 摘要 · 会话事件 · JSONL 持久化 · 知识库 · spill · memory/search | 寄存器→Cache→主存→磁盘的同一存储系统 |
| **I/O 与互连** | web/MCP/PDF/文件/PTY（外设）＋ subagent/workflow/intercom/acp/sdk（总线） | 外设与总线本就是同一 I/O 子系统 |
| **系统软件层（OS，软件承载）** | 引导装配 · 调度（goal/list/todo/jobs/schedule）· 命令/模板/技能/人格/主题 · 诊断统计 | 一整块软件层，不再增殖 |

可再并到严格三大件：**处理器、存储、I/O**（控制面并入处理器），OS 单独一层。

## 3. 会话 = 进程

dsh 的 session API 几乎照进程语义设计：

| 操作系统进程 | dsh 会话 |
|---|---|
| 独立执行上下文 | 独立事件日志(seq) + agent 实例 + 状态 |
| 地址空间隔离 | 会话间隔离、损坏会话单独容错（fail 隔离） |
| 就绪/运行/阻塞/终止 | `session.status`（idle/running）、`disposed` |
| `fork()` | `session.fork(source, boundary, childId)` |
| 内存映像换出/恢复 | JSONL 持久化 = 磁盘映像；`resume` = 恢复 |
| IPC | intercom / acp / sdk |
| 退出码 + 看门狗 | audit、repeat-tool-reminder |

**边界（类比失真点）**：

- 并行性：OS 进程真并发，dsh 会话多"单前台 agent 串行"——成立的是隔离/生命周期/IPC 语义，真并行在 subagent 层；
- fork 语义：进程 fork 是写时复制内存，session fork 是共享日志前缀 + 独立续写（更像 git branch）。

**补充映射**（主映射见 §0）：subagent ≈ 线程/轻量进程；jobs ≈ 守护线程/DMA 异步 I/O；tools = 设备；intercom/sdk = IPC。

## 4. workflow = 编程语言

有了这一层，这台"会话即进程"的计算机才真正可编程。

| 计算机体系结构 | Agent 系统 |
|---|---|
| 机器码 / ISA | 模型每步直接调用工具（bash/fs/LSP/审批） |
| **编程语言** | **workflow**：JS 表达顺序/分支/循环/并发/数据流/函数复用 |
| 编译器 / 解释器 | workflow-worker-thread + ctx.workflowEngine |
| 系统调用（syscall） | ctx.subagents / ctx.workflowEngine 等能力缝 |
| 标准库 / 框架 | 内置 workflow patterns（deep-research、audit 等） |
| 应用程序 | 用户写的 workflow 脚本 |

**语言代际**：机器码（模型裸调工具）→ 汇编/宏（prompt-template 固化步骤）→ 高级语言（workflow 可组合）→ 框架（内置 patterns）。

## 5. OS 与 goal 不一致：goal 是"作业（job）"

- **OS 的核心职能**：资源抽象、隔离、调度、保护——管"怎么执行"，对应 **dsh 宿主运行时**（cordis + ctx.\* 服务），不是 glla；
- **goal 的核心职能**：意图声明、状态追踪、完成验证——管"要达成什么"，对应**批处理系统中的作业（job）**。

| OS 功能 | agent 对应 |
|---|---|
| 进程管理 | session store + agent loop |
| 内存管理 | 上下文管理/compaction/存储层次 |
| 文件系统 | workspace / fs 服务 |
| 设备管理/驱动 | 工具注册表 + provider 适配器 |
| 中断/异常、权限保护 | approval、sandbox、permission-presets |
| IPC | session/event 事件总线、subagent 通信 |
| 系统调用接口 | ctx.\* 注入服务 |
| 作业控制 | **glla（goal/list/loop/audit）** |
| shell | TUI/CLI/slash 命令 |

## 6. glla = 用编程语言实现的系统服务

goal/list/jobs/schedule 不是硬件、不是内核，而是**用编程语言写出来的用户态系统服务程序**——就像真实计算机里的 cron、批处理调度器、任务队列、systemd/supervisord。

| 计算机系统中的服务程序 | Agent 对应 |
|---|---|
| cron / systemd timer | schedule |
| 批处理调度器（Slurm/PBS）/ 任务队列（Celery/RQ） | list（作业队列） |
| systemd unit / supervisord | goal（作业状态机）+ jobs |
| 常驻守护循环（daemon / CI watcher） | loop |
| CI 验证阶段 / watchdog | audit |

**分层**：硬件层（LLM/工具/存储）→ 内核层（dsh 宿主）→ 语言层（workflow）→ **服务层（glla，用语言实现的常驻程序）** → 应用层（具体任务）。

**判断标准**：凡是"可以完全用 workflow 脚本重写而不改 dsh 宿主"的功能都属于服务层；必须由宿主提供的才是内核层。→ glla 的 gap（list/audit/loop 语义）应当作为新服务程序，用 workflow/插件在 ctx.\* 之上实现，而不是改内核。

## 7. 执行粒度：run / turn / step

```text
run（一次运行/执行实例）      ← 最外层：跑一个任务/程序
  └─ turn（回合）             ← 一次问答/交互周期（函数调用）
       └─ step（步骤）        ← 一次原子运算（一条指令）
            └─ chunk/token    ← 流式节拍（时钟周期）
```

- **一次运算 = 一次 step**：一次工具调用或一次模型推理决策，dsh 有 `step/start`/`step/end`（载荷 `{turn, step}`）事件承载；指令周期（取指-译码-执行-写回）详见 §11.1 与 §13.1；
- **程序计数器 = 会话事件序号 seq**：每完成一次运算 seq 单调递增，下次从最新 seq 处"取指"；
- **turn vs step**：turn 是回合（turn/start→turn/end，reason：completed/aborted/blocked/error/max-tokens/interrupted），step 是回合内原子动作（step/start→step/end），一个 turn 含多个 step——turn=函数调用，step=函数体里的指令；
- **run**：一次执行实例，无统一事件承载（workflow run、subagent run、agent run 各有 id）；dsh 里最接近的是 `session.status`（idle/running）。run=运行一次程序，会话=进程。

## 8. 从概率输出到确定性操作

**核心**：单个 token 永远是概率性的，"确定性"来自两道闸：① 结构约束（schema/文法/离散动作集）把无限输出空间压到有限合法集；② 执行验证（validator）保证只有合法结果进入系统状态。**确定性 = 模型做受限选择，系统做裁决与执行。**

工具调用之所以"确定"，是因为同时有 schema（结构）+ 参数校验（验证）。推理链条要获得同等确定性，必须把"推理"从自由文本降级为受约束的决策原语。

**四层控制（由轻到重，可叠加）**：

| 层 | 机制 | 说明 |
|---|---|---|
| L1 结构化输出 | 离散字段 + JSON Schema/受限解码 | 如每个 step 强制输出 `{step_type: reason\|tool\|stop}`；reason 正文进固定字段不进系统状态 |
| L2 验证门禁 + 重试 | validator 只放行合法结果 | step_type 合法、参数过 schema、状态前后一致；失败带反馈重试 |
| L3 状态机/工作流 | 控制流移出模型 | 模型只在决策点从枚举动作集中选一 + 填参数；控制流由确定性执行器跑 DAG/脚本 |
| L4 计划-执行分层 | 先结构化计划再执行 | 模型产出计划 JSON，执行器按计划跑，模型只在计划内局部决策 |

**落到 dsh**：tool-call-delta 已是结构化通道（L1 半边）；step/start-end 已是事件化裁决点；workflow + tool-ralph 即 L3。缺口 = step_type 的结构化强制 + step 级 validator 门禁——可迁移到 dsh 的新插件面（见 §16）。

## 9. 直接实现 vs 自顶向下拆分

| 维度 | 直接实现（联想式） | 自顶向下（规划式） |
|---|---|---|
| 流程 | 任务 → 匹配记忆/模式 → 产出 | 任务 → 目标树 → 子问题 → 逐层细化 → 可执行原子步 |
| 知识使用 | 检索+联想（System 1） | 推理+分解+抽象（System 2） |
| 控制流 | 单轮生成 | plan → execute → verify 多轮闭环 |
| 错误发现 | 事后（运行/测试失败才暴露） | 事前（分解时暴露歧义） |
| 开销 | 快、省 token | 慢、贵 |
| 可审计性 | 黑盒 | 分解树可回溯 |
| 确定性 | 低 | 高 |

**为什么 LLM 倾向直接实现**：训练目标（next-token，语料大量"问→答"直接配对）、自回归性质（无显式规划循环）、上下文压力、RLHF 偏好简洁。

**关键洞察**：直接实现对简单任务是最优解；对复杂任务是"把概率性释放到整条链路上"。自顶向下本质是"把概率关进笼子"：分解树确定结构（确定性骨架），模型只在叶子做局部决策。类比：直接实现 = 解释执行；自顶向下 = 编译（源码→AST→IR→优化→代码生成）。

**强制自顶向下的手段**：① plan 门禁（先输出结构化计划，经校验/确认后才允许实现）；② 分解到可执行粒度（叶子=一次 step 可完成）；③ 每层验证契约（verificationContract）；④ 复用 glla/workflow（list 承载队列、workflow DAG 承载结构、audit 验收）。

## 10. 强制"每次只细化一层"

**核心**：不要靠提示词求它"只细化一层"，而是把"细化一层"变成模型唯一的合法输出动作——一个工具调用。输出通道里没有"实现"这个选项，模型无从直接实现。

**① 分解动作工具化（schema 强制）**：`decompose(node)` 输出子任务列表（id、标题、验收、是否需再拆）——参数里没有 code/实现字段，schema 层面排除一步到位；`implement` 仅对叶子节点开放。

**② 外部执行器持有任务树（深度控制）**：模型不决定下一步，执行器决定——维护任务树、每次只取一个待细化节点喂给模型、输出子节点后校验挂树、再取下一个；细化策略（BFS 逐层/DFS 下钻）由执行器定。

**③ 验证器判定"是否真的只细化了一层"**：

| 检查 | 规则 |
|---|---|
| 越级 | 子任务含实现细节/代码 → 拒绝，要求再抽象一层 |
| 过粗 | 还能拆出多动作但标记可执行 → 拒绝 |
| 过细 | 叶子仍含多步骤 → 拒绝，要求拆到单 step |
| 数量 | 子任务数超上限（如 7）→ 拒绝，要求合并 |

不通过 → 输出不进状态，带反馈重试。**概率性被关在"这一层怎么分"里，系统状态只接收"粒度已裁决"的结果。**

**叶子判定**：叶子 = 一次 step 可完成（单工具调用/单段代码/单次问答）；只有执行器标记为叶子的节点才允许 `implement`。

**为什么能控制住**：直接实现是自由文本，自由文本无法可靠约束；把它变成"不存在的工具"就从通道上消灭了它。每次推理的输出空间被压缩为 decompose/implement 二选一，由 schema 和 validator 双重裁决；深度控制权在执行器（确定性层）手里，模型只是局部决策器。

**计算机类比**：逐层 IR 降级——编译器前端每次只降一层（AST→高层 IR→低层 IR→指令），从不一步生成机器码。

**落地形态**：`plan-decompose` 插件（工具 + 树存储 + 遍历器），细节并入 §16.1。

## 11. 最小推理步骤（step）的构成

### 11.1 五要素

一个最小的推理步骤 = 一次"可定位、可裁决、可写回"的原子运算（对应一条指令）：

| # | 要素 | 内容 |
|---|------|------|
| 1 | 定位（取指上下文） | run/turn/step 归属 + seq（程序计数器）+ 输入上下文 |
| 2 | 决策（译码） | 离散 `type ∈ {reason, tool, decompose, implement, stop}` |
| 3 | 裁决（验证门禁） | schema 合法 + 语义合法（前置条件/粒度/权限/状态一致） |
| 4 | 执行（副作用） | 工具结果 / 推理产出 / 子任务挂树 |
| 5 | 写回 + 下一步 | 事件 append 进日志（seq 递增）+ step/end + 执行器决定 next |

五要素的字段集：`seq / run / turn / step`（定位）＋ `type / payload`（决策）＋ `accepted`（裁决）＋ `result`（执行）＋ `next`（下一步）。

关键点：**"推理"不是步骤的必要内容——裁决后的结果才是**。推理正文只是决策过程的瞬态中间产物，不进系统状态；这是确定性（§8）的落点。

### 11.2 与 dsh 事件流的对应（约 70%）

一个 step 在 dsh 里是**一组事件构成的窗口**（step/start → chunk\* → tool/result? → step/end），不是单事件：

| 要素 | dsh 事件流 | 状态 |
|------|-----------|------|
| 定位 | step/start {turn,step} + 事件自带 seq | ✅ |
| 决策 type | 由 assistant/attempt 的 stream 记录推断（text-chunks/reasoning-chunks/tool-call-chunks） | ⚠ 无显式字段 |
| 裁决 accepted | 无对应 | ❌ 需补 step 级 validator |
| 执行 result | tool/result（+meta），纯推理步无 | ✅ |
| 写回 | 事件 append 进日志 | ✅ |
| 结束 | step/end（回合末另有 turn/end） | ✅ |
| 下一步 next | 无显式字段，agent loop 内部决定 | ❌ 需补执行器 |

缺 accepted 与 next 两字段——正是确定性控制要新增的部分；补上后，逻辑 step（schema 规范视图）与物理事件窗口（持久化形式）可严格互译。

### 11.3 现状机制（无结构化输出 / 门禁 / 执行器时）

- **决策**：模型隐式生成——流式输出中"说"出下一步（reasoning-delta=推理、tool-call-delta=调工具、finish=结束）；无显式 step_type，系统不裁决、不记录选择理由；
- **操作**：半结构化外壳（tool_calls 协议强制工具名 + JSON 参数）+ 运行时直接执行 + tool/result 返回；无语义门禁；
- **门禁只有三道薄闸**：API 参数解析（结构层）、运行时错误（事后暴露）、审批链（人在环）；
- **控制流**：agent loop 固定 ReAct 循环（模型输出 → 执行工具 → 结果回填 → 再给模型 → … → finish）；loop 只是循环骨架，不裁决节点与转移，next 由模型隐式决定；
- **本质**：现状 = 事后纠错（报错/重试/人发现）；设计 = 事前约束（结构 + 门禁 + 执行器）。确定性只存在于工具调用外壳，其余靠模型自觉。

## 12. 存储层次设计：L4 知识库

> 依据：本地实证（context-mode 双 FTS5 + sources 表；hermes-memory 元数据分层 + last_referenced + TRIGGER 写直达 + backfill 兜底）＋外部范式（MemGPT 分页、Cline/Claude Code 文件型记忆库）。

### 12.1 结构（4 张表 + 双 FTS5 影子表）

| 表 | 关键列 | 职责 |
|---|---|---|
| sources | kind（session/file/url/tool_result/manual）、label、ref、content_hash、chunk_count | 溯源 / 去重 / 记账 |
| chunks | source_id、project、target、category、title、content、importance（1-5）、session_id、last_referenced | 内容主体（普通 SQL 做过滤 / 排序 / 淘汰） |
| chunks_fts | title、content（porter 分词） | 语义词干 BM25 检索 |
| chunks_trigram_fts | title、content（trigram 分词） | 子串 / 模糊检索 |

索引：`(project, last_referenced)` 与 `(source_id)`；双 FTS5 影子表以 external content 模式挂靠 chunks（免双份存储），由 TRIGGER 在 insert / delete / update 时写直达同步（update = delete 旧行 + insert 新行）。

设计决策：

- **外部内容表 + TRIGGER 同步**（SQLite 官方推荐）而非 FTS5 本体存数据：元数据过滤走普通 SQL，全文检索走 FTS5，各自高效；
- **双索引**：porter（语义词干 BM25，必选）＋ trigram（子串/模糊，可配置开关）；
- **元数据分层**：project / target / category / importance / session_id / last_referenced（hermes 实证）。

### 12.2 写入规则（两级写策略）

**写直达（实时，会话内）**：

- 事件过滤器：仅「值得沉淀」类型——错误/failure、修正/correction、决策/计划、工具结果摘要；
- 块大小上限约 2K token，超限按 markdown 边界（段落/代码块）切块；
- 去重：content_hash 命中则不重复写；
- TRIGGER 同步进双索引（强一致）。

**写回（批量，会话结束 / compaction 触发）**：

- 聚合 turn 摘要、经验教训（insight）批量写入；
- consolidation 锁（hermes `.consolidation-locks` 模式）防并发；
- 失败可延迟：下次启动 backfill 兜底（最终一致）。

### 12.3 淘汰规则（LRU + importance 加权）

- 主依据：`last_referenced`（LRU）＋ `importance`；
- 触发：project 级 token 超预算，或定期（如每周）；
- 候选：last_referenced 超过 TTL（如 90 天）且 importance ≤ 2；
- 降级优先：先压缩为单行摘要（title + summary 保留在归档区），再删除；
- 溯源联动：source.chunk_count 归零时清理该 source。

### 12.4 提升规则

- **resume**：按 project 拉取 top-K（last_referenced 倒序 × importance 加权）注入 L0；
- **检索命中**：命中即更新 last_referenced（参考计数，写入方执行）；
- **回填**：检索结果按 relevance + importance 取前 K 条注入上下文；
- **人可读导出**（可选）：定期把高 importance 条目生成 MEMORY.md 式文件。

### 12.5 与 dsh 整合

- 存储：独立 SQLite 库（搜索密集，独立于 storage KV 域）；
- 数据源：session/event hooks（对齐 dsh session-telemetry 事件捕获）；
- 接口：新插件暴露 `ctx_knowledge`：`search / put / touch / evict`；
- 复用 0.1.2-rc.1 已有：storage-sqlite、session-query-sqlite（FTS5 基础）作为实现底座。

## 13. 运行流水线：调用栈 × 指令流水线

类比函数调用的「压栈-计算-返回」，结合「决策-验证-执行」，得到两层嵌套流水线：**帧间是压栈-返回的调用栈，帧内是决策-验证-执行的指令循环**。

### 13.1 帧内指令循环（每条 = 一次 step）

```text
┌─ 任务帧 F（栈顶 = 当前活跃子任务）
│  ① 取指   读 F 的上下文（局部 + 必要的全局引用）
│  ② 决策   模型输出 step_type + 参数（受约束选择）
│  ③ 验证   validator 门禁（放行 / 拒绝 + 反馈重试）
│  ④ 执行   按类型分派：
│       reason    → 思考写入 F.thinking，回 ②
│       tool      → 工具执行，结果写回 F.events，回 ②
│       decompose → CALL：压栈新帧 F'，PC 跳 F' 的 ①
│       implement → 叶子动作，产出 F.result
│       stop      → 验收：audit(F) 通过 → RET
│  ⑤ 写回   每个动作 append 进会话日志（seq++）
│  RET：F.result 写回父帧 → 弹栈 → PC 回到父帧 ①
└─
```

### 13.2 与「压栈-计算-返回」的映射

| 函数调用栈 | agent 流水线 |
|---|---|
| `call` 压栈 | `decompose`：压入子任务帧（参数 = 子任务描述 + 前置产物） |
| 返回地址 | **续体**：父帧记「等哪个子节点完成」，子帧完成事件激活它 |
| 栈帧（局部变量） | 帧内上下文：目标、todo、局部事件、thinking |
| `ret` 弹栈 | `stop` + **audit 验收通过**后返回 |
| 返回值 | 子任务产物写回父帧 |
| 栈溢出 | 任务深度上限 `max_depth`，超限强制合并/转 plan 门禁 |
| 尾调用 | 无需返回的独立子任务 |

### 13.3 关键设计决策

1. **帧不背全史**：每帧只携「续体所需最小上下文」；父帧上下文在子帧运行时换出（存储层次 L0→L2），返回时按需恢复——调用栈就是存储层次的热区；
1. **验证在帧的出入口**：入栈前校验参数，出栈时验收——「每帧边界 + 每步」双层（门禁分布见 §18.3）；
1. **验收失败不弹栈**：留在帧内修正，或带失败标记返回父帧；
1. **续体是事件驱动**：子帧完成事件激活父帧，不轮询；
1. **返回即沉淀**：RET 时把子帧经验写回知识库（§12.2 写回路径）。

## 14. 任务树：树、栈、todo 的一面三体

**todo 列表不是无关视图——它就是任务树按执行序展开的嵌套列表。** 树是本体，栈是树的单线程遍历器，todo 是树的序列化（先序）视图。

### 14.1 时空树：嵌套 = 空间，先序 = 时间

```text
任务树（本体）                    todo 视图（嵌套列表 = 先序展开）
root                             [ ] root
├─ c1 ── c1.1 ── c1.2            ├─ [x] c1
├─ c2 ── c2.1                    │   ├─ [x] c1.1
└─ c3                            │   └─ [ ] c1.2
                                 ├─ [ ] c2
                                 │   └─ [ ] c2.1
                                 └─ [ ] c3
```

- 空间维：父子嵌套（decompose 包含关系）；
- 时间维：先序遍历序列（栈驱动执行序 = todo 顺序）；
- 栈 = 把树线性化的 DFS 遍历器（子任务逆序压栈 = 让先序出栈）；todo = 线性化的缩进表示。

### 14.2 并行从树上来

- 兄弟子树无数据依赖 → 可并行；
- 并行 = 树上开多个执行器：每个执行器 = 一栈一 agent，各取就绪分支，各自 DFS；
- 同步点 = 父帧 join：全部子分支完成才激活续体；调度器管并行度（就绪分支池、资源上限）。

### 14.3 学术名称

| 社区 | 术语 | 强调的面 |
|---|---|---|
| 编译器运行时 | **活动树（activation tree）** | 栈 = 根→当前结点活跃路径；帧 = 活动记录 |
| AI 规划 | **HTN（分层任务网络）** | compound/primitive task、method=decompose |
| BDI agent | **goal-plan tree** | goal 分解为 plan，plan 挂 subgoal |
| 调度/并行 | **task DAG** | 树是 DAG 的串行特例 |
| 多智能体 TAEMS | task 树 + enable/facilitate/hinder 边 | 分支间非局部依赖 |
| 形式验证 | **计算树（computation tree）** | 空间=分支结构，时间=路径 |
| 项目管理 | **WBS** | 嵌套 todo 清单本身 |
| 搜索 | **AND-OR 树** | 失败重做=OR 备选分支（若带备选方案） |

## 15. 记录与并行修改

不需要同点并发写，只需并发执行多个任务帧。

### 15.1 记录：事件溯源（Euler tour）

- 不存树，存事件流：`decompose(parent, [c1..cn])` / `push` / `complete(frame, result)` / `fail(frame, reason)` / `retry(frame, feedback)` 全部 append 进会话日志；
- 树 = 回放（fold）出的物化视图；崩溃恢复 = 重放；审计 = 日志天然证据链；
- 学术对应：push/pop 事件序列 = 树的**欧拉环游**表示，事件内 `parent_id` = 邻接表——日志、栈、todo 是同一棵树的三种序列化；
- 分层落点：L0 运行时活树 / L2 帧事件流（真相源）/ L3 周期快照（resume 加速）；
- SQL 查询：邻接表（`parent_id` + `order`）+ 递归 CTE 足够；版本历史：持久化数据结构（Okasaki 路径复制）或 Git 式 Merkle DAG。

### 15.2 并行：fork-join + 工作窃取 + 所有权

核心洞察：**树在分支处天然不相交——不加锁，而是不共享**。

1. **Fork-Join + 工作窃取**（Cilk/TBB/ForkJoinPool）：每执行器一 deque，自己底部 pop（LIFO 局部性），空闲者顶部 steal（偷大子树）；Blumofe-Leisler 定理：T_P ≤ T₁/P + O(T\_∞)；
1. **所有权原则**（Actor/Erlang）：任一时刻一个帧只属一个执行器，树无锁，协调走消息；steal = 所有权转移；
1. **join = future/Promise.all**（Kahn 过程网络）：父帧续体在全部子 future 完成时激活；
1. 同点并发才需 MVCC/STM/CRDT（树形 CRDT，Yjs/Automerge）——本场景有宿主、任务有清晰所有权，**用不上，省一大块复杂度**；
1. 事件日志并发写：单写者 sequencer 或 per-branch 流 + 逻辑时钟合并（`branch_id` = 分布式追踪 span id）；
1. 打回重做 = bounded retry（Erlang supervisor 模式），已入 Frame。

最简落地：日志记帧事件 + 内存树 + 周期快照；一个就绪池 + N 执行器认领；不加锁、不上 CRDT。

## 16. 实现清单与 dsh 接口对照（0.1.2-rc.1 已核源码）

### 16.1 要实现的内容

- **A. 引擎（dsh-toolset 新插件，cordis 服务）**：①TaskStack 引擎（Frame 状态机、decompose、pop、join 续体、就绪池、并行度上限、bounded retry）；②门禁（前置 + 验收 + 语义蕴含/coverage，拒绝带反馈打回）；③帧事件记录（自定义事件 `plan/node-expanded {parent, children}` + 内存树 + 周期快照）；
- **B. 模型侧工具**：④`decompose`/`implement`/`stop`/`status`（decompose 输出含 coverage 映射，见 §17.2）；⑤嵌套任务列表（带 `parent_id` + `order`）；
- **C. 执行器（用现成接口）**：⑥并发任务帧 = 并发子 agent run，join = 完成通知收口；⑦RET 验收路由器（按 acceptance.level 分派三路裁决，见 §17.4）；
- **D. 与 glla 结合**：任务树 = list 数据源，叶子 = todo 项，audit 验收；
- **E. 后续立项**：audit 复核协议细化、L4 知识库接写回（§12）。

### 16.2 dsh 接口满足度

| 需要 | dsh 接口 | 满足度 |
|---|---|---|
| 并发执行多任务帧 | `ctx.subagents.start()` 多 run 并发（providers：spawn/fork/acp/dsh-sdk） | ✅ |
| 子帧继承父上下文 | `subagent-fork-in-process`：child 以父会话已完成 turn 前缀为 seed | ✅ |
| 完成通知 / join | `SubagentRun` + `SubagentRunEndInfo`（`subagent.started/finished`） | ✅ |
| 决策约束（L1 结构化输出） | start 的 `outputSchema`：JSON Schema 校验，`SubagentResult.structured` | ✅ |
| 防栈溢出 max_depth | 委托深度上限（`SubagentCapabilities.depthLimit`） | ✅ |
| 帧事件记录 | `session.append` + `ignorable` 机制；`tool/result.meta` | ✅ |
| seq | `SessionSeq` 会话内单调 | ✅ |
| 快照/恢复 | `sessions.flush`；storage-sqlite KV 域 | ✅ |
| 中途引导执行器 | `sendMessage`；`startContinuable` | ✅ |
| 嵌套 todo | `tool-todo` 为扁平快照 | 🔶 需新建嵌套版 |
| 用户审批 | `ctx.approval`（waterfall、fail-closed） | ⚠️ 须在 open turn 内；后台作业 fail-closed |
| 动态分解编排 | `tool-workflow`（worker-thread 静态 JS） | 🔶 不匹配：动态分解用 TS 服务直写，勿硬套 workflow |

### 16.3 结论

- 核心六件事（多执行器并发、上下文续承、结构化输出、深度上限、完成通知、事件记录）全部有现成服务；
- 自建仅三块：引擎服务、模型侧工具 + 嵌套任务列表、就绪池调度（薄）；
- 注意点：①审批 turn-enclosed 约束（后台作业需设计交互通道）；②workflow 适合静态 DAG，不适合动态分解。

## 17. 统一任务模型：契约与分解校验

> 基础层抽象：像把任意程序抽象为「代码 + 数据 + 堆栈」，把任意任务抽象为「契约 + 工作集 + 任务树」。程序是 how 预先写死（命令式）；任务是 what 固定、how 动态生成（声明式）——任务的"代码面"是**契约（Hoare 三元组 `{P} S {Q}`）**，S 由模型 + 执行器在运行中生成（decompose = 增量式程序合成）。执行流程（调度/门禁/验收）只依赖契约与状态，与任务内容解耦。

### 17.1 契约结构

契约 = `id` ＋ `spec`（任务描述 + 前置约束 P）＋ `acceptance` 列表（每条含 `check` 验收描述、`level` 判定级别、mechanical 级可选 `command` 执行命令）。例：机械级"npm run check 退出码 0"、语义级"行为符合描述，无越界改动"、人工级"涉及不可逆操作需确认"。

验收判定三级：

| 级别 | 裁决者 | 形式 |
|---|---|---|
| mechanical | validator（确定性） | 命令退出码 / diff / 测试 |
| semantic | 独立 audit run（LLM 裁决 + outputSchema） | 结构化裁决结果 |
| human | approval（fail-closed） | 审批链 |

### 17.2 双重校验：粒度 + 语义蕴含

`decompose(parent, children)` 过两道门——**既要检查粒度，又要验证语义**。

**第一道：粒度四规则**（§10 ③：越级 / 过粗 / 过细 / 数量；拒绝带反馈重试）。

**第二道：语义蕴含校验**（Hoare 组合 / 逐步精化）：

- **合取蕴含**：`∧Qᵢ ⟹ Q_parent`——子验收合取必须蕴含父验收；
- **前置传递**：第 i 个子任务的前置 = 父 P ∧ 前序兄弟的 Q（顺序依赖显式化）；
- **覆盖完备**：父 Q 的每条验收至少被一个子任务覆盖；
- **无漂移**：子任务 spec 必须与父 spec 相关，不做目标外的事。

蕴含校验分两层：**结构可机械查**——decompose 输出强制带 coverage 映射（父验收条目 → 子任务 id 集），缺映射/空映射机械拒绝；**语义需裁决**——合取是否真蕴含父 Q，走 semantic 级（decompose 时轻量审查，或独立 audit run）。

### 17.3 两个校验时点

- **事前（decompose 时）**：粒度四规则 + coverage 完备性（机械）+ 蕴含合理性（语义）；
- **事后（join/RET 时）**：子任务各自 Q 已过，还要**合取复核父 Q**（接口缝隙/集成问题）——防"每步都合规、整体走偏"的漂移。

### 17.4 RET 验收路径（三级路由）

按 `acceptance.level` 路由：

- mechanical → 执行命令，退出码裁决（确定性）；
- semantic → 独立 audit run，outputSchema 结构化裁决；
- human → approval 链（fail-closed；注意 turn-enclosed 约束，见 §16.2）。

全部通过才弹栈；任一失败带反馈打回（bounded retry，§15.2）。

学术对应：Hoare 逻辑组合规则、契约式设计（DbC）、逐步精化（Dijkstra 最弱前置条件）、Event-B 精化证明义务（蕴含校验 = proof obligation）。

## 18. 两类任务：元/对象与统一生命周期

> 分类依据是**作用对象**（非承担者）：元任务修改任务树本身，对象任务操作外部世界。两类被强制走同一条「推理 → 裁决 → 执行 → 复验 → 写回」生命周期。

### 18.1 指令集按作用对象归类

| 指令 | 类 | 副作用 | ISA 类比 |
|---|---|---|---|
| `decompose` | 元（写树） | 挂子节点 | 控制流指令（受控的自改代码） |
| `stop` | 元（写树） | 标记完成/弹栈 | `ret` |
| `implement` | 对象 | 工件/世界 | 计算指令 |
| `tool` | 对象 | 外设副作用 | I/O 指令 |
| `reason` | 两类都不是 | 无（瞬态） | "推理正文不进系统状态"（§11.1） |
| `status` | 读 | 无 | 读寄存器 |

### 18.2 三个精确对应

1. **Lisp 同像性（homoiconicity）**：任务树既是**数据**（模型在 decompose 参数里读写 children）又是**代码**（引擎遍历执行）——整套系统等价于一台 Lisp 机：模型是运行时的程序员，引擎是 eval；
1. **self-writing program**：传统程序的控制流在写码时固定（stored program）；agent 的控制流**运行时生长**——元任务就是"程序写程序"的那半边，比存储程序再高一层；
1. **ISA 的指令二分**：控制指令 vs 计算指令。agent 的控制指令是数据形态（JSON 子树），**由引擎代为生效**——模型提议控制流，引擎执行控制流。

### 18.3 统一生命周期：两类任务都强制经过

通道唯一性保证"强制"：模型唯一的输出方式就是结构化决策，没有绕过审查的路径（fail-closed）。生命周期即 §13.1 帧内指令循环，是 **Hoare 三元组 `{P} S {Q}` 的运行时化**：事前查 P（门禁），执行 S，事后查 Q（验收）。两类的差别只在 P/Q 的内容与强度：

| | 元任务（decompose/stop） | 对象任务（implement/tool） |
|---|---|---|
| 提议 | 子任务数组 + coverage 映射 | 动作 + 参数 |
| 事前门禁 P | 粒度四规则 + 语义蕴含 + 前置传递（§17.2） | 参数 schema + 前置条件 |
| 执行 S | 挂树 / 标记完成 | 工件产出 / 外设副作用 |
| 事后验收 Q | join 时合取复核父 Q（§17.3） | acceptance 三级路由（§17.4） |
| 出错代价 | 控制流错误，整棵子树白做，打回重拆 | 局部错误，bounded retry 可修 |
| 审查者 | validator（机械）+ LLM 蕴含审查 | 机械 / audit run / approval |

强制审查的对象是**副作用**——凡改树或改世界的必过两道闸；纯思考豁免（`reason` 只有推理，没有执行与审查，仍被记录但不受裁决）。引擎不在两类中——它是求值器（eval），两类任务的共同底座：元任务经它裁决后生效，对象任务经它派发验收。

## 19. 总结

1. **agent = 一台软件实现的计算机**：CPU（LLM）、存储层次（上下文/记忆）、I/O（工具/互连）、OS（dsh 宿主）、语言（workflow）、进程（会话）、作业系统（glla）。
1. **分层决定实现边界**：硬件/内核由 dsh 宿主提供；服务层（goal/list/jobs/schedule/audit）用 workflow 语言实现；应用层是具体任务。
1. **确定性来自结构约束 + 验证裁决**：把"下一步类型"和"细化一层"都变成受 schema 与 validator 双重约束的离散动作，模型只做受限选择。
1. **自顶向下需要机械强制**：plan 门禁 + 逐层 decompose 工具 + 叶子判定 + audit 验收，把"想清楚"变成默认路径。
1. **任务 = 契约（Hoare 三元组）**：what 固定、how 生成；分解双重校验（粒度 + 语义蕴含，coverage 映射），验收按 mechanical/semantic/human 三级路由。
1. **两类任务：元/对象**：改树是元任务、做具体工作是对象任务（任务树 = 同像结构）；两类都强制经「推理→裁决→执行→复验→写回」，门禁强度按类分布——元任务审结构（蕴含），对象任务审结果（acceptance）。
