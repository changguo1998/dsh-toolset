# @dsh-toolset/context-report

DSH（DeepSeek Harness）进程内插件：会话级上下文与 token 报告（项目级「context-report」项，pi `supi-context` 等效面）。

承载两件事：

1. **投影单元 `sessionContext`**（host-only）：折叠会话日志，产出**官方没有的** token 分桶（未缓存输入 / 缓存读 / 缓存写 / 输出，reasoning 为子集）。注册在宿主 `ctx.sessionProjections` 上，由宿主按会话 eager 驱动与持久化缓存（`stateVersion` 变更即丢弃旧行）。回合 / 步 / 墙钟 / 首 token / 解码**不自折叠**，直接读官方 `sessionStats` 投影（2026-10-06 去重）。
1. **工具 `context_report`** + **服务 `contextReport`**：把上述累计值与宿主 `ctx.tokenMeter` 的即时压力读数合成一份可读报告。

## 能力

工具 `context_report`（单工具 + `action` 分派）：

| action | 参数 | 作用 |
| --- | --- | --- |
| `report`（缺省） | `session_id?`、`detail?` | 渲染报告（文本 + 结构化字段同源） |
| `state` | `session_id?` | 返回投影原始状态（JSON）；读不到时返回 `{ok:false,error}`（投影未注册 / 缺会话） |
| `list` | — | 列出当前会话（id + 是否有投影状态） |

`detail` 三档：

- `summary`：回合/步 + token 总量；
- `standard`（缺省）：再加上下文占用（压力/容量/百分比）、墙钟分档、解码速率、最近路由；
- `full`：再加 reasoning 细分与下次请求构成（需外部提供 `contextBreakdown`）。

报告字段：

```
会话 <id> 上下文报告（standard）
- 回合/步：1 / 2（官方 sessionStats；token 水位 seq=8）
- token 累计：总 1.6k = 未缓存输入 1.4k + 缓存读 50 + 缓存写 20 + 输出 160
- 上下文占用：下次请求预估 1.2k / 128.0k（0.9%）
- 墙钟累计：模型 500ms、工具 200ms、首 token 500ms（均 250ms）、解码 0ms
- 最近路由：deepseek/v4
```

结构化字段 `projection` 如实标注两组来源的在位情况：`sessionStats+sessionContext`（都在）/ `sessionStats`（仅官方）/ `sessionContext`（仅本包）/ `unavailable`（都不在）。

只读服务 `contextReport`（`provide("contextReport")`）：`report(options)`、`sessionState(sessionId?)`、`listSessions()`、`dispose()`。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `detail` | `standard` | 工具与服务的缺省细节级别 |
| `projection` | `true` | 是否注册 `sessionContext` 投影单元（false = 只有即时读数） |

bundle 契约：`name` / `inject: ["sessionProjections", "sessions", "tools"]` / `provide: ["contextReport"]` / `Config` / `apply`。

`inject` 必须显式声明这三个服务：cordis 的 ctx 代理对**未 inject 的服务属性**访问即抛错（`cannot get property "x" without inject`），不能靠「读到 undefined 再降级」；可选服务 `tokenMeter` 经内部 `optionalService` 做存在性探测后访问（未挂载时报告只缺即时读数，会话累计不受影响）。

## 口径（与宿主对齐）

**数据来源**：

| 数字 | 来源 | 说明 |
| --- | --- | --- |
| 回合 / 步 / 模型与工具墙钟 / 首 token / 解码 | 官方 `sessionStats` 投影（`dsh-session-stats`） | 本包只读不注册；口径即官方口径（`sessionStatsSchema` 视图字段逐一对应） |
| token 分桶（未缓存输入 / 缓存读 / 缓存写 / 输出，reasoning 子集） | 本包 `sessionContext` 投影 | 官方空缺 |
| 上下文占用（压力 / 容量 / 百分比） | 宿主 `ctx.tokenMeter.measure(session)` | 即时读数 |
| 最近路由 | 宿主 `Session.requestHeader()` | 即时读数 |

