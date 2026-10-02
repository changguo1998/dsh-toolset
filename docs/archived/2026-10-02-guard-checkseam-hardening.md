# 复查缝硬化：fail-open 粒度 / 事件流可见性 / 审计与回执措辞（接取条目：`docs/BACKLOG.md`「metric-loop 复查缝的两处低优先项」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 目标（三组，均为「复查缝」的收尾）

1. **抛错静默放行（两包同口径）**：`metric-loop` 的复查缝在 `inspectCommand` **抛错**时第 1 次告警、之后**完全静默**放行（`metric-loop/src/index.ts:168-170` 附近）；`task-engine` 的 `makeCommandGuard` 同形（抛错一次告警后无痕）。要求：复查**不可用**要**可见**（不能静默）—— 写进事件流或结果字段，并可计数。
1. **`start` 重复判定**：`metric_loop{action:"start", measureCmd}` 会被判两次（guard pre-execute + 引擎内复查）→ `recent()` 双记录。要求：工具入参侧已由 pre-execute 覆盖，**引擎内复查只对「来自状态文件的命令」生效**（即 tick 路径），start 不再重复判定。
1. **审计与回执措辞**：`recent().toolName` 现承载「来源标注」（如 `metric_loop{tick} id=x`），字段名误导；敏感层回执渲染成「工具：metric_loop{tick} id=x」（其实是来源）。要求：文档口径改为「工具名**或**来源标注」，并把回执里的来源行改成明确的「来源：…」（不再借「工具：」字段）。

## 决策

- **D1（不可见 → 可见）**：两包统一为「抛错/不能判定 → 告警一次 + **在事件流留痕**」：
  - `task-engine`：`plan/frame-executed` 增 `guardSkipped?: true`（或等价标注），`task_stop` 反馈同口径；
  - `metric-loop`：结果 `summary`/`round` 增 `guardSkipped` 标注（tick 路径）。
  - **不做** fail-closed（保持可用性优先），但**必须**可审计。
- **D2（start 不重复判定）**：`metric-loop` 的引擎内复查仅在命令**来自状态文件**时执行（`tick`）；`start` 的工具入参已过 pre-execute → 引擎内跳过并（可选）在结果里注明「入参侧已复查」。
- **D3（措辞）**：`security-guard` 的 `recent()` / `policy()` 文档与 README 说明改为「工具名或来源标注」；`receiptToolName()` 对「来源」形态输出 `来源：<source>` 行（不再写成「工具：」）；新回执**不得**破坏既有断言（如需改动既有断言文本，逐条列出并说明）。
- **D4（测试）**：① `metric-loop`：抛错 → 告警一次 + 结果含 `guardSkipped`；tick 命中 → 不执行 + 回执；start → **只判一次**（`recent()` 单条）；② `task-engine`：抛错 → `plan/frame-executed` 含 `guardSkipped` + 命令执行；③ 回执/审计措辞用例（来源行形态）；④ 既有用例不回归。
- **D5（反向验证）**：撤「留痕」→ 对应用例必失败；撤「start 跳过」→ 双记录用例必失败（两态）。
- **D6（文档）**：`security-guard/README.md`（`recent()` 字段语义）、`metric-loop/README.md` 与 `task-engine/README.md`（复查缝口径：入参侧 vs 状态文件侧、不可用时的可见性）。
- **D7（不做）**：不改判定逻辑本身；不改默认 fail-open 策略；不新增配置项。

## 计划改动文件清单

