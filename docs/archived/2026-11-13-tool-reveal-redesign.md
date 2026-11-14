# 工具揭示架构重设计（接取条目: docs/BACKLOG.md「工具揭示架构重设计（缓存友好）」）

状态: 已完成（主 profile 待人工安装） 开启: 2026-11-13 关闭: 2026-11-14
本文件是本任务的追踪文档与文档改动位置; 开工前只改文档, 不改代码.

## 目标

- 首次请求的 `request/header` 工具声明在会话内保持字节稳定, 揭示不重建头部.
- 非初始且不在条件工具白名单内的工具在模型上下文里只有短定义; 完整说明与完整 schema 在揭示后按需投递.
- 受管工具的未揭示调用由门禁拒绝, 不靠「模型看不见」防守.
- 接管状态下, 白名单外的条件工具在模型面完全不可见: 无声明、无描述、无 schema, 也不进咨询索引、揭示与 pinNotes 投递; 自检失败、`restrict` 失败或 `schemas` 残留时整体不接管, 该保证不生效.

## 现状与问题

### 现有机制

- `tool-surface` 在注册前把定义换成短说明与宽松占位, 全文与完整 schema 收进进程内 catalog; 严格校验在派发前做 (`tool-surface/src/definition.ts`).
- `tool-consult` 在 `agent/created` 用 `tools.restrict({allow})` 遮罩; allow = 初始集 + 已授权 + resident (`tool-consult/src/index.ts:301-334`).
- 揭示改两块: 遮罩 allow（影响 header 的 tools 集合）与 `pinNotes.hold("revealed-tools")` 正文（追加消息）.
- 收回在 `turn/end` 重设遮罩; 调用由 `tools/pre-execute` 的 deny 守.

### 现有断点

1. 主 profile 没有 `@dsh-toolset/tool-surface`: `ctx.get("toolSurface")` 为空, resident 为空, 任何非初始工具揭示都改 allow.
2. `edit` / `todo_write` 等宿主工具不在 catalog, 揭示它们必改 allow.
3. turn 档收回让 allow 缩回, header 再变一次.

结论: 断点一半来自部署缺口, 一半来自「用遮罩表达揭示」这一机制本身.

## 已定方案

### 请求面

- 首请求 `tools` = 初始 14 个完整定义（已含白名单 web 2）+ 其他白名单内条件工具 + 其余可管理工具的短定义 + `consult_tools`; 在固定路由与固定就绪状态下之后不再变化.
- 短定义由 `wrapToolDefinition` 生成; 全文进 catalog, 派发前严格校验.
- 揭示不新增、不删除、不重排声明; 只追加 pinNotes 正文.
- 模型看得到 header 里全部工具名; 初始 14 与白名单内条件工具带完整定义, 其余只有一句短说明; 短说明工具的完整描述与 schema 只在揭示后投递.
- 条件工具白名单: `allowedWhenTools` 缺省 `web_search` / `web_fetch`; 只有名单内的条件工具保留 `when` 与完整定义. 名单外的一律静态 deny, 模型面完全没有名字、描述与 schema; 新增放行项只改这一项配置. readiness 波动不纳入防御, 也不在会话开始时冻结 web 两件.

### 注册与门禁

