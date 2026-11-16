# task-engine 集成测试两条失败（工具面包装后 schema 与校验语义断言过时）收口

- 日期: 2026-11-16
- 条目: 【项目级 §2】task-engine 集成测试两条失败（工具面包装后的参数 schema 与校验语义断言过时）(P2, 待排查)
- 方案: 修复类, 走标准流程; 接取时裁定经用户批准选**路径 A**（按包装层语义收口, 只改测试, 不改产品代码）
- 状态: 实施中

## 现象

`pnpm run test:integration`（task-engine）18 例中 2 条恒红（已实测确认）:

- ①`参数编译成 JSON Schema`（`plugin.test.ts:83`）: 断言注册面 `task_decompose` 参数
  properties = `[parent_id, children, enumeration]`, 实得 `[]`。
- ②`参数非法`（`plugin.test.ts:242`）: 缺 `children` 调用期望回执 `{ok:false, feedback:/参数非法/}`,
  实为抛 `ToolArgsError`（`invalid arguments: missing required property "value.children"`）。

## 根因

`task-engine/src/plugin.ts:430` 把工具经 `wrapToolDefinition(toDshTool(t))` 注册
（`@dsh-toolset/tool-surface`）:

- 包装层把完整参数 schema 收进全局面 catalog, 注册面换 `placeholderParameters()`（type object +
  空 properties）→ 断言①看注册面 params 拿到空数组;
- 包装层 `execute` 前置 `validateValue(full.parameters, args)`, schema 违规直接 `throw ToolArgsError`
  （`tool-surface/src/definition.ts:134-138`）→ 缺参被前置拦截, task-engine 自己的 `fail()` 回执收不到
  → 断言②过时。

集成套件（`tests/integration/`）不属 `pnpm run test`（只跑 `tests/*.test.ts`）, 故全仓绿而此处红。

## 裁定（用户 2026-11-16 批准, 路径 A）

tool-surface 是统一包装层, 对全部被包装工具一致采用「注册面宽松占位 + 完整 schema 收进 catalog
（`lookupSurface`）+ execute 前置抛 `ToolArgsError`」。task-engine 不作为特例（路径 B = 对 `task_*`
延后校验会破坏统一性, 复杂度高, 弃）。

- 缺参在真实宿主本就以 `ToolArgsError`（`INVALID_ARGS`）标准形态呈现, 集成测试改断言该路径;
- 非法 executor（参数齐全但业务非法）不受前置拦截, 仍走 task-engine `fail()` 回执, 原断言保留
  （覆盖不弱化——验收要求「缺参 / 非法 executor 仍有可断言路径」达成）。

## 计划改动文件清单

- `task-engine/tests/integration/plugin.test.ts`: 断言①改用 `lookupSurface` 读 catalog 完整 schema
  并顺带断言注册面为宽松占位; 断言②缺参改 `assert.rejects`（判 `code === "INVALID_ARGS"`）,
  非法 executor 保留原 `{ok:false, feedback}` 断言。
- 新增 import `lookupSurface`（`@dsh-toolset/tool-surface`, task-engine 已在 `plugin.ts` 依赖）。
- `docs/archived/2026-11-16-task-engine-integration-schema.md`: 本文。
- `docs/BACKLOG.md`: §2 清理该条 + §1 加完成注记。

## 验证

- 修复前实测: `pnpm run test:integration` 18 例中 2 红（断言①、②均红, 形态与记录一致）。
- 修复后: `pnpm run test:integration` 18 例全绿; `pnpm run check`（task-engine）通过;
  全仓 `pnpm run check` 通过（无产品代码改动, 不跑 build / 全仓 test）。
- 覆盖未弱化: 缺必填以 `INVALID_ARGS` 抛错路径仍可断言; 非法 executor 的
  `{ok:false, feedback}` 回执断言保留。

## 收尾

- 已从 `docs/BACKLOG.md` §2 清理该条目。
