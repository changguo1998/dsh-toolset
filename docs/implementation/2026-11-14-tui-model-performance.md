# TUI 显示当前模型性能（接取条目：docs/BACKLOG.md「TUI 显示当前模型性能（首字节延迟, 解码速率）」）

状态：决策　　开启：2026-11-14　　关闭：
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

> 协调（2026-11-14 用户裁定）: 本任务与「缓存命中率监控」任务共享 `TUI/src/app/layout/status-line.ts`（本任务新增性能槽位, 对方改既有 cache 段着色）; 两任务顺序执行, 不并发, 实现顺序由用户安排。
>
> 实现分工与机械审计任务列表见 `docs/implementation/2026-11-14-model-observe-impl-plan.md`（本任务 = B 系 B1–B4; 顺序: B3 状态行性能槽位先于对方 A6 的 cache 段着色）。

## 目标

TUI 展示当前模型调用的首字节延迟（TTFB）与解码速率（tokens/s）。在 **TUI 内实现**, 不新建插件、不跨包采集; 数据源用现有宿主事件/字段组合。

## 调研

（来源：TUI 现有消费、`docs/host/DSH-CTX-API.md`、`TUI/src/app/adapter/`）

- **首字节延迟（TTFB）**: 现有流式路径已拿「首块到达时刻」——`agent/assistant-stream` 实时帧逐 chunk 带 `time`（`TUI/src/app/adapter/types/session-events.ts:113`; 实时帧已在 `dsh.ts:316` 消费）。缺「请求发出时刻」锚点: 宿主接口面未暴露模型请求实际发出的时刻, 用本 step 起点近似（step/start 或本 step 首个可见事件时刻）。TTFB = 首 chunk.time − 本 step 起点（近似口径, 状态行/文案注明偏差）。
- **解码速率**: TUI 已有启发式速率——`dsh-events.ts:49-61` `recordAgentRate`（4 字符 ≈ 1 token 折算 + 指数加权瞬时速率, 供状态列 Agents 块闪烁）。精确口径: 流末 `assistant/message.usage.outputTokens` 真值 / 本步流时长 → 平均速率。两者并存: 流中瞬时估值 + 流末真值反算。
- **用量数据**: `assistant/message.usage`（inputTokens / outputTokens / cacheReadTokens）已在 `dsh-events.ts:372-409` 提取并落 `state.usage`。性能展示复用该事件时机, 在同一步收尾处结算。
- **展示位**: `/stats` 现有 token 用量双口径（`state/types.ts:527-540`）; 状态行有 usage 槽位。性能指标放状态行新槽。
- **边界**: 非流式 provider（无 chunk）无 TTFB/瞬时速率, 回落平均速率（`usage.outputTokens /（assistant/message 到达时刻 − 本 step 起点）`）。

## 决策

- 决策项 1 = 实现位置 = **TUI 内实现（a）**: adapter 采集 + layout 展示; 数据源都是 TUI 已消费的现有事件/字段, 无需独立插件。用户 2026-11-14 裁定。
- 决策项 2 = 展示口径 = **状态行新增性能槽位（b）**: TTFB + 解码速率常驻状态行, 状态行弹性行/宽度预算内安排（参考 TUI 已有弹性名称行形态）。不做 /stats 详情回看（用户同日裁定）; /stats 保持现状。用户 2026-11-14 裁定。
- 决策项 3 = TTFB 起点 = **本 step 起点到首 chunk.time（c）**: step/start 事件时刻（或本 step 首个可见事件时刻）→ 首 chunk.time; 单步回合等价于 turn/start, 多步回合每个 step 独立起算; 偏差: 仍含排队、prompt 组装, 非纯网络 TTFB, 状态行注明「近似」。（不采用 turn/start: 会把前面 step 的时长算进本步 TTFB; 精确请求时刻宿主未暴露。）
- 决策项 4 = 解码速率口径 = **瞬时估值 + 真值反算并存（a）**: 流中启发式瞬时速率; 收尾 average = `usage.outputTokens` 真值 /（收尾时刻 − 首个 chunk.time）, 从首块起算（不含 TTFB 等待段）。用户 2026-11-14 裁定分母口径。
- 决策项 5 = 非流式回落 = **只给平均并标注（a）**: 无 chunk 时无瞬时/TTFB, 给平均速率 + 「非流式无 TTFB」占位; 平均速率起点 = 本 step 起点（与决策 3 起点一致）。

## 规划

任务拆分:

1. adapter 采集: 在 `dsh-events.ts` 流式路径记录每步 step 起点时刻（step/start 或本 step 首个可见事件）、首个 chunk.time; 收尾 `assistant/message` 处结算 TTFB（首 chunk.time − step 起点）与平均速率（`usage.outputTokens` /（收尾时刻 − 首个 chunk.time））。
2. state: 新增 per-step 性能字段（ttfbMs / avgTokensPerSec / 瞬时峰值）到 `state.usage` 或独立字段, 随 usage 事件在 `reducer-tool.ts` `case "usage"` 同频结算（另见 B2 审计）。
3. 渲染: 状态行新增性能槽位（TTFB + 解码速率, 弹性宽度内）。不做 /stats 详情回看。
4. 测试: reducer/渲染用例（有流、无流、无 usage 回落、TTFB 缺失占位）。

计划改动文件清单:

