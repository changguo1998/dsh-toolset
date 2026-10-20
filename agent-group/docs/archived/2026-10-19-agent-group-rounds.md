# agent-group 轮次与终止的三个细节（接取条目：agent-group/docs/BACKLOG.md「轮次与终止的三个细节」）

状态：关闭　　开启：2026-10-19　　关闭：2026-10-20
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

用户另行裁定后落地三个边界语义：全组预算、检查间隔、关闭组的边界语义；在此之前保持 `timeoutMs`（每条指令参数，缺省 30 分钟）+ `check` 手动控制的现状。条目明确 P3（等用户定），故本任务以「等裁定」为前提，不先行改动。

## 调研

2026-10-20 用户裁定落地前，三个细节的既有口径：

- **全组预算**：无。`send` 的 `timeoutMs` 是**每条指令**的等待上限（缺省 30 分钟），结算走 `check` 懒判定；组级「任务预算 / 检查间隔 / 关闭边界」未建模（决策项 15 / 20 明确首期不建模轮次与终止）。
- **检查间隔**：无自动巡查；组长靠人工（或模型调工具）按需 `check` 结算未结指令。成员**忙闲状态**（待机 / 工作 / 疑似卡死 / 离线）在项目级 BACKLOG #1「agent 状态检查」落地（跨进程状态牌，见追踪文档 `docs/implementation/2026-10-20-agent-status-board.md`）。
- **关闭组**：无关闭动作；组只会因管理者会话目录删除而消失（落盘文件无 = 空组集）。组内未结指令没有「终止」语义。

## 决策

（2026-10-20 用户裁定，与项目级 BACKLOG #1「agent 状态检查」同任务一并处理）

- **1 全组预算：不定**（用户原话「1 不定」）—— 不设组级预算。维持现状：`timeoutMs` 每条指令 + `check` 懒判定；本任务与状态牌任务均不引入预算计量。
- **2 检查间隔**：由状态牌任务的**巡查**承担 —— 组长侧自动定时巡查缺省 20 s 可配（廉价 Redis 读状态牌，无推理、无目标交互；见 `2026-10-20-agent-status-board.md` 决策②）。指令**结算**的检查（`check`）仍保持手动 / 按需，不并入巡查（结算涉及读任务表与回报解析，比状态牌重，且语义不同）。
- **3 关闭组的边界语义**（用户裁定）：**只有组长（创建组的 agent）可关闭**；关闭 = 组内派发任务结束、**未结指令终止**（收场为超时/取消口径）、**连接关系关闭**（主从 / 平等连接随之失效）、**不连带关闭成员 agent**（成员是否关闭由各自拉起方决定，agent-group 不销毁会话）。
- **实现归属**：本裁定记入本追踪文档；`close_group` 动作及其在「未结终止 / 连接失效」上的落地不在本轮（状态牌任务只记裁定），是否落地由后续条目决定。

## 规划

任务拆分（本轮 = 与「agent 状态检查」同任务）：

- 记录用户裁定（本文件 §决策）。
- 状态牌任务完成后：若管理员接受「裁定落笔即视为处理完成」，本条目关闭并归档；`close_group` 落地（如需）另开条目。

计划改动文件清单：

- 本追踪文档（唯一改动点；状态牌任务的主改动见 `docs/implementation/2026-10-20-agent-status-board.md`）。
- 收尾：BACKLOG #4 标记完成并移除；本文件归档 `docs/archived/`。

明确不做：不做组级预算（裁定 1）；`close_group` 不连带关闭成员 agent（裁定 3）；结算检查不自作主张并入巡查。

## 实现记录

（2026-10-20 用户裁定后落地「关闭组语义」；全组预算 / 检查间隔按裁定不落地代码）

- `agent-group/src/types.ts`：`AgentGroupState` / `GroupView` 加可选 `closedAt`（存在 = 已关闭；缺失即不写键）。
- `agent-group/src/model.ts`：新增 `closeGroup(book, {group, now})` 纯迁移——幂等守卫（已关闭 → `group_closed`）；全部 `open` 指令按**超时 / 取消口径**收场（`status: "timeout"` + `cause: "组已关闭（组长终止未结指令）"` + `settledAt`）；写 `closedAt`。
- `agent-group/src/core.ts`：`close_group` 动作（分派 + 实现）——`caller` 须为组长（`caller === group.managerSessionId`，否则 `not_manager`）；经 `#locked` 串行、落盘、镜像；返回 `closedAt` / `terminated` / `view`。新增 `#closedGuard(book, groupName)` 并在 8 个写动作（add_member / link / link_peer / send / send_peer / broadcast / check / remove）load 后调用——**已关闭组一律拒绝写动作**（`group_closed`），`status` 只读仍可用。
- `agent-group/src/main.ts`：工具 `action` enum 与描述补 `close_group`（10 → 11 个动作）。

## 偏差

- 非组长关闭路径：`#load(caller)` 按调用方会话读各自的书——成员会话名下没有组长组的书，直接 `group_not_found`；代码里的 `caller === group.managerSessionId` 检查是防御性双保险（同书被另一会话读到的极端情形才触发 `not_manager`）。

## 测试与证据

- `agent-group/tests/core.test.ts` 新增 2 用例：组长关闭（未结终止为 timeout + 成因、`closedAt`、再关 / 写动作被拒、status 仍可读、视图带 `closedAt`）；成员会话访问不到组长组（独立书 → `group_not_found`）+ 关闭组上 remove 被拒（守卫覆盖抽查）。
- `agent-group/tests/main.test.ts`：工具定义断言更新（action enum 含 `close_group`）。
- `npm --prefix agent-group run check` 通过；`npm --prefix agent-group run test` **61/61** 绿。

## 收尾

- 待办：格式化改动文件 → 提交询问点 → 提交到 `dsh/agent-group` 分支；条目 1 的消费端（四态判定 + 巡查 + 状态视图）等 `dsh/session-channel` 读数面合 main 后按契约补齐（串行），再进行真机四态验证；BACKLOG #4 移除与归档与条目 1 一起收尾。
