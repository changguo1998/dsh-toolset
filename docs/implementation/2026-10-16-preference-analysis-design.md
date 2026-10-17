# 偏好分析（接取条目：`docs/BACKLOG.md`「偏好分析（从行为与编辑中归纳用户偏好并自动应用）」）

状态: 决策 | 开启: 2026-10-16 | 关闭: 未关闭
本文件是本任务唯一的过程记录与文档变更落点; 计划外的文件不改.

## 目标

条目为**用户意向** (2026-10-16 登记, 登记时裁定"先记意向, 不调研"). 本任务 = **调研 + 决策**: 把条目"接取时裁定"的 7 项与包形态逐项定下, 并细化验收与估时.

**本任务不写实现代码**: 不动包代码, 不动架构, 不 push; 只产出本文档. 实现等用户裁定后另起.

## 调研

分七组: 存储与审阅面 / 注入面 / 观测面可得性 / 不可得信号 / LLM 面 / 现有静态约定 / 包形态与接线成本.

### R1 存储与审阅面: memory-base 的分类机制与候选队列

- **分类机制 `registerKind`**: 第三方在自身 apply 时注册 `{kind, table?, columns?, eventTypes?, preWrite?, routes?}`; 注册不建表, 首次写入才建 ("空表不建"); 注册后自动进入所在层检索并集, 检索结果带 `kind` 标签; U 层禁落兜底分类: `memory-base/README.md:18-23`, `memory-base/src/router.ts:110-133`.
- **写入闸门顺序**: 隐私闸 (内置凭据 / 私钥形态, 命中**整条拒绝**) → 分类闸 (未注册拒写) → 注册方 `preWrite` 钩子 (可拒写或建议 `importance`); 被拒返回 `{ids: [], skipped}`: `memory-base/src/knowledge.ts:500-520`.
- **扩展列不可经服务面写入**: `knowledge.put()` 的 INSERT 列固定为 `source_id/project/target/category/title/content/content_hash/importance/session_id/last_referenced/created_at/origin`: `memory-base/src/knowledge.ts:555-575`. 故 `columns` 声明的扩展列不会被填值. **推论: 偏好元数据只能走 `importance`(1..5) / `title` / `source.label` / `source.ref` 与插件自有账簿, 不声明扩展列.**
- **候选队列与三态**: `CandidateRow` / `PromoteItem`: `memory-base/src/promote.ts:27-56`; `pending` / `approved` (转换成功即删行) / `rejected` (终态留痕 = `fact_key` 墓碑, 防同源反复提审); 幂等键 = `target_tier + kind + fact_key`; 同 kind 的 pending 之间按"归一化相同, 或短者是长者子串且占比 >= 0.8"机械合并; S -> P 提升 **agent 可代批**, P -> U 与冲突候选 **user-only**; 候选表独立上限 5 MB, 每轮生产上限 I->S 20 / S->P 20 / P->U 10: `memory-base/README.md:32-39`.
- **转换闸 (关键发现)**: `approveCandidate` 对 `summarized = 0` 的候选**要求已注入 LLM caller**, 无 caller 直接返回 `{ok: false, reason: 'llm-unavailable'}` 并保持 pending: `memory-base/src/promote.ts:639-700`; 而 `summarized` 只由 `summarizeForCandidate(llm,...)` 产生, 无 caller 时恒为 0: 同文件 `:490-575`. **即现态下没有 LLM caller 就无法批准任何候选, 候选队列只能 reject.**
- **枚举面缺口**: `targetRows({project, limit})` 是唯一"列全部行"的只读面, 但它只返回 `target IS NOT NULL` 的行: `memory-base/src/knowledge.ts:917-943`; 而 `approveCandidate` 落库时不写 `target`: `memory-base/src/promote.ts:686-694`. 故**批准后的偏好行无法被枚举**; `search` 必填 `query` (FTS, `memory-base/README.md:14`).
- **服务面**: `export const provide = ["memory"]`: `memory-base/src/index.ts:118`; 服务面暴露 `remember / search / forget / promote / registerKind / checkPrivacy / candidates.{list,approve,reject,edit,markConflict,resolveConflict} / setLlmCaller / usage / enforceLimits` 等: 同文件 `:776-940`.
- **TUI 审阅面已存在**: `/memory review [session|project|user]` 面板 (候选清单 + approve / reject / edit / resolveConflict, `reviewer` 写死 `user`), `/memory search`, `/memory add <tier> [--kind <k>] <content>` (`origin: user` 免审直达): `TUI/src/app/index.ts:4915-4945`, `TUI/src/app/adapter/dsh.ts:4022-4090`. **走 memory-base 的 kind + 候选队列, 审阅与可见性可零 TUI 改动获得.**
- **服务面写入面很窄 (2026-10-16 追加核)**: `ctx.get('memory')` 实际暴露的键为 `getSummary / whenReady / consolidate / lastConsolidation / rescanDenied / migrate / checkPrivacy / registerKind / search / remember / forget / usage / enforceLimits / scanDocs / promote / candidates.* / setLlmCaller` (`memory-base/src/index.ts:770-950`); **没有** `targetRows` / `setImportance` / `evict` / `touch`, 也没有按 kind 列举的入口; `forget` 在单库模式恒返回 0 (`return bundle.tiers?.forget(refs) ?? 0`, 同文件 `:846-851`).
- **分层写入路由**: `tiers.remember` 只在 `origin === "user" && tier !== undefined` 时写指定层, 否则一律落 `session` (`memory-base/src/tiers.ts:320-336`) -> 插件要写项目层 / 用户层只能冒充用户来源; 单库模式则完全没有层级概念 (`memory-base/src/index.ts:839-844`).
- **运行时现状 (本机 `~/.dsh/memory-base/memory.db`, 2026-10-16 只读核)**: `candidates` 表 0 行; 全库只有 v1 的 `chunks` / `sources` 与两张 FTS 表, **无任何 `kind_*` 表** -> 分类注册制, 候选队列, 提升链从未启用; 本机 profile 只配了 `dbPath`, 未配 `tiers` (`~/.dsh/profiles/fff/cordis.patch.yml:31-34`).

