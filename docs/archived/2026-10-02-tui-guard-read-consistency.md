# TUI 两处 guard 读法不一致（接取条目：`docs/BACKLOG.md`「TUI 两处 guard 读法不一致（观察项）」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 背景（前条目审阅 P3-c）

TUI 里 guard 服务有**两种读法**：

- `/guard` 面板等路径：`main.ts` 在 **apply 期取值快照**（`guard: ctx.get?.("guard")` 形态）→ 装载顺序不同会出现「面板报服务不可用，而 `$` 复查生效」（或反之）；
- `$` 模式复查：**惰性**读取器（`getGuard = () => ctx.get?.("guard")`，规避插件并发装载）。

两处口径不一致 → 同一会话里对「guard 在不在」可能给出不同答案。

## 决策

- **D1（统一为惰读）**：把 apply 期的 `guard` 快照改为**惰性读取器**（与 `$` 复查、`getSymbols`/`getSessionChannel`/`getRuleEngine` 同款），供 `/guard` 面板与其它消费者使用；不改 `SecurityGuardLike` 类型面（已有结构子集）。
- **D2（行为不变）**：面板在「服务未挂载」时的表现保持不变（原有降级文案/空态）；只在**装载顺序**变化时不再误报不可用。
- **D3（测试）**：① 既有 `/guard` 面板用例不回归（列出可能受影响的用例）；② 新增：**apply 期服务不存在、之后才 provide** → 面板能读到（惰读生效；快照实现下必失败）；③ 反向验证：把惰读退回快照 → ② 必失败。
- **D4（文档）**：`TUI/README.md` 或 `TUI/docs/DESIGN.md` 的 `/guard` 段补一句「服务按惰读获取（与 `$` 复查同口径）」。
- **D5（不做）**：不改 security-guard 侧；不改面板 UI/文案；不动其它包。

## 计划改动文件清单

- `TUI/src/main.ts`（读法统一）、`TUI/src/app/index.ts` 或面板接线处（随读法调整）、`TUI/tests/guard-panel.test.ts`（或既有面板测试文件）、`TUI/README.md`（一句）
- `docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 待办

1. 定位两处读法与面板消费点，统一为惰读。
1. 测试 + 反向验证 + TUI 单包与根验证。
1. 交子代理审阅（只读）→ 关闭 → 归档 → 提交（一次提交）。

## 实现记录（2026-10-02，父会话直接实现）

- `TUI/src/main.ts`：`createRealDshAdapter({...})` 的 `guard` 字段由 **apply 期值快照** 改为 **惰性 getter**（`get guard(): SecurityGuardLike | undefined { return ctx.get?.("guard") … }`），与同文件 `getGuard`（`$` 复查，`:622-624`）及 `sessionChannel` 同口径。
- 用例（+2）：`tests/adapter.dsh.test.ts` 新增「opts.guard 按次读取」（**适配层一侧**：直接 `createRealDshAdapter` + getter，先未挂载 → `refreshGuard()` reject，后 provide → 同一适配器立即读到并渲染面板行）；`tests/main.config.test.ts` 新增结构防呆（`src/main.ts` 含 `get guard():` 且不含旧快照写法）。
- 文档：`TUI/README.md:286`、`TUI/docs/DESIGN.md:341` 各补一句「guard 服务惰读」。
- **偏离清单**（相对计划清单）：新增 `TUI/tests/main.config.test.ts`（结构防呆用例的落点；计划只写了 adapter 侧测试文件）。

## 测试与证据（2026-10-02）

- `TUI`：`npm run check` 无错误、`npm run build` exit 0、`bash scripts/test.sh` **1300/1300 全绿**（+2）。
- **反向验证**：把 `main.ts` 的 getter 退回值快照 → `main.config.test.ts` **恰 1 例红**；还原后 `src/main.ts` sha256 **逐字节一致**（`5484196c…`）→ 1300/1300。
- 全仓：`npm run check` exit 0、`npm run test` **20 包全 `fail 0`**、`npm run build` exit 0。

## 审阅（子代理 `98f0451b`）——结论：**通过**（P3×2 + P4×1，无阻塞）

| 审阅发现 | 处置 |
|---|---|
| 生产路径有效：`createRealDshAdapter(opts)` 全程持 opts 引用（无 `...opts`），`opts.guard` 仅在 `refreshGuard`（`dsh.ts:3445`）/ `guardPolicy`（`:3472`）方法体内按次读取 | 已确认 |
| 回归面：`/guard` 未挂载文案不变（`dsh.ts:3447`，既有用例 `adapter.dsh.test.ts:4957` 通过）；面板 catch 仍 `guard 服务不可用`（`command-panel-guard.test.ts:179`）；全量 1300/1300 | 已确认 |
| **P3①**：新用例 docstring「若任一侧退化成快照必失败」对 **main.ts 一侧为假**（该用例自带 getter、不 import main.ts；main.ts 实际由结构防呆用例守） | 已改写措辞（明确「只覆盖适配层一侧，main.ts 由结构用例守」） |
| **P3②**：`TUI/tests/main.config.test.ts` 不在计划改动清单 | 已记入偏离清单 |
| **P4**：getter 取值在 `try` 块之外（`dsh.ts:3445/3472`）——getter 抛错会绕过适配层错误归一（App catch 后仍是同一条 warn，用户可见不变） | 记入残余（不阻塞） |
| 审阅另验：dispose 后即便仍读到服务，`emit` 被 `dsh.ts:1193` 的 `disposed` 门拦住（与旧快照同表现）；服务卸载后 reject 文案不变、`guardPolicy→undefined`；全仓 `ctx.get("guard")` 调用点只有 `main.ts:576/623`（task-engine 侧已惰性）→ **无第三处需统一** | 已确认 |
| 反向验证（审阅独立复现，/tmp 副本）：退回快照 → **恰 1 例红**；工作区未被改动 | 已确认 |

## 关闭记录

- 条目从项目级 `docs/BACKLOG.md` 清理并重编号；追踪文档移入 `docs/archived/`。
- 残余：① getter 取值在适配层 `try` 之外（抛错绕过错误归一，用户可见行为不变）；② 该条目原应登记在 `TUI/docs/BACKLOG.md`（跨层登记为预存在小瑕，关闭即消失）。
