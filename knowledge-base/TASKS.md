# knowledge-base 开发任务安排

> 来源：`docs/DEVELOPMENT-BACKLOG.md` #8-#10（P0→P1）；分支 `feat/knowledge-base`（基线 c1ad2ae）。
> 定位：与 task-engine **零依赖的并行线**；也是 #9-#11（写回/淘汰/记忆/压缩入库）的底座。

## 进度状态（2026-09-10）

- 已完成：#8+#9+#10 全部实现并分阶段提交（8 条，见 `IMPLEMENTATION.md` §4）；`npm run check/test/build/demo` 退出 0，31/31 测试通过；glla 验收审计通过。
- 未完成：真实 DSH profile 挂载（`dsh.bundle` + `cordis.patch.yml`）联调 + `ctx_knowledge` 服务注册到宿主并人工确认（本机暂无 dsh profile）。

## 目标

**首版（#8）跨会话知识库**：

- 四表结构：sources / chunks + 双 FTS5 影子表（porter + trigram，external content + TRIGGER 写直达）；
- 接口：`ctx_knowledge: search / put / touch / evict`；
- 独立 SQLite 库（搜索密集，独立于 storage KV 域）。

**后续（P1）**：

- #9 两级写策略（写直达事件过滤器 / 批量写回 + consolidation 锁 + backfill 兜底）、LRU+importance 淘汰、resume top-K 提升；
- #10 持久记忆 CRUD 与检索（target/category/项目过滤，token-aware）。

## 任务分解

- [x] 脚手架（同 herdr-integration 流程）
- [x] SQLite schema：四表 + 双 FTS5 + TRIGGER（结构见设计文档 §12.1）
- [x] `ctx_knowledge` 四接口（search/put/touch/evict）
- [x] 数据源接入：session/event hooks（对齐 session-telemetry 事件捕获）
- [x] 写回/淘汰/提升（#9）
- [x] 持久记忆 CRUD（#10）
- [x] 构建部署 + 人工确认

## 复用（不新建）

storage-sqlite、session-query-sqlite（FTS5 底座模式）、session-telemetry（事件源）。

## 约束

- **所有改动仅限本目录（`knowledge-base/`）内；不得修改仓库根目录任何既有文件**；跨目录变更回 `migrate-pi-plugins` 处理。
- 契约对齐 `DSH-CTX-API.md`；设计对照 `AGENT-ARCHITECTURE-ANALOGY.md` §12。
- 变更流程：改代码 → `npm run build` → 人工确认 → 提交；Conventional Commits 中文。

## 验收

对照 BACKLOG #8-#10：检索命中并更新 last_referenced；TRIGGER 双索引同步一致；淘汰/提升规则生效；记忆 CRUD 过滤检索可用。
