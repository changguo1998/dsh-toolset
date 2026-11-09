# task-engine 集成用例的工具 schema 断言同步（接取条目：docs/BACKLOG.md「task-engine 集成用例的工具 schema 断言过期（required 多了 enumeration）」）

状态：关闭　　开启：2026-11-09　　关闭：2026-11-09
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. `pnpm -C task-engine run test:integration` 恢复全绿：把 `task_decompose` 的参数 schema 断言补到当前形态。

## 调研

- 实跑 `pnpm -C task-engine run test:integration`：17 例中 1 例红——`tests/integration/plugin.test.ts:87` 的 `Object.keys(parameters.properties)` 断言, 实际 `['parent_id','children','enumeration']`, 期望 `['parent_id','children']`。
- 条目原文说「`required` 多了 `enumeration`」不准确：`required` 数组由 `compileParameters`（`src/dsh-tools.ts:22-44`）按属性的 `required: true` 生成, `enumeration` 没有该标记；实际 `required` 仍是 `['parent_id','children']`（第 91 行断言未失败）。真正过期的是第 87 行的 properties 名单——`enumeration`（`src/tools.ts:230-234`）进 schema 后没同步。
- 该字段语义是「子任务数超过 8 个时的枚举来源」, 非必填（属主为 `gate.ts` 的 `enumeration` 规则）。

## 决策

1. 修法：a 把 properties 期望补上 `enumeration` / b 改成「包含 …」的弱断言。
   选定 a：断言要盯住工具入参面, 精确名单能挡住意外新增字段；同时保留第 91 行 `required` 精确断言（它正好证明 `enumeration` 非必填）。
2. 不新增字段形状断言（type / description）——本轮只修过期断言；形状由 `tools.ts` 自己的单测覆盖。

## 规划

- 计划改动文件清单：`task-engine/tests/integration/plugin.test.ts`（第 87-90 行的期望名单）
- 明确不做：不动 `src/tools.ts` / `src/dsh-tools.ts`（不是缺陷）、不新增测试文件。
- 验证：`pnpm -C task-engine run test:integration` 17 例全绿；`pnpm -C task-engine run test`。

## 实现记录

- 2026-11-09：`tests/integration/plugin.test.ts:87-90` 的期望名单补 `enumeration`, 保留第 91 行的 `required` 精确断言。

## 偏差

- 条目原文写「`required` 多了 `enumeration`」；实测失败点是 `properties` 名单断言（第 87 行）, `required` 断言（第 91 行）一直通过。按实际失败点修, 未改 `required` 断言（见「调研」）。

## 测试与证据

- 修复前：`pnpm -C task-engine run test:integration` → 17 例 / pass 16 / fail 1, 失败信息 `actual: ['parent_id','children','enumeration']`、`expected: ['parent_id','children']`（第 87 行）。
- 修复后：同一命令 → **17 例 / pass 17 / fail 0**。
- 根 `pnpm run check`（38 包）、`pnpm run build`、`pnpm run test`（38 包全绿）通过。

## 收尾

- BACKLOG 条目已移除；本文件移入 `docs/archived/`。
- 回写：无（测试断言同步, 不改能力面）。
