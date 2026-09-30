# 插件告警显示改道活动区（接取条目：`docs/BACKLOG.md` #61「rule-engine 的用户提示应显示在活动区」）

状态：进行中　　开启：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

运行期插件告警（如 `[rule-engine] warn: 来源 "consumer:symbol-normalizer-guide" flush 失败：SessionHandleClosedError…`）目前在 TUI 里印在**输入区**附近；改为进**活动区**、可回溯。用户裁定（2026-10-01）：**两个方案都做**（A 兜底 + B rule-engine 结构化通道），并**顺带审计其他插件**的同类情况、登记 backlog 后续处理；告警本身**不抑制**。

## 调研

### 机制（为什么漏到输入区）

1. 插件的告警出口是裸 `process.stderr.write`（rule-engine 三处：`engine.ts:156` 兜底 / `inject.ts:72` 注入器 defaultWarn / `main.ts:130` 插件 warn；`main.ts:188` 加载自证行同路）。
1. TUI **不拦截 stderr**（全仓仅有子进程 stderr 处理）→ 字节直接写到窗格终端，绕过渲染器。
1. 渲染器每帧结束把真实终端光标**定位回输入区光标处**（focus/光标定位设计）→ 字节正好印在输入区；且重绘是\*\*增量（delta）\*\*的（只重写内容变化的行）→ 输入区那几行不被覆盖，残留显眼（`Ctrl+L` 整帧可清）。

### 审计：其他插件的同类写点（运行期 `process.stderr.write`）

- `command-template/src/main.ts:103`（`[name] ${message}` 日志助手）
- `session-title-cutoff/src/main.ts:275`（warn）
- `task-engine/src/main.ts:168`（warn）
- `goal-contract/src/index.ts:41`（warn）
- `session-channel/src/index.ts:229`、`:1386`
- `metric-loop/src/index.ts:423`、`:445`
- `hash-edit/src/main.ts:336`（warn）
- `symbol-normalizer/src/main.ts:110`、`:217`（warn）
- `code-map/src/index.ts:404`（优先 `ctx.logger`，stderr 兜底）
- TUI 自身：`main.ts:167/579/602`、`app/index.ts:2210`、`adapter/dsh.ts:1179/2475/2511`
- 无 `console.*` 写点；无运行期 `process.stdout.write`（stdout 是渲染器通道，插件未用）。

结论：同类情况全部是 **stderr 一类**，均被方案 A 兜底覆盖（显示进活动区）；如需统一结构化 tone / 降噪，另登记项目级条目后续评估（见「规划」第 8 项）。

### notice 通道现状

- TUI#17 已支持**注入消息** `source.form:'notice'` 的一行摘要渲染（`adapter/normalize.ts` 的 `noticeSummaryOf`），但**当前无生产者**；且该写法会把人类告警写进会话/模型上下文。
- 既有先例：`symbol-normalizer` 以**服务订阅**推人类 notice —— `provide("symbolNormalizer", { onReview })`，TUI 订阅后 `this.notice(event.notice, "warn")` 进活动区（`app/index.ts:1431` 附近）。B 采用同构写法。

## 决策

1. **A（TUI 兜底，覆盖所有插件）**：新增 `TUI/src/app/stderr-bridge.ts`——运行期接管 `process.stderr.write`：按行缓冲，完整行交给 App 新公开入口 `appendExternalLog(line, tone)`（进活动区 notice/log 行 + 重绘）；tone 按前缀判定（含 `warn` → 黄 / 含 `error` → 红 / 其余 log 灰）。就绪前与 dispose 后**透传原 stderr**（不吞诊断）；桥内再写 stderr 时防递归（直通原 write）。由 `TUI/src/main.ts` 在 App 创建后安装、随 dispose 回收。
1. **B（rule-engine 结构化通道）**：`rule-engine` 在 `ruleEngine` 服务上增 `onNotice(listener) => dispose`（形状同 `symbolNormalizer.onReview`）；插件 `warn` 路由——**有订阅者 → 只发总线（不写 stderr）**，无订阅者 → stderr（headless 兜底）。TUI 以 `getRuleEngine` 依赖懒读服务并订阅，渲染进活动区（带 `[rule-engine] ` 前缀与 warn tone）。
   - 细化说明：不采用「会话消息 `form:'notice'`」写法（会把人类告警写进模型上下文；且已关闭句柄场景——本条告警的原始场景——投不进已关闭会话）；服务订阅同 symbol-normalizer 先例，且对「告警所涉会话已关闭」同样可送达 TUI。
   - **用户确认（2026-10-01）**：A + B 都做；B 采用**服务订阅**写法（会话消息写法弃用）。
1. **不抑制**：rule-engine 的告警内容与产生条件不变（`rule-engine/docs/BACKLOG.md` #1 维持「暂缓」）。
1. 审计发现：其他插件无需逐个改（A 已覆盖显示）；登记一条项目级条目评估「统一走结构化通道 / 降噪」（P3）。

## 规划

任务顺序：文档（本文件 + #61 状态 + 审计条目）→ 实现 → `check`/`build` → 测试 → 真机复验（触发一次 rule-engine 告警：子代理被中止后观察活动区；输入区无残留）→ 收尾。

计划改动文件清单（**只改这些**）：

1. `TUI/src/app/stderr-bridge.ts`（新增）：桥实现（行缓冲 / tone 判定 / 防递归 / restore），纯函数可测。
1. `TUI/src/main.ts`：安装与回收桥；`getRuleEngine` 接线（懒读 `ruleEngine` 服务）。
1. `TUI/src/app/index.ts`：公开 `appendExternalLog(line, tone?)`；订阅 `ruleEngine.onNotice`（按 `getSymbols` 同款接法）。
1. `TUI/src/app/adapter/types.ts`（按需）：`RuleEngineLike` 最小形状（`onNotice` 订阅）。
1. `TUI/tests/stderr-bridge.test.ts`（新增）+ 订阅渲染用例（并入现有 TUI 测试文件之一）。
1. `rule-engine/src/main.ts`：notice 总线 + `warn` 路由；`rule-engine/src/types.ts`：NoticeEvent 形状与 `RuleEngineService.onNotice`。
1. `rule-engine/tests/main.test.ts`：有订阅者走总线（stderr 无输出）/ 无订阅者 stderr 兜底。
1. `docs/BACKLOG.md`：#61 完成清理 + 新增「插件运行期 stderr 告警统一（评估）」条目（含审计清单）。
1. `TUI/docs/DESIGN.md`、`rule-engine/DESIGN.md`：回写（stderr 桥口径 / notice 总线）。
1. 本追踪文档。

明确不做：不改告警产生条件与文案；不改渲染器主链路；不做「子代理会话过滤」（rule-engine #1 暂缓）；不做顺手改。

## 实现记录

（待写）

## 测试与证据

（待写）

## 收尾

（待写）
