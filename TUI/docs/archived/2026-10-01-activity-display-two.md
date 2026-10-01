# 活动区显示两项（接取条目：`TUI/docs/BACKLOG.md`「模型可见正文未进历史区、内容像是全落在「思考」列」+「启动期（插件装载 / 解析）告警不进活动区」）

状态：关闭　　开启：2026-10-01　　关闭：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

1. 条目一（正文 / 思考二分）：判定「可见正文未进历史区」是模型侧还是 TUI 侧，并给出处置。
1. 条目二（装载期告警）：让装载期告警也能在活动区可见。

## 调研

### 条目一：模型 vs TUI 二分

- 宿主会话日志（`~/.dsh/sessions/--home-guochang-Projects-dsh-toolset--/tui-9c0c2a21…/session.v4.jsonl.zstd`）实测：`assistant/message` 每回合末步都含 **`text` 块**（可见回复原文；turn 98 末步 = 952 字符）与 `reasoning` 块（同回合 9302 字符）——**模型侧有正文产出，宿主有记录**。
- 逐回合末步统计：text 291-952 字符 / reasoning 1.1k-36k 字符 → 思考量约为正文的 **10 倍**。
- 当前屏幕逐列解析（pane 行 = `┃历史…│┃活动…`）：**历史 pane（左）显示可见回复**（backlog 表格、结尾句均在）；**活动 pane（右）显示思考 + 工具调用**。→ 「正文未进历史区」**当前不可复现**。
- 设计口径（`TUI/src/app/state.ts#appendTurnSeparator`）：活动区（思考 / 工具 / notice / 非 final 中间输出）**保留到下一次用户输入才整体清空**；思考属临时 UI 流，不进历史记录。
- 旁证（非本条范围）：会话内 `assistant/attempt` 的 finish 全为 error（RATE_LIMIT 57 / PI_AI_ERROR 2）、`llm/retry` 56 次（`upstream stream closed before a terminal event`）——provider 限流问题，另行对待。
- **结论**：非 TUI 缺陷、非正文丢失；观感成因 = ① 模型推理档位 `max`（会话设置）使思考体量远大于正文；② 活动区保留整回合思考直至下次输入（设计）。

### 条目二：装载期告警时序

- `rule-engine/src/main.ts` 的 `warn`：无订阅者时直写 `process.stderr`（headless 兜底）；装载期（引擎构造 `loadLayer`）告警即走这条路径。
- TUI 的 stderr 桥（`TUI/src/app/stderr-bridge.ts`）在 **TUI 插件 apply 中、App 创建之后**才安装（`TUI/src/main.ts:129`），且桥注释明确「安装前的写入照旧直写」。
- 结果：装载期告警早于桥安装 / `onNotice` 订阅 → 落原始 stderr，活动区看不到（2026-10-01 真机演示复现）。

## 决策

1. **条目一：记录结论，不改 TUI**（条目的「落点」已预留此分支）。可行动项属体验层：调低 `reasoningEffort`（当前 `max`，可在 `/model` 调整）。
1. **条目二：在 rule-engine 侧缓冲装载期告警、首个 `onNotice` 订阅者出现时重放**——自包含、不依赖插件装载顺序。
   - 行为保持：无订阅者时仍写 stderr（headless 兜底不变）。
   - 未采用（备选）：TUI 侧「stderr 桥提前安装 + 缓冲」——依赖插件装载顺序（TUI apply 内安装仍可能晚于 rule-engine apply），且模块顶层安装会污染测试进程。
   - 已知边界：桥已装但尚无订阅者的极短窗口内产生的告警可能「桥一次 + 重放一次」重复；窗口在启动期，影响可忽略（记录备查）。

## 规划

计划改动文件清单（**只改这些**）：

1. `rule-engine/src/main.ts`：`warn` 增装载期缓冲；`onNotice` 首个订阅者注册时重放缓冲。
1. `rule-engine/tests/main.test.ts`：新增用例——订阅前产生的告警在订阅后重放，且 stderr 兜底仍生效。
1. `TUI/docs/BACKLOG.md`：两条目「完成」标记与收尾清理。
1. 本追踪文档。

明确不做：不改 TUI 渲染 / 分栏（条目一结论）；不改 stderr 桥安装时机；不改其它插件的告警出口；不动 provider 限流问题。

## 实现记录

1. `rule-engine/src/main.ts`：`warn` 增装载期缓冲 `pendingNotices`（上限 64 条；无订阅者时仍写 stderr）；`onNotice` 首个订阅者注册时重放缓冲（仅一次，重放后清空）。
1. `rule-engine/tests/main.test.ts`：新增用例「apply：装载期告警挂起——首个 onNotice 订阅者注册时重放（stderr 兜底不变）」。
1. `TUI/src/app/index.ts`：新增 `bootLogPending` 挂起队列——恢复启动（`resumedAtLaunch`）时 `start()` 先置挂起态，`appendExternalLog` 入队；启动历史折叠落定（`flushKickoffPending`）后补发，且**排在 kickoff 之后**（kickoff 开新回合会清活动区）。
1. `TUI/tests/startup-resume-history.test.ts`：新增用例「启动期外部日志：恢复启动时先挂起，折叠落定后补发」。
1. 真机首验发现新问题并当场补完：仅 rule-engine 侧缓冲时，告警**出现但随后被冲掉**——`history-restore` 启动历史折叠会**整表替换 buffer**（既有机制，代码注释已明示）；TUI 侧按既有先例（`kickoffPending`）补完。
1. 条目一为结论项，**无代码改动**。

## 测试与证据

- 单测：`cd rule-engine && npm run test` → 64 pass / 0 fail（新增 1 例：订阅前挂起 + 首个订阅者重放 + 非首个不重放 + stderr 兜底断言）。
- 单测：`npm run test:tui` → 1229 pass / 0 fail（新增 1 例：启动期外部日志挂起 / 落定后补发 / 落定后直入）。
- 机械门禁：根 `npm run check` / `npm run build` exit 0。
- 全量：`npm run test`（根）→ 16 包全绿（TUI 1229 / rule-engine 64 / 0 fail）。
- 真机：第一轮（仅 rule-engine 侧）→ 告警出现在活动区但折叠落定后被冲掉（用户观察）；第二轮（TUI 侧补完后）→ 告警**常驻可见**，用户确认「可以了」；随后已还原 `rules.json`（1122 字节）。

## 收尾

- 回写：无需（口径已落在代码注释与本追踪文档；`DESIGN.md` 未描述启动期日志时序）。
- BACKLOG 清理：TUI 两条目「模型可见正文未进历史区、内容像是全落在「思考」列」与「启动期（插件装载 / 解析）告警不进活动区」已按「完成」清理移除（空章节「渲染与活动区」一并清理）。
- 归档：本追踪文档移入 `TUI/docs/archived/`。
- 残留检查：`git status` 无计划外文件；`tmp/rules.json.bak-tui9` 保留至用户重启确认规则恢复后清理。
- 遗留项：条目一的可选体验改进（思考列折叠 / 收窄）**未立项**——如需另开条目。