### R2 注入面: rule-engine 消费者 (现成通道)

- `registerConsumer({id, sources, delivery, cooldownTurns?, cooldownMs?, dedupeInRecord?, directWrite?, decide})`; 同节点同 `delivery` 的全部命中**合并为一条**注入 (正文空行分隔); 消费者与规则共用闸门 (逐段上限 / 同文本去重 / `dedupeInRecord` 判空): `rule-engine/README.md:184-199`.
- 会话开局指南的成熟组合: `sources: ["session-start", "compaction", "step-end"]` + `delivery: "steer"` + `dedupeInRecord: 1` + `directWrite: ["session-start", "compaction"]`: `symbol-normalizer/README.md:40-45`.
- 消费者型插件的骨架与硬依赖: `inject: ["ruleEngine"]`: `md-table-check/src/main.ts:1-24`, `ponytail/README.md:36-41`.
- 注入消息形态: 正文带 `[RULE]` 前缀, 按用户输入块呈现: `rule-engine/README.md:64-66`.
- 时序约束: `session/event` 是同步派发窗口, `decide` 必须廉价, 不得调宿主 API 与直接注入 (注入由 rule-engine 推迟宏任务): `rule-engine/README.md:187,203`.

### R3 观测面: 可得事件 (全部经 `session/event`)

- 订阅形态 `ctx.on('session/event', (session, event) =>...)`: `docs/host/DSH-CTX-API.md:32`; 先例 `memory-base/src/hooks.ts:294-300`, `herdr-integration/src/main.ts:220,307`.
- 与偏好相关的可得事件: `docs/host/DSH-CTX-API.md:62-63`:
- `user/message`: 文本块可取, 且带 `message.source.kind`, 可排除 rule-engine 自身注入 (先例 `rule-engine/src/engine.ts:536-550`);
- `turn/end{reason}`: `completed / aborted / interrupted / max-tokens / blocked / error / forked`;
- `approval/asked {id, toolName, callId?, reason?}` + `approval/decided {id, outcome}`: 审计对 (log-only), `outcome = allowed-once / rejected / cancelled / unavailable`: `docs/host/DSH-CTX-API.md:89`. **`decided` 只带 id 与 outcome**, 要拿"被拒的是哪个工具 / 什么参数"必须与 `asked` 按 id 配对 (进程内 map), 参数另需与同回合 `tool/call {name, arguments, callId?}` 配对 (`tool/call` 带 `callId`: `TUI/src/app/adapter/dsh.ts:2316-2323`);
- 另有 `tool/call` / `tool/result`, `command/run` / `command/done`, `workspace/changes {turn}` (每轮 git 快照差公告), `feedback/record` / `feedback/message-put` / `feedback/message-delete`.
- 归纳节奏可复用: memory-base 的巩固链"启动后一次 + `compaction/end` 后一次, 进程内节流 10 min": `memory-base/README.md:60`. 归纳不需要新调度面.

### R4 不可得 / 名不副实的信号 (决定观测面取舍)

- **"用户对模型输出的修改"在 TUI 不可得**: TUI 侧未发现"编辑 / 重发已定稿消息"或逐消息评分的功能 (`grep` `edit. *message` / `resend` / `重发` 的命中均为排队输入重投与模型切换, 不是编辑); 官方 `message-feedback` (`ctx.messageFeedback`: 对已定稿 assistant 消息评分 / 备注) 虽已挂载但**本仓无消费者**: `docs/host/HOST-PACKAGES.md:52,96`; 历史库口径里 `feedback/record` 计数为 **0**: `docs/archived/2026-10-07-knowledge-memory-lifecycle.md:107`. 故该信号只能**用代理信号替代** (打断 + 纠正性重述 + 审批拒绝).
- **TUI `$` 本地 shell 与快捷键不进会话事件**: `TUI/src/app/local-shell.ts` 内 `append` / `session/event` 零命中, 且该模式设计上不进模型上下文. 要采集需 TUI 侧新增事件, 属跨包改动.
- **打断信号可得但归因弱**: `turn/end{reason: 'aborted'}` 确由用户中断产生 (`TUI/src/app/adapter/dsh.ts:429-435`), 但"为什么打断"不可知, 只能与该回合的用户消息合并使用.
- **工具选择分布反映模型习惯而非用户偏好**: 不纳入首期 (避免把模型行为当用户偏好).
- **提交信息风格**需读 `git log`, 且项目级约定已写死在 `AGENTS.md` (Conventional Commits + 中文): 不纳入首期.

### R5 LLM 面: 宿主无公开 `ctx.llm`

- memory-base 的 LLM 概括走可插拔 `setLlmCaller(caller)`, 注释明写"宿主无公开 ctx.llm, 由 wrapper 注入": `memory-base/README.md:36`; 决策 D51 见 `docs/archived/2026-10-07-knowledge-memory-lifecycle.md:484`.
- **本仓目前没有任何调用方注入 caller**: 全仓 `grep -rn "setLlmCaller"` 只有定义与透传 (`memory-base/src/index.ts:256,714,934` 与 `memory-base/README.md`). 故"LLM 归纳"等于要新建一条 LLM 通路 (无公开契约), 需另立调研.

### R6 现有静态约定都没有"生产者"

`~/.dsh/AGENTS.md` / 项目 `AGENTS.md` (用户手写), `rule-engine` 规则表 (只来自配置与 `rule_add`: `rule-engine/README.md:117-123`), `ponytail` 阶梯 (内置文本: `ponytail/README.md:8`), `symbol-normalizer` 符号规则 (内置表: `symbol-normalizer/README.md:13-27`): 全是人工写定, 没有从行为归纳的生产者. 与条目"现象 / 现状"一致.

### R7 包形态与接线成本

