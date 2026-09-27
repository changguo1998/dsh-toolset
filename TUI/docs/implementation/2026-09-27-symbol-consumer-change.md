# TUI 符号逻辑迁出为 symbol-normalizer 插件（TUI BACKLOG #18；项目级 #43 / #48）

状态：进行中　　开启：2026-09-27
本文件是本任务 TUI 侧唯一的过程记录与文档变更落点；计划外的文件不改。
项目级侧（框架、新插件、集成与总体决策）见 `docs/implementation/2026-09-27-rule-engine-consumer-and-integration.md`。

## 目标

- TUI **删除**内置符号实现：`src/app/symbols.ts`（含默认规则与算法）、逐符号冷却表、回合报告累积、turn-end followup。
- 改为经 `ctx.get('symbolNormalizer')` 服务消费：
  - 流式展示归一：`normalize(text)`（`/symbol-unify` 开启时对每个 stream 段调用）；
  - 人类 notice：订阅 `onReview(cb)`，插件审查通过冷却闸门时推给 TUI 显示（口径与模型反馈一致）；
  - 模型提醒：由插件在 rule-engine 的消费者询问中返回内容、rule-engine 统一注入，TUI 不再发送。
- 插件缺席 → 原文透传（无归一、无 notice、无提醒）；`/symbol-unify` 开关保留（仅控制 TUI 侧归一与订阅）。
- TUI 保持零运行时依赖（结构面访问服务）。

## 调研（关键事实）

- 迁移前落点：`src/app/index.ts`（L958-967 流式归一；L1237-1252 回合报告；L1259-1341 冷却 + notice + followup；`symbolRules` / `symbolCooldown` / `symbolTurn` 字段）、`src/app/config.ts`（L240-286 `symbols` 段解析）、`tests/symbols.test.ts`。
- 服务接线模式：`src/main.ts` L500+ 经 `ctx.get('...')` 读服务并传入 adapter / `main()` opts；AppDeps 见 `src/app/index.ts` L187+。
- 插件服务面（项目级 #48）：`symbolNormalizer.normalize(text)` → `NormalizeResult`；`onReview(cb)` → 注销函数；`status()`。

## 决策

沿用项目级 D5–D10。补充：

- TUI 侧保留 `/symbol-unify` 开关：OFF 时不调用 `normalize`、不订阅 notice（行为与现状「开关关闭：既不提示也不注入」一致）。
- notice 只在 `onReview` 触发时显示（与模型反馈同一冷却闸门），不再由 TUI 自行累积判断。
- 会话过滤：notice 回调按 `sessionId` 过滤到当前活跃会话（与其它事件处理同口径）。

## 规划

### 计划改动文件清单

| 文件 | 改动 |
|------|------|
| `src/app/symbols.ts` | **删除**（迁入 `symbol-normalizer/src/symbols.ts`） |
| `src/app/config.ts` | 删除 `symbols` 段解析与类型引用（配置迁至插件 `config`） |
| `src/app/index.ts` | 删除 `symbolRules` / `symbolCooldown` / `symbolTurn` / 累积与 `flushSymbolTurn`；改为服务 `normalize` + `onReview` notice；AppDeps 增加 `symbols` 服务结构面 |
| `src/app/adapter/types.ts` | `SymbolNormalizerLike` 结构面（normalize / onReview / status） |
| `src/main.ts` | `ctx.get('symbolNormalizer')` 读取并注入 `main()` opts |
| `tests/symbols.test.ts` | **删除**（用例迁入插件 `tests/symbols.test.ts`） |
| `tests/*`（`app.test.ts` 或新增） | 服务消费用例：归一替换、notice 回调、插件缺席透传、开关 OFF 不调用 |
| `docs/DESIGN.md`、`TUI/README.md` | 符号机制与配置位置更新（配置迁至插件） |
| `docs/BACKLOG.md` | #18 状态（关闭时标完成） |
| 本文件 | 关闭时移入 `docs/archived/` |

### 明确不做

- rule-engine / symbol-normalizer 包内改动（属项目级任务）
- TUI 保留内置符号兜底（项目级 D9）
- 改 `~/.dsh/profiles/fff`

## 实现记录

（按时间追加）

## 测试与证据

（命令与结果）

## 收尾

（关闭时填）
