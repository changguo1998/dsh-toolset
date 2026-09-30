# rule-engine 待办

> 职责：rule-engine 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、引擎契约与规则表（见 `rule-engine/README.md`）
> 编号口径：扁平连续 `#n`，本文件内唯一，**仅供阅读**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `rule-engine/docs/archived/`，不在此重复。

## 待办

- **待办** **#1 子代理会话参与消费者评估 → 已关闭句柄 flush 告警（SessionHandleClosedError）**：现象 —— 子代理结束/被中止后其会话句柄关闭；本引擎仍对子代理会话的 `turn/end` 询问消费者，延迟注入的 flush 打到已关闭句柄 → `warn: 来源 "consumer:symbol-normalizer-guide" flush 失败：SessionHandleClosedError…`（2026-09-30 真机；该提示还渲染在 TUI 输入区，显示位置问题另见项目级 `docs/BACKLOG.md` #61）。原因 —— `src/main.ts` 的 `ctx.on("session/event")` 订阅**不过滤会话**，消费者（`registerConsumer`）对含子代理在内的全部会话评估；`src/inject.ts` 的延迟 flush 对已关闭句柄仅 warn。期望（接取时裁定其一或叠加）—— ① 面向用户会话的消费者/注入面跳过子代理会话（`session.header.origin === "subagent"` / `delegationDepth > 0`）；② 已关闭句柄的 flush 失败静默降噪（会话已结束属正常竞态）。落点：`rule-engine/src/main.ts`（订阅过滤）、`src/engine.ts`（评估面）、`src/inject.ts`（flush 失败处理）+ `tests/`。验收：子代理会话结束不再产生 flush 告警；用户会话注入行为（含 next-step）不变。来源：TUI 小问题批修真机验证发现（2026-09-30，见 `TUI/docs/archived/2026-09-30-tui-small-fixes.md`）。
