# 泛化 task-engine: 编排模板框架（接取条目：docs/BACKLOG.md「泛化 task-engine: 编排模板框架」）

状态：实现　　开启：2026-11-15　　关闭：
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

**task-engine 只提供「节点基础工具」; 流程语义全部由流程定义插件（flow-track / plan-mode）定义与编排。** 职责边界（用户 2026-11-15 裁定）:

- **task-engine = 节点级原子能力**: 建节点 / 写产出 / 验收 / 执行 / 查询等节点基础工具（既有 `task_*` 家族已覆盖大部分）; 为流程定义插件提供可用的服务面与执行能力（含可选的顺序强制执行校验、任务推送的基础接入）。
- **flow-track / plan-mode = 流程定义方**: 创建多少个节点、每个节点做什么（spec / acceptance / 粒度）、什么条件下允许做下一个节点——都由流程插件定义; 流程插件使用 task-engine 提供的节点基础工具落地执行。
- 执行层（状态机 / 门禁 / 验收 / 事件 / 查询）全部复用 task-engine 通用内核, 不自研新引擎; 「声明式资产 / 静态注册表文件」不是目标——流程插件硬编码流程定义始终可接受。

验收（BACKLOG 条目口径, 按上述裁定重述）: 同一套节点基础工具能承载两种流程形态（线性八阶段与 plan 三段各一）; flow-track 的八阶段从「代码内硬编码 + 自身注入建树」迁移为「flow-track 定义流程 + 用 task-engine 节点工具执行」, flow-track 不再自实现建树与流程推进。

接取范围说明（2026-11-15）: 仅接取本条「泛化 task-engine」。BACKLOG「自研 plan 模式」条目与本条有前置依赖关系, 本任务只把 plan 三段做成第二份流程定义作通用性验证（节点基础工具能承载两种不同形态的流程）, 不接取该条目的完整机制设计; 该条目仍在 BACKLOG 待用户另行接取。

## 调研

### task-engine 现状（树形分解内核）

- `engine-types.ts:23-33` `RootSpec`: 根契约（title / spec / acceptance / needDecompose / executor）。引擎只有一个根契约 `rootTemplate`（`engine.ts:77-78`）, 每轮新根沿用同一份（`engine.ts:558-574` `buildRootFrame`, `root-<n>` 自动编号）; **线性阶段语义不存在于引擎内**。
- `engine.ts:222-345` `decompose(parentId, children, entail, enumeration)`: 对当前轮根 `root` 拆一层或多层; 对已完成的当前轮根再分解自动开新一轮。子帧 `ChildSpec`（`types.ts:67-85`）含 `deps`（前置只允许引用前序兄弟, `gate.ts:446-462`）、`coverage`、`executor`、`enumItem`。
- `tools.ts:211-407` 模型侧 `task_*` 五工具: `task_decompose`（手动建树）/ `task_implement` / `task_execute` / `task_stop` / `task_status`; 过机械 + 语义蕴含双门禁。
- 门禁 `gate.ts`: 机械门禁（结构校验 + 分解粒度 / 越级检查）+ 语义蕴含（`entail`, `engine-types.ts:113-125`）; 验收 `acceptance.ts` 三级 mechanical / semantic / human（命令退出码 / 人工审批 / 独立 audit run）。
- 服务面 `plugin.ts:383-391`: `provide("taskEngine", { query, frameStack })`; 注入面 `plugin.ts:49` `inject = ["tools"]`, **无回合注入**。

结论: 引擎是通用树形状态机, 不关心树按什么排; 顺序 / 流程语义完全在引擎外层。

### flow-track 现状（外层流程语义, 硬编码八阶段）

- `stages.ts:15-28` `StageSpec`: `{ index, name, spec, acceptance, gate, deps }`; 八阶段 `STAGES`（`stages.ts:31-96`）硬编码。
- `stages.ts:116-134` `renderStages`: 把八阶段渲染成文本注入给模型, 模型据此**手动** `task_decompose` 建树。
- `policy.ts:16-25` `STAGE_NAMES`: `flow_record` 顺序策略（同阶段替换 / 下一阶段新增 / 跳过与倒回拒绝）靠阶段名与序推导。
- `status.ts:49-83` `currentStage` / `renderStatus`: 从 task-engine 快照 `frameStack` 末位帧、按**标题前缀匹配**（`stageOfTitle`）反推当前阶段并渲染推进状态。
- `inject.ts:50-63` `decideText`: 回合边界把阶段模板 / 推进状态 / 合规提示 / 最近记录合成一条注入, 经 `pinNotes.hold("flow")` 动态保持（`index.ts:279-305`）; 注入门槛 = 开关开 + memory 有未完成阶段的流程记录。
- `tools.ts`: `flow_record / flow_status / flow_enable / flow_remove / flow_rollback` 五工具; stage 枚举来自 `STAGES` 阶段名。

结论: flow-track 的「八阶段」同时是注入模板、记录顺序、阶段识别三者的来源, 全部从 `stages.ts` 派生; 流程定义迁出后这三处都要改走同一新来源（flow-track 流程定义）。

### 流程抽象要素 × task-engine 已有能力