- `metric-loop/src/index.ts` + `tests/*`；`task-engine/src/{main,engine}.ts` + `tests/exec-guard.test.ts`；`security-guard/src/index.ts`（措辞）+ `README.md`
- `docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 待办

1. 交子代理审阅本文件「决策」。
1. 实现 + 测试 + 反向验证 + 全仓 `check` / `build` / `test`。
1. 关闭条目 → 归档 → 提交（一次提交）。

## 实现记录（2026-10-02）

- **`metric-loop`**：复查器返回结论对象 `{receipt, skipped}`；**抛错告警从「每轮」收敛为「一次」**；引擎内复查只在 `guardScope === "engine-side"` 时执行（工具层 `start` 传 `tool-args` → 不重复判定，**直连 `controller.start()` 缺省仍复查**，不留空洞）；结果**顶层**加 `guardSkipped` + `summary` 标注（未动 `RoundRecord`/持久化 history）；`types.ts` 新增 `GuardScope`。
- **`task-engine`**：`CommandChecker` 返回结论对象；executor 缝经 `ExecuteOutcome.guardSkipped` → `plan/frame-executed.guardSkipped`；验收缝经 `audit` 收集 → `plan/acceptance-verdict.guardSkipped` + `task_stop` 反馈（**成功路径也透出 `feedback`**，否则留痕到不了工具结果）；三种失效模式**各只告警一次 + 每次标 skipped**。
- **`security-guard`**：`receipt.ts` 标签行参数化 + `receiptLabelLine`「工具：/来源：」二态；来源形态（`metric_loop{tick} id=x` 之类）输出 `来源：`，「真工具名」仍输出 `工具：`；`recent()`/`policy()`/`inspectCommand` 口径文档改为「工具名**或**来源标注」。
- 规模：16 文件、**+731/-134**（未动其它包与根 `docs/`）。

## 测试与证据（2026-10-02）

- 用例数：`task-engine` **112**（+3）、`metric-loop` **44**（+2）、`security-guard` **99**（用例数不变，改 1 条 + 新增 1 条反向断言）。
- 新增用例：① executor 缝抛错 → 命令照常执行 + `plan/frame-executed` 标 `guardSkipped`；② guard 未挂载 → 同事件留痕；③ 验收缝抛错 → `task_stop` 反馈 + `acceptance-verdict` 留痕；④ `tick` 抛错 → fail-open + 告警一次 + 结果标 `guardSkipped`；⑤ `tick` 未挂服务 → 同上。
- **既有断言改动 8 条**（原 → 新 → 原因）：a/b/c `exec-guard` 的 `check(...)===null` → `.receipt` + `skipped` 判定（签名变更 + 留痕断言，其中「空串/非字符串回执」明确 `skipped=false`）；d 命中透传同样改 `.receipt`；e `metric-loop` 假 guard 的 `checker` 返回类型与两包对齐；f **apply 用例的 start 来源断言改为成对断言**（`guardScope==="tool-args"` + `calls` 里无 `metric_loop{start}` + `calls.length===1 && calls[0].source==="metric_loop{tick} id=ap"`，防「整条缝删掉也过」）；g 直连 start 用例注释语义明确化（断言仍绿）；h `guard.test.ts` 的 `/工具：metric_loop{tick} id=p1/` → `/来源：…/` + `doesNotMatch(/工具：/)`，并**新增反向断言**「真工具名 `bash` 仍 `/工具：bash/`」。其余既有「工具：」断言与 README 回执示例**未动**且仍绿。
- **反向验证五组**（变异 → 必红 → 还原）：撤 task-engine 事件留痕 → 2 红；撤验收侧收集 → 1 红；撤 metric-loop 结果字段/摘要 → 2 红；撤「start 跳过」→ 3 红（含成对断言）；撤「来源：」措辞 → 1 红。全部还原后 112/112、44/44、99/99。
- 全仓：三包 `check`/`build` rc=0；根 `npm run check` rc=0、`npm run test` rc=0（**20 包全 `fail 0`**，含 TUI 1290）、`npm run build` rc=0；`format` 已跑改动文件；`git diff --name-only | grep src/` 仅 9 个预期文件，无变异残留。

## 审阅（子代理 `45f776d1`）——结论：**有条件通过** → 处置

| 审阅发现 | 处置 |
|---|---|
| **D1 前提写反**：`metric-loop` 抛错是**每次都告警**（实测 3/3），`task-engine` 才是「一次后静默」 | 已按实测实现：`metric-loop` 收敛为**一次告警**；两包统一「告警一次 + 事件流/结果留痕」 |
| **D4④ 与 D2 自相矛盾**：`controller.test.ts:549-551`/`:694-695` 写死「start 也走引擎内复查」 | 已按实测改写为**成对断言**（见上 f/g），并在本文档列明改动 |
| **D2 缺显式传参**（`source` 字符串不足以判定） | 已加 `guardScope`（`tool-args` | `engine-side`）；**直连 start 缺省仍复查**；文案不写「已复查」 |
| 验收缝 / worktree 缝落点未定义 | 验收缝已留痕（`acceptance-verdict` + `task_stop` 反馈）；worktree 缝**不单独落事件**（理由写进 README/DESIGN：每次隔离执行必经同一命令缝，`guardSkipped` 已在同一事件留痕；**回收期** git 调用仅告警可见，记残余） |
| 一致性：非字符串/空串回执未表态；`guardSkipped` 一词两义 | 已明确（`skipped=false`）并断言；D2 侧改名 `guardScope` |
| D3 影响面 | 按实测清单处置：仅改 `guard.test.ts` 那条 + 新增反向断言；其余 14 处与 README/smoke 的真工具名**未动** |
| 文档校准（`metric-loop/README.md` 用例数、`task-engine/docs/DESIGN.md` 口径） | 已改 |
| 「start 不双记录」测试写法 | 已改为「引擎侧未被调用」+「tick 仍被拦」成对断言，删除缝变异会红 |

## 关闭记录

- 条目从项目级 `docs/BACKLOG.md` 清理并重编号；追踪文档移入 `docs/archived/`。
- 残余：① **worktree 回收期**的 `git` 调用不进事件流（仅告警可见）；② `metric-loop` 直连 `createController()` 路径不复查也不标 `guardSkipped`（**长期残余**，按用户口径保留 fail-open）；③ 未跑三包 smoke（需 dsh + 模型凭据）与真机联调（`guardScope="tool-args"` 与宿主 pre-execute 的配合目前只有单测级证据）；④ `plan/step-verdict` 成功路径 `feedback` 分支未单独断言（由 stop 反馈用例间接覆盖）；⑤ 未做 fail-closed、未改判定逻辑与配置项（D7）。
