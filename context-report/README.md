# @dsh-toolset/context-report

DSH（DeepSeek Harness）进程内插件：会话级上下文与 token 报告（BACKLOG #34，pi `supi-context` 等效面）。

承载两件事：

1. **投影单元 `sessionContext`**（host-only）：折叠会话日志，产出会话累计值 —— 回合/步数、模型/工具墙钟、首 token、解码窗口、token 分桶（未缓存输入 / 缓存读 / 缓存写 / 输出，reasoning 为子集）。注册在宿主 `ctx.sessionProjections` 上，由宿主按会话 eager 驱动与持久化缓存（`stateVersion` 变更即丢弃旧行）。
1. **工具 `context_report`** + **服务 `contextReport`**：把投影值与宿主 `ctx.tokenMeter` 的即时压力读数合成一份可读报告。

## 能力

工具 `context_report`（单工具 + `action` 分派）：

| action | 参数 | 作用 |
| --- | --- | --- |
| `report`（缺省） | `session_id?`、`detail?` | 渲染报告（文本 + 结构化字段同源） |
| `state` | `session_id?` | 返回投影原始状态（JSON） |
| `list` | — | 列出当前会话（id + 是否有投影状态） |

`detail` 三档：

- `summary`：回合/步 + token 总量；
- `standard`（缺省）：再加上下文占用（压力/容量/百分比）、墙钟分档、解码速率、最近路由；
- `full`：再加 reasoning 细分与下次请求构成（需外部提供 `contextBreakdown`）。

报告字段：

```
会话 <id> 上下文报告（standard）
- 回合/步：1 / 2（已关闭步，水位 seq=8）
- token 累计：总 1.6k = 未缓存输入 1.4k + 缓存读 50 + 缓存写 20 + 输出 160
- 上下文占用：下次请求预估 1.2k / 128.0k（0.9%）
- 墙钟累计：模型 500ms、工具 200ms、首 token 500ms（均 250ms）、解码 0ms
- 最近路由：deepseek/v4
```

只读服务 `contextReport`（`provide("contextReport")`）：`report(options)`、`sessionState(sessionId?)`、`listSessions()`、`dispose()`。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `detail` | `standard` | 工具与服务的缺省细节级别 |
| `projection` | `true` | 是否注册 `sessionContext` 投影单元（false = 只有即时读数） |

bundle 契约：`name` / `inject: ["sessionProjections", "sessions", "tools"]` / `provide: ["contextReport"]` / `Config` / `apply`。

`inject` 必须显式声明这三个服务：cordis 的 ctx 代理对**未 inject 的服务属性**访问即抛错（`cannot get property "x" without inject`），不能靠「读到 undefined 再降级」；可选服务 `tokenMeter` 经内部 `optionalService` 做存在性探测后访问（未挂载时报告只缺即时读数，会话累计不受影响）。

## 口径（与宿主对齐）

- **只统计已关闭的步**（`step/end`）：步内模型墙钟、token 分桶、回合数先挂账在在途账上，`step/end` 时一次提交；未闭合的步一律不计（在途回合不算完成）。与宿主 `dsh-session-stats` 的「已关闭步」口径一致。
- **回合计数**挂在 `turn/start` 的回合身份上：同回合多步只计一次；无回合信息的步不计回合。
- **首 token / 解码**：优先取流记录里首个非空 text/reasoning 增量——宿主 0.1.5-rc.2 实测（rc.3 与其源码同构）为 `text-chunks` / `reasoning-chunks` 块（取 `time0` 精确绝对时间），兼容旧 `text-delta` 形态（entry `time`，缺则消息时间兜底）。`assistant/attempt` 的流增量同样计入；完全无增量时退化为「消息时间上界」（此时解码窗口记 0，不编造）。
- **token 分桶**只累计 provider 实际上报的步（`assistant/message.usage`）；`reasoning` 是 `output` 的子集，单独给出且不重复计入总量。
- **上下文占用**：`projectedTokens` 优先、其次 `pressureTokens`；容量取自宿主 token-meter 的 `contextWindow`（模型路由容量）——容量未知时**不给百分比**，不猜分母。
- 墙钟差为负、时间戳缺失、载荷形状非法时跳过该样本，不写入负数、不抛错。

## 边界与限制

- 投影为 **host-only**（只声明 state，不声明 wire）：宿主 `SessionProjectionMap` 由宿主包声明，第三方 key 无 client wire 语义；故客户端（TUI/web）快照不含本 key，读取走 `sessionProjections.stateOf(session, 'sessionContext')` 或本包服务面。
- 即时读数复用宿主 `ctx.tokenMeter.measure(session)`：宿主未公开 `ContextPressureProjection` 的读面时，退化为 `TokenMeasurement.totalTokens`（请求 + 回复压力）作为压力近似值。
- `full` 级别的「下次请求构成」（system/tools/messages 三档）需外部提供 `breakdown` 字段（宿主 token-meter 的 `contextBreakdown` 目前无公开读面），缺省时报告明确写「未接入」而不是补零。
- 不推进 TUI `/stats`：`/stats` 展示的是宿主侧最近一次模型调用；本插件补的是**会话累计**形态，二者口径不同、互不替代。
- 会话累计依赖宿主装配 `session-projection`（dsh-base 默认装配，见 `dsh-base/cordis.patch.yml`）；缺该服务时工具仍注册，但报告标注「会话累计：不可用」。

## 测试

```sh
npm run check   # 类型检查（tsc --noEmit，strict）
npm run build   # 编译到 dist/
npm run test    # node --test（42 例：fold / report / schema / main）
```

单测全部用构造事件与假宿主 ctx（仿宿主投影注册表的按会话缓存语义）驱动，不依赖 dsh 运行时与文件系统。