| 要素 | 含义 | task-engine 现状 |
| --- | --- | --- |
| 节点 / 阶段 | 流程里一个可执行步骤 = 一个任务帧 | 有: `ChildSpec` / `Frame`（`types.ts:66-117`） |
| 节点内容 | 该步骤要做什么 | 有: `title` + `spec`（帧字段） |
| 每节点验收 | 多条 acceptance, 每条 mechanical / semantic / human | 有: `Acceptance[]` + `AcceptanceLevel`（`types.ts:8-18`）三档裁决 |
| 节点粒度 | 叶子或可再拆 | 有: `needDecompose` / `executor` |
| 节点间关系 | 顺序 / 依赖（前序兄弟） | 有: `deps`（声明校验, 非执行强制, `gate.ts:446-462`） |
| 流程归属 | 流程挂在整个任务树的哪一层 | 现形态: `RootSpec` 单根契约, 每轮新根沿用 |

结论: **执行内核已覆盖流程的全部运行要素**——阶段即 `ChildSpec[]`（一次 `decompose` 挂 N 帧）; 缺的是三样: ① 顺序强制校验（把 `deps` 从声明校验升级为可选执行强制）; ② 编程服务面建树接口; ③ 任务推送（把当前节点内容交给 pin-note 动态保持）。

## 决策

- **决策项 1 = 顺序强制功能（用户 2026-11-15 拍板: 增加, 可选打开）**: 现状——引擎的「强制停留」是验收导向（stop 不过 → 打回重做本帧）, 不是顺序硬禁: 就绪池 DFS 先序 + step 裁决把 next 指向下一帧属软引导, 引擎不检查「前序兄弟是否 done」, 模型可直接对后续节点 implement / stop。

  - 选项 a: 不做, 维持现状（验收强制 + 顺序软引导）; b: 增加严格顺序强制到执行内核, **可选打开**（缺省关闭 = 既有行为逐字不变）。
  - 选定: **b**。理由: 流程（线性八阶段 / plan 三段）需要「未完成本阶段不得进入下一阶段」的确定性保证; 可选打开保住既有行为与测试不外溢。

- **决策项 2 = 顺序强制开关粒度（用户 2026-11-15 拍板: 流程定义级）**: 每个流程定义声明时可选带 `enforceOrder` 标志（缺省不声明 = 不强制）; 只有声明了该标志的流程建出的树才强制顺序。不设引擎全局开关, 不设调用参数级。

  - 选项 a: 引擎配置级（全局开关, 对所有树生效）; b: 流程定义级（每流程声明）; c: 两级配; d: 调用参数级（建树时每次传）。
  - 选定: **b**。理由: 粒度最准——只有需要顺序保证的流程声明它, 不污染 task-engine 的其它用法（如 fan-out 并行树、自由分解）; 缺省关闭保证既有行为与测试零变化。
  - 职责分界下的落点: **流程定义插件（flow-track / plan-mode）决定是否要强制依赖（定义侧: 流程声明是否带强制）, task-engine 负责检查与执行强制（执行侧: stop / implement / execute 的拦截校验）**。

- **决策项 3 = 顺序强制校验落点（用户 2026-11-15 拍板: stop 与 implement/execute 都拒）**: 打开顺序强制的流程树里, 前序兄弟未 done 时拒绝后续节点的任何操作:

  - `stop(验收)`: 前序兄弟未 done → 拒绝标完成（打回带反馈, 指向本帧）。
  - `implement` / `execute`（写产出 / 发起执行）: 前序兄弟未 done → 拒绝写产出。
  - 选定: 两者都拒（a）。理由: 既不许提前写产出, 也不许提前标完成, 顺序边界完整; 只拦一处会留缝。
  - **作用域说明（2026-11-15 用户提醒）**: 「前序兄弟」= **同父帧下的兄弟序列**, 不是全局序——流程段可挂在任意待分解节点（`needDecompose: true`）下, 顺序强制约束在该父帧的兄弟序列内成立, 不跨层、不跨父。与 `deps` 既有语义一致（`gate.ts:446-462`: 只允许引用前序兄弟）。

- **决策项 4 = 任务推送机制（用户 2026-11-15 拍板: 动态保持推送）**: 现状——模型主动拉取任务信息（`task_status` 看树 / `task_stop` 的 `next` 拿下一帧 id）, 且查询视图只带 `title` 不带 `spec`（`events.ts:144-152`）; 职责分界后 spec 由流程定义写入、建树后落节点帧, 模型建树时没见过, 拉取式拿不到任务内容; task-engine 无回合注入面。

  - 选项 a: 维持拉取式（模型 task_status / 看 next）; b: 动态保持推送——经 pin-note 机制把「当前任务目标（spec）+ 其他提示词」保持在上下文, 每轮注入给模型。
  - 选定: **b**。理由: 任务被推给模型而非模型自己去找, 减少漏做 / 做错节点的概率, 与 flow-track 既有 `pinNotes.hold("flow")` 同范式。
  - 职责分界下的落点: 节点内容的来源与流向（2026-11-15 用户澄清）——**流程定义插件在开启流程时一次性指定所有节点的内容**（每个节点带 title / spec / acceptance 等, 即流程定义的节点数组）; **task-engine 负责把正在执行的那个节点的内容取出来**交给 pin-note; **pin-note 负责把内容保持在上下文里**（动态保持机制）。三者职责: 流程插件定内容, task-engine 取当前节点内容, pin-note 保持与渲染。

- **决策项 4.0 = flow-track 与 task-engine 的职责契约（用户 2026-11-15 拍板）**: **flow-track 创建完节点后, 后续全部交给 task-engine**——流程定义（几个节点 / 各做什么 / 是否强制依赖）在 flow-track 侧完成并建树之后, 节点推进 / 校验 / 验收 / 推送 / 查询全部由 task-engine 接管, flow-track 不再介入执行期。

