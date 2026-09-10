# knowledge-base TASKS

## 已完成

### 阶段 1：核心实现（#8+#9+#10，已验收）

- [x] 调研 DSH-CTX-API 契约与 dsh 包内部结构（hooks 注入面、bundle 装配）
- [x] 脚手架：package.json（`dsh.bundle` 声明）+ tsconfig + cordis.patch.yml + index 工厂
- [x] schema：sources/chunks 四表 + 双 FTS5 影子表 + TRIGGER 写直达 + open 守护
- [x] `ctx_knowledge` 四接口（search/put/touch/evict）：分块、去重、联动
- [x] session/event hooks 数据源接入：白名单过滤器 + 事件摘要化
- [x] #9：批量写回、backfill 失败兜底、consolidation 锁、stale 淘汰、top-K 提升
- [x] #10：记忆 CRUD、target/category/project 过滤、token-aware 截断
- [x] 单测（node:test）与 mock demo（`npm run demo`）
- [x] 文档：DESIGN.md / IMPLEMENTATION.md / TASKS.md / README.md
- [x] glla 验收：审计通过（存档 `.pi-glla/archive/20260910132849-yaf437.md`）

### 宿主联调（profile dsh-toolset-kb，2026-09-10 完成）

- [x] 真实 DSH profile 挂载：独立 headless profile `dsh-toolset-kb`，
  `dsh plugin add "@dsh-toolset/knowledge-base@link:<worktree>/knowledge-base"`；
  用户层 `cordis.patch.yml` 配置 dbPath（`KNOWLEDGE_DB_PATH` 可重定向）与 project
- [x] `ctx_knowledge` 服务注册验证：`npm run smoke` 自动化断言（真实 dsh headless 会话后
  知识库文件由 bundle apply 创建 + schema 指纹 application_id/user_version 匹配）
- [x] put/search/touch/evict 往返验证：smoke 对 dist 产物在真实文件库上执行全链通过
  （EN 词干 + CJK LIKE 检索、touch 刷新 last_referenced、evict 清理）
- [x] 真实事件摄取观测：`[tool/meta]`（真实 fs write 载荷）与 `shadowedRange`（真实
  auto-compaction 载荷）入库内容确认
- [ ] （收尾门，不阻塞）真实会话中人工使用 put/search 的最终确认

### 接口对齐（DSH-CTX-API 0.1.5-rc.2，2026-09-10 完成）

- [x] `tool/result.meta` 摄取：`serializeToolMeta` 序列化后以 `[tool/meta]` 段追加至
  chunk 内容（`{}`/`[]`/null 不追加），单测覆盖
- [x] `compaction/summary` 新字段 `shadowedRange`/`sourceCommandId` 摄取：`[compaction]`
  尾注块（shadowedSeqs/shadowedTokenCount/provider/model 一并记录；summary 缺失回落整体
  JSON），单测覆盖（含旧载荷回落）
- [x] `SessionEvent.ignorable` 安全跳过复确认：白名单类型仍摄取（保守）、非白名单类型
  安全跳过，单测覆盖
- [x] `SessionSeq`/`SessionLogOffset` 结论记录 **N/A**：content_hash 全局去重、
  seq/log offset 不消费（IMPLEMENTATION.md §5、DESIGN.md §8）

## 验证

```sh
npm run check   # tsc --noEmit
npm run test    # node --experimental-transform-types --test
npm run build   # 编译到 dist/
npm run demo    # mock demo
npm run smoke   # 宿主联调（真实 dsh 会话，约 1-2 分钟）
```

验证契约机械项（单命令、以仓库根目录为工作目录，不含管道/重定向/逻辑连接）：

```
dsh --version
npm --prefix knowledge-base run check
npm --prefix knowledge-base run test
npm --prefix knowledge-base run build
npm --prefix knowledge-base run smoke
grep -c "shadowedRange" knowledge-base/src/hooks.ts
grep -c "sourceCommandId" knowledge-base/src/hooks.ts
git log --oneline -- knowledge-base
```