- `agent/created` 先识别条件工具（`executable(name) === undefined`）, 再算 `denied` = 全部条件工具减去 `allowedWhenTools`.
- 白名单外的条件工具一律 `restrict({ deny })`, 从该 agent 的模型面彻底移除; 白名单内的保持宿主原样（不 shadow / 不 deny / 不包装）, 保留 `when` 与完整定义.
- 非初始、非条件工具在 agent 作用域 shadow; 宿主工具先经 `wrapToolDefinition`.
- 初始 14 个不 shadow; `consult_tools` 注册在 agent 自身层.
- 顺序: 枚举全局工具 → 识别条件工具 → 算 deny → `restrict({deny})` → 跳过初始 / 条件工具 / `consult_tools` 后按名排序注册 shadow → 注册 `consult_tools` → 用全局定义 + 本地 catalog 重建 matcher（排除 deny）.
- shadow 失败的工具记入 managed 集合并告警; 未授权仍拒绝, 揭示后放行.
- 晚注册的非条件工具不进 managed 集合, 默认放行; 以完整定义出现属已知边界. 晚注册的条件工具由 `tools/change` 重算 deny.
- `tools/pre-execute`: managed 集合成员未授权即拒绝 (`TOOL_NOT_REVEALED`); 初始 14、白名单内条件工具、`consult_tools`、未纳管（晚注册非条件工具）放行.
- 自检失败（catalog 不可共享: 服务未挂载、多实例或已知包装工具缺项）: 整体不接管, 不注册 `consult_tools` / 不 shadow / 不 deny / 不 hold / 不挂门禁 / 不注册监听, 写一条告警说明原因（仅一次）, 工具面回退宿主默认; 该状态下白名单不生效.
- `enabled: false` 整体关闭: 不 shadow、不 deny、不投递.

### 揭示与收回

- 揭示 = 记入 session 授权集合 + pinNotes 按工具分 key 投递全文（描述与 `input_schema`）; key 用 `revealed:<工具名>`, 每个工具一条, 不重投已揭示全集.
- 取消 turn 档: 无 `revealScope` / `scope` / `pin` / `maxRevealed` / `maxPinned` / `ttlTurns`; 运行期无收回, 授权随会话结束释放.
- deny 集合不进检索索引、按名咨询、揭示与 hold; 已授权的名字后来被 deny 时, 投递返回 undefined.
- 不依赖 `deferLoading` / `toolUpdate` / developer 增补消息 / `headerSeq`.
- 全文查找直接 import `@dsh-toolset/tool-surface` 的 `lookupSurface` / `wrapToolDefinition`; `ctx.get("toolSurface")` 只用于启动自检（失败时整体不接管, 见 C2）.

### 缓存效果

- 固定路由与固定就绪状态下, system 与 tools 前缀从首请求起字节不变; 揭示只追加消息.

## 决策记录

| 决策 | 最终值 | 理由 |
| --- | --- | --- |
| 1 目标形态 | 全量短清单常驻 | 不依赖路由能力, header 稳定 |
| 2 初始面 | 14 个 | 高频入口即时, 其余按需揭示 |
| 3 揭示投递 | 短定义 + pinNotes | header 小, 复用压缩补投 |
| 4 调用门禁 | 保留 deny | 未揭示调用必须被拒 |
| 5 turn 档 | 取消 | 运行期无收回, 简化配置 |
| 6 路由能力判定 | 作废 | 不依赖 `toolUpdate` |
| 7 网关前置验证 | 作废 | 同上 |
| 8 条件工具白名单 | `allowedWhenTools` 缺省 web 2 | 新条件工具默认隐藏, 放行只加名 |
| 9 子代理 | 不遮蔽 / 不 deny | 已裁定, 维持 `applyTo: roots` |
| 10 白名单内工具 | 不做处理 | 保持宿主原样, 不 shadow / deny / 包装 |
| 11 静态 deny 失败或残留 | 整体不接管 | 与自检失败同口径, 保证仅覆盖成功接管 |

初始 14: bash / read / glob / grep / ask_user_question / skill / write / edit / read_image / web_search / web_fetch / job_output / job_list / job_kill.
`read_image` 仅在 attachments 服务挂载时注册; 本 profile 已挂 `attachment-local`.
不开放: `hash_read` / `hash_edit`（锚点编辑, 成对按需咨询）、`todo_write`、子代理 6 个、`workflow`、goal 3 个、`working_directory`.

### 已排除的路线

延迟声明（`deferLoading`）加 `tool-addition` 激活: 只有路由声明 `toolUpdate` 时生效; 当前 `tg` / `ds41f` 未声明, 宿主会摊平声明并丢弃更新消息, 隐藏工具反而全量可见. 因此不采用, 决策 6 / 7 一并作废.

## 宿主依据（dsh `0.2.2-rc.1`）

