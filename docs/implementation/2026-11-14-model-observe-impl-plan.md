# 模型观测两任务实现任务列表（实现分工与机械审计）

> 这份文档是为下述两个条目准备的分工与机械审计任务列表, 作为总体规划的引用输入; 条目各自的决策与口径以对应追踪文档为准:
>
> - 「缓存命中率监控」→ `docs/implementation/2026-11-14-cache-hit-monitor.md`（A 系任务）
> - 「TUI 显示当前模型性能（首字节延迟, 解码速率）」→ `docs/implementation/2026-11-14-tui-model-performance.md`（B 系任务）
>
> 状态: 待审阅　　日期: 2026-11-14　　不提交（决策/实现等提交询问点另行按流程询问）。

## 审计约定

本列表的每一条都以「命令 + 退出码 / 断言」作为完成判据, 不依赖人工主观判断。仓库根 `package.json` 委托 `scripts/test-parallel.sh`, 支持包名过滤: `pnpm run check / build / test -- <包名>` 只跑单个子包。`pnpm run test:tui -- <文件>.test.ts` 只跑 TUI 单个测试文件（`TUI/scripts/test.sh` 把名字正则安插到 `--test-name-pattern` 之前）。`pnpm run check:docs` 递归扫全仓 Markdown（符号 / 术语 / 计数 / 断链）, 新增包无需另行登记。

## 顺序约束

- 两任务共享 `TUI/src/app/layout/status-line.ts`, **顺序执行, 不并发**（用户 2026-11-14 裁定）; 推荐顺序: B 先加性能槽位, A 后改 cache 段着色, 使同一 group 数组上的改动最小化。
- 新增包后全仓包计数从 39 变为 40（`39 个包（TUI 与 38 个插件）` → `40 个包（TUI 与 39 个插件）`）, 计数更新集中在 A7 一次性做, 避免中间态 check:docs 失败。

______________________________________________________________________

## A 系任务（缓存命中率监控, 新建 `cache-hit-monitor` 包）

### A1. 包骨架

- **改动**: 新建 `cache-hit-monitor/`: `package.json`（`dsh.bundle` + check/build/test 三脚本, 模板参照 `pin-note/package.json`）、`cordis.patch.yml`（`insert: id: cache-hit-monitor`）、`tsconfig.json`、`README.md`、`LICENSE`、`src/index.ts`（最小加载）与 `tests/*.test.ts` 冒烟用例。
- **审计**:
  - `pnpm run check -- cache-hit-monitor` → 退出 0
  - `pnpm run build -- cache-hit-monitor` → 退出 0, 且 `test -f cache-hit-monitor/dist/src/index.js` 成功
  - `pnpm run test -- cache-hit-monitor` → 退出 0

### A2. agent/pre-step 只读订阅验证（决策 4 备忘）

- **改动**: `src/index.ts` 订阅 `agent/pre-step`, 事件内调 `ctx.sessions.get(id).deriveMessages()` 取快照, **不返回任何注入字段**; 配套单测断言 PreStepDecision 原样透传、注入区为空。
- **审计**:
  - `pnpm run test -- cache-hit-monitor` → 退出 0, 且报告 pass >= 2
  - `grep -cE "prepend|inject" cache-hit-monitor/src/index.ts` → 输出 0

### A3. 判定核心（纯函数, 可脱离宿主单测）

- **改动**: 新增 `src/overlap.ts`（前缀重叠度计算）、`src/monitor.ts`（per-session 上次快照维护、阈值判定、三态 normal/stale/first、回合运行最低、首次=0 豁免偏差判定、可选「只盯第一步」开关）。
- **审计**:
  - `pnpm run test -- cache-hit-monitor` → 退出 0, 且报告 pass >= 6（重叠 / 快照 / 阈值 / 三态 / 运行最低 / 首次豁免 / 只盯第一步）
  - `test -s cache-hit-monitor/tests/monitor.test.ts` → 成功

### A4. 服务面

- **改动**: `src/index.ts` 事件接线后 `ctx.provide("cacheHitMonitor", { summary() })`; summary 返回 `{ state, hitRate, minHitRate, firstStep }` 形状; 集成测试在 app 装配后经 `ctx.get("cacheHitMonitor").summary()` 读取。
- **审计**:
  - `pnpm run test -- cache-hit-monitor` → 退出 0, 且报告 pass >= 1（服务面形状用例）
  - `grep -q 'provide("cacheHitMonitor"' cache-hit-monitor/src/index.ts` → 退出 0

______________________________________________________________________

## B 系任务（TUI 性能, TUI 内实现）

### B1. 采集与结算（dsh-events）

- **改动**: `TUI/src/app/adapter/dsh-events.ts` 流式路径记录本 step 起点时刻（step/start 或首个可见事件）、首个 `chunk.time`; 收尾 `assistant/message` 处结算 TTFB（首 chunk.time − step 起点）与平均速率（`usage.outputTokens` /（收尾时刻 − 首个 chunk.time））; 非流式回落平均（分母起点 = 本 step 起点）。上游 usage 提取与 `ctx.emit({ type: "usage", … })` 已被 TUI 消费（`dsh-events.ts:372-409`）, 结算复用同一事件时机。
- **审计**:
  - `pnpm run check -- TUI` → 退出 0
  - `pnpm run test:tui` → 退出 0（既有用例不破坏）

### B2. 状态字段

