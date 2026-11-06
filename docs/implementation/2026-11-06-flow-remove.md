# flow-track 删除工具（接取条目：docs/BACKLOG.md「flow-track 删除工具」）

状态：进行中　　开启：2026-11-06
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

给 `flow-track` 补一个模型侧删除工具：删掉 memory-base 项目层（kind `flow`）里的流程记录。按 `id` 删一条，按 `slug` 删该任务的全部记录并回报条数；删完刷新注入用的记录缓存，使「最近记录」不再引用已删条目。

起因：模型侧原只有 `flow_record` / `flow_status`，memory-base 的模型面只有只读 `memory_query`，验证留下的演示记录（`真机验证-demo@测试` 等）无法由模型清理。

## 调研（既有代码）

- 工具面：`flow-track/src/tools.ts:203` 原为 `[flowRecordTool, flowStatusTool]`；`flow_status` 回执每条记录带 `id`（`flow-track/src/tools.ts:190`）。
- 删除面：memory-base 的 `MemoryScope.forget(refs)`（`memory-base/src/scope.ts:116`）按 `{ tier, ids }` 删行，并校验 tier 在注册声明的 `writableTiers` 内；`flow` 注册为 `writableTiers: ["project"]`（`flow-track/src/store.ts:139`），故只能删项目层。
- 记录形态：`title = <slug>@<阶段>`、`content = 状态: <status>` + 可选正文；`FlowStore.list` 把行解析回 `id / slug / stage / status / body`（`flow-track/src/store.ts:248`）。

## 决策

- 参数 `id` 与 `slug` 二选一（2026-11-06 用户裁定）：`id` 删一条，`slug` 删该任务全部并回 `removed` 条数；两者同时给或都不给回 `invalid_args`。
- 删除一律经 `scope.forget([{ tier: "project", ids }])`；句柄缺 `forget` 时返回 `unavailable`（老版本 memory-base 降级，不抛错）。
- 按 `slug` 删除先用 `list({ slug, limit: REMOVE_SCAN_LIMIT })` 定位（`REMOVE_SCAN_LIMIT = 200`），再一次性 forget。
- 只写 `kind: flow`，不带文件改动，不进 `security-guard` 登记表。

## 计划改动文件清单

- `flow-track/src/store.ts`：`ScopeLike` 加 `forget`、`ForgetRefLike`、`RemovalResult`、`REMOVE_SCAN_LIMIT`、`FlowStore.remove`。
- `flow-track/src/tools.ts`：`flow_remove` 工具、工具顺序、相关链接与文件头注释。
- `flow-track/tests/store.test.ts`：fake memory 加 `forget`，补存储侧用例。
- `flow-track/tests/main.test.ts`：fake memory 加 `forget`，补接线用例与工具计数。
- `flow-track/README.md`：工具表、测试条数、真机验证步骤。
- `AGENTS.md`、`README.md`、`README.zh.md`：包描述补 `flow_remove`。

## 实现记录

- `store.ts`：`FlowStore.remove` 返回 `{ ok: true, removed, ids }` 或 `{ ok: false, reason }`；`id` 路径直接 forget，`slug` 路径经 `list` 定位后 forget；`forget` 抛错归 `rejected`。
- `tools.ts`：`flow_remove` 校验参数（二选一、正整数 id），删后调 `deps.onRecorded?.()` 刷新注入缓存，回执 `{ ok, removed, ids }`。
- 注册顺序：`flow_record` → `flow_status` → `flow_remove`。

## 偏差

- 单条删除不先校验行归属：`forget` 以 `{ kind: "flow", id }` 复合定位，id 属于别的分类时 `removed` 为 0，不误删。
- 按 slug 只能扫到最近 200 条（`REMOVE_SCAN_LIMIT`）：记录量超出时需多次删；当前量级远低于此值，未做分页。

## 测试与证据

- `pnpm -C flow-track run check`：`tsc --noEmit` 通过。
- `pnpm -C flow-track run build`：编译到 `dist/` 通过。
- `pnpm -C flow-track run test`：57 例全过（存储 11 例、接线 19 例，含新增的按 id 删 / 按 slug 删 / 删不存在 / 无 forget 降级 / 参数互斥 5 类）。
- `pnpm run check:docs`：115 篇 Markdown、928 个 `.ts`，0 错误 0 警告。
- 未做真机验证：需重启会话（`fff` 走 `install.sh --sync` 刷快照）。

## 收尾

（关闭时填）