- 作用域注册按名覆盖全局, 视图只保留一份定义 (`tools/src/index.ts:199-227`); 作用域注册不受 restrict 影响 (`:219-225`).
- 每步 admitted 集合只过滤可见性与 `when`, 不检查激活 (`tools/src/index.ts:264-296`); 派发按 toolSet 查定义 (`tools/src/pipeline.ts:104-127`). 所以门禁必须由插件提供.
- 工具声明顺序由全局注册顺序决定; header 每请求重发.
- `deferLoading` / `toolUpdate` 细节仅作背景, 不进入实现.

## 计划改动文件清单

| 文件 | 改动 |
| --- | --- |
| `tool-consult/package.json` + `pnpm-lock.yaml` | 新增 `@dsh-toolset/tool-surface` 依赖（`link:../tool-surface`）; lockfile 的 `tool-consult` importer 补登 |
| `tool-consult/src/config.ts` | 删 `revealScope` / `maskMode` / `maxRevealed` / `maxPinned` / `ttlTurns` / `disabledWhenTools`; 新增 `allowedWhenTools`（缺省 `web_search` / `web_fetch`）; 初始集改 14 个; 旧键只记录供告警 |
| `tool-consult/src/state.ts` | 授权状态收成只增集合; 删 turn 档 / pin / LRU / TTL |
| `tool-consult/src/degrade.ts` | 失败分类改为 shadow 注册 / 白名单 deny / catalog 自检; 删遮罩漂移与回读校验 |
| `tool-consult/src/index.ts` | 自检、白名单 deny、按名 shadow、索引 / 揭示 / hold 过滤、managed 门禁、生命周期与热重载 |
| `tool-consult/src/tool.ts` | 删 `scope` / `pin`; `isCallable` 对 denied 恒 false; 文案改「本会话内有效」; 配额只报已揭示数 |
| `tool-consult/cordis.patch.yml` | 配置键同步（删旧键、初始 14、白名单） |
| `tool-consult/tests/*` | 假宿主补作用域 shadow / `definitions` / `get` / `executable` / `when` / `tools/change`; 单测与集成覆盖白名单、deny、索引与揭示隔离 |
| `tool-surface/src/definition.ts` + `src/index.ts` | 导出 `isWrappedDefinition(def)`（读 `WRAPPED` 符号） |
| `tool-surface/tests/*` | 判定用例 |
| `tool-surface/README.md` | 导出面补一行 |
| `tool-consult/README.md` | 重写能力 / 配置 / 边界 / 注入通道（白名单、默认隐藏、放行方式） |
| `tool-consult/package.json` | `description` 改新机制 |
| `e2e/tool-consult.test.ts` + `e2e/tool-surface.test.ts` | 新断言（含条件工具白名单）; 改用 `tool-surface` 先挂的启动顺序 |
| `README.md` / `README.zh.md` | `tool-consult` 行、目录注释; `tool-surface` 行补导出 |
| `AGENTS.md` | 插件清单里 `tool-consult` 的一句改新机制 |
| `docs/BACKLOG.md` / 本文件 | 条目同步; 关闭后归档 |

## 实施计划

### 前提（已核的宿主与部署事实）

- 完整定义可枚举: `tools.definitions()` 给全局视图的完整定义（含 `execute` / `output`）, `tools.get(name)` 按名取; `tools.schemas()` 只是模型侧投影, 不能用来 shadow.
- 条件工具可识别: `tools.executable(name)` 不带 `toolSet` 时, 带 `when` 的注册返回 undefined; shadow 会丢掉 `when`, 所以条件工具不 shadow; 白名单外的由静态 deny 隐藏, 白名单内的保持宿主原样（不 shadow / 不 deny / 不包装）.
- shadow 语义: `agent.ctx.tools.register(def)` 按名覆盖全局定义, 作用域注册不受 `restrict` 约束; 派发按该 step 的 admitted 视图取名, 被调用的就是 shadow 的 `execute`.
- 静态隐藏: `agent.ctx.tools.restrict({ deny })` 只挡「全部条件工具减去 `allowedWhenTools`」; 名单从全局定义实时计算; 揭示路径不再调用 `restrict`.
- 部署顺序: profile 的 `dsh.profile.bundles` 里 `tool-surface` 必须早于 `tool-consult`; `scripts/install.sh` 的 `canonical_pkgs` 已是此序（`tool-surface` 第 3 位、`tool-consult` 第 35 位）, 只需 `--sync`.
- catalog 一致性: shadow 与揭示共用同一个 `@dsh-toolset/tool-surface` 模块实例（`link:../tool-surface`, Node 默认按 realpath 解析）; 自检用服务面 `list()` 与本地 `listSurface()` 比对.