- **决策项 4.1 = 保持到上下文的当前节点数据（用户 2026-11-15 拍板: c）**: task-engine 取出并交给 pin-note 的**当前节点数据** = 节点 `title` + `spec` + 验收摘要 + 下一步帧 id + 顺序强制提示（顺序强制模式开启时含「须先完成前序」一句, 关闭时省去该句）。不推整棵树。渲染为注入文本由 pin-note 负责（决策项 4.2 / 9-②）; 节点内容本身是流程插件开启流程时一次性指定的（决策项 4 落点）。

  - 选项 a: 仅当前节点 title + spec; b: title + spec + 验收摘要; c: title + spec + 验收 + 下一步 id + 顺序强制提示。
  - 选定: **c**。理由: 目标（spec）+ 达标判据（验收）+ 边界（顺序）+ 走向（下一步）一次给全, 模型不查工具就能开工。

- **决策项 4.2 = 保持机制（用户 2026-11-15 拍板: pin-note 负责保持）**: **pin-note 负责把内容保持在上下文里**——task-engine 把正在执行的节点内容交给 pin-note（`pinNotes.hold` 面）, pin-note 负责动态保持（渲染 / 模板 / 缓存影响等上下文影响的控制由 pin-note 处理）; task-engine 不自造注入渲染策略、不复刻「投递一次就不管」的通告式。

  - 选项 a: 每回合动态保持（自有实现）; b: 仅状态变化投递一次; c: 状态变化更新 + 每回合兜底。
  - 选定: 复用已实现的统一动态保持机制接口（`pinNotes.hold`）做动态保持。理由: 「推送」= 保持 = 每轮在场, 正是 pin-note 机制本职; task-engine 只取节点内容交给 pin-note, 渲染与缓存影响由 pin-note 侧负责。

- **决策项 4.3 = 保持门槛（用户 2026-11-15 拍板: c）**: 树非空且根未完成时保持到上下文; 树空 / 已完成则不（天然防刷屏）。门槛绑定任务树自身状态, 不依赖 memory 流程记录。

  - 选项 a: 无条件; b: 有活跃流程记录才保持; c: 树非空且根未完成。
  - 选定: **c**。

- **决策项 4.4 = 与 flow-track 的关系（用户 2026-11-15 拍板: flow-track 重构, 不再自己实现流程, 使用 task-engine 定义）**: flow-track 随本任务一并重构——不再自实现流程（不再自持 `renderStages` 阶段模板与 `renderStatus` 推进状态的树级注入）, 其八阶段流程定义迁为「flow-track 定义 + task-engine 节点基础工具承载执行」（决策项 4.0 / 5）; flow-track 保留记录（`flow_record`）/ 合规提示 / 最近记录等非树级职责。树级内容保持由「flow-track 定内容 → task-engine 取当前节点 → pin-note 保持」承担, 不并存不重叠。

  - 选项 a: 并存; b: task-engine 接管树级推送, flow-track 模板 / 状态注入退役; c: 互相感知让位。
  - 选定: **b**, 且明确 flow-track 是重构。

- **决策项 5 = 建树入口形态（用户 2026-11-15 拍板: 编程服务面, 不提供模型侧建单节点工具）**: 流程建树不走模型侧 `task_decompose` 手动逐个建节点; 改由**编程服务面工具**完成——流程插件定义流程后, 模型侧只暴露**流程入口工具**（如 `flow_start`）: 模型确认使用某流程并调用入口, 入口内部经编程服务面自动创建整棵节点列表。

  - 选项 a: 模型侧建单节点工具（task_decompose 逐节点）; b: 编程服务面建树 + 模型侧只有流程入口工具。
  - 选定: **b**。理由: 模型不必知道流程内部节点结构与拆法, 只确认「用哪个流程」即自动建树; 节点定义一致性由流程插件保证。
  - 落点: task-engine 提供编程服务面建树接口（`composeFromNodes(parentId, nodes)`, 父帧可任意, 供流程插件入口调用）; 流程插件提供模型侧流程入口工具（归各自 `flow_*` 族）。**入口确定挂载点**——流程段可挂 root, 也可挂在某 `needDecompose: true` 的待分解节点下（挂载点由流程定义或入口调用指定, 2026-11-15 用户提醒）。
  - 子项定稿: 既有模型侧 `task_decompose` **保留**——两重用途: ① 自由细化复杂任务; ② 流程阶段也可能是复杂任务（阶段 `needDecompose: true`）时, 阶段内部再分解仍走 `task_decompose`。即: 流程提供骨架, 节点内细化走自由分解, 两者互补; 不作为流程建树入口用。

- **决策项 6 = plan 三段流程定义的载体（用户 2026-11-15 拍板: 独立插件, 与 flow-track 平级）**: plan 模式（探索 → 计划 → 实施三段）**独立成插件**（`plan-mode/`）, 地位与 flow-track 等同（同为流程定义插件）; 不内置于 flow-track, 不作为 task-engine 内置注册。

  - 选项 a: 放 flow-track 内置（不新建包）; b: 独立新插件; c: task-engine 内置注册。
  - 选定: **b**。理由: 各流程定义插件平级、职责单一, 双方都经 task-engine 节点基础工具落地; 验证「同一套节点工具承载多个独立流程插件」的通用性。
  - 本任务范围内 plan 插件只做流程定义 + 入口工具（三段节点: 探索 / 计划 / 实施, 各 `needDecompose: true` 可再拆）, 不接取 BACKLOG「自研 plan 模式」条目的完整机制设计（门禁策略等留该条目另行接取）。