新包模板 = `package.json` (`dsh.bundle.patch` + `main: dist/src/index.js`) + `cordis.patch.yml` + `tsconfig.json` + `src/` + `tests/` + `README.md` (参照 `md-table-check/`). 加一个包的接线点共 7 处: 根 `package.json` (check / build 链), `scripts/install.sh` (`canonical_pkgs`), `scripts/test-parallel.sh` (`default_pkgs`), `profiles/example/cordis.patch.yml` (挂载行), 根 `README.md` + `README.zh.md` (插件清单), `AGENTS.md` ("结构与约定"清单与包数), `docs/BACKLOG.md` 的 §4 插件规划表. `docs/STATUS.md` 由用户择时更新, 流程内不改.

## 决策

决策项用数字, 选项用 abcd, 选定项写字母与理由.

**D1 包形态: 选 (a) 独立新包 `preference-analysis` (第 22 个插件).**
(a) 独立新包 (b) 并入 `rule-engine` (c) 并入 `memory-base` (d) 不建包 (只写文档与流程)
理由: 本能力要做四件独立的事: 订阅 `session/event` 观测, 维护跨会话账簿, 注册分类与候选, 注册注入消费者. (b) `rule-engine` 是判定与注入引擎, 不装偏好语义; (c) `memory-base` 已明写"只提供分类机制, 不规定有哪些分类, 偏好 / 技能沉淀等语义归各自上层插件" (`memory-base/README.md:18`); (a) 同时给出 `enabled: false` 一键关闭与独立测试边界, 与 `ponytail` / `symbol-normalizer` / `md-table-check` 同形.

**D2 观测面: 选 (a) 三条结构化信号 (S1 重复约束 / S2 纠正加权 / S3 审批拒绝) + 显式登记通道.**
(a) 三条机器可判信号 + 显式登记 (b) (a) 再加 TUI 侧命令与快捷键采集 (c) 全量会话事件 (含助手正文与工具结果原文) (d) 只做显式登记
理由: (a) 三条全部可从 `session/event` 机械提取, 不改宿主, 不改 TUI (R3 / R4); (b) 需 TUI 新增事件; (c) 体积与敏感面不可接受 (见 D3); (d) 放弃"自动归纳"这个条目核心期望.
三条信号的首期口径:

- **S1 重复约束**: `user/message` (排除 `source.kind === 'rule-engine'`) 文本含约束标记词 (词表可配, 缺省 `不要 / 不要用 / 别 / 别用 / 不用 / 以后 / 一律 / 统一 / 都 / 记住 / 禁止 / 只能 / 必须 / 优先`) 且句长 \<= 120 字 -> 抽出承载该标记的最短句 -> 归一化 key (去空白与标点, 大小写折叠) -> 与账簿已有 key"完全相同, 或 3-gram Jaccard >= 0.8"则合并计数 (相似阈值参考 memory-base 机械合并判据 0.8, `memory-base/README.md:35`), 否则新建.
- **S2 纠正加权**: 同会话内, 若上一回合 `turn/end{reason: aborted|interrupted}`, 或本消息含纠正标记 (`不对 / 错了 / 不是 / 重来 / 重新 / 我说的是 / 别这样 / 又 / 还是`), 则该消息里的 S1 约束句**权重 x1.5**; 若纠正消息里没有约束句, 只记入账簿的"未成形观察"计数 (不产出, 不上报, 留给后续 LLM 面). 这样避免从纠正里硬造弱偏好.
- **S3 审批拒绝**: `approval/asked` 与 `approval/decided{outcome: 'rejected'}` 按 id 配对, 参数经同回合 `tool/call{callId}` 取 -> 指纹 = `toolName` + 参数首段 (首个子命令 / 首个路径), 如 `bash:rm` / `write:.env` -> 同指纹被拒 >= 3 次且跨 >= 2 会话 -> 偏好文案"不要直接 `<toolName>` `<参数首段>`; 如确需执行, 先说明影响并取得确认".
- **显式登记通道**: 用户直接写 (TUI `/memory add <tier> --kind preference <内容>`, `origin: user` 免审直达) 与模型提议 (`preference_add`, 落候选待审, 见 D12).
  **不纳入首期** (各有硬原因, 见 R4): 模型输出被用户修改, 快捷键 / 命令使用, 提交信息风格, 工具选择分布, 打断单独计数.

**D3 原文留存: 选 (a) 只存用户原话片段 (\<= 120 字).**
(a) 只存用户原话片段 (作偏好文案与证据) (b) 存消息全文与会话上下文 (c) 只存计数不存文本
理由: (a) 无 LLM 时偏好文案只能来自用户自己的措辞, 片段也是用户能审阅, 能判断真假的最小单位; (b) 越界 (助手正文 / 工具结果原文体积大, 敏感面宽); (c) 产不出可读偏好, 用户无法审阅.

**D4 归纳方式: 选 (c) 混合, 但首期只实现 (a).**
(a) 纯统计阈值 + 机械归一 (首期实现) (b) 纯 LLM 归纳 (c) 统计决定"是否成偏好", LLM 只做文案润色与冲突检测 (预留注入口, 缺省不注入)
理由: R5 (无公开 LLM 通路, 接 LLM 等于新契约与新调研); (a) 可给出"固定埋点序列 -> 一条偏好"的机械断言 (验收条款要求); caller 注入是 memory-base 已验证的形态, 需要时按同一形态接.

**D5 置信分档 (首期数值, 均可配)**

- 观察中: 证据 < 3 或只出现在 1 个会话 -> 只留账簿, 不产候选;
- 候选: 证据 >= 3 且跨 >= 2 会话 -> 产出候选 (`promote`, pending 待审);
- 高置信: 满足候选门槛 + 最近一次证据 \<= 30 天 -> 可自动应用 (D8);
- `importance` 映射: 候选 3 / 高置信 4 (`importance` 是少数能经服务面写入的元数据位, 见 R1).

**D6 老化与失效: 90 天休眠 / 180 天退休.**

- `lastSeen` 超 90 天无新证据 -> `dormant` (不注入, 条目与账簿保留, 再现即复活);
- 超 180 天 -> `retired` (调 `forget` 删正式行; 账簿记 `suppressed` 键, 防同一模式被再次归纳出来, 与 memory-base 的 reject 墓碑同语义);
- 检查挂巩固链节奏 (启动后 + `compaction/end` 后, 节流 10 min), 不新增调度面.