### 阶段 A: 依赖与包装层契约

- A1 `tool-consult` 依赖: `package.json` 的 `dependencies` 加 `"@dsh-toolset/tool-surface": "link:../tool-surface"`; `pnpm-lock.yaml` 的 `tool-consult` importer 补同一条（先试 `pnpm install --lockfile-only`, diff 只允许这一条）. 验收: 先 `pnpm -C tool-surface run build`, 再 `pnpm -C tool-consult run check` 能解析该包.
- A2 `tool-surface` 导出判定: `definition.ts` 导出 `isWrappedDefinition(def)`（读现有 `WRAPPED` 符号, 只看 own property）, `index.ts` 再导出; 不改短说明 / 占位文本 / catalog 行为. 验收: 包装后 true、原始定义 false、重复包装不重复入 catalog.

### 阶段 B: 配置与授权状态

- B1 `config.ts`: 删 `RevealScope` / `MaskMode` / `revealScope` / `maskMode` / `maxRevealed` / `maxPinned` / `ttlTurns` / `disabledWhenTools` 及 `ResolvedConfig` 对应字段; 新增 `allowedWhenTools`（缺省 `web_search` / `web_fetch`）; `DEFAULT_INITIAL_TOOLS` 换决策 2 的 14 个（顺序: `bash` / `read` / `glob` / `grep` / `ask_user_question` / `skill` / `write` / `edit` / `read_image` / `web_search` / `web_fetch` / `job_output` / `job_list` / `job_kill`）; 旧键命中时记入 `ignoredKeys`, 接线层每次 apply 告警一次; 初始集里的非白名单条件工具告警并以隐藏为准; 保留 `expandInitialTools` / `matchGlob` / `isSubagentSession` / `applyTo` / `maxResults` / `audit`.
- B2 `state.ts`: `AgentGrants` 收成 `RevealSet`（`grant(name)` / `has` / `names()` / `size()` / `forget(name)`）, 删 scope / pin / turn / LRU / TTL / `switchScope` / `converge`; 重复揭示返回 `already`. 验收: 只增不减、按运行时隔离.

### 阶段 C: 注册、shadow 与门禁

