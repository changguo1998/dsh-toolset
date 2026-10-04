# `/new` 启动自检门控取到上一会话的模型（求值窗口）（接取条目：`TUI/docs/BACKLOG.md`「`/new` 启动自检门控取到上一会话的模型（求值窗口）」）

状态：进行中　　开启：2026-10-04　　关闭：—

## 计划改动文件清单（只改这些）

- `TUI/src/app/adapter/tool-bootstrap.ts`（新增纯函数 `newSessionKickoffText`）
- `TUI/src/app/adapter/dsh.ts`（重导出该函数）
- `TUI/src/main.ts`（`kickoffForNewSession` 改用它；注释写明为什么不能读回填值）
- `TUI/tests/tool-bootstrap.test.ts`（门控矩阵用例 + 覆盖说明）
- `TUI/docs/DESIGN.md`（锚定·启动自检一节的 `/new` 判据口径）
- `TUI/docs/BACKLOG.md`（条目标进行中 → 收尾移除）
- 本追踪文档

## 调研（已核）

- 现象位置：`TUI/src/main.ts` 的 `kickoffForNewSession()` 读 `sessionModel.current?.model ?? readDefaultSelection(...)`；`TUI/src/app/index.ts#startNewSession()` 在 `create()` 决议后的**同一同步回合**内 `this.restoreSessionState()`（异步，含会话模型重置）→ 紧接着调该门控 → `sessionModel.current` 仍是**上一会话**的模型。
- 为什么不能「等回填落定再判」：kickoff 必须**先于** rule-engine 的 `session-start` 注入入队（后者在 `session/created` 期排入宏任务；TUI 侧同步发送属微任务 → 结构性在前，见 `docs/archived/2026-10-04-bootstrap-kickoff-order.md` 的实验结论）。把判据挪进 `restoreSessionState().then(...)` 会让 kickoff 退到 rule 注入之后 → 违反该不变量。
- 新会话的模型来源（可同步读到）：适配器 `newSession()` 用 `agentOptions: route`（`main.ts` 建适配器时的启动 route，含 `provider` / `model`）调 `agents.create` → **钉住时以它为准**；未钉住时新会话走宿主默认 → `readDefaultSelection(defaultModelSvc)?.model`（种子）。

## 决策

1. **判据改为「新会话将要使用的模型」**：`pinnedModel（route.model）→ defaultModel（宿主默认选择）`，**删掉 `sessionModel.current` 这一来源**。理由：该值按会话回填、在判据求值时刻属于**上一会话**；而新会话的模型由 `create()` 的 `agentOptions` / 宿主默认决定——两者都可同步读到，无需等 I/O。
1. **保持同步求值**：不动 `startNewSession()` 的时序（kickoff 仍在同一同步回合内发出），只换取值来源——避免触碰「kickoff 先于 rule-engine 注入」的既有不变量。
1. **抽取纯函数** `newSessionKickoffText({enabled, pinnedModel, defaultModel})`（放 `tool-bootstrap.ts`，与 `shouldAutoKickoff` 同处），使门控矩阵可单测；`main.ts` 的闭包只做「接线 + 惰性读服务」。
1. **判据不可读即不发**（两处来源都缺 → `undefined`），与启动路径的 fail-closed 方向一致。
1. **不做**：不改「恢复会话等历史折叠落定再发」；不动宿主；不给该门控加异步等待。

## 实现记录（2026-10-04）

- `tool-bootstrap.ts`：新增导出 `newSessionKickoffText`（纯函数，含「为什么不读会话回填值」的注释，指向时序实验文档）。
- `adapter/dsh.ts`：在 `tool-bootstrap` 的重导出清单里加该函数（`main.ts` 经 barrel 导入）。
- `main.ts`：`kickoffForNewSession` 改为 `newSessionKickoffText({enabled: config?.toolBootstrap ?? true, pinnedModel: route.model, defaultModel: readDefaultSelection(defaultModelSvc)?.model})`，注释写明求值窗口与同步时序约束。
- `tests/tool-bootstrap.test.ts`：新增 2 例（门控矩阵 4 组断言 + 开关/不可读 3 组断言），文件头覆盖说明同步。
- `TUI/docs/DESIGN.md`：锚定·启动自检一节的 `/new` 判据由「当前/默认模型」改为「新会话将要使用的模型（钉住 route → 宿主默认；不读会话回填值）」。