**D7 产出形式: 选 (a) memory-base 的 `kind = "preference"` 分类行承载偏好正文 + rule-engine 消费者统一注入。**（"分类行为唯一事实源"的原表述已由 D16 取代）
(a) 分类行 + 单一消费者注入 (b) 每条偏好写一条 rule-engine 规则 (c) 追加进项目 `AGENTS.md` (d) 仅提示不注入
理由: (a) 存储侧白拿分层 / 隐私闸 / 检索; 注入侧只注册**一个**消费者 (不污染规则表, 可整块控制条数与去重). (b) 规则表被偏好灌满, 且规则的两层合并语义与偏好的生命周期 (老化 / 休眠 / 退休) 不同步, 等于两套规则系统 (条目明确要求避免). (c) 首期不做: 改仓内文件需用户批准, 留 diff 噪声, 纯注入已可撤销. (d) 与条目期望"自动应用"不符.

**D8 自动应用程度: 选 (b) `autoApply: "confident"` (缺省)。**（落地方式原为 `candidates.approve`, 已由 D17 取代）
(a) `off` (只列建议) (b) `confident` (只有高置信自动应用并注入, 其余留待审) (c) `all` (达候选门槛即自动应用)
理由: 条目期望"归纳并自动应用", 缺省必须真的会应用; (b) 用四重保险压住误归纳风险: 统计门槛 (>= 3 次 / >= 2 会话 / 30 天内), 注入上限 (每次 \<= 5 条, \<= 600 字符, 可配), 逐条可撤销 (D17), `enabled: false` 一键关闭; 且**不自动改仓内文件** (与条目默认建议一致).
附: **模型提议的偏好不自动应用** (`preference_add` 一律落账簿的待审状态): 统计证据是用户自己的重复原话, 模型提议是模型的理解, 两者不该同权.

**D9 审阅与回滚: 原选 (a) 复用 memory-base 候选队列 + TUI `/memory review` —— 已被 D17 取代 (该面随 `candidates` 一起下线)。**
~~(a) 复用候选队列与现成面板 (零 TUI 改动) (b) 新建 TUI 面板 / `/prefer` 命令 (c) 只靠模型侧工具~~
~~(a) 的两条路径: (i) **候选态**: `/memory review project` 里 approve / reject / edit; reject 走 memory-base 的 `fact_key` 墓碑, 同模式不再提审; (ii) **生效态**: 模型侧工具 `preference_remove` 把该条记入账簿 `suppressed` 键并调 `forget` 删行~~
~~已知缺口: TUI 侧没有删除生效记忆行的入口 (`/memory replace|remove` 仍是 `docs/BACKLOG.md`"后续补条目候选"里登记的缺口)~~
取代后仍成立的部分: 撤销走 `preference_remove` + 账簿 `suppressed` 键; 用户层门禁改由 D18 承担.

**D10 隐私边界: 选 (a) 三层防线.**
(a) memory-base 内置隐私闸 + `registerKind.preWrite` 钩子 + 账簿侧显式预检与自有敏感模式 (b) 只靠库闸门 (c) 加密存储
理由: **账簿是插件自有文件, 不经过库闸门**: 若不在写入前显式调 `checkPrivacy(text)` (服务面可得, `memory-base/src/index.ts:818`) 并加自有模式 (`.ssh` / `.env` / `id_rsa` / `credentials` / 家目录绝对路径形态), 隐私底线会被账簿绕过, (b) 因此不成立. 防线: (a1) 证据片段 \<= 120 字且写入前 `checkPrivacy` 预检; (a2) `registerKind.preWrite` 再拒一次 (纵深防御); (a3) 不采集助手正文 / 工具结果原文 / 文件内容; 账簿文件 `0o600`, 目录 `0o700` (同 memory-base 约定, `memory-base/README.md:119`). (c) 不必要 (记录本身是用户自己的约束原话).

**D11 与现有件的分工 (避免两套规则系统)**

- `rule-engine`: **注入通道**. 偏好分析只注册消费者, **不往规则表写规则**; 规则表仍归人工与 `rule_add`.
- `memory-base`: **分层存储面** (`kind = preference` 分类 + 分层 / 隐私闸 / 检索). 候选队列与提升链属被下沉的管理逻辑, 本包不再依赖 (见「修订」D16-D20).
- `ponytail`: 固定决策阶梯, 不参与归纳, 也不被偏好改写; 同一节点时由 rule-engine 合并成一条注入.
- `symbol-normalizer`: 符号规范是固定规则; 偏好可能与之重复 (例如归纳出"不要用 emoji"): **不自动抑制**, 由用户在审阅里 reject 或退休, 避免两套规则互相打架.
- 静态 `AGENTS.md`: 仍是人工写定的最高优先约定; 偏好不自动写文件, 也不自动覆盖静态约定.

**D12 模型侧工具面: 选 (a) 三个工具.**
(a) `preference_list` / `preference_add` / `preference_remove` (b) 不注册工具 (c) 全功能 (含 approve / edit)
理由: (a) 让"用户一句话登记""看一下现在有哪些偏好""撤掉这条"不必先做 TUI 面; `preference_add` 一律落**候选待审** (D8 附); `preference_remove` 的描述写明"仅在用户当次明确要求撤销时调用". (c) 把审阅权交给模型, 不该.

**D13 归纳触发节奏: 选 (a) 复用巩固链节奏.**
(a) 启动后一次 + `compaction/end` 后一次 (进程内节流 10 min) (b) 每回合结束 (c) 独立定时器 / 宿主 schedule
理由: (a) 与 memory-base 既有节奏一致, 零新调度面 (宿主 `schedule` 在本 profile 未挂载, 见 `docs/BACKLOG.md`"后台常驻守护机制"条目); (b) 代价高, 噪声大; (c) 引入新生命周期.

**D14 依赖与降级: `inject: ["memory"]` 硬依赖, `ruleEngine` 软依赖.**
理由: 存储与候选面缺了本包无意义 (硬依赖); 注入面缺了仍能观测与提议 (软依赖 + warning). 不沿用消费者型插件"硬依赖 ruleEngine"的先例: 那些包没有注入面就什么也不做, 本包不是.

