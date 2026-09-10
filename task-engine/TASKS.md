# task-engine 后续任务安排

> 系列：`DEVELOPMENT-BACKLOG.md` #1-#5、#13（P0/P1）。
> 状态：首版最小闭环已完成并合入 main（单执行器 + 机械门禁 + 两级验收；profile 已挂、4 个 `task_*` 工具注册成功）。以下均为待办。

## 待办：第二迭代

- [ ] fan-out 多执行器（#13：就绪池 + agent-team DAG 并行）
- [ ] semantic 级验收（独立 audit run + outputSchema）
- [ ] step 级 `accepted`/`next` 裁决字段（#5）
- [ ] 语义蕴含校验（门禁第二道，设计文档 §17.2；当前遇 semantic 即 fail-closed 打回）

## 待办：接口对齐（DSH-CTX-API 0.1.2-rc.1）

- [ ] 切 SessionSeq/SessionLogOffset 双序模型（0.1.1-rc.2 的 seq = log length 契约为破坏性变更）
- [ ] turn/end reason 扩展（aborted/blocked/error）对齐门禁与中止路径
- [ ] tool/result.meta 透传

## 验收

对照 BACKLOG #1-#5、#13：单/多执行器全链路可跑通；门禁拒绝与带反馈打回生效；验收按 mechanical/human（及第二迭代 semantic）分级路由；接口对齐后 `npm run check` / `test` 全绿。
