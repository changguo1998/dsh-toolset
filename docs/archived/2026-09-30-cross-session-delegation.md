# 跨会话委托/协调（planner-worker 语义）（接取条目：`docs/BACKLOG.md`「跨会话委托/协调（planner-worker 语义）：把一个任务交给另一个会话执行并回收结果」）

状态：进行中　　开启：2026-09-30
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

在既有 `session-channel`（#30：专用 Redis + unix socket，消息注入目标会话下一回合）之上加**任务语义**：
把任务交给另一个会话执行，并把结果回收给委托方。四个必备件：**消息类型**（任务 / 结果 / 状态）、
**任务表**（谁委托给谁、何时、状态、结果）、**结果回传**、**失败与超时**。

## 调研（既有面）

- 注入面：`inject.ts` 的 `injectUserMessage`（`agents.get(id).followup()` + `sessions.flush()`，宏任务推迟）——
  任务投递复用这条路径（任务正文即注入文本，带 taskId）。
- 服务面：`provide("sessionChannel", …)` + `SERVICE_FACE_METHODS` 键集合守卫（D5）——新增方法须同步清单与守卫测试。
- 存储：Redis（专用实例）已有 KV 面（last-value + 版本号 + CAS）；任务表另设键（不复用 KV，避免语义混淆）。
- 投递面：reader loop 按 stream 读新消息并投递本进程会话；跨进程会话由对端实例自行读取。

## 规划（含过程中增补）

计划改动文件清单：

1. `session-channel/src/types.ts`：任务类型（`TaskRecord` / `TaskStatus` / `DelegateRequest` 等、`task_*` 错误码）。
1. `session-channel/src/keys.ts`：任务键（`task:<id>`、`tasks:<sessionId>` 索引）与解析函数。
1. `session-channel/src/tasks.ts`（**新增**，计划外增补）：纯函数面（常量、注入 / 通知文案、UTF-8 截断、
   补丁合并规则 `applyTaskPatch`、超时懒判定 `withTimeoutCheck`）。
1. `session-channel/src/broker.ts`：任务表读写（`putTask` / `getTask` / `patchTask` / `listTasksOfSession` /
   `listAllTasks` / `countTasks`）。
1. `session-channel/src/index.ts`：服务方法（`delegate` / `taskStatus` / `taskList` / `taskCancel` /
   `taskResult`）、结果回收（`user/message` 对位 + `turn/end` 自动回收）、委托方通知、三个工具
   （`channel_delegate` / `channel_task` / `channel_task_result`）、服务面键清单与 provide 同步。
1. `session-channel/tests/task.test.ts`（**新增**）+ `tests/apply.test.ts`（工具数量断言 1 → 4）。
1. `session-channel/README.md`、根 `README.md`（英）与 `README.zh.md`（中）：能力表 / 服务面 / 键位 / 边界。
1. 本追踪文档；`docs/BACKLOG.md` 状态与收尾。

## 决策记录（用户 2026-09-30 裁定）

1. **结果回收：两者都要** —— `turn/end` 自动回收兜底 + `channel_task_result` 显式回传（`tool` 来源优先）。
1. **agent 工具面：本次一并做** —— `channel_delegate` / `channel_task` / `channel_task_result` 三个工具。
1. **结果体量**：结果全文上限 64 KB（超出截断并标注）；回传通知注入正文截断到 8 KB。
1. 实现者补充（已在 README 记录）：任务表 `task:<id>`（TTL 7 天）+ 每会话索引 `tasks:<sid>`（LTRIM 50）；
   状态机 `pending → running → done/failed/canceled/timeout`，超时按读取时懒判定（缺省 1800 秒），
   终态不可回退；任务注入正文**不带** `[CHANNEL](来源)` 前缀（由投递路径统一加，避免双前缀）。

## 实现记录

- 2026-09-30：类型与键位（`types.ts` / `keys.ts`）；纯函数面新模块 `tasks.ts`；broker 任务表读写。
- 2026-09-30：服务面五方法 + 两个内部事件处理（`#onTaskEvent`：`user/message` 对位、`turn/end`
  自动回收）+ 通知注入（`RESULT <id>: …` / 失败与超时文案）+ 三个工具的定义与注册 +
  `SERVICE_FACE_METHODS` 与 provide 同步。
- 2026-09-30：README（包 + 根中英）契约、能力表、键位表与边界更新；`tests/task.test.ts` 新增 6 例。
- 2026-09-30：真机验证发现工具注册缺 `output` 元数据 → 修复（提交 `116d5d3`）并加回归断言；
  真机复测：自动回收、显式回传、三个工具可用、跨进程 RESULT 注入全部通过。

## 测试与证据

- `npm --prefix session-channel run check` ✓；`build` ✓；`npm --prefix session-channel run test`
  **41/41** ✓（含新增 6 例：纯函数、补丁规则、任务表真 Redis、委托端到端自动回收、显式回传优先、
  取消 / 离线 / 非法 id 错误码）。
- 端到端用例覆盖：A 委托 → B 收到 `TASK <id>:` 注入 → `user/message` 对位为 `running` →
  `turn/end` 自动回收最终回答（`resultSource:"auto"`、`triggerSeq` 记录）→ A 收到 `RESULT <id>:` 通知；
  显式 `taskResult` 后 auto 不覆盖；`taskCancel` 终态锁定；`to` 离线返回 `target_offline`。
- 全仓 `npm run check` ✓。
- **真机验证（2026-09-30，通过）**：
  1. 自动回收：本会话经 `delegate` 委托另一 dsh 进程的会话（`delivered:true`），
     worker 注入 seq 46 → 状态 `running` → 轮末自动回收，`resultSource:"auto"`、结果「委托链路 OK」；
     委托方会话收到注入 `[CHANNEL](tui-34ffeca8…) RESULT 9afdfd9f…: 委托链路 OK` ✓。
  1. 显式回传：同会话内自测（`to` = 自身）→ `channel_task_result` 回传 → `status:"done"`、
     `resultSource:"tool"`、结果「显式回传 OK（真机）」✓（验证 worker 侧工具可用与 tool 优先）。
  1. 工具面：`channel_delegate` / `channel_task` / `channel_task_result` 三个工具在会话内可见可调 ✓。
- **真机发现并修复的缺陷**（`116d5d3`）：三个新工具缺少 `output: {schema, render}` 元数据 →
  宿主 `tools.register` 拒绝注册（单测假 register 不校验，故此前未暴露）；补齐元数据并加回归断言
  （每个工具的 `output.render` 必须是函数）。

## 收尾

- 状态：**完成**（`docs/BACKLOG.md` #54 从 §2 移除并记入 §1 索引；§3 里程碑剩余列表同步）。
- 落点：`session-channel/src/{types,keys,tasks,broker,index}.ts`、`tests/task.test.ts`（新增）、
  `tests/apply.test.ts`、`session-channel/README.md`、根 `README.md` / `README.zh.md`；
  本文档随收尾提交移入 `docs/archived/`。
- 提交：`8df3693`（实现 + 测试 + 文档）、`116d5d3`（工具 output 元数据修复）、本收尾提交为最后一次。
- 遗留：任务表无「订阅 / 推送」面（拉取式，`taskStatus`/`taskList` 查询）；跨机不覆盖（#30 边界）；
  任务正文与结果不落知识库（如需另立条目）。
