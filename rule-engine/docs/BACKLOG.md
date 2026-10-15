# rule-engine 待办

> 职责：rule-engine 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、引擎契约与规则表（见 `rule-engine/README.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `rule-engine/docs/archived/`，不在此重复。
> 组织：单一「待办」区（按编号）；条目统一结构——现象 / 现状 → 期望 →（可选）原因 / 接取时裁定 → 落点 → 验收 → 来源·状态·优先级。

## 待办

**1. 回合正文缓冲的 20000 字符截断会让消费者漏检**（2026-10-16 登记）：**现象 / 现状** —— `#buffer` 对单条 `assistant/message` 正文做 `text.slice(0, TEXT_BUFFER_LIMIT)`（`src/engine.ts:67` / `588-594`）后再派发 `assistant-text`, 消费者只看得到前 20000 字符; 截断处之后的内容（例如一张列数不一致的表格）不会被检查, 而 TUI 显示的是全文 —— 判定结论与实际画面不一致（离线夹具: 坏表放在第 20050 字符后 → 显示面报 1、插件面不报）。真机巡检 559 条 `assistant/message` 未出现超限样本（最长 2875 字符）, 属低频问题。**期望** —— 定下超长正文口径: 提高上限 / 按回合累计上限 / 改滑动窗口, 或至少在截断发生时对消费者透明告知（载荷标记或告警）, 不静默丢内容。**落点** —— `src/engine.ts`（`#buffer` / `TEXT_BUFFER_LIMIT`）、`src/types.ts`（若需载荷标记）、`tests/`。**验收** —— ① 超长 step 的判定与显示面一致（或明确告警）; ② 新增用例覆盖超限路径; ③ `npm --prefix rule-engine run check` 与测试全绿。**估时** —— 0.5 天。**优先级** —— P2。**来源** —— 项目级条目「助手正文三面一致核对」的任务 A 实测（追踪文档 `docs/implementation/2026-10-16-three-surface-text-consistency.md` 任务 A 的「决策」1 与「测试与证据」）。〔待办: 2026-10-16 登记〕

**2. `assistant/message` 的 replace 语义与 TUI 不一致（可能对被覆盖内容误报）**（2026-10-16 登记）：**现象 / 现状** —— TUI 对 `surfaceOp === "replace"` 的 `assistant/message` 直接跳过（`TUI/src/app/adapter/dsh.ts` 的 `assistant/message` 分支; 实测显示文本为空）, 而本引擎不看 `surfaceOp`, 照常把该 step 正文缓冲进回合文本（`src/engine.ts:504-508`）。后果: 画面上被覆盖（不存在）的那一步若含表格缺陷, 消费者仍会报出并要求「修正」用户看不到的内容（离线夹具: 显示面不报 / 插件面报 1）。真机巡检 559 条事件未出现 replace（0 条）, 但宿主协议存在该形态。**期望** —— 定下 replace 口径: 与 TUI 对齐（丢弃该 step）或按 replace 重置该 step 的缓冲, 二者择一; 需先确认宿主 replace 的语义（整条消息替换 vs 追加修正）。**接取时裁定** —— ① 丢弃 vs 重置; ② 是否同时影响 `turn-end` 载荷。**落点** —— `src/engine.ts`（`handle` 的 `assistant/message` 分支）、`tests/`。**验收** —— ① replace 场景下派发文本与 TUI 显示一致; ② 新增用例（replace 丢弃 / replace 后仍 append）; ③ 全仓库测试全绿。**估时** —— 0.5 天。**优先级** —— P3。**来源** —— 同上（任务 A 的「决策」4）。〔待办: 2026-10-16 登记〕

**3. `turn/end` 的 `reason` 非字符串时被当成 `completed`（异常收尾会被误唤醒）**（2026-10-16 登记）：**现象 / 现状** —— `handle` 的 `turn/end` 分支只按字符串判定可注入性（非字符串一律回退 `"completed"`, `src/engine.ts` 的 `turn/end` 分支）, 于是**对象形态**（宿主协议里存在 `reason.kind`, TUI 侧 `turnEndReason` 就读它）与 `null` / 数字 / 布尔一律按正常收尾处理 → 照常唤醒消费者与规则。实测: `{ kind: "aborted" }` / `{ kind: "interrupted" }` / `null` / `42` / `true` / `{}` 当前都注入, 而同语义的字符串 `"aborted"` 正确不注入。后果: 被打断 / 出错的回合仍会让消费者检查半截输出并可注入「请修正」类提示。**期望** —— 先按对象形态归一（读 `reason.kind`）再判定; 显式 `null` 与其它非法值按「不唤醒」处理（或给出告警）, 不再默默当成正常收尾。**落点** —— `src/engine.ts`（`turn/end` 分支与 `INJECTABLE_TURN_REASONS` 判定）、`tests/turnEndMatrix.test.ts`（现有断言需反转）、`README.md`（节点表说明）。**验收** —— ① 非字符串形态按 `kind` 归一后判定, `null` / 非法值不唤醒; ② `tests/turnEndMatrix.test.ts` 的「已知缺陷固定」用例改为正向断言; ③ `npm --prefix rule-engine run check` 与测试全绿。**估时** —— 0.25 天。**优先级** —— P2。**来源** —— 任务 C 的 `turn/end` 触发矩阵实测（追踪文档 `docs/implementation/2026-10-16-three-surface-text-consistency.md` 任务 C 的 P3）。〔待办: 2026-10-16 登记〕
