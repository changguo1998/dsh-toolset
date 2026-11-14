# 工具揭示架构重设计（接取条目: docs/BACKLOG.md「工具揭示架构重设计（缓存友好）」）

状态: 规划（决策已定, 待开工） 开启: 2026-11-13 关闭:
本文件是本任务的追踪文档与文档改动位置; 开工前只改文档, 不改代码.

## 目标

- 首次请求的 `request/header` 工具声明在会话内保持字节稳定, 揭示不重建头部.
- 非初始工具在模型上下文里只有短定义; 完整说明与完整 schema 在揭示后按需投递.
- 受管工具的未揭示调用由门禁拒绝, 不靠「模型看不见」防守.

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

- 首请求 `tools` = 初始 14 个完整定义 + 其余可管理工具的短定义（名字、一句话、宽松占位）+ `consult_tools`; 在固定路由与固定就绪状态下之后不再变化.
- 短定义由 `wrapToolDefinition` 生成; 全文进 catalog, 派发前严格校验.
- 揭示不新增、不删除、不重排声明; 只追加 pinNotes 正文.
- 模型看得到当前 header 里全部工具名与一句短说明; 完整说明与 schema 只在揭示后投递.
- 条件工具: 仅 `web_search` / `web_fetch` 允许带 `when`; 其余带 `when` 的工具不挂载或列入 `disabledWhenTools`. 该约束由部署与人工保证; readiness 波动不纳入防御, 也不在会话开始时冻结 web 两件.

### 注册与门禁

- `agent/created` 枚举全部工具, 对「非初始且不在 `disabledWhenTools`」的工具在 agent 作用域 shadow; 宿主工具先经 `wrapToolDefinition`.
- `disabledWhenTools` 必须从 shadow 枚举排除（作用域注册豁免 restrict）, 只用静态 `restrict({ deny: 已知交集 })` 隐藏.
- 初始 14 个不 shadow; `consult_tools` 注册在 agent 自身层.
- 顺序: 枚举全局工具 → 跳过初始 / disabled / `consult_tools` → 按名排序注册 shadow → 注册 `consult_tools` → 构建 matcher.
- shadow 失败的工具记入 managed 集合并告警; 未授权仍拒绝, 揭示后放行.
- 晚注册工具不进 managed 集合, 默认放行; 以完整定义出现属已知边界.
- `tools/pre-execute`: managed 集合成员未授权即拒绝 (`TOOL_NOT_REVEALED`); 初始 14 与 `consult_tools` 放行.
- 自检失败（`tool-surface` 的 catalog 不可共享: 服务未挂载、多实例或已知包装工具缺项）时整体不接管: 不注册 `consult_tools`、不 shadow、不 deny, 并写一条告警说明原因（仅一次）, 工具面回退宿主默认.
- `enabled: false` 整体关闭: 不 shadow、不 deny、不投递.

### 揭示与收回

