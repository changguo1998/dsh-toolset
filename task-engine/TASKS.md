# task-engine 后续任务安排

> 系列：`DEVELOPMENT-BACKLOG.md` #1-#5、#13（P0/P1）。
> 状态：首版最小闭环已完成并合入 main（单执行器 + 机械门禁 + 两级验收；profile 已挂、4 个 `task_*` 工具注册成功）。以下均为待办。

## 待办：第二迭代

- [ ] fan-out 多执行器（#13：就绪池 + agent-team DAG 并行）
- [ ] semantic 级验收（独立 audit run + outputSchema）
- [ ] step 级 `accepted`/`next` 裁决字段（#5）
- [ ] 语义蕴含校验（门禁第二道，设计文档 §17.2；当前遇 semantic 即 fail-closed 打回）

## 待办：接口对齐（DSH-CTX-API 0.1.5-rc.2）

> 已核实：本插件不订阅 session 事件（无 `ctx.on` 消费；事件更名/词汇增量不适用），交互面仅 `ctx.approval`（turn-enclosed）+ `session.append` + `ctx.subagents`。

- [ ] turn/end reason 扩展（aborted/blocked/error）：核对 approval 链 fail-closed 与中止路径在宿主新 reason 下的行为
- [ ] tool/result.meta：仅当需要透传/渲染工具私有展示载荷时处理（当前不消费 session 事件则 N/A）
- [ ] SessionSeq/SessionLogOffset：仅当 `session.append` 偏移语义影响续体恢复时对齐（当前内部自管事件溯源，N/A）

## 验收

对照 BACKLOG #1-#5、#13：单/多执行器全链路可跑通；门禁拒绝与带反馈打回生效；验收按 mechanical/human（及第二迭代 semantic）分级路由；接口对齐后 `npm run check` / `test` 全绿。