- **决策项 7 = 流程选择开关（用户 2026-11-15 拍板: 每个流程都有开关, 由独立仲裁插件统一管理）**: 每个流程定义插件都提供**开关**, 用于确认使用哪一种流程; 开关形态为**独立流程仲裁插件**统一管理（各插件不自持唯一开关）。

  - 选项 a: 各插件自持开关（flow_enable / plan_enable, 无唯一性约束）; b: 独立仲裁插件; c: 仲裁逻辑放 task-engine。
  - 选定: **b**。理由: 流程选择 / 仲裁是流程层职责, 不是节点层——符合「task-engine 只管节点基础工具」分界; 新流程插件接入即被统一约束。

- **决策项 8 = 流程仲裁插件形态（用户 2026-11-15 拍板: 独立插件; 会话级状态; 入口工具层拦截, 恒注册 + pre-execute 检查; 本项为决策项 7-b 的落点细化, 不再重复选项枚举）**: 独立流程仲裁插件（`flow-arbiter/`）负责「**最多选中一个流程, 拦截其他流程**」:

  - 落点 1（会话级）: 「当前选中流程」状态**按会话记录**——不同会话可并行跑不同流程, 互不干扰（进程内内存, 不落盘, 同 `FlowSwitch` 范式）。
  - 落点 2（入口工具层拦截, 生效在流程入口: 2026-11-15 用户细化）: 仲裁的拦截**只作用在「使用哪个流程入口」那一刻**——只有**被选中的那个流程插件**的入口工具（`flow_start` / `plan_start`）能**真正初始化流程节点**; 其它流程入口在 pre-execute 检查时被拒绝（未选中流程 / 选中了别的流程 → 拒绝并说明）。**未选中流程无法建树, 故不存在其内容保持问题**——树级内容保持只看 task-engine 门槛（决策项 4.3: 树非空且根未完成), 不再叠加仲裁的每轮判定。task-engine 不感知「流程」概念, 拦截不进引擎内核, 也不在工具面删注册（保缓存命中）。
  - 开关入口: 仲裁插件提供模型侧工具 + 命令面（选中流程 / 取消）; 冲突（试图同时选中两个）拒绝后者或自动顶替（实现时定）。
  - 协作: 流程插件注册自身到仲裁, 仲裁持有「流程 id → 入口」登记（实现时定）。

- **决策项 9 = 上下文缓存友好约束（用户 2026-11-15 提出）**: 开关 / 流程选择不能破坏上下文缓存命中, 落实三条:

  - ① **所有流程插件工具恒注册, 拦截走 pre-execute**: 流程入口与仲裁选择工具装配期全部注册, 不随选中状态运行时增删——工具定义区（系统提示大头）稳定, 是缓存命中的最大块; 选中 / 拦截判定在工具执行前一刻的 pre-execute 检查做, 不改工具面。
  - ② **pin-note 负责动态保持与上下文影响控制**: 内容来源链 = 流程定义插件（开启时一次性指定所有节点内容）→ task-engine（取当前正在执行节点的内容）→ pin-note（把内容保持在上下文, 渲染 / 模板 / 缓存影响等上下文控制的处理归 pin-note, 对齐其既有的按步调用、同 key 覆盖、inbox 收敛语义, `pin-note/src/index.ts:245-395`）; task-engine 不夹带自己的注入渲染策略。
  - ③ **开关切换不导致缓存失效（2026-11-15 用户更正）**: 切换流程只修改仲裁的**放行规则**（进程内选中状态), 不改工具列表、不进上下文内容——工具恒注册（见①), 选中状态是内存态不在 prompt 里; 若切换后不初始化流程, 这次切换完全不被感知, 缓存不受影响。真正改变上下文的是**初始化流程（建树）之后**: 建树使节点 / 推进状态 / 当前节点推送内容随之变化, 那时前缀才重新累积; 「开关切换 = 低频一次性」仍成立（低频、一次性), 但**失效的诱因是建树而非切换**。
  - 缓存观测: 依赖既有 cache-hit-monitor（预估 vs 实际命中率判定）。

## 规划

### 任务拆分与实现顺序（2026-11-15）

按依赖排序拆为五个阶段, 阶段内串行（共享文件按顺序避免冲突）, 阶段间顺序执行不并发（与「顺序执行不并发」既有约定一致）:

**阶段 1: task-engine 节点基础工具增强（无前置, 先做）**

- 1a 类型位: `ChildSpec` / `RootSpec` 增可选 `enforceOrder`（`engine-types.ts` / `types.ts`）。
- 1b 顺序强制校验: `implement` / `execute` / `stop` 三入口加前序兄弟校验（仅流程声明强制时启用）。
- 1c 编程服务面建树接口: `plugin.ts`（或新 `flow-service.ts`）暴露「按节点数组建树」服务, **签名 = `composeFromNodes(parentId, nodes)`——父帧可任意**（缺省 root), 流程段可挂在任意 `needDecompose: true` 的待分解节点下（2026-11-15 用户提醒）。
- 1d 任务推送: 取当前节点数据交给 pin-note（`pinNotes.hold`）。
- 验证: `pnpm run check -- task-engine` / `pnpm run test -- task-engine`（含三入口 × 关/开两态、建树接口、推送门槛）。
- 依赖: 1a → 1b（标志位先行）; 1c / 1d 无相互依赖, 可并行。
- 交付: 引擎侧能力齐备, 不破坏既有 `task_*` 行为（顺序强制缺省关闭）。

