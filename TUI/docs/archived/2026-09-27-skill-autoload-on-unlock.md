# 锚定两阶段解锁后自动加载两个 skill（rule-engine 规则路径）（接取条目：`TUI/docs/BACKLOG.md`「锚定两阶段解锁后自动加载两个 skill（`i-have-adhd` 模拟用户指令、`karpathy-guidelines`）」）

状态：关闭（真机确认通过）　　开启：2026-09-27　　关闭：2026-09-27
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
审阅：用户 2026-09-27 逐条审阅第 9 条（本条）：先问「将来增加其他 skill，两条路线哪个更方便扩展」→ 结论 rule-engine 更可扩展 → 用户选定 **rule-engine 主路径**（见决策）。

## 目标

会话走完锚定引导（首请求锁定小工具集 → 首个 durable `tool/call` 解锁全量工具目录）后，自动加载 `i-have-adhd`（模拟用户指令）与 `karpathy-guidelines` 两个 skill；将来新增 skill 时**只加规则、不改代码**。

## 调研

来源：TUI 源码 + `rule-engine` 源码 + 宿主包。

- 锚定实现：`TUI/src/app/adapter/tool-bootstrap.ts` 的 `installToolBootstrap` 挂 `system-prompt/assemble`；解锁判定 `isPromoted(session)`（进程内 `promoted` 集合 + `session.deriveMessages()` 兜底），**已解锁分支就在同一 waterfall 内**（`tool-bootstrap.ts:404-416`）。
- rule-engine 能力（`rule-engine/README.md` + `src/engine.ts` / `src/inject.ts`）：
  - 匹配面 `tool-call`（事件到达即判定，判定文本 = 工具名 + 参数 JSON）、`tool-result`、`assistant-text`、`turn-end`；
  - 动作 `inject`：构造 **user-role** 消息（`source.kind: "rule-engine"` + `form: "notice"` + `summary`）后经 `agents.get(sessionId)` 投递；
  - 送达路径 `delivery`：`followup`（独立新回合）或 **`next-step`**（`agent.inject`，挂最近 pre-step、**不唤醒**，宿主 rc.2+）；
  - 节流：规则级 `cooldownTurns` / `cooldownMs`，**按会话记账**（`engine.ts:627-629`）→ **`cooldownTurns: 0` = 不节流**（每次命中都注入；同回合内同文本只发一次、回合级条数上限 `maxInjectionsPerTurn`），要「每会话一次」需把该值设为**大于会话回合数**（本条目取 10000）——初版误按「0 = 每会话一次」配置，真机观测到每回合重复注入后修正；
  - 注意：`tool-call` 匹配面在 `match` 为空时视为**永不命中**（防误配置），故规则须带恒真条件。
  - TUI 已支持 `source.form:'notice'` 渲染为一行提示（BACKLOG #46 已完成）。
- 两路线的扩展性对比（用户提问的结论依据）：
  1. **rule-engine**：新增 skill = 加一条规则（`rule_add` 或配置基线），零代码、零构建、当次生效；每条规则可独立 `enabled` / `rule_test` 干跑 / `rule_list` 审计；
  1. **TUI 侧挂钩**：新增 skill = 改 `tool-bootstrap` 文案常量 + 重新 `build` + 重启 dsh；多条 skill 挤在一条指令里，无逐条开关。
  1. 代价：rule-engine 触发时机只能对齐「首个工具调用」（拿不到解锁瞬间），且其注入面**没有 steer**（`AgentLike` 只有 `followup` / `inject`）。

## 决策

选项 → 选定：