- C1 宿主结构面: `HostTools` 补 `definitions` / `get` / `executable`; `HostToolDefinition` 补 `execute` / `output` / `timeoutMs`; `AgentRuntime` 增 `initialNames` / `conditional` / `denied` / `managed` / `shadowDisposers` / `denyDisposer` / `warnedOnce`, 保留 `listeners`, 删 `masked` / `maskDisposer` / `appliedAllow` / `appliedHidden` / `wrapped` / `currentTurn`; hold 登记放插件级 `Map<工具名, disposer>`（key 全局唯一、provider 按 sessionId 取运行时）, 不进 `AgentRuntime`.
- C2 catalog 自检: `apply` 里一次; 条件 = `ctx.get("toolSurface")` 存在 + 服务面名集与本地 `listSurface()` 一致 + 所有「已包装的全局定义」在本地 `lookupSurface` 有项（用 `isWrappedDefinition` 判定）. 任一不满足: 写一条 warn, `apply` 直接返回, 不注册 `consult_tools` / 不 shadow / 不 deny / 不 hold / 不注册监听; 工具面回退宿主默认.
- C3 `setupAgent` 顺序: 判 `shouldManage` → 展开初始集（未命中的模式告警）→ 枚举全局定义 → 算 `conditional`（`executable(name) === undefined`）与 `denied`（全部条件工具减去 `allowedWhenTools`）→ `restrict({ deny: denied })`（空集跳过; 失败则撤已做的 deny（若有）, 告警一次, 本 agent 不接管）→ 核对 `schemas(agent)` 不含 denied 名（残留则撤 deny, 告警一次, 本 agent 不接管）→ 按名排序 shadow: 跳过初始 / 条件工具 / `consult_tools` → `wrapToolDefinition(def)` → `agent.ctx.tools.register` → 记 disposer 与 managed（注册失败也记 managed, 并 warn）→ 注册 `consult_tools` → 用全局定义 + 本地 catalog 重建 matcher（排除 denied）→ 挂 agent 级监听.
- C4 门禁: `tools/pre-execute` 里, 名非字符串放行; `managed.has(name) && !grants.has(name)` → `{ kind: "deny", reason: notRevealedReason(name), info: { name: TOOL_NOT_REVEALED, code } }`; 初始集、白名单内条件工具、`consult_tools`、未纳管（晚注册非条件工具）放行.
- C5 生命周期: `agent/disposed` 与插件卸载撤 shadow / consult / 静态 deny / agent 监听; 插件卸载还要撤全局监听与全部 hold; `tools/change` 重算 `conditional` / `denied`, 集合变化时替换 deny（防重入）并重建 matcher 与初始集展开; 替换失败或核对残留则移除该 agent 的运行时（hold provider 自然返回 undefined）, 撤 shadow / consult / deny / agent 监听, 告警一次, 回退宿主默认; 不给新工具补 shadow; 重复 `apply`（配置热重载）先撤旧注册（含全局监听与 hold）再重建, 保留授权集合, 新白名单项即时生效.

### 阶段 D: 揭示与投递

- D1 `tool.ts`: 删 `scope` / `pin` 参数与相关文案; `ConsultRuntime` 改 `isCallable(name)` / `grantedNames()` / `reveal(names)`; `isCallable` 对 denied 恒 false; 结果文案区分「初始工具面」与「本会话已揭示」; `renderQuota` 只报已揭示数量（会话内只增不减）; 预览（`reveal: false`）不写授权.
- D2 每工具投递: 揭示时 `ensureHold(name)`: 首次对某工具登记 `pinNotes.hold("revealed:" + name, provider)`; provider 按 `context.sessionId` 找运行时, 未授权或 denied 返回 undefined, 已授权返回该工具全文（`lookupSurface(name)` 的 `description` + `input_schema`, JSON 紧凑）; catalog 缺项时退回全局定义; 插件卸载释放全部 hold; `pinNotes` 缺席只 warn 一次, 揭示仍写授权.
- D3 揭示动作不变量: `reveal` 只 `grant` + `ensureHold` + 返回结果; **不**调用 `tools.register` / `tools.restrict` / 改 shadow 集合. 这条用单测与 e2e 双向守（揭示前后 `tools.schemas(agent)` 深相等）.
- D4 白名单外条件工具不可揭示: matcher 不收录, 按名查询按未知处理, `reveal` 拒绝, hold 不投递; 单测与 e2e 双向守.

### 阶段 E: 单测与集成