**阶段 2: flow-track 重构（依赖阶段 1）**

- 2a `stages.ts` 改八阶段流程定义（节点数组, 不再作注入模板）。
- 2b `flow_start` 入口: 内部调 task-engine 编程建树; `flow_tools.ts` 增工具（本阶段仲裁未就绪, 入口暂全放行; 拦截在阶段 4 挂上）。
- 2c `renderStages` / `renderStatus` 树级注入退役; `policy` / `status` 阶段序改从流程定义读。
- 2d `flow_enable` 并入仲裁（本阶段先移除自持开关, 仲裁工具在阶段 4 补齐）。
- 验证: `pnpm run check -- flow-track` / `pnpm run test -- flow-track`（阶段序来源变更、注入退役）。
- 依赖: 阶段 1 的 1c（建树接口）; 内部 2a → 2b → 2c → 2d（定义先行, 入口随后, 注入退役在入口接管后, 开关并入仲裁最后）。

**阶段 3: plan-mode 新插件（依赖阶段 1; 阶段间串行, 见拆分说明）**

- 3a 新包 `plan-mode/`: 三段流程定义（探索 / 计划 / 实施, 各 `needDecompose: true`）+ `plan_start` 入口（同 2b, 本阶段仲裁未就绪暂全放行）。
- 3b 根级接线: `scripts/*` 枚举计数 40→41、README、PACKAGES。
- 验证: 包内 check / test; `pnpm run check:docs`。

**阶段 4: flow-arbiter 新插件（依赖阶段 2 / 3 的入口存在）**

- 4a 新包 `flow-arbiter/`: 会话级选中状态 + 选择入口工具 + 命令面。
- 4b pre-execute 入口拦截: 挂到 `flow_start` / `plan_start` 执行前（恒注册, 工具面不变）——此前两入口暂全放行, 本阶段起按选中流程拦截。
- 4c 根级接线: 计数 41→42、README、PACKAGES。
- 验证: 包内测试（选中 / 取消 / 唯一性 / 入口拦截）; 两流程插件联测（选 flow 时 plan_start 被拦, 反之亦然）。
- 依赖: 阶段 2 的 2b 与阶段 3 的 3a（入口工具存在, 才能挂拦截）。

**阶段 5: 全量收尾（依赖阶段 1-4）**

- 全仓 `pnpm run check` / `build` / `test` / `test:tui` / `check:docs`; 集成联测（flow-track 建树 → 顺序强制 → 推送 → 仲裁拦截链路）。
- 文档回写: README 双侧、PACKAGES、各新包 README。

拆分说明: 五个阶段均独立可验证, 前一阶段完成后再进入下一阶段（顺序执行不并发）; 阶段 2 与 3 依赖阶段 1（建树接口等节点基础工具能力）, 按「甲完成后乙开始」串行, 不与「fan-out 并行」混淆——阶段内多条改动可按天并行, 阶段间不并行。

### 任务清单（每条带命令行机械审计）

审计约定: 命令在仓库根目录执行; `TEST_SCRIPT=check sh scripts/test-parallel.sh <pkg>` = 该包子类型检查（退出 0 通过）; `pnpm -C <pkg> run test` = 该包子测试（node --test, 退出 0 且计数≥N）; `grep -q "…" <file>` 断言源码/产物存在。所有断言以退出码 0 为通过, 非 0 为失败。

**T1（阶段 1a）enforceOrder 类型位**

- 改动: `task-engine/src/types.ts` 的 `ChildSpec` 增可选 `enforceOrder?: boolean`; `task-engine/src/engine-types.ts` 的 `RootSpec` 同增; `task-engine/src/plugin.ts` `normalizeRoot` 透传到根。
- 审计: `TEST_SCRIPT=check sh scripts/test-parallel.sh task-engine` → 退出 0; `grep -q "enforceOrder" task-engine/src/types.ts` → 退出 0; `grep -q "enforceOrder" task-engine/src/engine-types.ts` → 退出 0。

**T2（阶段 1b）顺序强制校验（implement / execute / stop 三入口）**

- 改动: `task-engine/src/engine.ts` 的 `implement` / `execute` / `stop` 入口各加前序兄弟校验: 帧所在树声明了强制（帧或其根带 `enforceOrder`）且存在未 done 的前序兄弟 → 拒绝并打回指向本帧; 校验读取帧 `parent` / `siblings` 与兄弟状态。
- 审计: `pnpm -C task-engine run test` → 退出 0 且 通过数 ≥ 既有+6（关/开两态 × 三入口）; `grep -q "enforceOrder" task-engine/src/engine.ts` → 退出 0。

**T3（阶段 1c）编程服务面建树接口 `composeFromNodes`**

- 改动: `task-engine/src/plugin.ts`（或新 `flow-service.ts`）暴露服务面接口, 提供 `composeFromNodes(parentId, nodes)`——内部一次 `decompose` 传全部 children（走既有双门禁）；父帧可任意（缺省 root）。
- 审计: `TEST_SCRIPT=check sh scripts/test-parallel.sh task-engine` → 退出 0; `grep -rq "composeFromNodes" task-engine/src` → 退出 0; `pnpm -C task-engine run test` → 退出 0 且 通过数 ≥ 既有+2（root 挂载 / 任意父挂载）。

