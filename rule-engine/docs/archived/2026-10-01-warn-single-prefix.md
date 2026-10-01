# 告警文案双前缀（接取条目：`rule-engine/docs/BACKLOG.md`「告警文案双前缀」）

状态：关闭　　开启：2026-10-01　　关闭：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

告警输出只带**一层**前缀：`[rule-engine] warn: <正文>`，不再出现 `… warn: [rule-engine] warn: …`。

## 调研

- 两层来源：入口 `src/main.ts:153-154` 的 `warn` 统一加 `[rule-engine] warn: `（它自己的消息如「ctx.on 不可用…」「工具族注册失败…」**没有**前缀、需要这层）；引擎 `src/engine.ts` 的 **14 处** `#warn(...)` 文案**自带**同一前缀 → 入口再加一层 → 双前缀。
- 引擎 `#warn` 由 `EngineOptions.warn`（`engine.ts:122`）注入，缺省 = 直接 `process.stderr.write`（`engine.ts:155-156`）——缺省路径**没有**入口那层，若只删前缀会让兜底输出丢标记。
- 测试：`rule-engine/tests/*.ts` 中无 `[rule-engine] warn` 字面断言（grep 为空）→ 改文案不触发既有断言。
- 用例落点：`tests/main.test.ts` 已有 apply 级夹具（`fake.listener` 捕获通知）与 `stateDir` 临时目录，可就近加「单前缀」用例（损坏 `rules.json` → 加载告警）。

## 决策

1. **前缀归入口**（`main.ts` 不动）：删掉 `engine.ts` 14 处 `[rule-engine] warn: `，只留正文——即条目期望的「引擎文案去前缀」。
1. **引擎兜底 warn 自加前缀**：缺省 `#warn` 改为 `process.stderr.write(`[rule-engine] warn: ${message}\\n`)`，兜底路径行为不回退。
1. `EngineOptions.warn` 注释写明契约：**注入方负责加前缀**，引擎只给正文。
1. 备选（未选）：入口按「是否已带前缀」跳过——字符串嗅探脆、且留两处真相。

## 规划

计划改动文件清单（**只改这些**）：

1. `rule-engine/src/engine.ts`：14 处文案去前缀 + 缺省 `#warn` 自加前缀 + `EngineOptions.warn` 注释（契约）。
1. `rule-engine/tests/main.test.ts`：新增「单前缀」用例——损坏 `rules.json` 触发加载告警，断言入口通知行只有一个 `[rule-engine] warn: `。
1. `rule-engine/docs/BACKLOG.md`：条目「完成」标记与收尾清理。
1. 本追踪文档。

明确不做：不改 `main.ts` 的 `warn`；不改告警显示改道（通知 / 日志）通路；不动其它文案。

## 实现记录

1. `src/engine.ts`：14 处 `#warn` 文案自带的 `[rule-engine] warn: ` 批量去除（`grep -c` 由 14 → 0），保留正文。
1. `src/engine.ts`：缺省 `#warn`（宿主未注入时的兜底）改为自带一层前缀；`EngineOptions.warn` 注释写明契约「注入方负责加前缀，引擎只给正文」。
1. 核查同包其它出口：`inject.ts` 全部 `warn(...)` 文案无前缀（其 stderr 兜底自带，与引擎改法一致）；`persist.ts` 的 warnings 文案无前缀，无需改。
1. `tests/main.test.ts`：既有「告警改道」用例两处断言由宽松匹配加严为**严格等值**（总线与 stderr 各一处，期望 `[rule-engine] warn: registerConsumer 的 id 必须是非空字符串`）——双前缀必然失败，等价 RED。

## 测试与证据

- 单测：`cd rule-engine && npm run test` → 63 pass / 0 fail。
- 全量：`npm run test`（根）→ 16 包全绿（rule-engine 63 / TUI 1228 / 0 fail）。
- 机械门禁：`npm run check` exit 0；`npm run build` exit 0。
- 真机（2026-10-01，点 3，用户选「在活动区亲眼看」）：
  - 装载期路径：备份并临时写坏 `~/.dsh/rule-engine/rules.json` → 用户重启 → **装载告警未进活动区**（见「新发现」）→ 收尾已还原（1122 字节）。
  - 运行期路径：临时探针规则（`rule_add` 带未知谓词触发 normalize 告警）→ 活动区出现 `[rule-engine] warn: 未知谓词名 "__unknown_predicate__"，已忽略`（**单前缀** ✓，用户「中途看到了」）→ 探针已删。
- 新发现（已登记条目）：**装载期告警不进活动区**——引擎构造时（`loadLayer`）的告警早于 TUI stderr 桥安装 / `onNotice` 总线订阅，按桥设计直写原始 stderr；条目见 `TUI/docs/BACKLOG.md`「启动期（插件装载 / 解析）告警不进活动区」。

## 收尾

- 回写：无需（前缀契约已写进 `EngineOptions.warn` 注释；README / DESIGN 未描述告警前缀细节）。
- BACKLOG 清理：rule-engine 条目「告警文案双前缀」已按「完成」清理移除（「## 待办」区现为空）。
- 归档：本追踪文档移入 `rule-engine/docs/archived/`。
- 残留检查：`git status` 无计划外文件；`tmp/rules.json.bak-warncheck`（演示用规则备份）保留至用户重启确认规则恢复后清理。
- 遗留项：无（新发现「装载期告警不进活动区」已另立条目 `TUI/docs/BACKLOG.md`）。
