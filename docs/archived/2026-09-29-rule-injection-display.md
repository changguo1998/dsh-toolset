# rule-engine 注入改按用户输入显示（`[RULE]` 前缀）（接取条目：TUI/docs/BACKLOG.md「rule-engine 注入改按用户输入显示（前缀 `[RULE]`）」）

状态：关闭　　开启：2026-09-29　　关闭：2026-09-29
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

rule-engine 的模拟用户注入（`source.kind:'rule-engine'`，如 `skill-autoload-on-unlock`）不再按「一行 notice」显示：消息本体去 `form:'notice'`、正文前加 `[RULE]` 前缀（区分自动注入 / 真实输入 / kickoff 的 `[AUTO]`）；TUI 侧实时按用户块显示、历史折叠为用户消息块，且不参与任务模式分类。

## 调研

来源：`rule-engine/src/inject.ts`、`rule-engine/tests/{inject,main}.test.ts`、`TUI/src/app/adapter/dsh.ts`、`TUI/src/app/adapter/normalize.ts`、`TUI/src/app/adapter/types.ts`、`TUI/src/app/index.ts`、`TUI/src/app/state.ts`、`TUI/tests/{notice-form,adapter.dsh}.test.ts`、`~/.dsh/rule-engine/rules.json`、`docs/archived/2026-09-27-rule-engine-consumer-and-integration.md`（#46/#47 记录）。

- **生产侧**：`buildInjectionMessage(text, summary)` 产出 `source: { kind:'rule-engine', form:'notice', summary }`（`inject.ts:46-56`）；正文来自规则 `action.text`（运行时规则 `skill-autoload-on-unlock`，`delivery: next-step`）。`summary` 语义是「一行提示」；`source.kind` 为 `"rule-engine"`（`SOURCE_KIND`）。
- **TUI 实时路径**（`dsh.ts:1746-1788`，`user/message` 与 `agent/inbox/spliced` 两通道）：`noticeSummaryOf(item)` 命中 → `emit({type:'notice', tone:'log'})` 一行提示；**其余 user 消息不渲染**（注释：用户输入由本地回显覆盖）→ 消息本体去 form 后，实时将不再有任何显示。
- **TUI 历史路径**（`dsh.ts:343-347`）：`user/message` 事件 `noticeSummaryOf(data)` 命中 → `HistoryMessage{role:'notice'}`；否则 `role:'user'`（`surfaceToBuffer` 渲染用户块）。去 form 后自然回落 user 块。
- **判定函数**（`normalize.ts:52-60`）：`noticeSummaryOf` 只看 `source.form === "notice"`，与来源无关（通用机制，不是 rule-engine 专属）。
- **kickoff 口径参照**：`sendBootstrapKickoff` 消息不带 notice form；实时显示由 App 程序化回显（`submitBootstrapKickoff`：`user-line` action），历史恢复折叠为用户块；`firstUserText` 按 `source.kind` 过滤注入消息——模式分类安全。
- **模式分类安全**：`firstUserText` 的 events / 投影两个分支都跳过 `kind !== "user"` 的消息（`tool-bootstrap.ts`）；规则注入 `kind:'rule-engine'` 不参与分类，无需额外改动。
- **既有测试面**：`notice-form.test.ts`（notice 通用机制：`noticeSummaryOf` 判定 + `surfaceToBuffer` notice 行，**与来源无关，保留**）；`adapter.dsh.test.ts:5560-5650`（#17 notice 形态：历史归一 + live 渲染 + 去重，其中 rule-engine 形态的 1-2 条需随语义更新）；`rule-engine/tests/inject.test.ts` 与 `main.test.ts` 断言 `source.form === "notice"`（需更新）。

## 决策

