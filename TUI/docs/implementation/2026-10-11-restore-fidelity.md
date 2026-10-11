# 恢复保真两处缺口（接取条目：`TUI/docs/BACKLOG.md` 第 23 条）

状态：进行中（① 已修；② 待续）　　开启：2026-10-11　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标（条目验收）

恢复含辅助行（subagent / 重试等）的会话时该行上屏；恢复含 steer 插队的会话时被续接块显示 `←`、该回合输入块拿终态。

## ① 辅助行不还原 —— **已修**

**根因**：`normalizeHistoryMessages` 只映射 `tool/call` 与 `tool/result`，辅助行事件（如 `llm/retry` / `llm/retry-started`）在恢复链路里被整条丢弃（live 侧由 `state.ts` 的 `retry` / `retry-started` 分支落成缓冲行，重放器有兜底，但恢复侧根本不产这种行）。

**修法**（`adapter/dsh.ts`，与 live 文本字面一致）：

| 事件 | live 口径（`state.ts`） | 恢复侧产出 |
| --- | --- | --- |
| `llm/retry` | `appendNotice("重试 attempt/max (Ns): code message", warn)` | `role: "notice"`，同款文本 |
| `llm/retry-started` | `appendToolLine(retryStartedLine(attempt), "log")` | `role: "tool"`，`retryStartedLine(attempt)`（同一 helper） |

**证据**：真机日志里 `llm/retry`=54 条、`llm/retry-started`=51 条（此前恢复后全部不可见）；用例〈辅助行还原〉断言 notice 文本含 `重试 2/3 (1.5s): ECONNRESET 连接被重置`、tool 行含 `↻`。

**其余辅助行种类**（subagent / hook / command / feedback）：本会话日志里只有 `subagent/catalog`（状态列事件，不是正文行），无可取证的行事件 → 待有真机样本再按同款补（口径：从 live 的 `state.ts` 分支抄文本）。

## ② steer 插队块的终态与 `←` —— 待续

**live 口径**（已读）：`index.ts:1719 case "inbox-claim"` → `deliverLocal({kind:"user-flag", steerContinued:true})` → 上一条用户输入块的 `steerContinued`（渲染 `←`，且不随终态覆盖）；`state.ts:1530` 的 `kind === "steer" → markSteerClaim`。

**恢复侧要做的链路**（四处透传，下一轮照此做）：

1. `adapter/dsh.ts`：`agent/inbox/spliced` 且 `removedCount > 0 && target === "next-step"`（live 侧就是这条判据发 `inbox-claim`）→ 在归一化里给**上一条已产出的用户消息**打 `steerContinued`（新字段），并把该 spliced 的注入项标记为 steer 输入（不拿终态）。
1. `adapter/types.ts`：`HistoryMessage` 增 `steerContinued?: boolean`。
1. `commands.ts` 的 `surfaceToBuffer`：把它透传到缓冲行；`state.ts` 的 `BufferLine` 增同名字段。
1. `replay.ts` 的 user 交付 → `sections.ts` 的 `steerContinued`（条目侧已有该字段与渲染）。
1. 终态归属：`turnStatus` 只落到**该回合的真正输入块**（非 steer 块）——即回填时跳过 `steerContinued` 的块。

**验收用例**（下一轮）：手工事件序列（用户 → spliced steer → 用户 → turn/end）→ 断言被续接块 `steerContinued`、steer 块无终态、回合输入块拿到终态。

## 测试与证据

- ① 用例：`tests/adapter.dsh.test.ts`〈辅助行还原（llm/retry → notice 行；llm/retry-started → tool 行）〉✓
- 全量 `npm test` **1457 / 1457 通过**；`npm run check` 干净；`npm run build` 通过。

## 收尾

（待 ② 完成）