1. **载体：rule-engine 规则**（用户 2026-09-27 定案）。理由：可扩展性最好（一 skill 一规则、可逐条开关与干跑），且 rule-engine 本就是为「规则触发自动注入」而建；TUI 侧**不挂钩**（避免两套注入面）。
1. **触发**：`source: "tool-call"` + 恒真条件（`predicates: ["always"]`）；判定文本任意 → 首个工具调用即命中 = 对齐解锁点。
1. **去重**：`cooldownTurns: 10000`（每会话一次；初版 0 = 不节流，已修正）。选择「每会话一次」而非「每回合一次」，与「解锁是会话级一次性事件」的语义一致。
1. **送达**：`delivery: "next-step"`（挂最近 pre-step，不唤醒）——注入在同回合下一 step 前生效，最贴近「解锁后立即带上约束」；若宿主 rc.2 行为异常（回合已收尾挂空，inject.ts 会 warning 跳过），回落 `followup`。
1. **文案**：一条短指令，要求加载两个 skill（`i-have-adhd`、`karpathy-guidelines`）并遵循其规则；将来新增 skill = **新增一条同类规则**（不把新 skill 塞进本条文案），保持「一规则一 skill 组」的可审计粒度。
1. **门控**：规则本身不限模型；因锚定引导只对 `deepseek-*` + `toolBootstrap: true` 生效，非 deepseek 模型下本规则仍会在首个工具调用时注入一次——**接受**（skill 加载与模型无关，加载本身无害），不再加模型判定（rule-engine 无模型面）。

## 规划

任务拆分：

1. 规则定义（可直接 `rule_add` 的载荷）：
   - `id`: `skill-autoload-on-unlock`；`source: "tool-call"`；`match: { predicates: ["always"] }`；
   - `cooldownTurns: 10000`（每会话一次；0 为不节流）；`delivery: "next-step"`；
   - `summary`: `解锁后加载 i-have-adhd / karpathy-guidelines`；
   - `text`: 见下方「规则文案」。
1. 干跑验证：`rule_test(text, "tool-call")` 断言命中；`rule_list` 确认 `origin`（配置基线或运行时层）与节流参数。
1. 真机验证：在启用 rule-engine 的 profile 下跑一轮「提问 → 模型调用一次工具」的会话，确认：① 注入以一行提示出现；② 后续回合行为体现两个 skill（如输出风格与编码约束）；③ **同一会话第二次工具调用不再重复注入**；④ 新会话重新注入一次。
1. 扩展性演练（可选、1 分钟）：再 `rule_add` 一条同构规则（如第三个 skill），确认不重启即生效。
1. 文档：`TUI/docs/DESIGN.md` 锚定工具引导一节补「解锁后经 rule-engine 自动加载 skill」的说明与规则 id；规则正文落在本文档（配置基线如落到 profile，属用户侧文件，不纳入本仓改动）。

计划改动文件清单（**只改这些**）：

- 本追踪文档（规则定义、验证记录）
- `TUI/docs/DESIGN.md`（锚定引导一节回写：解锁后自动加载的机制与规则 id）
- **不改代码**（`tool-bootstrap.ts` / `main.ts` 保持现状）
- 运行时规则（`rule_add`）落在 dsh 状态目录（用户侧），不属仓库文件；如需入仓，落 `TUI/docs/` 记录而非 profile

明确不做：TUI 侧 `onPromoted` 回调与 steer 投递（记录为将来升级路径）；不改 `~/.agents/skills/*` 内容；不做 skill 自动发现（新增 skill 由人加规则）。

## 规则文案（拟）

```
首轮工具已调用、工具目录已解锁。请立即用 skill 工具加载 i-have-adhd 与 karpathy-guidelines 两个 skill 并遵循其规则：i-have-adhd 决定输出风格（首行给动作、多步编号、每回合复述状态、结尾一个下一步）；karpathy-guidelines 决定编码行为（先想后写、最小实现、外科手术式改动、可验证的成功标准）。加载后在本回合继续原任务，不要额外确认。
```

（落地时按 `rule_add` 的 `text` 字段写入；`summary` 用于 TUI 一行提示。）

## 实现记录

**实现（2026-09-27）：规则载荷（唯一交付物，可直接 `rule_add`）**

```json
{
  "id": "skill-autoload-on-unlock",
  "source": "tool-call",
  "match": { "predicates": ["always"] },
  "delivery": "next-step",
  "cooldownTurns": 10000,
  "action": {
    "type": "inject",
    "text": "首轮工具已调用、工具目录已解锁。请立即用 skill 工具加载 i-have-adhd 与 karpathy-guidelines 两个 skill 并遵循其规则：i-have-adhd 决定输出风格（首行给动作、多步编号、每回合复述状态、结尾一个具体下一步）；karpathy-guidelines 决定编码行为（先想后写、最小实现、外科手术式改动、可验证的成功标准）。加载后在本回合继续原任务，不要额外确认。",
    "summary": "解锁后加载 i-have-adhd / karpathy-guidelines"
  },
  "description": "BACKLOG TUI#41：锚定两阶段解锁（首个工具调用）后自动加载两个行为 skill"
}
```