- E1 `tests/fake-host.ts`: 加每代理作用域注册表（shadow 覆盖全局）、`definitions` / `get` / `executable` / `when`、deny 在视图里生效、注册与撤销广播 `tools/change`; 保留 `restrictCalls` 供静态 deny 断言, 可注入 `restrict` 失败与 `schemas` 残留; `assemble.ts` 的 `STANDARD_SCHEMAS` 换 14 个初始 + 宿主与插件工具各若干, 含条件工具.
- E2 单元: 重写 `config` / `state` / `degrade` / `tool` / `main` / `index`; `dual-track.test.ts` 改 `shadow.test.ts`; `revealed-hold.test.ts` 改每工具键与多会话隔离; `matcher` / `retrieval` / `aliases` / `tokenize` 只改受初始集与全文语料影响的断言; 删除 maskMode / denylist / turn / LRU / 回读校验用例; 新增白名单增删、默认隐藏、索引与揭示隔离用例.
- E3 集成: `tests/integration/plugin.test.ts` 按新语义重写: shadow 集合与顺序、初始不 shadow、白名单外条件工具静态 deny 且 `schemas` 无项、白名单内条件工具不 shadow、`consult_tools` 最后、未揭示 deny、揭示不改 `schemas`、每工具 hold、索引 / 按名咨询 / 揭示 / hold 不泄漏 denied、`tools/change` 补 deny; 自检失败 / `restrict` 失败 / 残留零注册; change 重算失败该 agent 回退宿主默认.

### 阶段 F: e2e

- F1 `e2e/tool-consult.test.ts`: 改 `bootPackage("tool-surface", { extraPackages: ["tool-consult", "fs-digest"] })`（`tool-surface` 必须先挂）; boot 后注册一个带 `when` 的测试工具, 断言默认不在 `schemas` 与检索中; 揭示前后 `ctx.tools.schemas(agent)` 深相等; `fs_digest` 的注册定义是短说明 + 宽松占位; 未揭示调用 `error.info.code === "TOOL_NOT_REVEALED"`; 揭示后可调用; 第二个代理仍被拒.
- F2 `e2e/tool-surface.test.ts`: 两处 `bootPackage` 同改启动顺序; 保留已有「常驻 + 拒绝 + INVALID_ARGS」断言; 补一条揭示前后 `schemas` 不变与条件工具默认不可见.

### 阶段 G: 文档与配置

- G1 `tool-consult/README.md`: 重写「能力 / 配置 / 边界 / 注入通道」: 全量短清单、14 初始、shadow + 门禁、每工具 hold、`allowedWhenTools` 白名单（缺省 web 2, 放行只加名）、白名单内保持宿主原样、晚注册边界; 重新挂载条件工具前先加白名单（如 plan-mode 的 `exit_plan_mode`、Team 的 `team_task_*`）.
- G2 `tool-consult/cordis.patch.yml`: 删旧键; `initialTools` 换 14 个; 新增 `allowedWhenTools`（缺省 `web_search` / `web_fetch`）; 保留 `applyTo` / `maxResults` / `audit`.
- G3 `tool-consult/package.json` 的 `description`、根 `README.md` / `README.zh.md` 的 `tool-consult` 行与目录注释、`AGENTS.md` 的插件清单一句, 全部改新机制（含条件工具白名单）; `tool-surface` 双侧 README 补 `isWrappedDefinition`.
- G4 核一遍仓库里对 `revealScope` / `maskMode` / `turn 档` 的描述, 只改仍描述现状的段落; 历史归档与 `docs/ARCHITECTURE-REUSE.md` 的审计快照不动.

### 阶段 H: 验证与部署

- H1 包级: `pnpm -C tool-surface run check` / `build` / `test`; `pnpm -C tool-consult run check` / `build` / `test` / `test:integration`; 受影响 e2e 单跑 `node --experimental-transform-types --test e2e/tool-consult.test.ts e2e/tool-surface.test.ts`.
- H2 全量: `pnpm run check` / `build` / `test` / `check:docs`; 失败按包定位, 不放宽. 全量 e2e（`pnpm run test:e2e`）按既有基线判（`e2e/ponytail.test.ts` 计划废弃, 仍红）, 本次两条必须绿.
- H3 部署: `scripts/install.sh --profile fff --sync`; 核对 `~/.dsh/profiles/fff/node_modules/@dsh-toolset/tool-surface` 存在、`tool-consult` 的依赖 realpath 与它一致、`dsh.profile.bundles` 里 `tool-surface` 在 `tool-consult` 之前.
- H4 真机: 新开会话跑一轮, 解压 `~/.dsh/sessions/<project>/<session>/session.v4.jsonl.zstd` 取首条 `request/header`: tools = 14 完整（含白名单 web 2）+ 其他白名单内条件工具 + 其余短定义 + `consult_tools`; 后续 header 的 `tools` 逐字节相同（白名单内 `when` 就绪变化除外）; 非初始、非白名单工具说明为短句; header 不含白名单外条件工具名; 未揭示调用被拒（`TOOL_NOT_REVEALED`）; 揭示后可调用. 证据（数量 / 对比结果 / denied 名单）回写本文件.