**D15 跨包改动 (本轮只登记, 不实施): 原列"为偏好放开 memory-base 的候选转换闸 (`conclusion` 标记) + 按 kind 枚举行" —— 已被 D19 取代。**
~~(i) **转换闸放开"成文结论"**: `PromoteItem` 增可选 `conclusion?: true`, `promote` 时写 `summarized = 1`, `approveCandidate` 据此跳过 LLM 概括闸~~
~~(ii) **按 kind 枚举行**: `KnowledgeService` 增只读 `list({kind, project?, limit?})` 并经服务面透出~~
~~退路: 偏好改由插件自持账簿为事实源, 审阅面退到模型侧工具 + 提示, 放弃 TUI `/memory review` 复用~~
取代理由: 用户 2026-10-16 裁定 memory-base 只保留分级结构, 管理逻辑下沉到各插件 -> `conclusion` / `approveCandidate` / `promote` / `candidates` 整套随之下沉, 新的最小要求见 D19.

## 修订 (2026-10-16, 用户裁定后重定)

前提变更 (用户 2026-10-16 裁定): memory-base **计划改动** —— 只保留分级结构, 其余限制可能取消, 管理逻辑 (提升 / 审阅 / 生命周期) 分配到各插件. 据此新增 D16-D20; 受影响的 D7 / D8 / D9 / D15 已在原处注明取代者. 用户同次指示: 该 memory-base 改动**不新开 BACKLOG 条目**, 记录以本文件为准.

**D16 状态源: 选 (b) 账簿为唯一状态源, memory-base 只存偏好正文。**
(a) 库里有行为生效信号 (原 D7 口径) (b) 账簿 `status` 为生效信号, 库仅作正文与可检索副本
理由: (b) 让库行被删 / 被压缩 / 被重构迁移都不影响注入正确性, 也不再需要"按 kind 列举"才能判断生效 (R1 已证该面缺失). 代价: 库侧一致性靠插件维护 (写入 / 撤销 / 退休三处).

**D17 审阅与回滚: 选 (b) 自持。**
(a) 复用 memory-base 候选队列 + TUI `/memory review` (原 D9, 随重构下线) (b) 模型侧工具 + 注入文案说明 (c) 自建 TUI 面板 / `/prefer`
理由: (a) 的数据源 `candidates` 表就是被下沉的管理逻辑, 不能再依赖; (b) 零 TUI 改动且闭环可用 (`preference_list` 看, `preference_add` 提议, `preference_remove` 撤销); (c) 列待裁定项 4.

**D18 分层归属与用户层门禁: 选 (b) 默认项目层, 用户层只走用户显式动作。**
(a) 归纳可直接写用户层 (b) 归纳默认写 P, 跨 >= 2 个项目才提议升 U, U 只走用户显式动作 (c) 全部只写 P
理由: `candidates` 带来的"U 层必须用户本人批"闸门随重构消失, 门禁缺口要补上; (b) 把门禁落在插件侧 (写入前判 actor), 并希望 memory-base 保留 `preWrite` 钩子作硬闸; (c) 会丢掉跨项目偏好这一档.

**D19 对 memory-base 的最小要求 (替代 D15): 只要四项纯存储面。**
(a) 指定层写入: `remember({tier})` 不再要求 `origin: "user"` (b) 按 kind 列出: `list({kind, project?, limit?})` (c) 删除: `forget` 回落单库, 或透出 `evict` (d) 可选: 保留 `registerKind` (按需建表 + 并入检索 + `preWrite` 钩子)
理由: 这四项都是"分级结构 + 内容读写"的自然组成, 与"memory-base 只提供分层记忆内容"的新定位一致; 不再需要 `conclusion` 标记, `approveCandidate`, `promote`, `candidates` 与 LLM caller (R1 的两处硬缺与三处妥协随之消失). 若 (d) 一并取消, 隐私闸与用户层硬闸全部归插件自担.

**D20 顺序依赖: 选 (a) 先瘦身, 再按新面做偏好。**
(a) 先做 memory-base 瘦身, 偏好随后按 D19 新面实现 (b) 先做偏好, 本期正文也自持, 重构后再迁到分层 (c) 并行: 本期用现有面直写, 接受"删不掉 / 列不全", 重构后切换
理由: (a) 避免二次迁移与临时妥协, 且偏好分析正好是"管理逻辑在插件"的第一个样板 —— 它的账簿状态机 (observe -> candidate -> active -> dormant -> retired) 可直接作为瘦身条目的参考实现; (b) 最快看到效果, 代价是将来迁一次; (c) 会留下"库里有行但删不掉"的临时状态.

**随之作废的具体条款**: 原验收里的"候选 reject 墓碑 (`fact_key`)"与"自动批准调 `candidates.approve` + `reviewer`"不再成立, 改为账簿状态断言 (见「验收细化」); 原"最高只到待审"的分档改由账簿 `status = candidate` 承载.

## 规划

### 实现前冻结的接口（消费方按此写）

**上游两项**（memory-base 重设后的句柄面 + `rule-engine` 注入消费者）：

```ts
// ① 归纳路径：只拿项目层权限（能力即闸门）
const induction = memory.registerKind({
  kind: "preference",
  writableTiers: ["project"],
  preWrite,                       // 纵深防御：内容级再拒一次（D10 a2）
});
// ② 用户层：单独 kind，只由显式动作路径调用
const explicit = memory.registerKind({ kind: "preference_user", writableTiers: ["user"] });

await induction.put({ content, tier: "project", project, title, importance: 3, source: { kind: "manual" }, sessionId });
await explicit.put({ content, tier: "user", project, title, importance: 4, source: { kind: "manual" } });
await induction.forget([{ tier: "project", ids: [a, b] }]);   // 撤销 / 退休（返回删条数）
const rows = await memory.list({ kind: "preference" });        // 全局只读（D16 只把库当副本）
```

