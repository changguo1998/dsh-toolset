# 修改默认揭示工具列表（接取条目：tool-consult/docs/BACKLOG.md「修改默认揭示工具列表（initialTools 改为 9 个: 保留 write, 去掉 edit / todo_write, 加 hash_read / hash_edit）」）

状态：已完成　　开启：2026-11-08　　关闭：2026-11-08
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. 把 `tool-consult` 缺省 `initialTools` 从 9 个核心工具调整为 9 个：`bash` / `read` / `glob` / `grep` / `ask_user_question` / `skill` / `hash_read` / `hash_edit` / `write` —— **保留 `write`**（整文件创建 / 覆写, 无追加与局部替换能力, 用户核实后决定保留）, 去掉 `edit` / `todo_write`, 新增 `hash_read` / `hash_edit`（工具名已核对 `hash-edit/src/index.ts:300,332`）。
2. 同步 `tool-consult/README.md`：`initialTools` 缺省值、包定位段的「缺省只留 9 个核心工具」表述改为新名单（仍为 9 个）。
3. 更新配套缺省名单断言（`tool-consult/tests/`）, 全仓 check / build / test 全绿。

## 计划改动文件清单

- `tool-consult/src/config.ts`（`DEFAULT_INITIAL_TOOLS` 换名单, 注释日期同步）
- `tool-consult/cordis.patch.yml`（bundle 层 `initialTools` 换名单; 带注释 YAML 手工编辑, 不跑格式化）
- `tool-consult/README.md`（「能力」段与配置表 `initialTools` 缺省值同步为新名单）
- `tool-consult/tests/config.test.ts`（缺省名单断言按新名单收紧）
- `tool-consult/tests/main.test.ts` / `tests/index.test.ts` / `tests/assemble.ts` / `tests/integration/plugin.test.ts`（假宿主工具面补 `hash_read` / `hash_edit`, `CORE` 期望值换成新 9 个）
- `tool-consult/docs/implementation/2026-11-08-default-tools.md`（本文件）
- `tool-consult/docs/BACKLOG.md`（条目关闭）
- `tool-consult/docs/archived/2026-11-08-default-tools.md`（关闭时移入）

## 实现记录

缺省名单在四处对齐为同一顺序（`bash` / `read` / `glob` / `grep` / `ask_user_question` / `skill` / `hash_read` / `hash_edit` / `write`）：

1. `tool-consult/src/config.ts:60-77`：`DEFAULT_INITIAL_TOOLS` 换名单, 注释写明与 2026-10-22 版的差异（去 `edit` / `todo_write`, 加 `hash_read` / `hash_edit`, 留 `write` 因它是唯一能新建文件的写入口）。
2. `tool-consult/cordis.patch.yml:9-18`：bundle 层 `initialTools` 同步（带注释 YAML, 手工改, 未跑格式化）。
3. `tool-consult/README.md:11` 与配置表 `initialTools` 行：新名单 + 写面分工说明（`write` 建文件 / 整文件覆写, `hash_read` + `hash_edit` 行级锚点读写, `edit` 与 `todo_write` 进按需揭示）。
4. `tool-consult/tests/`：`config.test.ts` 加精确名单断言与「不含 `edit` / `todo_write`」新用例; `main.test.ts` / `index.test.ts` / `assemble.ts` / `integration/plugin.test.ts` 的假宿主工具面补 `hash_read` / `hash_edit`,`CORE` 期望值换成新 9 个（假宿主只按已知工具名展开 `initialTools`, 不补夹具则遮罩少两项）。

## 验证

- `pnpm -C tool-consult run check`：通过。
- `pnpm -C tool-consult run test`：104 例全绿。
- `pnpm -C tool-consult run test:integration`：18 例全绿。
- `pnpm -C tool-consult run build`：通过。
- 根 `pnpm run check`（38 包）：通过。
- 根 `pnpm run test`（34 包并行）：全绿。
- 根 `pnpm run check:docs`：117 篇 Markdown / 948 个 .ts, 错误 0 / 警告 0。
- `format` 逐个跑过改动文件, 均 `unchanged`；`cordis.patch.yml` 按项目约定例外未格式化。

## 未覆盖

- 真机切换：本项只改缺省配置与文档, 未在 profile 上重启验证遮罩实际生效（要生效需 `scripts/install.sh --profile fff --sync` 后重开会话）。