- **改动**: `TUI/src/app/state/types.ts` + `initial.ts` 增加 per-step 性能字段（ttfbMs / avgTokensPerSec / 瞬时峰值）; `TUI/src/app/state/reducer-tool.ts` `case "usage"` 同频结算（改点 :73-109）。
- **审计**:
  - `pnpm run check -- TUI` → 退出 0
  - `grep -q "ttfbMs" TUI/src/app/state/types.ts` 且 `grep -q "ttfbMs" TUI/src/app/state/initial.ts` → 均退出 0

### B3. 状态行性能槽位

- **改动**: `TUI/src/app/layout/status-line.ts` 在 LLM group（`llmFull` / `llmFit` 两处数组）新增性能槽位（TTFB + 解码速率）, 弹性宽度内; 缓存段本任务**不动**（留给 A6）。
- **审计**:
  - 新增渲染测试 `TUI/tests/status-performance.test.ts` 后, `pnpm run test:tui -- status-performance.test.ts` → 退出 0
  - `grep -n "llmFull" TUI/src/app/layout/status-line.ts` → 有输出（确认槽位落在组数组内, 配合 diff 审查）

### B4. 文档同步

- **改动**: `TUI/README.md`（状态行说明）+ `TUI/docs/COMMANDS-SPEC.md`（状态行段说明; /stats 不改）。
- **审计**:
  - `pnpm run check:docs` → 退出 0

______________________________________________________________________

## A 系收尾（TUI 懒读接线 + 着色 + 根接线）

### A5. TUI 懒读接线

- **改动**: `TUI/src/app/app-deps.ts`（`CacheHitMonitorLike` 类型 + `getCacheHitMonitor` 读取器, 同 `getFlowTrack` 范式）、`TUI/src/main.ts`（注入 `ctx.get("cacheHitMonitor")`）、`TUI/src/app/runtime/wiring.ts`（StatusTicker 内 `maybeRefreshCacheHit` 懒读 summary, 值变化才 apply + paint, 同 `maybeRefreshFlowTrack`）、`TUI/src/app/state/types.ts` + `initial.ts`（cache 判定状态字段）、`TUI/src/app/state/reducer-view.ts`（新 action case）。
- **审计**:
  - `pnpm run check -- TUI` → 退出 0
  - `grep -q "cacheHitMonitor" TUI/src/app/app-deps.ts`、`TUI/src/main.ts`、`TUI/src/app/runtime/wiring.ts` → 均退出 0

### A6. status-line cache 段着色（共享文件, 顺序在 B3 之后）

- **改动**: `TUI/src/app/layout/status-line.ts` 既有 cache 段按判定状态着色（绿/红/黄三态, 无 cache 数据保持 `—` 不着色）; 只改 `status-line.ts` 与新增测试文件, 不新增槽位。
- **审计**:
  - 新增渲染测试 `TUI/tests/status-cache-tint.test.ts` 后, `pnpm run test:tui -- status-cache-tint.test.ts` → 退出 0
  - `pnpm run test:tui -- status-wrap-strategy.test.ts` → 退出 0（既有状态行宽度机制不破坏）

### A7. 根级接线与计数更新（最后一步）

- **改动**: `scripts/test-parallel.sh` default_pkgs 加 `cache-hit-monitor`; `scripts/install.sh` canonical_pkgs 加 `cache-hit-monitor`; `scripts/test-install.sh` 的 39 包计数断言同步为 40; 根 `README.md` / `README.zh.md` 包清单; `docs/PACKAGES.md` 职责表与计数（`39 个包（TUI 与 38 个插件）` → `40 个包（TUI 与 39 个插件）`）; `AGENTS.md`（若计数口径出现）; `profiles/example/*`（挂载示例, 若需要）。
- **审计**:
  - `grep -q "cache-hit-monitor" scripts/test-parallel.sh` 与 `grep -q "cache-hit-monitor" scripts/install.sh` → 均退出 0
  - `grep -rn "38 个插件" AGENTS.md README.md README.zh.md docs/` 与 `grep -rn "39 个包" AGENTS.md README.md README.zh.md docs/` → 均无命中（旧计数清零; 覆盖 AGENTS.md 第 3 行「共 39 个包」句式, check:docs 的 count 规则不抓该句式, 须 grep 兜底）
  - `pnpm run check:docs` → 退出 0（count.packages 断言对 40/39 通过）
  - `sh scripts/test-install.sh` → 退出 0（其第 11 步断言 `canonical_pkgs == default_pkgs` 且包数为 40, 即 :597 的 39 断言须同步）

______________________________________________________________________

## C 收尾（两任务完成后全量验证）

### C1. 全量机械验收

- **审计**（一条链, 全部退出 0）:
  - `pnpm run check`
  - `pnpm run build`
  - `pnpm run test`
  - `pnpm run test:tui`
  - `pnpm run check:docs`
- **通过判据**: 五条全退出 0; build 后 `dist/` 含两任务产物。

### C2. 演示与冒烟（人工确认变更效果前置）

- **审计**:
  - `pnpm run demo`（TUI mock demo 可跑）
  - `pnpm run demo -- --smoke`（帧断言 SMOKE_PASS）
- **通过判据**: smoke 输出含 SMOKE_PASS; 依 AGENTS.md「变更流程」, 人工确认通过后才允许提交。

______________________________________________________________________

## 明确不做（沿用两份追踪文档）

- 不改宿主 `agent-loop` / `dsh-llm` 等包。
- 不做独立 notice 告警（呈现已定为状态行三态颜色）。
- 不改 `/stats` 的展示（含缓存命中率与 token 用量, 两任务一致约定）。
- 不做精确 token 化模拟（前缀重叠度近似口径写明偏差）。
- 不做 /stats 性能详情回看（状态行即唯一展示位）。
- 不动 `STATUS.md`（用户择时更新）。