### 阶段 I: 关闭

- I1 `docs/BACKLOG.md`: 条目移入 §1 已完成索引, 从 §2 删除; 本文件移入 `docs/archived/`; 状态记录补实施与验证证据; 按流程在实现后 / 测试后 / 关闭后各询问一次是否提交.

## 验证计划

阶段 H 是执行清单, 本节是判定口径:

- 单测 / 集成: 新机制的每条不变量都有用例; 揭示不改 `schemas`; 未揭示 deny; 每工具 hold; 白名单外条件工具在声明 / 描述 / schema / 索引 / 揭示 / hold 均不可得; 自检失败、`restrict` 失败或 `schemas` 残留均不接管. 白名单: 缺省隐藏全部白名单外条件工具, 增加名字后可见并保留 `when`, 删除后重新隐藏.
- e2e: 真实宿主下同上; `tool-surface` 先挂; 第二代理隔离; 条件工具默认不可见.
- 部署: profile 单实例; bundle 顺序; 自检通过（无自检失败告警）.
- 真机: 首条 header 与后续 header 的 tools 字节一致; 短定义可读; 拒绝与揭示闭环.
- 全量: 39 包 check / build / test 与 check:docs 全绿; 人工确认后提交.

## 风险与边界

- 非初始、非条件工具的短定义全部常驻 header, 每请求固定成本随工具数增长; 短说明长度要控制.
- 宿主工具 shadow 后模型只看到一句话, 细节必须咨询; 有意取舍.
- 带 `when` 的工具可能改变 header; 白名单内（缺省 `web_search` / `web_fetch`）保持宿主原样, 会随 readiness 进出; 白名单外一律 deny, 完全不可见.
- 晚注册的非条件工具（MCP 等）本次不补 shadow: 不进 managed 集合, 默认放行; 晚注册的条件工具由 `tools/change` 重算 deny（白名单外隐藏）.
- 子代理（`applyTo: roots`）已裁定不遮蔽 / 不 deny; 条件工具可见性保持宿主默认; 不纳入本次范围.
- shadow 注册失败按 managed 未授权处理, 宁可拒绝也不绕过门禁.
- catalog 自检失败、`restrict` 失败或 `schemas` 残留时整体不接管并告警一次, 工具面回退宿主默认; 这是有意选择.
- 条件工具检测只覆盖全局定义; agent 作用域注册的同名 / 条件工具不受 `restrict` 约束; 本仓当前无此用法, 若后续引入需另加处理.
- 包装宿主工具改变其参数默认值处理, 需逐个验收.
- pin-note 缺席时只能投递短定义, 告警里写明.
- `restrict` 仅用于静态 deny 表, 不参与揭示.
- 短说明里的指向名沿用 `tool_consult`（各包 `summary` 与测试已固定）, 本次不改; 实际入口 `consult_tools` 在 header 里可见. 若要统一另开条目.
- 初始集若被用户改成已包装的工具, 该工具没有完整参数 schema 可投递; setup 时告警, 不阻断. 初始集若含白名单外条件工具, 以隐藏为准并告警.
- 本保证只覆盖工具面与咨询 / 揭示通道; 其他插件写进系统提示的静态工具名不在清理范围.
- 白名单外条件工具若在 deny 生效前已被模型看到（旧会话 / 热重载）, 历史消息无法撤回; 新会话不受影响.

## 实现与验证

### 实现