**T4（阶段 1d）任务推送给 pin-note**

- 改动: 新增 `task-engine/src/push.ts`（或并入 plugin）: 订阅任务树状态变化, 当树非空且根未完成时, 取当前节点数据（title / spec / acceptance 摘要 / 下一步帧 id / 顺序提示）经 `pinNotes.hold` 动态保持。
- 审计: `TEST_SCRIPT=check sh scripts/test-parallel.sh task-engine` → 退出 0; `grep -q "pinNotes" task-engine/src/plugin.ts` → 退出 0（pinNotes 登记在装配层）; `grep -q "renderCurrentTask" task-engine/src/push.ts` → 退出 0（取数与渲染在 push.ts）; `pnpm -C task-engine run test` → 退出 0 且 通过数 ≥ 既有+3（门槛: 树空/已完成不推; 内容字段齐全）。

**T5（阶段 2a）flow-track 八阶段改流程定义**

- 改动: `flow-track/src/stages.ts` 重构为流程定义数据结构（八阶段节点数组: id / title / spec / acceptance / needDecompose / deps / enforceOrder 声明）; 保留导出供建树。
- 审计: `TEST_SCRIPT=check sh scripts/test-parallel.sh flow-track` → 退出 0; `grep -q "enforceOrder" flow-track/src/stages.ts` → 退出 0; `pnpm -C flow-track run test` → 退出 0。

**T6（阶段 2b）flow_start 入口**

- 改动: `flow-track/src/flow-start.ts`（新）或并入 tools: 注册模型侧 `flow_start` 工具——按流程定义调 task-engine `composeFromNodes` 建树（挂载点按流程定义/入口指定）; 仲裁尚未挂（阶段 4）, 入口暂全放行。
- 审计: `TEST_SCRIPT=check sh scripts/test-parallel.sh flow-track` → 退出 0; `grep -rq "flow_start" flow-track/src` → 退出 0; `pnpm -C flow-track run test` → 退出 0 且 通过数 ≥ 既有+2（建树成功 / 挂 root 与任意父）。

**T7（阶段 2c）flow-track 注入退役与阶段序来源**

- 改动: `flow-track/src/inject.ts` / `status.ts` / `policy.ts`: `renderStages` / `renderStatus` 树级注入退役; 阶段序 (`STAGE_NAMES` / `currentStage` / `flow_status` / `flow_rollback` 枚举) 改从流程定义读。
- 审计: `pnpm -C flow-track run test` → 退出 0（既有断言改从流程定义来源）; `! grep -q "renderStages" flow-track/src` → 退出 0（grep 未命中即已删）; `! grep -q "renderStatus" flow-track/src` → 退出 0（grep 未命中即已删）。

**T8（阶段 2d）flow_enable 迁出**

- 改动: `flow-track/src/tools.ts` / `switch.ts`: 移除 flow-track 自持唯一开关（`flow_enable`）; 开关职责移交仲裁（阶段 4 补齐）。
- 审计: `TEST_SCRIPT=check sh scripts/test-parallel.sh flow-track` → 退出 0; `pnpm -C flow-track run test` → 退出 0; `! grep -q "flow_enable" flow-track/src/tools.ts` → 退出 0（grep 未命中即已迁出）。

**T9（阶段 3）plan-mode 新插件**

- 改动: 新建 `plan-mode/` 包（`package.json` / `cordis.patch.yml` / `tsconfig.json` / `README.md` / `LICENSE`）; 三段流程定义（探索 / 计划 / 实施, 各 `needDecompose: true`）+ `plan_start` 入口工具（同 flow_start 语义, 阶段 4 前暂全放行）; `scripts/test-parallel.sh` default_pkgs 加 `plan-mode`。
- 审计: `TEST_SCRIPT=check sh scripts/test-parallel.sh plan-mode` → 退出 0; `TEST_SCRIPT=build sh scripts/test-parallel.sh plan-mode` → 退出 0 且 `test -f plan-mode/dist/src/index.js` → 退出 0; `pnpm -C plan-mode run test` → 退出 0 且 通过数 ≥ 3。

**T10（阶段 4a）flow-arbiter 选中状态与选择入口**

- 改动: 新建 `flow-arbiter/` 包（含 `package.json` / `cordis.patch.yml` / `tsconfig.json` / `README.md`）: 会话级「当前选中流程」状态（进程内内存, 不落盘）+ 模型侧选择工具（选中 / 取消）+ 命令面; 流程插件向仲裁登记自身（流程 id → 入口）。
- 审计: `TEST_SCRIPT=check sh scripts/test-parallel.sh flow-arbiter` → 退出 0; `pnpm -C flow-arbiter run test` → 退出 0 且 通过数 ≥ 4（选中 / 取消 / 唯一性 / 冲突拒）。

**T11（阶段 4b）pre-execute 入口拦截**

- 改动: `flow-arbiter/src/pre-execute.ts`: 挂到 `flow_start` / `plan_start` 执行前一刻——按调用方会话匹配选中流程, 未选中 / 选别的 → 拒绝并说明; 工具恒注册, 不在工具面删注册。
- 审计: `TEST_SCRIPT=check sh scripts/test-parallel.sh flow-arbiter` → 退出 0; `grep -rq "pre-execute" flow-arbiter/src` → 退出 0; `pnpm -C flow-arbiter run test` → 退出 0 且 通过数 ≥ 2（选中流放行 / 未选中拒）。

