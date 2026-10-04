# symbol-normalizer 设计

模块：`symbol-normalizer`（项目级 BACKLOG #48）。契约与用法见 `../README.md`，过程记录见项目级 `docs/archived/2026-09-27-rule-engine-consumer-and-integration.md`。

## 目标与边界

把 TUI 的符号规则迁移为独立插件：展示层归一（纯函数）+ 回合审查（notice / 模型反馈）；以 rule-engine 消费者形式接入（消费者框架的第一个验证插件）。

边界：

- 不做 rule-engine 侧调度（消费者只负责 `decide` 返回内容）。
- 不做 TUI 命令 / 面板；展示层经服务消费。
- `tag` / `abort` / `memory` 动作、逐 delta 实时匹配不做。

## 分层

```text
main.ts     插件入口：name / inject(["ruleEngine"]) / provide(["symbolNormalizer"]) / Config / apply
            ├─ registerConsumer({ id: 'symbol-normalizer', decide })   ← 经 ctx.ruleEngine
            └─ provide('symbolNormalizer', { normalize, onReview, status })
review.ts   回合审查：正文 → normalizeSymbols → 逐符号冷却 → notice + 反馈文案（按会话记账）
symbols.ts  纯函数：治理区段 / 推荐白名单 / 别名表 / normalizeSymbols / resolveSymbolRules（自 TUI 迁入）
```

依赖方向单向：`main → {review, symbols}`；`review → symbols`。

## 关键取舍

1. **规则与算法整体迁出 TUI**（用户 2026-09-27 定稿）：代码与配置（`recommended` / `aliases` / `warnModel` / 冷却）随迁；TUI 只经服务消费（见 TUI 追踪文档）。
1. **消费者接入而非自行注入**：反馈内容由 rule-engine 统一注入（`source.form:'notice'` 一行提示；节流闸门 / 推迟宏任务 / 落盘都在 rule-engine）。
1. **冷却按会话隔离**：迁移前 TUI 为进程级；独立插件服务多会话，故 `Map<sessionId, Map<symbol, rec>>`。冷却语义（双维度任一未过期即冷却、每次审查推进 run 计数、登记时重置）与迁移前一致。
1. **notice 经服务回调（`onReview`）**：审查只算一次（冷却只消费一次），展示层订阅事件；避免展示层自行计算导致口径不一致。
1. **硬依赖 rule-engine**（`inject: ["ruleEngine"]`）：插件职责就是消费者接入；rule-engine 缺席时本插件不加载（TUI 回退原文透传）。
1. **无运行时 schema**：沿用本仓松口径（宿主原样透传配置，缺省由 `resolveSymbolRules` 收敛）。
1. **可观测性**：apply 写 stderr 自证日志（推荐 / 别名 / 冷却 / warnModel）；`decide` 内异常不外抛（rule-engine 侧也会隔离）。
1. **开局指南（F2）按 rule-engine 统一标准注册**（2026-10-01「注入标准统一与合并」起；2026-10-02「注入时机直写」改为多节点 + 直写）：`sources: ["session-start", "compaction", "step-end"]` + `delivery: "steer"` + `dedupeInRecord: 1` + `directWrite: ["session-start", "compaction"]`——`session-start`（含恢复）与 `compaction` 跳过记录去重判断直接写入，`step-end` 按会话记录（可见投影 + 未消费 inbox）判断（最多 1 条，压缩挤出后补回）；与 skill 自加载规则同节点同组 → 合并成一条注入；不再自管进程内 gate 与历史判空（那份逻辑已删）。`提醒` 类回合反馈仍不走去重（每次违规都该说）。
