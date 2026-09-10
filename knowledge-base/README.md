# @dsh-toolset/knowledge-base

DSH（DeepSeek Harness）进程内集成插件：跨会话知识库与持久记忆。

- 范围：`docs/DEVELOPMENT-BACKLOG.md` #8-#10（BACKLOG #8 跨会话知识库、#9 写回/淘汰/提升、#10 持久记忆 CRUD）。
- 任务安排：`TASKS.md`；设计对照 `docs/AGENT-ARCHITECTURE-ANALOGY.md` §12。
- 实现契约：`DSH-CTX-API.md`（跨插件共享研读笔记，只读）。

## 命令

```sh
npm run check   # 类型检查（tsc --noEmit）
npm run build   # 编译到 dist/
npm run test    # 运行 tests/*.test.ts（node --test）
npm run demo    # 运行 mock demo（无 DSH 依赖）
```

## 结构

- `src/schema.ts` — 四表结构（sources/chunks）+ 双 FTS5 影子表 + TRIGGER 写直达
- `src/knowledge.ts` — `ctx_knowledge` 四接口（search/put/touch/evict）
- `src/hooks.ts` — session/event 数据源接入（写直达事件过滤器）
- `src/writepolicy.ts` — 两级写策略、LRU+importance 淘汰、resume top-K 提升
- `src/memory.ts` — 持久记忆 CRUD 与过滤检索
- `demo/main.ts` — mock demo（无 DSH 宿主依赖）

## 状态

- 2026-09-10：#8+#9+#10 实现完成（8 条提交）、31/31 测试通过、`check/build/demo` 退出 0，glla 验收审计通过；待真实 DSH profile 挂载联调（人工确认）。