1. **消息侧去 notice form（方案 ①）**：`buildInjectionMessage` 产出 `source: { kind:'rule-engine', summary }`（不再带 `form`），正文由调用方在注入时加 `[RULE] ` 前缀。理由：TUI 改动最小（历史路径零改动即回落用户块）、`summary` 保留给非 TUI 面、语义单一（form 不再是「一行提示」却按用户块显示的矛盾）。
1. **前缀落在消息侧**：`buildInjectionMessage` 内统一加前缀（所有 rule-engine 注入一致，规则文本无需改），正文首行即 `[RULE] …`；非 TUI 面（宿主/其它前端）也据此可辨来源。
1. **实时显示补通道**：因 TUI 实时路径不渲染非 notice 注入，新增 adapter 事件 `{ type:'rule-injection'; id; text }`（`DshEvent` 增成员），在 `user/message` / `spliced` 两通道识别 `source.kind === 'rule-engine'` 时 emit；App 收到后按用户块追加（`user-line`，id 去重），不置回合状态（真实 turn/start 事件仍会画分隔线、活动区清空）。
1. **notice 通用机制保留**：`noticeSummaryOf` 与 `surfaceToBuffer` 的 notice 分支不动（其它插件的 notice 形态注入仍走一行提示）；本次只改 rule-engine 生产面与其 TUI 分支。
1. **不接其它来源**：仅 `source.kind === 'rule-engine'`；`[RULE]` 前缀只加在 rule-engine 注入。
1. **模式分类不动**：依赖既有 `firstUserText` 的 kind 过滤，不新增过滤逻辑。

## 规划

任务拆分：

1. `rule-engine/src/inject.ts`：`buildInjectionMessage` 去 `form`、正文加 `[RULE] ` 前缀；注释更新（说明 TUI 按用户块渲染的口径与 #46 关系）。
1. `TUI/src/app/adapter/types.ts`：`DshEvent` 增 `{ type:'rule-injection'; id: string; text: string }`。
1. `TUI/src/app/adapter/dsh.ts`：实时两通道识别 `source.kind === 'rule-engine'` → 按 id 去重后 `emit({type:'rule-injection', ...})`（复用现有 `renderedNoticeIds` 或并列一个 id 集合）。
1. `TUI/src/app/index.ts`：事件路由新增 `rule-injection` 分支 → `user-line` 追加 + paint（id 去重）。
1. 测试：`rule-engine/tests/inject.test.ts` 与 `main.test.ts`（form 移除 + `[RULE]` 前缀断言）；`TUI/tests/adapter.dsh.test.ts`（#17 相关断言更新 + 新增 rule-engine 实时/历史两条用例）；必要时 `TUI/tests/notice-form.test.ts` 保留不动（通用机制）。
1. 文档：本追踪文档；关闭时回写 `TUI/docs/DESIGN.md`（事件映射表 + 注入显示口径）与 `rule-engine/README.md`（注入消息形状）。

计划改动文件清单（**只改这些**）：

- `TUI/docs/BACKLOG.md`（条目状态）
- `docs/implementation/2026-09-29-rule-injection-display.md`（本追踪文档）
- `rule-engine/src/inject.ts`
- `rule-engine/tests/inject.test.ts`
- `rule-engine/tests/main.test.ts`
- `TUI/src/app/adapter/types.ts`
- `TUI/src/app/adapter/dsh.ts`
- `TUI/src/app/adapter/normalize.ts`（实现期补充：`ruleInjectionTextOf` 判定落点）
- `TUI/src/app/index.ts`
- `TUI/tests/adapter.dsh.test.ts`
- `TUI/tests/injection-display.test.ts`（实现期补充：App 级显示用例）
- `TUI/docs/DESIGN.md`（关闭时回写）
- `rule-engine/README.md`（关闭时回写）

明确不做：不改 `normalize.ts` 的 `noticeSummaryOf`（通用机制）；不改 `surfaceToBuffer`；不给其它来源加前缀；不做规则文本迁移（`~/.dsh` 用户数据不动）；不顺手改相邻代码。

## 实现记录

2026-09-29：

