# knowledge-base 后续任务安排

> 系列：`DEVELOPMENT-BACKLOG.md` #8-#10。
> 状态：#8-#10 代码实现已完成（31/31 测试 + glla 审计通过）。以下均为待办。

## 待办：宿主联调

- [ ] 真实 DSH profile 挂载（`dsh.bundle` + `cordis.patch.yml`，`link:` 依赖，勿用 `file:`）
- [ ] `ctx_knowledge` 服务注册到宿主 + 人工确认（search/put/touch/evict 在真实会话验证）

## 待办：接口对齐（DSH-CTX-API 0.1.2-rc.1）

- [ ] SessionSeq/SessionLogOffset 拆分（事件摄取偏移）
- [ ] SessionEvent.ignorable 跳过未知事件类型
- [ ] compaction/summary.shadowedRange 摄取
- [ ] 事件词汇表 48→52 同步（新增 model/selection、session-log-deepseek/delivery-accepted、subagent/model-selection-policy；agent-preset/selected 连字符名修正）
- [ ] tool/result.meta 入库

## 验收

对照 BACKLOG #8-#10：检索命中并更新 last_referenced；TRIGGER 双索引同步一致；淘汰/提升规则生效；记忆 CRUD 过滤检索可用；宿主注册后可搜可写；接口对齐后 `npm run check` / `test` 全绿。