- 揭示 = 记入 session 授权集合 + pinNotes 按工具分 key 投递全文（描述与 `input_schema`）; key 用 `revealed:<工具名>`, 每个工具一条, 不重投已揭示全集.
- 取消 turn 档: 无 `revealScope` / `scope` / `pin` / `maxRevealed` / `maxPinned` / `ttlTurns`; 运行期无收回, 授权随会话结束释放.
- 不依赖 `deferLoading` / `toolUpdate` / developer 增补消息 / `headerSeq`.
- 全文查找直接 import `@dsh-toolset/tool-surface` 的 `lookupSurface` / `wrapToolDefinition`; `ctx.get("toolSurface")` 只作兼容保留.

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
| `tool-consult/src/config.ts` | 删 `revealScope` / `maxRevealed` / `maxPinned` / `ttlTurns` / `maskMode`; `initialTools` 缺省改为 14 个; 凡带 `when` 的非 web 工具必须不挂载或列入 `disabledWhenTools` |
| `tool-consult/src/index.ts` | `agent/created` 由遮罩改为 shadow 非初始且非 disabled 的工具（宿主工具经 `wrapToolDefinition`）; 移除 resident / applyMask / turn 收敛; `pre-execute` 门禁改 managed 集合; `disabledWhenTools` 改静态 deny; matcher 在 shadow 之后构建; pinNotes 改每工具一个 key; 启动自检 catalog 可共享性失败时告警一次并整体不接管 |
| `tool-consult/package.json` + `pnpm-lock.yaml` | 新增 `@dsh-toolset/tool-surface` 依赖（`link:../tool-surface`）; lockfile importer 手工补登 |
| `tool-consult/src/state.ts` | 删除 turn 档字段（`turnGrants` / `pinned` / TTL）; 新增 managed 集合与每工具 hold 的 disposer |
| `tool-consult/src/tool.ts` | 删 `scope` / `pin` 参数与 turn 文案; 揭示只写 session |
| `tool-consult/src/degrade.ts` | 分类改为 shadow 注册失败 / 包装失败 / 同名冲突; 保留静态 deny 失败 |
| `tool-consult/tests/*` | shadow 跳过 disabled、短定义、header 不变、managed 门禁、静态 deny、无 turn 档、每工具 hold、自检失败告警与不接管 |
| `e2e/tool-consult.test.ts` | 断言揭示前后 `request/header` 的 tools 深度相等; 无新增开发者消息; 揭示后可调用, 未揭示被拒 |
| `tool-consult/README.md` | 新机制、`when` 例外、边界 |
| `docs/BACKLOG.md` | 条目描述同步; 关闭后移入已完成索引 |
| 本文件 | 关闭后移入 `docs/archived/` |

## 验证计划

- 单测: shadow 后非初始工具为短定义; disabled 不出现在 shadow 集合; 揭示不改 `tools.schemas(agent)`; managed 未授权被拒; 静态 deny 生效; 每工具 hold 只追加单条.
- e2e: 揭示前后 `request/header` 的 tools 深度相等; 无新增开发者消息; 揭示后可调用, 未揭示被拒.
- 部署: `scripts/install.sh --profile fff --sync` 装上 `tool-surface`; 确认 profile 内该包只有一个实例（catalog 才能共享）; catalog 自检失败则不挂载 `tool-consult` 并告警.
- 真机: 同步 profile 后跑一轮, 核对 `request/header` 只出现一次（`when` 就绪状态变化除外）; 非初始工具在数组里是短说明.
- 全量: `pnpm run check` / `build` / `test` / `check:docs`.

## 风险与边界

- 非初始工具的短定义全部常驻 header, 每请求固定成本随工具数增长; 短说明长度要控制.
- 宿主工具 shadow 后模型只看到一句话, 细节必须咨询; 有意取舍.
- 带 `when` 的工具可能改变 header; 仅 `web_search` / `web_fetch` 允许如此; 其他条件工具必须不挂载或禁用.
- 晚注册工具（MCP 等）本次不处理: 不进 managed 集合, 默认放行; 若以完整定义进入 header, 接受一次变化.
- 子代理（`applyTo: roots` 缺省）不走 shadow, header 仍带完整宿主定义; 保持现状, 不纳入本次范围.
- shadow 注册失败按 managed 未授权处理, 宁可拒绝也不绕过门禁.
- catalog 自检失败时 `tool-consult` 不接管并告警一次, 工具面回到宿主默认; 这是有意选择.
- 包装宿主工具改变其参数默认值处理, 需逐个验收.
- pin-note 缺席时只能投递短定义, 告警里写明.
- `restrict` 仅用于静态 deny 表, 不参与揭示.

## 状态记录

- 2026-11-13: 接取条目; 完成现状复核与宿主能力调研.
- 2026-11-13: 决策定稿; 放弃延迟声明路线, 改全量短清单.
- 2026-11-13: 按审阅修订并整理文档; 待开工.
