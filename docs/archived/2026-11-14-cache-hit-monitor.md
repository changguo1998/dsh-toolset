# 缓存命中率监控（接取条目：docs/BACKLOG.md「缓存命中率监控」）

状态：已完成　　开启：2026-11-14　　关闭：2026-11-15
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

> 协调（2026-11-14 用户裁定）: 本任务与「TUI 显示当前模型性能」任务共享 `TUI/src/app/layout/status-line.ts`（本任务改既有 cache 段着色, 对方新增性能槽位）; 两任务顺序执行, 不并发, 实现顺序由用户安排。
>
> 实现分工与机械审计任务列表见 `docs/archived/2026-11-14-model-observe-impl-plan.md`（本任务 = A 系 A1–A7; 顺序: 包本体 A1–A4 → TUI 收尾 A5–A7, 其中 A6 排在对方 B3 之后）。

## 目标

对模型调用的缓存命中率做监控: 宿主在发送请求前按「上次与本次请求上下文的比较」预估本步可命中率, 收到返回后对比实际命中率, 若预测与实际偏差超过阈值则判定缓存失效并显示告警。判定靠对比结果, 不靠时间; 偏差大的典型成因是服务商侧缓存失效（含长时间未命中导致缓存过期）。

## 调研

（来源：官方源码 `~/GithubRepos/deepseek-harness` @ 0.2.2-rc.1、本仓既有消费与 `docs/host/`）

- **每次请求发送给模型的完整上下文**: 宿主把全部消息事件逐条 append 进 Session 日志（带 `surfaceOp` 标记, 含 compaction 替换语义）; `session.deriveMessages()` 从日志重建发给模型的完整消息面（`packages/core/session/src/index.ts:999`, 纯快照、深度冻结）, `agent-loop` 发请求时用的就是它（`packages/core/agent-loop/src/agent.ts:728`）。
- **插件侧取上下文**: `ctx.sessions.get(sessionId)` 拿 Session 调 `deriveMessages()`（`index.ts:1375`）; 或订阅 `session/event` 自维护消息面。
- **请求前时机**: `agent/pre-step` 在每步请求前触发, 载荷只带本步新认领消息（`{ messages: claimed, ... }`）, 不含完整上下文; 完整上下文需自行 `sessions.get()` + `deriveMessages()` 取快照。
- **`request/context` / `request/header`**: 只记录路由元数据（provider / model / contextWindow / 工具 / systemPromptUpdate）, 不含消息正文, 不是预估依据。
- **实际命中率**: `assistant/message.usage.cacheReadTokens`（+ inputTokens / outputTokens）, TUI 已在 `dsh-events.ts:372-409` 消费。命中率口径 = `cacheRead / (input + cacheRead)`。
- **TUI 状态行已有 cache 段**（`TUI/src/app/layout/status-line.ts:47-65`）: 显示最近一次调用的缓存读占比（`cache 70%`）, 无用量时占位 `—`; `/stats` 已显示「缓存命中率」（`commands.ts:422`）。现状是静态文本、无颜色。
- **精度**: 前缀重叠度只是近似——真实命中取决于 provider 缓存实现（token 化粒度、前缀哈希、最小缓存长度、TTL）, 无法精确到百分比; 预估为粗估 + 容差, 告警阈值按经验调。
- **快照维护**: 宿主不把每次 `deriveMessages()` 分别落成事件; 插件须自维护「上次快照」（会话 id → 上一步请求的完整消息面摘要）供前缀比对。

## 决策