## 测试与证据（2026-10-04）

- `TUI`：`npm run check` ✓；`npm run test:tui` 见收尾复跑（本文件 34 例全绿）。
- 新增用例覆盖条目验收三条：①「非 deepseek 会话 `/new` 不误发」→ 钉住/默认都非 deepseek → `undefined`；②「deepseek 会话 `/new` 且默认模型非 deepseek 也不误发」→ 钉住非 deepseek（默认 deepseek）→ `undefined`（模型来源与上一会话无关）；③「反向组合必发」→ 无钉住 + 默认 deepseek → 正文。
- 反向验证（脚本式，未留痕）：把 `pinnedModel ?? defaultModel` 反转为 `defaultModel ?? pinnedModel` → 门控矩阵用例红（1 例）、其余 33 例绿；恢复后 34 例全绿。
- 已知边界（未做机器守卫）：**接线处**「不读 `sessionModel.current`」由函数签名（只接受两处来源）+ 审阅守卫；若要机器守卫需把门控工厂导出为可注入来源的形式，本次未做（避免为测试引入间接层）。

## 子代理审阅

（决策后一轮 + 收尾前复核合并记录；本项改动面小（1 个纯函数 + 接线 + 文档），一轮覆盖决策、实现、测试与文档四问）

### 审阅（2026-10-04）

只读审阅（`TUI` 1319 例全绿）。结论「可继续」，一条次要 + 一条提示：

1. **[次要] `route.model` 是**启动快照\*\*」：宿主默认模型热更新后（`main.ts` 注释自认该路径存在），门控仍按启动时的 route 判定，而新会话请求可能走**实时默认**（`sessionModel.current` 的种子仅来自显式 config，否则回落实时默认）→ 反例：启动默认 deepseek、中途宿主改 gpt-5 → route 仍是 deepseek → 误发（反向则漏发）。**记为已知边界**（不改法）：① 影响面仅「route 与实时默认背离」这一窗口；② 门控与锁定过滤器同源（`tool-bootstrap.ts` 的 filter 用 `ctxAgent.options.model`），两者自洽——改门控单侧反而会让「门控发/不发」与「是否锁定工具」不一致；③ 要根治需先定「新会话模型的权威来源」并同步 filter，属另一个条目。
1. **[提示] 接线无机器守卫**：确认新增 2 例可失败（反转 `??` 顺序即红）、覆盖条目验收三条；`main.ts` 接线处「不读 `sessionModel.current`」仅由签名 + 审阅守卫（追踪文档声明属实）。已核通过：时序不变量未破（`app/index.ts` 仍在 `restoreSessionState()` 调用后的同一同步回合内求值并同步发送，无新增 `await` / `.then`）、`/model` 边界（新会话不继承上一会话选择，门控同口径）、`toolBootstrap:false` 与双源缺失均 fail-closed、`DESIGN.md` 口径与代码一致、diff 无越界。

## 收尾

- 条目从 `TUI/docs/BACKLOG.md` 移除（表内宽度表条目重编号为 #1）。
- 本追踪文档移入 `TUI/docs/archived/`；本次变更合并为一次提交（`tool-bootstrap.ts` + `adapter/dsh.ts` + `main.ts` + 测试 + `TUI/docs/DESIGN.md` + BACKLOG + 归档文档），提交见 git 历史。
- 复跑记录：`npm run check`（根，20 包）✓、`npm run build` ✓、`npm run test:tui` **1319 例全绿**（含新增 2 例）。
