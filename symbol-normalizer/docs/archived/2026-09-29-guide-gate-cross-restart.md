# 开局指南记账跨重启去重（接取条目：`symbol-normalizer/docs/BACKLOG.md`「开局指南记账跨重启去重（可选增强）」）

状态：关闭　　开启：2026-09-29　　关闭：2026-09-29
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`SymbolGuideGate` 的「每会话一次」记账目前只在进程内（容量 256 FIFO），dsh 重启后同一会话会再收到一次指南。本任务把判定改为「会话历史里是否已有该指南消息」，使**同一会话跨重启只注入一次**，同时保留：不同会话各自一次、记账不随会话数增长、`injectGuide: false` 行为不变。

## 调研

（来源：本仓源码 / 宿主接口研读笔记 `docs/host/DSH-CTX-API.md`、`docs/host/HOST-PACKAGES.md`）

- 指南注入路径：rule-engine 消费者 `symbol-normalizer-guide` → rule-engine 统一注入（`source: { kind: "rule-engine", summary: GUIDE_SUMMARY }`，见 `rule-engine/src/inject.ts:37,58`）。
- 该消息会随会话日志持久化；宿主 `Session.deriveMessages()` 是**非废弃**的同步读面（`eventAt/snapshotEvents/ownEvents` 自 0.1.7-rc.2 起标 `@deprecated`，禁止新调用）。`ctx.sessions.get(id)` 取 Session；本仓 TUI 已在用 `deriveMessages`（`TUI/tests/tool-bootstrap.test.ts`）。
- `source` 保留在消息投影里（TUI 按 `source.kind` 分类显示，生产在用）⇒ 可用 `kind + summary` 精确识别本指南。
- rule-engine 消费者的 `decide` 是**同步**接口（`rule-engine/src/types.ts:206-217`），故历史判定必须走同步读面（`deriveMessages`），不能用 `sessionQuery.listEvents`（异步）。
- 备选路径「宿主指令面静态注入」不可达（`dsh-agent-instructions` 只读固定候选文件，无插件注册口，见 guide.ts 注释）；「压缩指南文本」不解决重复本身。

## 决策

- 选定：**读会话历史去重**（调研路线 1 的轻量实现）——不改注入面、不写额外事件；指南消息本身即持久记账。
- 判定：`decide` 先查进程内 gate；未记账时读 `session.deriveMessages()`，若已存在 `source.kind="rule-engine"` 且 `summary=GUIDE_SUMMARY` 的消息 → 记账并跳过；否则注入并记账。
- 降级：会话对象不可读 / `deriveMessages` 抛错 → 视为「历史为空」（fail-open，退回进程内记账的旧行为，不阻断指南）。
- 已知边界：若指南消息被 compaction 剪除，重启后可能再注入一次（可接受，文档记录）。
- 记账规模：进程内 FIFO 上限 256 不变；跨重启判定不新增存储，不随会话数增长。

## 规划

计划改动文件清单：

1. `symbol-normalizer/src/guide.ts`：`SymbolGuideGate` 加只读 `has()`；新增纯函数 `hasGuideMessage(messages)` 与规则来源常量。
1. `symbol-normalizer/src/main.ts`：`inject` 增加 `sessions`；指南消费者 decide 接入历史判定（含 `sessionMessagesOf` 结构面读法，异常降级）。
1. `symbol-normalizer/tests/guide.test.ts`：`hasGuideMessage` 用例（命中 / 不命中 / 空）、`gate.has` 用例。
1. `symbol-normalizer/tests/main.test.ts`：假 ctx 增加 sessions；新增「历史已有 → 跳过（resume 语义）」「历史为空 → 注入一次」「历史读取抛错 → 仍注入（fail-open）」用例。
1. `symbol-normalizer/README.md`：`inject` 硬依赖与「每会话一次」口径更新（跨重启去重）。
1. 本追踪文档。

明确不做：不改 rule-engine；不写自定义会话事件；不动 TUI；不做 `sessionProjections` 接入（无必要，历史判定已足够）。

## 实现记录

- 2026-09-29：`src/guide.ts` —— 新增 `RULE_ENGINE_SOURCE_KIND` 常量与纯函数 `hasGuideMessage(messages)`（按 `source.kind + summary` 识别）；`SymbolGuideGate` 新增只读 `has()`。
- 2026-09-29：`src/main.ts` —— `inject` 增加 `"sessions"`；`PluginContext` 增加 `SessionStoreLike`；新增 `sessionMessagesOf(sessions, id)`（try/catch 取 `deriveMessages()`，异常 → 空数组）；指南消费者 `decide` 改为「内存记账快路径 → 历史判定 → 注入」，历史命中时只记账不注入。
- 2026-09-29：测试 —— `tests/guide.test.ts` 加 `hasGuideMessage`（命中 / 空 / 异源异摘要）与 `gate.has` 用例；`tests/main.test.ts` 假 ctx 支持 sessions，新增「历史已有 → 跳过且不重复」「历史抛错 → fail-open 仍注入」用例，`injectGuide: false` 原用例保持不变。
- 2026-09-29：`README.md` —— §3 每会话一次口径、`injectGuide` 配置行、`inject` 依赖行、`decide` 时序约束（允许每会话一次同步只读）同步。
- 时序说明：历史判定在 `decide` 内做一次**同步只读**（`sessions.get` + `deriveMessages`），不做注入/写事件；记账后走内存快路径，故每会话至多一次。

## 测试与证据

- `npm --prefix symbol-normalizer run check` ✓；`build` ✓。
- `npm --prefix symbol-normalizer run test`：43 例全通过（新增 F3 用例在内）。
- **真机验证（2026-09-29，通过）**：重启后进程（pid 2386145，启动 22:20:03）完成首个回合边界时——rule-engine 通道正常（同边界 Skill 规则正常注入），而本指南**未再注入**：会话日志中指南条目仍止于重启前的 seq 1979（`source.kind=rule-engine` + `summary=符号规范（会话开局指南）`），跨重启去重生效 ✓。

## 收尾

- 提交：`f7ca13c`（feat：开局指南记账跨重启去重；6 文件，+190/-14）。
- 回写：`symbol-normalizer/README.md`（§3 每会话一次口径、`injectGuide` 行、`inject` 依赖行、`decide` 时序约束）。
- BACKLOG：`symbol-normalizer/docs/BACKLOG.md` F3 条目标完成并移除；本追踪文档移入 `symbol-normalizer/docs/archived/`。
- 遗留：无；已知边界（指南消息被 compaction 剪除后可再注入一次；历史不可读时 fail-open）已在决策与 README 记录。