- `rule-engine/src/inject.ts`：新增 `INJECTION_PREFIX = "[RULE] "`；`buildInjectionMessage` 正文改为 `INJECTION_PREFIX + text`，`source` 去 `form`（保留 `kind` / `summary`）；注释更新（说明 TUI 按用户块显示与 #46 通用 notice 机制的关系）。
- `TUI/src/app/adapter/normalize.ts`：**计划外补充**（原清单未列，因 live 判定需要落点在此最干净）——新增 `ruleInjectionTextOf(message)`：`source.kind === "rule-engine"` 时返回正文（trim 后空则 undefined）。
- `TUI/src/app/adapter/dsh.ts`：import + 重导 `ruleInjectionTextOf`；live 路径（`user/message` / `agent/inbox/spliced` 两通道）在 notice 判定**之前**识别 rule-engine 注入 → 复用 `renderedNoticeIds` 按 id 去重 → `emit({type:'rule-injection', id, text})`。
- `TUI/src/app/adapter/types.ts`：`DshEvent` 增 `{ type:'rule-injection'; id: string; text: string }`。
- `TUI/src/app/index.ts`：事件路由新增 `rule-injection` 分支（`renderedRuleInjections` id 集合去重、上限 200）→ `user-line` 追加 + paint；新模式字段 `renderedRuleInjections`。
- 测试：`rule-engine/tests/inject.test.ts`（消息形状：`[RULE]` 前缀 + 无 form；next-step 同口径）、`rule-engine/tests/main.test.ts`（两条旧断言更新）；`TUI/tests/adapter.dsh.test.ts`（#17 三条改用非 rule-engine 来源保持通用机制覆盖；新增 #49 live 与历史两条）、`TUI/tests/injection-display.test.ts`（新增 App 级 1 条：用户行 + id 去重）。
- 中途发现（记入追踪文档，不并入本任务）：规则文本里的既有方括号前缀（如 `[符号规范]`）会与 `[RULE] ` 叠成 `[RULE] [符号规范] …`，可接受（前缀语义不同：来源标识 vs 内容分类）；运行时规则 `~/.dsh/rule-engine/rules.json` 无需迁移（前缀由引擎注入）。

## 测试与证据

- `npm --prefix rule-engine run check` / `build` / `test`：通过（59 pass）。
- `npm --prefix TUI run check` / `build`：通过（0 error）。
- `npm run test:tui`：1207 pass / 0 fail（+3 条新用例：adapter 2 + App 1；#17 三条改用非 rule-engine 来源）。
- 全仓 `npm run test`（15 包并行）：全 OK（TUI 1207 / rule-engine 59，其余包无回归）。
- 构建产物行为校验（`node --input-type=module` 直接 import `rule-engine/dist/src/inject.js`）：
  - `buildInjectionMessage('测试正文','测试摘要')` → `text = "[RULE] 测试正文"`、`source = { kind: "rule-engine", summary: "测试摘要" }`（无 form）；
  - 两次构造 id 不同（唯一性保持）。
- 真机验证（沙箱 tmux，可选）：rule-engine 注入的实际显示需在真机跑一次「新会话 → 首个工具调用 → 注入」观察 `[RULE]` 用户块；本任务以单测 + 构建产物校验为准（真机留待用户下次使用自然确认）。
- 去重推理核对（收尾段复核）：live 回显与「首次恢复历史」不会双份——`history-restore` 整表替换 buffer（既有设计），live 行被替换为历史折叠行；同一消息在 history 内部不会重复（surface 折叠按事件序）。故 App 侧只需 live 双通道 id 去重，无需历史侧去重。

## 收尾

- 回写 `TUI/docs/DESIGN.md`「核心事件映射」表：新增 `rule-engine` 注入 → `rule-injection` 一行（用户块实时追加、id 去重、历史自然折叠）。
- 回写 `rule-engine/README.md`：消息形状（`[RULE] ` 前缀、无 notice form）、两条 delivery 口径、「已知限制」段的呈现说明。
- `TUI/docs/BACKLOG.md`：条目（rule-engine 注入改按用户输入显示）从待办清理移除。
- 本文件移入 `docs/archived/`。
- 计划外调整（已并入上文清单）：`TUI/src/app/adapter/normalize.ts`（判定落点）、`TUI/tests/injection-display.test.ts`（App 级用例）。
- 遗留项：运行时规则文本的既有方括号前缀与 `[RULE] ` 并存（可接受，见「实现记录」）；真机目视留待用户下次使用自然确认。
- 临时文件：无（本轮未建 `tmp/` 产物）。
