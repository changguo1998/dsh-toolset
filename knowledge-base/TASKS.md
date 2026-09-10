# knowledge-base 后续任务安排

> 系列：`DEVELOPMENT-BACKLOG.md` #8-#10。
> 状态：#8-#10 代码实现已完成（31/31 测试 + glla 审计通过）。以下均为待办。

## 待办：宿主联调

- [ ] 真实 DSH profile 挂载（`dsh.bundle` + `cordis.patch.yml`，`link:` 依赖，勿用 `file:`）
- [ ] `ctx_knowledge` 服务注册到宿主 + 人工确认（search/put/touch/evict 在真实会话验证）

## 待办：接口对齐（DSH-CTX-API 0.1.5-rc.2）

> 已核实：唯一真实摄入 session 事件的插件（`ctx.on('session/event')` + 白名单过滤）。白名单（tool/result、feedback/record、plan/mode、goal/change、todo/write、approval/decided、compaction/summary）不含任何 0.1.5 更名事件，事件更名/词汇增量不适用。

- [ ] tool/result.meta：白名单含 tool/result，摄取时保留/抽取 meta 载荷
- [ ] compaction/summary 新字段：shadowedRange{start,end} 与 sourceCommandId 摄取（白名单含 compaction/summary）
- [ ] SessionEvent.ignorable：确认未知类型可安全跳过（当前白名单已过滤，仅需验证不丢数据）
- [ ] SessionSeq/SessionLogOffset：仅当按日志偏移持久化/去重时对齐（当前按 session id 键控，N/A）

## 验收

对照 BACKLOG #8-#10：检索命中并更新 last_referenced；TRIGGER 双索引同步一致；淘汰/提升规则生效；记忆 CRUD 过滤检索可用；宿主注册后可搜可写；接口对齐后 `npm run check` / `test` 全绿。