- 决策项 1 = 机制 = **对比判定（b）**: 请求前按上次/本次 `deriveMessages()` 前缀重叠度粗估可命中率, 请求后对比 `cacheReadTokens` 实际命中率, 偏差超阈值判定缓存失效。不采用时间间隔估算（触发依据是对比结果而非时长）。用户 2026-11-14 裁定。
- 决策项 2 = 实现载体 = **新建独立插件（b）**: 进程内挂 `agent/pre-step` + `sessions.get().deriveMessages()` + `assistant/message.usage`; 判定在插件, 经服务面供 TUI 状态行懒读。不并入 TUI adapter（采集与展示耦合）。用户 2026-11-14 裁定。
- 决策项 3 = 预估口径 = **前缀重叠度近似（a）**: `重叠长度 / 本次总输入` 粗估 + 容差; 「本次总输入」= input + cacheRead（与 `/stats` 上下文总量口径一致, 保证预估与实际分母同基准）。不模拟 provider token 化（依赖内部实现, 不现实）。
- 决策项 4 = 请求前取快照方式 = **`agent/pre-step` 内自行取快照（a）**: 事件载荷不含完整上下文, 直接在事件内调 `sessions.get().deriveMessages()` 取快照（权威重建）。订阅 `session/event` 自维护为备选。
- 决策项 5 = 状态/告警呈现 = **TUI 状态行缓存状态变色, 落在既有 cache 段（c）**: 不改布局、不新增槽位——状态行已有 cache 段, 本任务给该段按判定状态着色; 插件经服务面把当前判定状态交给 TUI。用户 2026-11-14 裁定（覆盖 notice 方案）。
- 决策项 6 = 判定范围 = **实时全程（b）**: 采集与判定实时进行, 覆盖从回合开始到当前的整个过程, 每步都算预估与实际、都得出状态, 状态位实时反映, 不是只在第一步算。config 含偏差容差阈值（如 0.3, 不硬编码）, 另有可选「只盯第一步」开关（缺省关闭 = 全回合实时; 开启时只在第一步更新）。用户 2026-11-14 裁定。
- 决策项 7 = 首次请求（无上次快照）= **命中率设为 0, 显示黄, 豁免偏差判定（b）**: 最最开始那一步命中率按 0 计, 状态行显示「起始」颜色（黄）, 参与运行最低; 因无预估基线, 不参与「预估 vs 实际」偏差判定（否则 0 预估 vs 实际会误报）。用户 2026-11-14 裁定。
- 决策项 8 = 插件与 TUI 交互 = **服务面惰读（a）**: 插件 `ctx.provide('cacheHitMonitor', { summary() })`, TUI 状态行每 tick 懒读（与 flow-track `flowTrack.summary()` 同款机制, 加载顺序由懒读兜住）。
- 决策项 9 = 三态颜色 = **常用红黄绿（a）**: 正常 = 绿、缓存失效告警 = 红、首次（无上次快照, 命中率按 0）= 黄。具体色值实现时按 TUI 主题色板取。用户 2026-11-14 裁定。
- 决策项 10 = 同回合多步显示 = **实时维护「从回合开始到当前的运行最低」（a）**: 状态位随每步实时更新运行最低——本回合从开始到当前各步骤中最低一次命中率对应的状态/颜色, 不回退不抖动; 首次步按决策 7 命中率 = 0 作运行最低起点, 之后有实际命中率的步骤才可能刷新下限。
- 决策项 11 = 无 cache 数据时占位 = **沿用现有 `—` 占位（a）**: 本次请求没拿到 usage / cacheReadTokens 时, 状态行 cache 段保持 `—` 占位、不着色、不参与运行最低（与决策 7 的首次 = 0 无关——那是估值, 这是无实测数据）。
- 决策项 12 = 命中率分母口径（备忘）: 暂定预估 = `重叠长度 / 本次总输入`; 实际 = `cacheRead / (input + cacheRead)`（沿用 `/stats` 口径, 同量纲可比）。备忘: 部分 provider 的 inputTokens 可能已含 cacheRead（分母重复, 命中率被放大）, 若真机观察到明显不符, 分母改为 `cacheRead / (input - cacheRead)` 或按 provider 口径调整——先按现状实现, 记录实测值, 视情况修订。

## 规划

任务拆分:

1. 新插件骨架: `cache-hit-monitor/` 目录（`package.json` 的 `dsh.bundle` + `cordis.patch.yml` + `README.md` + `src/` + `tests/`）。
2. 采集: `agent/pre-step` 内调 `sessions.get().deriveMessages()` 取请求前快照, 经 `session/event` 的 `assistant/message.usage`（`cacheReadTokens`）取实际命中率; 维护 per-session 上次快照。骨架接线后先做宿主接线验证: `agent/pre-step` 是 waterfall 事件（返回 PreStepDecision, 有 prepend 注入语义）, 需验证只读订阅不干扰决策、不被视为注入方。
3. 判定: 实时进行, 从回合开始到当前——请求前粗估可命中率; 请求后按 usage 算实际; 每步得出状态 = 正常 / 缓存失效告警; 首次（无上次快照）命中率按 0、显示黄、不参与偏差判定; 其余步偏差超阈值判告警（可选配置限定只盯第一步时除外）; 状态位实时维护本回合运行最低命中率对应状态。
4. 服务面: 插件 `ctx.provide('cacheHitMonitor', { summary() })` 暴露三态（normal / stale / first, 具体命名实现时定）; TUI 状态行 cache 段懒读并按状态着色。
5. 接线: `scripts/test-parallel.sh`（default_pkgs 加枚举）、`scripts/install.sh`（canonical_pkgs 加枚举）、`scripts/test-install.sh`（39 包断言同步 40）、`docs/PACKAGES.md` 与 `AGENTS.md`（计数 39→40）、profile 模板（如挂载示例）、根 README 双侧包清单。
6. TUI 联动: 不新增槽位——状态行既有 cache 段按状态着色（读插件服务面, 无 cache 数据时沿用 `—` 占位）。
7. 测试: 单测（前缀重叠计算 / 快照维护 / 阈值判定 / 三态转换 / 回合运行最低 / 可选只盯第一步 / 首次豁免）+ 集成（事件接线 + 服务面形状 + 状态行着色渲染）。