两处说明（2026-10-17 第二轮接口核对后补）：① `sessionId` 只在 memory-base 的 **S 层**是必需项，P 层那次 `put` 也带上它是**有意留痕**（上游保留 `session_id` 列，便于回溯「哪次会话归纳出来的」）；U 层那次不带。② `forget` 的 `ids` 用数字 id，与上游句柄签名 `readonly { tier: Tier; ids: readonly number[] }[]` 对齐（不传字符串 id）。

**D19 四项要求 → 重设后的对应形态**（全部满足）：

| D19 的要求 | 重设后的形态 |
| --- | --- |
| (a) 指定层写入，不再要 `origin: "user"` | 句柄 `put({tier, ...})`（`origin` 列已删） |
| (b) 按 kind 列出 | 全局 `list({kind, tier?, project?, limit?, offset?})` |
| (c) 删除 | 句柄 `forget([{tier, ids}])` → 真删并返回条数 |
| (d) 保留 `registerKind` + `preWrite` | 保留：`KindSpec = {kind, table?, writableTiers?, preWrite?}` |

**门禁三条（D18 的落地）**：① 归纳只持 `writableTiers: ["project"]` 的句柄 —— 写 U 层会被 memory-base **抛错**（能力式硬闸，不靠自律）；② 用户层用独立 kind `preference_user`（`writableTiers: ["user"]`），**只由显式动作路径调用**；③ 两道隐私闸：写入前 `memory.checkPrivacy(text)` 预检 + 账簿自有敏感模式，再加 `preWrite` 纵深（D10）。

**已裁定（2026-10-17，用户「可以」）**：用「两个 kind」（`preference` / `preference_user`）而不是「同一 kind 声明两层 + 自律」—— 理由是 `preWrite` 的入参（`KindWriteInput = {content, title?, project, kind}`）**不含 `tier`**，按层拦不住；两个 kind 让「用户层只走显式动作」由能力保证。该事实已回写 memory-base 的冻结接口。

**账簿（自持，唯一状态源 D16）**：`<dshHome>/preference-analysis/ledger.json`（**跨会话**账簿，不能用会话目录），目录 0700 / 文件 0600，原子写 + 版本守卫，含 `status`（observe → candidate → active → dormant → retired）与 `suppressed` 键。

**注入（rule-engine 消费者，单个；注册面 2026-10-17 第二轮冻结）**：

```ts
ruleEngine.registerConsumer({
  id: "preference-analysis",
  sources: ["session-start", "compaction", "step-end"],   // 与 symbol-normalizer / ponytail 同款组合
  delivery: "steer",
  dedupeInRecord: 1,
  directWrite: ["session-start", "compaction"],           // 开局与压缩后立即注入，不被记录去重挡掉
  decide,                                                 // 只读账簿的 active 条目
});
```

每次 ≤ 5 条 / ≤ 600 字符（可配），超限截断并计数；`enabled: false` 时不注册（或注册后 `decide` 恒空）。取值来源见本文件调研 2 记的既有成熟组合（同节点同 `delivery` 的命中会被 rule-engine 合并成一条注入，故条数与字符上限必须由本包自己守）。

**模型侧工具三个**：`preference_list`（看账簿与状态）· `preference_add`（模型提议 → 一律落候选待审，不自动应用）· `preference_remove`（撤销 → 记 `suppressed` + 调 `forget`）。

**配置面**：`enabled`（缺省 true）· `autoApply: "confident"`（缺省，D8）· `markers`（S1 词表，缺省 12 词）· `thresholds: {evidence: 3, sessions: 2, recentDays: 30}` · `aging: {dormantDays: 90, retireDays: 180}` · `similarity: 0.8` · `inject: {maxItems: 5, maxChars: 600}`。

**依赖**：`memory-base`（必需，句柄与全局读）+ `rule-engine`（必需，消费者面）；`ctx.get` 取不到 → 记一次明确日志并停在「只观察不写入 / 不注入」（不静默）。

### 本任务 (调研 + 决策) 的改动文件清单

1. `docs/implementation/2026-10-16-preference-analysis-design.md`: 本追踪文档 (本任务唯一过程记录).

明确不做: 实现代码, 包骨架, profile 挂载, memory-base 改动, TUI 改动, `docs/BACKLOG.md` 条目注记改动, formatter, commit / push.

### 实现阶段 (预估) 的改动文件清单

新包 `preference-analysis/` (模板同 `md-table-check/`):

- `package.json` / `cordis.patch.yml` / `tsconfig.json` / `tests/tsconfig.json` / `.gitignore` / `LICENSE`
- `src/main.ts` (bundle 面: `inject: ["memory"]` + `ctx.get('ruleEngine')`, 配置归一, 接线, dispose)
- `src/observe.ts` (`session/event` -> S1 / S2 / S3 证据)
- `src/induce.ts` (约束句抽取, 归一化 key, 3-gram 相似合并, 置信分档)
- `src/ledger.ts` (状态文件: 版本守卫, 原子写, `0o600`, `suppressed` 键, 老化扫描)
- `src/apply.ts` (写库适配（按 memory-base 重设后的句柄面）+ 自动应用 + 注入消费者 `decide`，注册参数见冻结接口)
- `src/tools.ts` (`preference_list` / `preference_add` / `preference_remove`)
- `tests/*.test.ts` (observe / induce / ledger / apply / tools / main / 端到端)
- `README.md` + `docs/DESIGN.md` (有状态机与跨包契约, 按 `AGENTS.md`"DESIGN.md 口径"应建) + `docs/BACKLOG.md`

跨包 (原按 D15, 现按 D19):

- 偏好分析侧只做"按新面调用"的适配: 句柄 `put`（`induction` / `explicit` 两个）+ 句柄 `forget`（撤销 / 退休）+ 全局 `list({kind})`（列举）; memory-base 的瘦身改造本体归属它自己的任务 (用户 2026-10-16 指示: 不新开 BACKLOG 条目, 记录以本文件为准), 本任务不改其代码. **订正（2026-10-17 第二轮接口核对）**: 原文这里写的 `remember({tier})` 是旧面键 —— memory-base 重设后全局面不含 `remember`（写入只经句柄），一律以「实现前冻结的接口」那段为准.
- 若 D19 的三项尚未提供: 按 D20 的 (b) 退化为"正文也自持", **不加临时妥协代码** (不冒充 `origin: "user"`, 不依赖 `candidates`).

