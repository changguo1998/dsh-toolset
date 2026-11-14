# @dsh-toolset/cache-hit-monitor

DSH（DeepSeek Harness）进程内集成插件：对模型调用的缓存命中率做监控——请求前按「上次与本次请求上下文的比较」预估本步可命中率，收到返回后对比实际命中率，偏差超阈值判定缓存失效；判定靠对比结果，不靠时间。

判定在插件内完成，经服务面 `cacheHitMonitor` 供 TUI 状态行 cache 段按状态着色（绿 = 正常 / 红 = 缓存失效告警 / 黄 = 首次无基线）。

## 定位

宿主的缓存读命中（`usage.cacheReadTokens`）由模型提供商侧实现（前缀缓存），请求间上下文一致时本应命中；实测与预估偏差大是服务商侧缓存失效的信号（含长时间未命中导致缓存过期）。本插件把「预测 vs 实际」的偏差对比实时化，供用户从状态行直接看到缓存是否失效，而不用翻 /stats。

## 机制

| 环节 | 做法 |
| --- | --- |
| 预估 | 请求前（`agent/pre-step`）调 `sessions.get(sessionId).deriveMessages()` 取本次完整上下文快照，与插件自维护的「上次快照」做前缀重叠度粗估可命中率（重叠长度 / 本次总输入） |
| 实际 | 经 `session/event` 的 `assistant/message.usage.cacheReadTokens` 算实际命中率（口径 `cacheRead / (input + cacheRead)`，与 /stats 同基准） |
| 判定 | 预估与实际偏差超阈值（config `tolerance`）判缓存失效；偏差在容差内不误报 |
| 首次 | 无上次快照那一步命中率按 0 计、显示黄、不参与偏差判定（无预估基线），参与运行最低 |
| 展示 | 服务面 `cacheHitMonitor.summary()` 提供当前判定状态，TUI 状态行懒读并按状态着色 |

## 服务面

`ctx.provide("cacheHitMonitor", { summary(sessionId) })`——TUI 状态行每 tick 懒读（与 flow-track 同款机制，加载顺序由懒读兜住）。

## 配置

`cordis.patch.yml` 的 `config`：

| 键 | 缺省 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 显式 `false` 时停止采集与判定 |
| `tolerance` | `0.3` | 预估与实际命中率偏差阈值，超阈值判缓存失效 |

## 边界

- **只读订阅**：`agent/pre-step` 是 waterfall 事件（返回 PreStepDecision，有 prepend 注入语义）；本插件只读快照、不返回任何注入字段，不干扰宿主决策。
- **近似口径**：前缀重叠度只是粗估——真实命中取决于 provider 缓存实现（token 化粒度 / 前缀哈希 / 最小缓存长度 / TTL），无法精确到百分比；告警阈值按经验调。
- **不改宿主**、不做独立 notice（呈现已定为状态行三态颜色）、不改 /stats。
- 分子分母口径如有真机偏差（input 可能已含 cacheRead），按追踪文档决策 12 备忘修订。

## 测试

```sh
cd cache-hit-monitor
pnpm run check   # tsc --noEmit（含 tests）
pnpm test        # node --test
pnpm run build   # 编译到 dist/
```

真机验证（人工）：连续两次调用的上下文高度重叠时应为绿色，人为让 provider 缓存失效时应变红，首步应为黄色。