- 提交 `cc8d4ee1`（`feat(tool-consult): 重构为全量短清单与按需揭示`）: 阶段 A 至 G 的代码 / 测试 / 文档 / 配置; 未改计划外文件.
- `tool-surface`: 导出 `isWrappedDefinition`; `tool-consult` 新增 link 依赖; 配置、授权集合、失败分类、接线、咨询工具与测试按新机制重写.
- 历史测试 `dual-track.test.ts` 由 `shadow.test.ts` 取代.

### 验证

- 包级: `tool-surface` check / build / test 全绿（14 例）; `tool-consult` check / build / test 全绿（100 例）+ integration 全绿（10 例）.
- 全量: 39 包 `pnpm run check` / `build` / `test` 全绿; `check:docs` 通过（120 篇 Markdown / 970 个 .ts, 0 错误 0 警告）.
- e2e: `e2e/tool-consult.test.ts` 与 `e2e/tool-surface.test.ts` 3 例全绿（`tool-surface` 先挂）; 全量 e2e 40 / 41, 唯一红为计划废弃的 `e2e/ponytail.test.ts`.
- 部署: 按用户要求不动主 profile; 已用 `scripts/install.sh --profile fff-test --mode link --no-test-profile --sync --skip-dsh --skip-build` 更新伴随 profile; `tool-surface` 与 `tool-consult` 的 realpath 均指向仓库, bundle 顺序 `tool-surface` 第 51 行先于 `tool-consult` 第 83 行.
- 真机 header: 伴随 profile 两个独立会话各 78 个工具, `tools` 规范化 JSON 的 SHA-256 均为 `117dc9928e8b5531`（字节一致）; 14 个完整定义 = 13 个已就绪初始工具 + `consult_tools`（`web_search` 因 readiness 未就绪缺席）; 64 个短定义; `fs_digest` 短说明 82 字符, `hash_read` 108 字符; `team_task_list` / `exit_plan_mode` / `propose_action` 均不在 header.
- 机读复核: 短定义满足 `parameters.additionalProperties === true` 且 `properties === {}`; 白名单内 `web_fetch` 保持完整定义.
- 未验证: 伴随 profile 的 `tg` provider 缺 `TOLLGATE_API_KEY`（`MISSING_CREDENTIAL`）, 因此真机模型未走完「先拒 / 揭示 / 再调」闭环; 该闭环由 e2e 真实宿主用例覆盖（揭示前后 `schemas` 深相等、未揭示 `TOOL_NOT_REVEALED`、揭示后放行）.

### 遗留

- 主 profile `fff` 未安装; 由人工执行 `scripts/install.sh --profile fff --sync` 后再做一次带凭据的会话验收.
- 短说明指向名仍是 `tool_consult`; 实际入口 `consult_tools` 已在 header 可见, 统一命名另开条目.

## 状态记录

- 2026-11-13: 接取条目; 完成现状复核与宿主能力调研.
- 2026-11-13: 决策定稿; 放弃延迟声明路线, 改全量短清单.
- 2026-11-13: 按审阅修订并整理文档; 待开工.
- 2026-11-13: 按决策项细化实施计划（阶段 A 至 I）; 待开工.
- 2026-11-13: 条件工具改为 `allowedWhenTools` 白名单; 白名单外一律静态 deny, 并从索引 / 揭示 / hold 剔除; 待开工.
- 2026-11-13: 复审白名单文案, 修正初始 / 条件工具的短定义边界与部署注意; 待开工.
- 2026-11-13: 按既定裁定回退自检失败为整体不接管; 子代理不遮蔽, 白名单内工具不做处理; 待开工.
- 2026-11-13: 按 A 口径将 `restrict` 失败 / `schemas` 残留与自检失败统一为整体不接管; 待开工.
- 2026-11-14: 阶段 A 至 G 实现完成; 提交 `cc8d4ee1`.
- 2026-11-14: 包级 / 全量 check / build / test 与 check:docs 全绿; 两条工具 e2e 全绿; 全量 e2e 唯一红为计划废弃的 ponytail.
- 2026-11-14: 伴随 fff-test 软链接 profile 已同步; 两个真实会话 header 字节一致; 主 profile 按用户要求留待人工安装.