- **官方 `sessionStats` 不在位时**：回合 / 步 / 墙钟整组缺省（报告标注「官方 sessionStats 投影未在位」+「数据缺失不等于 0」），**不回退自折叠**——留一份并行实现正是本次去重要去掉的病灶。
- **token 分桶**只累计 provider 实际上报的步（`assistant/message.usage`），只在 `step/end` 提交（未闭合的步不计）；`reasoning` 是 `output` 的子集，单独给出且不重复计入总量；全零 usage 视为未上报（不计样本）。
- **上下文占用**：`projectedTokens` 优先、其次 `pressureTokens`；容量取自宿主 token-meter 的 `contextWindow`（模型路由容量）——容量未知时**不给百分比**，不猜分母。
- 首 token 均值分母用官方 `ttftSteps`，解码速率用官方 `decodeTokens / decodeMs`（同源，不跨源混算）。
- 载荷形状非法时跳过该样本，不写入负数、不抛错。

## 边界与限制

- 投影为 **host-only**（只声明 state，不声明 wire）：宿主 `SessionProjectionMap` 由宿主包声明，第三方 key 无 client wire 语义；故客户端（TUI/web）快照不含本 key，读取走 `sessionProjections.stateOf(session, 'sessionContext')` 或本包服务面。
- 即时读数复用宿主 `ctx.tokenMeter.measure(session)`：宿主未公开 `ContextPressureProjection` 的读面时，退化为 `TokenMeasurement.totalTokens`（请求 + 回复压力）作为压力近似值。
- `full` 级别的「下次请求构成」（system/tools/messages 三档）需外部提供 `breakdown` 字段（宿主 token-meter 的 `contextBreakdown` 目前无公开读面），缺省时报告明确写「未接入」而不是补零。
- 不推进 TUI `/stats`：`/stats` 展示的是宿主侧最近一次模型调用；本插件补的是**会话累计**形态，二者口径不同、互不替代。
- 会话累计依赖宿主装配 `session-projection`（dsh-base 默认装配，fff 已挂，见 `docs/host/HOST-PACKAGES.md`）。该服务在 `inject` 里是**硬依赖**：未装配时 cordis 让本插件保持 pending（工具与 provide 面都不注册），不会出现「工具在但无数据」；报告里的「会话累计：不可用」分支对应另外两种情形——（a）官方 `sessionStats` 单元未挂载（回合 / 步 / 墙钟缺省，token 仍可用），（b）`projection: false` 或该会话读不到本包状态（token 缺省，会话统计仍可用）。

## 与宿主投影的分工（2026-10-06 已定案并落地）

官方 `session-stats`（投影 `sessionStats`：对话轮次与墙钟）与 `session-turn-outline`（投影 `turnOutline`：回合大纲）两行已挂载（`docs/host/HOST-PACKAGES.md`）。**去重已完成**：本包不再自折叠回合 / 步 / 墙钟，只读官方 `sessionStats`；token 分桶与上下文占用仍是本包独占（`context_report` 是唯一模型工具面）。

| 口径 | 官方投影 | 本包 |
| --- | --- | --- |
| 轮次 / 步数 / 墙钟 / 首 token / 解码 | `sessionStats`（服务面读，无模型工具） | **读取方**（不再折叠） |
| 回合大纲 | `turnOutline` | 不做（新增能力，未立项） |
| token 分桶 / 上下文占用 / 三档报告 | 无 | 本包独占 |

依据与过程记录见 `docs/archived/2026-10-05-context-report-official-projections.md`（原评估 `docs/ARCHITECTURE-REUSE.md` §4 A 的「并存（需收窄）」已据此收窄完成）。

## 目录结构

```
src/
  main.ts    # 插件入口：bundle 契约、token 投影定义与注册、官方 sessionStats 读数、provide 面、context_report 工具
  fold.ts    # token 分桶折叠（纯函数：事件 → SessionContextState）
  report.ts  # 报告渲染（token 状态 + 官方会话统计 + 即时读数 → 结构化报告 + 文本）
  schema.ts  # SessionContextState 的极简 JSON 校验 schema（宿主 stateSchema.parse 用）
  types.ts   # 纯类型层（事件子集 / 状态 / 官方统计视图 / 报告 / 服务面），零宿主运行期依赖
  index.ts   # 包入口：re-export src/main
tests/       # node:test 单测
```

## 测试

```sh
npm run check   # 类型检查（tsc --noEmit，strict）
npm run build   # 编译到 dist/
npm run test    # node --test（41 例：fold / report / main）
```

单测全部用构造事件与假宿主 ctx（仿宿主投影注册表的按会话缓存语义）驱动，不依赖 dsh 运行时与文件系统。

宿主面事实见 `docs/host/HOST-PACKAGES.md`（`session-projection` / `token-meter` 挂载与口径）与 `docs/host/DSH-CTX-API.md`；复用评估见 `docs/ARCHITECTURE-REUSE.md` §4 A。
