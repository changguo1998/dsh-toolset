# rule-engine 待办

> 职责：rule-engine 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、引擎契约与规则表（见 `rule-engine/README.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `rule-engine/docs/archived/`，不在此重复。
> 组织：单一「待办」区（按编号）；条目统一结构——现象 / 现状 → 期望 →（可选）原因 / 接取时裁定 → 落点 → 验收 → 来源·状态·优先级。

## 待办

> 2026-10-16 关闭：条目 1-7 全部完成并**从本清单移除** —— 追踪文档归档为 `rule-engine/docs/archived/2026-10-16-test-coverage-and-defects.md`。结论：#1 单条正文上限 20000 → 200000 且超限告警（不再静默截断）；#2 `surfaceOp: "replace"` 的消息丢弃（与 TUI 显示面一致，不进 `turn-end` 载荷）；#3 `turn/end` 的 `reason` 归一（字符串按字面、对象读 `kind`、缺省 `completed`），其余非法值不唤醒 + 告警；#4 新建 `tests/tools.test.ts`（`src/tools.ts` 函数覆盖 33.33% → 100%）；#5 多 `delivery` 分组与段数预算用例；#6 `registerConsumer` / `update` 校验分支用例；#7 零散补钉十点（总行覆盖 93.11% → 100%、函数 89.71% → 97.84%，README 用例数 87 → 140）。证据：`npm --prefix rule-engine run check` 0 错误、`npm test` 140 例全绿、三处修正各做反向验证（撤改即转红）。跨包影响：`md-table-check/tests/surfaceDifferential.test.ts` 的镜像口径待同步（3 例转红，属 md-table-check 任务）。

> 2026-10-16 关闭：「内置谓词层加 `session-fresh` / `session-resumed`（配置可按「是否恢复」筛选）」已完成并**从本清单移除** —— 追踪文档归档为 `rule-engine/docs/archived/2026-10-16-session-predicates.md`。结论：匹配器加会话级上下文（`MatchContext.resumed`）；两个新内置谓词在配置 / 持久化规则 / `rule_add` 工具面（enum 由 `predicateNames()` 派生）直接可用；`resumed` 在**首次见到会话**时按宿主 `session.seq > 0 || inheritedEventCount > 0` 判定一次并在会话内稳定（`src/engine.ts` 的 `#session` / `isResumedSession`），`handle` 各分支兼作「插件后挂载」兜底；`match` 第三参缺省 `{ resumed: false }`（纯函数调用与 `rule_test` 干跑口径）。证据：`npm --prefix rule-engine run check` 0 错误、`npm test` 151 例全绿（+11）、覆盖率 all files 行 100% / 分支 96.96 / 函数 97.90（不回退）、反向验证（`resumed` 恒 false → 6 例转红）。`dedupeInRecord: 1` 仍是「重载不重复注入」的零改动替代（按记录判重, fail-open）。真机验证未做。

**1. 动作面扩展: 在 `tools/pre-execute` 拦截工具调用（消费者 guard 面）**〔进行中: 2026-10-21〕（2026-10-20 登记, 来源: 用户意图「用工具不要把 bash 当万能命令」; 裁定「可以先加在 pre-execute, 拒绝后给出理由, 需要审计的由人工决定」; 原设计 D5 预留「abort / memory 另开条目」）：**现象 / 现状** —— rule-engine 只有 `inject` 一种动作（`DESIGN.md` 边界: `tag` / `abort` / `memory` 不做）, 只能在工具调用事后注入提醒, 无法在执行前拦截; 模型仍能用 `bash` 直跑有专用工具的命令（如 herdr CLI）。**期望** —— 给消费者框架加 `tools/pre-execute` 节点: 宿主在工具执行前唤醒注册在该节点的消费者, 消费者自行判断并返回「放行 / 拒绝（含理由）」。**2026-10-21 用户裁定 B（取代原「内置 `deny-tool` 动作」口径）**: rule-engine 只做调度与汇总（任一拒绝胜出 → `{kind:"deny", reason}`, 否则 `next()`）, 不内置拦截规则、不扩模型工具面; 具体规则由独立插件实现（见项目级 `docs/BACKLOG.md`「新插件 behavior-correction」）; 不内置审计。**优先级** —— P2。**状态** —— 进行中（2026-10-21 接取, 追踪文档 `rule-engine/docs/implementation/2026-10-21-consumer-guard.md`, 决策与规划按裁定 B 已重写）。
