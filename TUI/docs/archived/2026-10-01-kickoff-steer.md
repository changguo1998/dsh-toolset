# 启动自检 kickoff 改走 `steer`（接取条目：`TUI/docs/BACKLOG.md`「启动自检 kickoff 的发送通道由 `followup` 改为 `steer`」）

状态：已完成　　开启：2026-10-01　　关闭：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

三种场景（启动新会话 / 启动恢复会话 / `/new` 补发）汇入的启动自检 kickoff，通道由 `followup`（next-turn：要等新回合）改为 `steer`（next-step：当前回合的下一步即可领取；空闲时立刻起回合），与「尽快驱动模型发起首个工具调用完成解锁」一致；无 `steer` 的宿主回落 `followup`（降级不丢、日志可见）。

范围：仅 kickoff 这一条链；`/init` 等用户命令走普通输入通道，不受影响；App 侧回显与门控（`shouldAutoKickoff` / `kickoffForNewSession`）不变。

## 计划改动文件清单

代码：

- `TUI/src/app/adapter/dsh.ts`：`sendBootstrapKickoff()` 优先 `activeCommandAgent.steer` → `activeAgent.steer` → `followup`（次序与 `sendMessage(target:"next-step")` 一致，含 stderr 降级日志）。
- `TUI/src/app/adapter/types.ts`：`sendBootstrapKickoff` 契约注释补通道口径。（`main.ts` 瘦 `agentLike` 无需加 `steer`：adapter 优先用原始宿主 agent，`activeCommandAgent` 随 resume/new 同步切换。）

测试：

- `TUI/tests/adapter-steer.test.ts`：新增 kickoff 两例（有 steer → `raw-steer` 且消息仍是 `tool-bootstrap`；无 steer → 回落 `thin-followup`）。
- `TUI/tests/adapter.dsh.test.ts`：既有 kickoff 用例改名并注明它是「无 steer 宿主」的降级分支。

文档：

- `TUI/docs/DESIGN.md`「启动自检 kickoff（2026-09-28）」补通道一句；`TUI/docs/BACKLOG.md` 条目状态维护与收尾清理。
- 本文件。

## 设计

- **查找次序**（与 `sendMessage` 的 `next-step` 分支完全一致）：`activeCommandAgent.steer`（宿主原始 Agent，官方 API）→ `activeAgent.steer`（瘦 agent，兼容旧接线）→ `activeAgent.followup`。
- **为何不用 `canSteer()`**：该方法是 adapter 对 App 的能力查询（`this` 语义不明、非纯函数式），kickoff 与 `sendMessage` 共用同一段两层判据更直白；两者次序一致即可满足 `canSteer()` 的对外承诺。
- **降级可见**：无 steer 时写一行 stderr（`[dsh adapter] sendBootstrapKickoff: 宿主无 steer，回落 followup`）——kickoff 无用户交互，App 侧降级提示通道不适用。
- **消息本体不变**：`buildBootstrapKickoffMessage()`（`[AUTO]` 前缀 + `source.kind:"tool-bootstrap"` + uuid）原样投递，仅换通道。

## 验证

- `npm run check`（TUI 单包）：通过；`npm run build`（TUI）：通过（dist 已更新）。
- `npm run test:tui`：**1275 通过 / 0 失败**（新增 2 例 kickoff 通道用例；`adapter.dsh.test.ts` 180 例含既有 kickoff 降级分支回归）。
- **真机验证项（待人工确认）**：① 启动新会话 / 启动恢复会话（`-c`）/ `/new` 三场景，会话记录里 kickoff 出现在 `agent/inbox/spliced{target:"next-step"}`（不再是 next-turn），且在当前回合内被领取；② 空闲启动时 kickoff 立刻起回合（不被排到下一回合）；③ 无 `steer` 的宿主上仍能发出，stderr 出现降级行。

## 过程记录

- 只动 kickoff 一条链；`/init` 等其它注入路径未触碰。
- `main.ts` 未改：核查后确认 `commandAgent: rawAgent` 始终传入且 `activeCommandAgent` 随 resume/new 同步（dsh.ts:3559 / 3614），故瘦 `agentLike` 无需补 `steer` 转发（条目里那条「必要时」不成立）。