**T12（阶段 4c）flow-arbiter 根级接线**

- 改动: `scripts/test-parallel.sh` default_pkgs 加 `flow-arbiter`; `scripts/install.sh` canonical_pkgs 加 `flow-arbiter`; `scripts/test-install.sh` 包数断言 41→42; 计数相关文档（README 双侧 / PACKAGES / AGENTS / dev/standard 计数规则）。
- 审计: `grep -q "flow-arbiter" scripts/test-parallel.sh` → 退出 0; `grep -q "flow-arbiter" scripts/install.sh` → 退出 0; `sh scripts/test-install.sh` → 退出 0; `pnpm run check:docs` → 退出 0。

**T13（阶段 4 后收尾检查: 全仓计数与清单一致性）**

- 改动: 核对新增包后的全仓接线一致性（test-parallel default_pkgs、install canonical_pkgs、test-install 包数断言、PACKAGES 职责表、README 双侧清单）——**接线动作在 T9 / T12 各自完成**, 本任务只做全量核对与查漏。
- 审计: `grep -q "plan-mode" scripts/test-parallel.sh` → 退出 0; `grep -q "flow-arbiter" scripts/test-parallel.sh` → 退出 0; `sh scripts/test-install.sh` → 退出 0; `pnpm run check:docs` → 退出 0。

**T14（阶段 5）全量收尾**

- 改动: 全仓联测与文档回写（README 双侧、PACKAGES、各新包 README）; 集成链路验证（flow-track 建树 → 顺序强制 → 推送 → 仲裁拦截）。
- 审计: `TEST_SCRIPT=check sh scripts/test-parallel.sh` → 退出 0; `TEST_SCRIPT=build sh scripts/test-parallel.sh` → 退出 0; `sh scripts/test-parallel.sh` → 退出 0（全量 test）; `pnpm run test:tui` → 退出 0; `pnpm run check:docs` → 退出 0; `sh scripts/test-install.sh` → 退出 0。

### 计划改动文件清单

#### task-engine 侧（节点基础工具增强）

- `task-engine/src/engine.ts`: `implement` / `execute` / `stop` 三入口各加**顺序强制校验**（仅当流程声明了强制依赖时启用: 前序兄弟未 done → 拒绝并打回指向本帧）。校验判定读帧 `deps` 与兄弟状态。
- `task-engine/src/engine-types.ts` / `types.ts`: 给流程声明带「顺序强制」标志的类型位; `ChildSpec` / `RootSpec` 增可选 `enforceOrder`。
- `task-engine/src/plugin.ts`（或新 `flow-service.ts`）: **编程服务面建树接口**——`composeFromNodes(parentId, nodes)`, **父帧可任意**（缺省 root): 向流程插件暴露可编程的「按节点数组建树」服务（内部 = 一次 `decompose` 传全部 children, 或新方法, 走既有双门禁）; 流程段可挂在任意 `needDecompose: true` 的待分解节点下。
- `task-engine/src/tools.ts` 或新 `inject-tools.ts`: **任务推送**——取出当前节点数据（title / spec / acceptance / 下一步 / 顺序提示）**交给 pin-note 动态保持**（`pinNotes.hold`）; 门槛 = 树非空且根未完成。
- `task-engine/tests/*`: 顺序强制校验（停 / 写 / 执行三入口 × 关 / 开两态）、编程建树接口、推送内容与门槛测试、与手动 `task_decompose` 等价性。
- 保留既有: `task_decompose` 等 `task_*` 工具不动（自由细化复杂任务 + 阶段内部再分解用, 决策项 5）。

#### flow-track 侧（流程定义方, 重构）

- `flow-track/src/stages.ts`: 保留为**八阶段流程定义**（节点数组: id / title / spec / acceptance / needDecompose / deps / 强制依赖声明）, 但不再作为「注入模板」, 改为建树输入。
- `flow-track/src/flow-start.ts`（新）或并入 tools: 把流程定义经 task-engine 节点工具落地建树（一次 `decompose` 挂全部节点到指定父帧, 父帧由挂载点决定）。
- `flow-track/src/tools.ts` / `inject.ts` / `index.ts`: `flow_start`（按流程定义建树; 仲裁未就绪时暂全放行, 阶段 4 起经仲裁拦截）; `renderStages` / `renderStatus` 树级注入**退役**（树级内容保持改走「flow-track 定内容 → task-engine 取当前节点 → pin-note 保持」, 见决策项 4.4）; 保留 `flow_record` / `flow_status` / `flow_remove` / `flow_rollback`（记录与合规）; 顺序策略阶段名来源改从流程定义读; `flow_enable` 并入流程仲裁插件（决策项 7 / 8, 不再自持唯一开关）。
- `flow-track/src/policy.ts` / `status.ts`: 随上述调整（阶段序取流程定义, 不再自持渲染树状态）。
- `flow-track/tests/*`: 随来源变更同步。

#### plan 插件侧（新独立插件, 与 flow-track 平级; 决策项 6）

- `plan-mode/`（新包）: 流程定义（探索 / 计划 / 实施三段, 各 `needDecompose: true`）+ 流程入口工具（如 `plan_start`; 仲裁未就绪时暂全放行, 阶段 4 起经拦截）; 内部调 task-engine 编程建树服务面; 随包接线（`package.json` / `cordis.patch.yml` / README / 根级包计数 40→41 与 `scripts/*` 枚举）。
- `plan-mode/tests/*`: 流程定义建树 + 入口工具测试。