计划改动文件清单:

- `docs/BACKLOG.md`（条目标进行中/完成）
- 本追踪文档
- 新包目录 `cache-hit-monitor/`: `package.json` / `cordis.patch.yml` / `README.md` / `src/index.ts` / `src/*.ts` / `tests/*.test.ts`
- TUI: `TUI/src/app/layout/status-line.ts`（既有 cache 段按三态着色, 不新增槽位）+ `TUI/src/app/app-deps.ts`（`getCacheHitMonitor` 读取器, 同 `getFlowTrack` 范式）+ `TUI/src/main.ts`（注入 `ctx.get("cacheHitMonitor")`）+ `TUI/src/app/runtime/wiring.ts`（StatusTicker 懒读保鲜）+ `TUI/src/app/state/types.ts` + `initial.ts`（cache 判定状态字段）+ `TUI/src/app/state/reducer-view.ts`（新 action case）+ `TUI/tests/*.test.ts`
- 根级: `scripts/test-parallel.sh`（default_pkgs 包枚举）、`scripts/install.sh`（canonical_pkgs 包枚举）、`scripts/test-install.sh`（包数断言 39→40）、`docs/PACKAGES.md`（职责表与计数 40）、`AGENTS.md`（计数口径）、根 `README.md` / `README.zh.md`（包清单与文档索引）
- `profiles/example/*`（若需挂载示例）

明确不做:

- 不改宿主 `agent-loop` / `dsh-llm` 等包（只用现成事件/服务面）。
- 不做独立 notice 告警（提示面已定为状态行三态颜色, 见决策 5/9）。
- 不改 `/stats` 的缓存命中率展示（现有口径与文案保持原样, 本任务只动状态行 cache 段着色; 与 TUI 性能任务的一致约定）。
- 不做精确 token 化模拟; 前缀重叠度近似口径在 README 写明偏差。
- 不动 `STATUS.md`（用户择时更新）。

## 实现记录（2026-11-14, 已实现并验证）

- **A1–A4 插件**: 新包 `cache-hit-monitor/`（`src/index.ts` 事件接线 + 服务面、`src/monitor.ts` 判定状态机、`src/overlap.ts` 前缀重叠与命中率）; 25 例单测（`tests/main|prestep|monitor|service.test.ts`）全过, 包内 `check` / `build` 通过。
- **A5 TUI 懒读**: `app-deps.ts`（`CacheHitMonitorLike` + `getCacheHitMonitor`）、`main.ts`（注入 `ctx.get("cacheHitMonitor")`）、`runtime/wiring.ts`（`maybeRefreshCacheHit` + 回执归一 `cacheJudgeOf`）、`runtime/lifecycle.ts`（StatusTicker 回调调用）、`state/types.ts`（`CacheHitJudge` + `cacheJudge`）、`state/initial.ts`、`state/actions.ts` + `state/reducer-view.ts`（`cache-judge`）。
- **A6 着色**: `layout/status-line.ts`（`cacheTintOf` / `cacheSegment`; 第 7 参 `cacheJudge`, 有 usage 且有判定才着色）、`layout/geometry.ts`（传 `state.cacheJudge`）、新测试 `TUI/tests/status-cache-tint.test.ts`（5 例）。三态色取主题调色板 `green` / `red` / `yellow`（决策项 9）; 无 usage 的 `—` 占位不着色（决策项 11）。
- **A7 根接线**: `scripts/test-parallel.sh` + `scripts/install.sh` 包枚举、`scripts/test-install.sh` 包数断言 39→40、`dev/standard/index.mjs`（count 规则 39/38→40/39）、`AGENTS.md` / 根 `README.md` / `README.zh.md` / `docs/PACKAGES.md` / `docs/ROADMAP.md` / `docs/WORKFLOW-STANDARD.md` / `docs/DEVELOPMENT.md` 计数与清单、`md-logic/README.md` 与 `security-guard/README.md` 的计数句。
- **审计**: `pnpm run check -- TUI` 退出 0; `pnpm run test:tui` 1889 例全过; `sh scripts/test-install.sh` 124 项通过（含「canonical_pkgs 与仓库包目录一致且为 40 个包」）; `pnpm run check:docs` 退出 0; 旧计数 grep 只剩 `docs/STATUS.md`（用户择时更新）、`docs/host/` 历史快照与 `docs/archived/`。
- **偏差**: A5 计划外补 `runtime/lifecycle.ts`（ticker 调用点）与 `state/actions.ts`（action 类型）; A6 计划外补 `layout/geometry.ts`（调用处传参, 同 B3 先例）; A7 计划外补 `dev/standard/index.mjs` 与两处包 README 计数。