- `docs/BACKLOG.md`（条目标进行中/完成）
- 本追踪文档
- `TUI/src/app/adapter/dsh-events.ts`（结算 TTFB / 平均速率）
- `TUI/src/app/state/types.ts`（per-step 性能字段）+ `TUI/src/app/state/initial.ts`（初值）+ `TUI/src/app/state/reducer-tool.ts`（`case "usage"` 同频结算, 改点 :73-109）
- `TUI/src/app/layout/status-line.ts`（状态行性能槽位; 参考弹性名称行形态 `h([符号, 名称(fill), 尾部])`）
- `TUI/tests/*.test.ts`（新增/更新用例）
- `TUI/README.md` 与 `TUI/docs/COMMANDS-SPEC.md`（状态行说明同步; /stats 不改）
- 根 `README.md` / `README.zh.md`（若命令说明索引涉及）

明确不做:

- 不改宿主、不新建插件、不跨包取数（用户裁定 TUI 内实现）。
- 不做精确请求发出时刻 TTFB（宿主未暴露; 近似口径写明偏差）。
- 不做 /stats 详情回看（状态行即唯一展示位）。
- 不做缓存命中率相关（属另一任务 `docs/implementation/2026-11-14-cache-hit-monitor.md`）。
- 不动 `STATUS.md`（用户择时更新）。

## 实现记录（2026-11-14, 已实现并验证）

- **B1 采集**: `TUI/src/app/adapter/types/events.ts`（新增 `performance` 事件）、`adapter/context.ts`（`stepPerf` 表, key `${sid}:${turn}:${step}`）、`adapter/dsh-events.ts`（`step/start` 记起点、`onAssistantFrame` 首个 chunk 记首帧时刻、`assistant/message` 结算 TTFB 与平均速率并清表; 无 chunk 走 `streamed: false`）。
- **B2 状态**: `state/types.ts`（`performance?`）、`state/initial.ts`（缺省不写, 注释说明随 usage 一并清空）、`state/actions.ts` + `state/reducer-tool.ts`（`case "performance"`）、`state/reducer-session.ts`（history-restore 与 `/new` 两处清空）、`runtime/wiring.ts`（事件直通）。
- **B3 渲染**: `layout/status-line.ts`（`performanceText` / `formatTtfb`, `llmFull` / `llmFit` 增末段且宽预算计入）、`layout/geometry.ts`（第 6 参传 `state.performance`）、新测试 `TUI/tests/status-performance.test.ts`（5 例）。
- **B4 文档**: `TUI/README.md`（LLM 组说明补槽位口径）、`TUI/docs/COMMANDS-SPEC.md`（`state.performance` 事实行）。
- **审计**: `pnpm run check -- TUI` 退出 0; `pnpm run test:tui -- status-performance.test.ts` 退出 0; `pnpm run test:tui` 1889 例全过; `pnpm run check:docs` 退出 0。
- **偏差**: 性能不并入 `reducer-tool.ts` 的 `case "usage"`, 改为 adapter 侧独立 `performance` 事件（同频结算仍在收尾 `assistant/message`）; B2 审计的 `grep ttfbMs TUI/src/app/state/initial.ts` 由 `initial.ts` 的注释行满足（该字段初值缺省不写）。

## 追加修改（2026-11-14 用户裁定, 已实现并验证）

用户两项要求:

1. **不写 `ttfb` 标签**: 只留「时间 + 速率」两段, 速率单位 `t/s`（原 `tok/s`）; 延时较大时改用秒（`1.5s`）。
2. **只显示最近一步的实时状态, 不持续显示**: 首字节延时固定口径为「最近一步」; 该步收尾后两个数字自动归零（渲染为 `0ms 0 t/s`）。

实现口径:

- **事件节奏**: `agent/assistant-stream` 的每个 chunk 帧更新本 step 记录（首块时刻 + 正文估算 token 累计）, 首块到达即投递一次 `performance`, 其后按 250ms 节流投递; `assistant/message` 收尾投递一次 `ttfbMs: 0 / avgTokensPerSec: 0` 并删除该 step 记录（`TUI/src/app/adapter/dsh-events.ts` 的 `emitLivePerformance` / 收尾块, `adapter/context.ts` 的 `stepPerf` 增 `estTokens` / `lastPerfEmit`）。
- **速率口径改为估算**: 真实 `usage.outputTokens` 收尾才到、而收尾即归零, 故实时速率只能是「正文估算 token（`estimateOutputTokens`, 已有宽字符启发式）÷ 首块后时长」; TTFB 仍是实际测量值（首块时刻 − step 起点）。README / COMMANDS-SPEC 已写明估算口径。
- **渲染**: `layout/status-line.ts` 的 `performanceText` 改为常驻返回（无读数或归零 → `0ms 0 t/s`）, 单位 `t/s`; 极窄宽（LLM 组组内压缩后 model 段预算 < 8 列）先丢掉该段保 model 身份。
- **测试**: `TUI/tests/status-performance.test.ts` 重写 5 例（无 `ttfb` 标签 / 秒格式 / 空闲零值 / 收尾归零 / ≥100 取整）; `focus-frame` 冻结基线按既有「重冻记录」流程重冻（仅 11 个 w60 场景的状态行多出 `•0ms 0 t/s`, w20 无差异）。
- **审计**: `pnpm run check -- TUI` 退出 0; `pnpm run test:tui` 1889 例全过; `pnpm run check:docs` 退出 0。