#### 流程仲裁插件侧（新独立插件; 决策项 7 / 8）

- `flow-arbiter/`（新包）: 会话级「当前选中流程」状态（进程内内存, 不落盘）+ 模型侧 / 命令面**选择入口**（选中流程 / 取消）+ **入口工具层拦截（恒注册 + pre-execute 检查）**: 流程入口与选择工具装配期全部注册, 拦截在**流程入口执行前一刻**——只有被选中的流程插件入口（`flow_start` / `plan_start`）能真正初始化流程节点, 其它拒绝并说明; 未选中流程无法建树, 故无内容保持问题。冲突（同时选两个）拒绝或顶替（实现时定）。随包接线 + 根级包计数 41→42 与 `scripts/*` 枚举。
- `flow-arbiter/tests/*`: 选中 / 取消 / 唯一性 / pre-execute 入口拦截测试。

#### 根级

- `docs/PACKAGES.md`（相关包职责句）、`README` / `README.zh.md`（如需）、`flow-track/README.md`、`task-engine/README.md`、新包 README。
- `STATUS.md` 不动（用户择时更新）; `docs/host/` 不动。

### 明确不做

- 不做静态声明式模板文件登记（用户已裁定向流程定义 + 节点基础工具）。
- 不自研新引擎; 不改 task-engine 执行内核（状态机 / 门禁 / 验收 / 事件 / 查询）的既有语义（顺序强制是**新增可选能力**, 缺省关闭）。
- 不接取「自研 plan 模式」条目的完整机制设计（仅以 plan 三段验证节点基础工具通用性）。
- 不改 `STATUS.md`。

## 实现记录

### 阶段 1（task-engine 节点基础工具增强, 2026-11-15）

- T1（1a）`enforceOrder` 类型位: `types.ts` 的 `ChildSpec` / `Frame`、`engine-types.ts` 的 `RootSpec`、
  `plugin.ts` 的 `Config.root` 与 `normalizeRoot` 透传; `events.ts` 物化时把 `ChildSpec.enforceOrder`
  落到帧, `engine.ts:buildRootFrame` 把它带到根帧（根的子节点因此可按序强制）。
- T2（1b）顺序强制校验: 新增 `task-engine/src/order.ts`（`orderEnforced` / `blockingSiblings` /
  `orderFeedback` 三个纯函数, 判定口径 = 帧自己或父帧带标记）; `engine.ts` 的 `implement` / `execute` /
  `stop` 三入口在既有身份校验之后插入前序兄弟校验——命中即拒绝, 落一条 `plan/step-verdict`
  （打回指向本帧）, **不计重试、不改帧状态、不写产出**。
- T3（1c）`composeFromNodes(parentId = "root", nodes, enumeration?)`: `engine.ts` 新方法, 内部一次
  `decompose`（照过机械门禁 + 语义蕴含）; `plugin.ts` 的 `taskEngine` 服务面同步暴露该入口,
  供流程定义插件调用（父帧可任意, 不限于根）。
- T4（1d）任务推送: 新增 `task-engine/src/push.ts`——`currentFrame` 选当前节点（在途帧 → 就绪池候选 →
  首个 pending, 在途优先避免「正做 A 时推 B」）; `renderCurrentTask` 按决策项 4.1 输出 title / spec /
  验收摘要 / 下一步帧 id / 顺序提示（顺序未开启时不带该句）, 门槛 = 树非空且根未完成（决策项 4.3）。
  `plugin.ts` 经 `pinNotes.hold("task")` 登记（装配期试一次, 未就绪时由 `tools.ts` 新增的
  `beforeExecute` 补登记口在首个工具调用时重试; 卸载时注销）。task-engine 不自造注入策略,
  渲染与缓存影响归 pin-note。

## 偏差

- T4 审计命令落点调整: `grep "pinNotes"` 改指 `task-engine/src/plugin.ts`（登记在装配层）, 另加
  `grep "renderCurrentTask" task-engine/src/push.ts` 守住取数与渲染所在文件; 其余审计命令按原样可用。
- T2 的实现把三入口共用的判定抽到新文件 `order.ts`（原计划只写「`engine.ts` 三入口各加校验」）:
  任务推送也复用同一判定, 抽纯函数避免两处口径漂移。

## 测试与证据

- `TEST_SCRIPT=check sh scripts/test-parallel.sh task-engine` → `OK task-engine`（退出 0）。
- `TEST_SCRIPT=build sh scripts/test-parallel.sh task-engine` → `OK task-engine`（退出 0）。
- `pnpm -C task-engine run test` → 201 例全过（既有 182 → 201, 新增 19 例:
  `tests/order.test.ts` 8 例 / `tests/compose.test.ts` 4 例 / `tests/push.test.ts` 7 例）。
- `pnpm run check`（全仓）→ 全部包 OK。
- 机械审计: `enforceOrder` 见 `task-engine/src/{types,engine-types,engine,events,plugin}.ts`;
  `composeFromNodes` 见 `task-engine/src/{engine,plugin}.ts`; `pinNotes` / `renderCurrentTask` 见
  `task-engine/src/plugin.ts` 与 `task-engine/src/push.ts`。

## 收尾

（待补。）