**落地方式（二选一，均不属本仓代码改动）**：

1. 运行时：在启用 rule-engine 的 dsh 会话里对该载荷执行一次 `rule_add`（规则入状态目录，随会话/进程生效，可用 `rule_remove` 撤销）；
1. 配置基线：把同形规则写进 rule-engine 的配置（只读基线层）。

**不加代码改动**：`tool-bootstrap.ts` / `main.ts` 保持现状（决策 1）；本仓只留规则定义与本文档。

**扩展方式（将来加 skill）**：再 `rule_add` 一条同构规则（改 `id` / `action.text` / `summary`）即可，无需改代码、无需重启（逐条可 `rule_test` 干跑、可 `rule_remove`）。若多个 skill 想合并进同一条注入，改 `action.text` 即可；若想逐条独立开关，保持一条规则一个 skill。

## 测试与证据

**契约校验（临时脚本 `tmp/rule-skill-autoload-verify.ts`，跑完即删；不落状态、不改运行时）**：

| 校验项 | 结果 |
| --- | --- |
| `normalizeRule(payload)` | `ok = true`，`warnings = []` |
| 归一化字段 | `source = tool-call`、`delivery = next-step`、`cooldownTurns = 0`（契约校验时的值，后按节流口径修正为 10000）、`enabled = true` |
| `compileMatcher(match, "tool-call")` | `warnings = []`；`match(toolCallText("bash", {command:"ls"})) = true`、`match(toolCallText("read", {path:"a.ts"})) = true`（恒真，任意首个工具调用即命中） |

**真机验证（待用户，在启用 rule-engine + TUI 的 profile 下）**：

1. 应用规则后发一条会触发工具调用的消息 → 注入以**一行提示**出现（TUI 已支持 `source.form:'notice'`，项目级 #46）；
1. 后续回合行为体现两个 skill；
1. **同一会话内不重复注入**（`cooldownTurns: 10000` 的每会话一次语义）；
1. 新会话重新注入一次；
1. 扩展演练：再 `rule_add` 一条同构规则，确认无需重启即生效。

**已知边界（记录在案）**：① 触发时机对齐「首个工具调用」，拿不到纳秒级解锁瞬间；② 命中兜底 `next-step` 不唤醒，若回合恰在工具调用后收尾、注入挂空则宿主记 warning 跳过（不会崩）；③ 规则不判模型，非 deepseek 模型（锚定引导不生效）下也会在首个工具调用注入一次——加载 skill 本身无害，故接受。

## 收尾

- 已回写 `TUI/docs/DESIGN.md`「锚定工具引导」一节：补「解锁后自动加载」的机制、规则 id 与不加代码改动的口径；
- 临时脚本 `tmp/rule-skill-autoload-verify.ts` 已删除；未向任何运行时状态写入规则（不污染本会话/用户 profile）；
- 真机确认（2026-09-27）：用户在启用 rule-engine 的会话中授权后执行 `rule_add`（runtime 层，stateDir `/home/guochang/.dsh/rule-engine`）→ **首个工具调用即触发注入**，注入内容以 `next-step` 落在同一回合的下一步被模型收到，模型随即用 `skill` 工具加载 i-have-adhd 与 karpathy-guidelines；同回合内多次工具调用只注入一次（回合级「同文本只发一次」闸门）。**后续复核（同日）**：`cooldownTurns: 0` 实为**不节流**——下一回合首个工具调用再次触发注入（会话日志亦显示注入本身以 `next-step` 投递），故按决策修正为 `cooldownTurns: 10000`（每会话一次）并更新规则 description；本节所述「每会话一次」以修正后的配置为准。**又一轮复核（同日）**：用户重启 TUI（同一会话经 `-c` 恢复）后再次观察到一次注入——`cooldownTurns` 的已触发记账在**进程内存**里（`engine.ts` 的 SessionState），重启进程即重置，故准确口径是「**每个进程生命周期内一次**」（会话保持不重启则只注入一次）；
- 原待办：用户在真机应用规则并做上面 5 步验证（若验证发现「挂空」频发，再按决策 5 的备选回到 TUI 侧挂钩方案，另开条目）（已完成，本文档归档于 `TUI/docs/archived/`）。