接线:

- 根 `package.json` (check / build 链), `scripts/install.sh`, `scripts/test-parallel.sh`, `profiles/example/cordis.patch.yml`, `README.md` + `README.zh.md`, `AGENTS.md`, `docs/BACKLOG.md` (§4 插件规划表行 + 完成时清理条目)

不改: `TUI/**`, `docs/STATUS.md` (用户择时), 其它 worktree 与主检出.

### 明确不做的部分 (首期)

TUI 面板 / `/prefer` 命令, `AGENTS.md` 写入, LLM 归纳与概括, 冲突自动检测, 快捷键与命令使用采集, 跨机共享, 用偏好影响模型工具选择 (只注入文本约束); 依赖 `candidates` / `promote` / LLM 概括闸的任何路径 (已随 D16-D19 作废); memory-base 的瘦身改造本体 (归属它自己的任务).

### 验收细化 (实现阶段)

机械断言 (各对应一个用例):

1. **成偏好**: 三个会话重放同一约束句的不同措辞 -> 账簿 `count >= 3`, `sessions >= 2` -> 账簿新增一条 `status = candidate` 条目 (断言归一化 key 与 3-gram 相似合并生效).
2. **低置信不产出**: 2 次证据或仅 1 个会话 -> 无 `candidate` 条目 (只留"观察中"计数).
3. **自动应用门槛**: `autoApply: "confident"` + 高置信 -> 条目转 `active` 且向 memory-base 写入一行 (断言写入层级 = 项目层 P, 正文 = 用户原话); `autoApply: "off"` -> 零写入, 零 `active`.
4. **拒绝后不再出现**: 条目被 reject (或 `preference_remove`) -> 账簿记 `suppressed` 键, 同一序列重放不再产出候选, 不再写入.
5. **老化**: 注入时钟推进 91 天 -> `dormant` 且不注入; 181 天 -> `retired` 并调删除面 (`forget` / `evict`); 若删除面尚未提供, 该断言退化为"账簿退休 + 不再注入".
6. **敏感信息不入库**: 证据含 `sk-` 形态或 `.ssh/id_rsa` -> 不产出条目, 且账簿文件里不出现该片段.
7. **注入面**: 存在 `active` 条目 -> 消费者 `decide` 返回含该偏好文案的正文 (条数超上限时截断并计数); 假 ruleEngine 断言**注册入参**与冻结值一致（`id` / `sources` / `delivery` / `dedupeInRecord` / `directWrite`）; `enabled: false` -> 不观测, 不注入, 不写入.
8. **分层门禁**: 归纳产生的写入只落项目层; 用户层写入只在显式动作下发生 (断言 actor 判定).
9. **机械门禁**: 新包 `npm run check` / `build` / `test` 全绿; 根 `npm run check` / `npm run build` / `npm run test` (TUI + 22 个插件) 全绿.

### 估时细化 (实现阶段, 共 3 天)

- 0.5 d: 包骨架 + 配置归一 + 账簿 (版本守卫 / 原子写 / 权限);
- 1.0 d: 观测与归纳 (三信号 + 相似合并 + 置信分档 + 老化);
- 0.5 d: memory-base 新面适配 (按 D19 调用) + 用例;
- 0.5 d: 应用面 (写库 / 自动应用 / 注入消费者 / 工具族);
- 0.5 d: 测试与文档 (DESIGN / README / 七处接线).

不含 TUI 面 (另 +2 d) 与 LLM 归纳 (另立调研). **优先级**维持 P2, 可在裁定时上调.

### 任务拆分（6 步，每步带中间验证）

1. **包骨架 + 账簿** —— `package.json` / `cordis.patch.yml` / `tsconfig.json` / `LICENSE` / `.gitignore`；`src/ledger.ts`（版本守卫、原子写、0600、`suppressed` 键、老化扫描）。验证：账簿用例（并发写、坏文件、`suppressed` 命中）。
2. **观测**（`src/observe.ts`）—— 订阅 `session/event`，抽 S1 / S2 / S3（S1 排除 `source.kind === 'rule-engine'`）。验证：三信号各一例 + 排除例。
3. **归纳**（`src/induce.ts`）—— 约束句抽取（≤ 120 字）、归一化 key、3-gram Jaccard ≥ 0.8 合并、置信分档（D5）。验证：验收 1、2。
4. **存储适配**（`src/apply.ts`）—— 两个句柄 + `put` / `forget` / 全局 `list`；隐私双闸。验证：验收 3、4、6、8。
5. **注入与工具**（`apply.ts` 的消费者 + `src/tools.ts`）—— 按冻结值注册一个 rule-engine 消费者（`id` / `sources` / `delivery` / `dedupeInRecord` / `directWrite`, 见冻结接口）; 三个工具的参数与返回值。验证：验收 7（含注册入参断言）+ 工具用例。
6. **文档与真机** —— `README.md` + `docs/DESIGN.md`（有状态机与跨包契约，按 DESIGN 口径需建）+ 七处接线。验证：该包 `test` 全绿 + 根三件套 + 真机一次。

### 实现阶段的验证口径（怎么跑）

- **单测**：`npm --prefix preference-analysis run test`（假 memory 与假 ruleEngine 两件可替身）；老化用**注入时钟**推进 91 / 181 天（验收 5）。
- **机械**：根 `npm run check` + `npm run build` + `npm run test` 三件全绿；`scripts/install.sh --dry-run` 的清单含本包。
- **真机**：重启 `dsh --profile fff`，连续三次说同一条约束 → 看账簿转 `candidate` / `active`，注入出现在提示里；`preference_remove` 后不再注入；`enabled: false` 全关（零观测、零写入、零注入）。
- **不做**：不验 TUI 面（首期零改动）；不验 LLM 归纳与冲突检测（D4 只实现统计那一半）；不验 `AGENTS.md` 写入（首期不做）。

### 收尾动作（实现完成时）

- 条目「偏好分析（从行为与编辑中归纳用户偏好并自动应用）」标「完成」并从 `docs/BACKLOG.md` 移除；本文件移入 `docs/archived/`。
- 文档回写：`preference-analysis/README.md` + `docs/DESIGN.md` + 根 `README.md` / `README.zh.md` + `AGENTS.md` + `docs/BACKLOG.md` §4 插件规划表一行；**包计数与 §4 表的统一**归条目「五个新插件落地时的仓库清单与包计数统一」。
- **memory-base 侧不写**：D19 的四项已由其重设满足（见冻结接口的对应表），本任务不改它的代码与文档。
- 依赖顺序：前置 = memory-base 重设（D20 选 (a)）；两包均未落地时本包停在「只观察不写入」（见冻结接口）。
- 遗留：TUI 面（D17 的 (c)，首期不做）；LLM 归纳与冲突检测（D4 预留注入口）；`AGENTS.md` 追加路径（首期不做，二期另议）。

## 剩余待用户裁定项

1. ~~**顺序依赖**: D20 选 (a) 先做 memory-base 瘦身, 偏好随后按 D19 新面实现~~ **已由上游覆盖（2026-10-17）**：memory-base 重设的决策项 8 同样选了「先瘦身」（沿用 D20），两项一致。
2. ~~**自动应用缺省档**: D8 选 `confident`~~ **已裁定（2026-10-17，用户「其他的没有问题」）：维持 `confident`**（高置信自动应用并注入，其余留待审；`off` 仍可配）。
3. ~~**用户层门禁落点**: D18 把门禁放在插件自律~~ **已由上游解决（2026-10-17）**：memory-base 重设**保留 `registerKind` 与 `preWrite`**，且写入只能经句柄 → 门禁改为**能力式**：归纳只持 `writableTiers: ["project"]` 的句柄，用户层用独立 kind `preference_user`（见冻结接口的「门禁三条」与那处待点头项）。
4. ~~**TUI 面**: 首期零 TUI 改动~~ **已裁定（2026-10-17，用户「其他的没有问题」）：维持零 TUI 改动**（审阅靠 `preference_list`，撤销靠 `preference_remove`）。
5. ~~**`AGENTS.md` 追加路径**~~ **已裁定（2026-10-17）：首期不做**（只注入）；二期是否列入另议，本文件不承诺。

## 实现记录

- 2026-10-16: 完成 R1-R7 调研与 D1-D15 决策, 写本文件. 无代码改动; 按用户当次指示**未跑 formatter, 未 commit**.
- 2026-10-16 (同日, 用户裁定后): 用户裁定 memory-base 计划只保留分级结构, 管理逻辑下沉到各插件 (**不新开 BACKLOG 条目**), 据此新增「修订」一节与 D16-D20, 并在 D7 / D8 / D9 / D15 原处注明取代关系; 补 R1 的服务面写入面与运行时现状核证, 同步更新规划 / 验收 / 估时 / 待裁定项. 仍未跑 formatter, 未 commit.

## 偏差

- 条目"接取时裁定"列出的信号里, **"用户对模型输出的修改"不可得** (TUI 无消息编辑, `feedback/record` 无生产者, 计数为 0), 首期用"打断 + 纠正性重述 + 审批拒绝"代理; **"快捷键 / 命令使用习惯"与"提交信息风格"未纳入首期** (前者需 TUI 侧新增事件, 后者与静态约定重复). 理由与证据见 R4. 这三条属与条目的偏差, 已并入待裁定项.
- 条目"落点 (预估)"把"作为 rule-engine 消费者 + memory-base kind 注册"列为可选形态; 本决策选了**独立新包**并仍复用这两面 (理由见 D1).
- 条目默认建议"先不自动改仓内文件"已遵守 (D7 选 (a), `AGENTS.md` 写入列入待裁定项 5).
- 原 D15 承诺的跨包改动 (`conclusion` 标记与按 kind 枚举行) **未实施即作废**: 用户 2026-10-16 改走"memory-base 瘦身"路线, 偏好分析不再依赖候选队列与概括闸; 新版最小要求见 D19, 其本体归属 memory-base 自己的任务, 本任务不记条目, 不改其代码.

## 测试与证据

- 本任务无代码改动, 故无 `check` / `build` / `test` 结果可报; 按用户当次指示未跑 `format`, 未 commit.
- 证据形式: 本文件内容 + `git status --short` (预期只有本文件为新增); 调研结论均在 R1-R7 里带 `文件:行` 出处, 可逐条复核.
- 复核命令 (供后续复用): `grep -rn "registerKind" memory-base/src/`, `grep -rn "summarized" memory-base/src/promote.ts`, `grep -rn "candidates" TUI/src/app/adapter/dsh.ts`, `grep -rn "setLlmCaller" .`.
- 2026-10-16 追加核证 (只读): `sqlite3 "file:$HOME/.dsh/memory-base/memory.db?mode=ro" ".tables"` -> 只有 `candidates` / `chunks` / `chunks_fts*` / `chunks_trigram_fts*` / `sources`, 无 `kind_*` 表; `select promotion_state, summarized, count(*) from candidates group by 1,2;` -> 零行 (候选队列从未被写入).
- 服务面能力核证: 逐键比对 `memory-base/src/index.ts:770-950`, 确认无 `targetRows` / `setImportance` / `evict` / `touch` / 按 kind 列举; `forget` 为 `tiers?.forget ?? 0` (`:846-851`); 分层写入路由见 `memory-base/src/tiers.ts:320-336`.

## 收尾

- 未关闭: 条目仍是〔进行中〕, 本文件留在 `docs/implementation/`; 等用户对「剩余待用户裁定项」答复后进入实现 (或调整决策).
- 未改 `docs/BACKLOG.md` (按用户当次指示: 只更新追踪文档, 等检查后再定).
- 未回写任何包 `README.md` / `DESIGN.md` / `docs/ROADMAP.md` (本任务不产生仓内实现).
- 归档: 待实现完成, 条目关闭后随收尾提交移入 `docs/archived/`.
