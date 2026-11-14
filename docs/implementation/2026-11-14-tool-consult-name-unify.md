# 工具咨询指向名统一（接取条目：docs/BACKLOG.md「`tool_consult` 指向名统一」）

状态: 实现与验证完成（进行中, 待关闭）　开启: 2026-11-14　关闭:
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

把模型可见文本里指向咨询工具的旧称 `tool_consult` 统一为实际注册名 `consult_tools`（`tool-consult/src/tool.ts:15` `CONSULT_TOOL_NAME = "consult_tools"`）。本任务是纯文本统一，不改变注册名、不改变工具行为。

## 现状

- `tool-surface` 的包装层把每个工具的描述收成短说明，并补一句「完整说明与参数 schema 经 tool_consult 查询。」；`tool-consult` 未揭示拒绝文案「请先经 tool_consult 查询后再调用」。这些文本里指向的工具名与实际注册名（`consult_tools`）不一致，模型按文案调 `tool_consult` 会得到一个不存在的工具。
- `tool-consult/README.md` 有一节「短说明指向名」解释该历史写法，统一后该节作废。

## 计划改动文件清单

源码（5）:
1. `tool-surface/src/definition.ts` — `SURFACE_HINT` / `PARAMETERS_HINT` 与 `head.includes(...)` 判断、注释改为 `consult_tools`
2. `tool-consult/src/index.ts:338` — 未揭示拒绝文案 `tool_consult` → `consult_tools`
3. `flow-track/src/tools.ts` — 5 处 summary 文案与注释
4. `flow-track/src/index.ts:240` — 注释
5. `coagent/src/main.ts:282` — 注释

测试（10）:
6. `tool-surface/tests/definition.test.ts`
7. `tool-consult/tests/main.test.ts`
8. `tool-consult/tests/integration/plugin.test.ts`
9. `e2e/tool-surface.test.ts`
10. `e2e/tool-consult.test.ts`
11. `flow-track/tests/main.test.ts`
12. `coagent/tests/integration/plugin.test.ts`
13. `coagent/tests/guard.test.ts`
14. `context-report/tests/main.test.ts`
15. `fs-digest/tests/digest.test.ts`

文档（5）:
16. `tool-surface/README.md`
17. `tool-consult/README.md` — 含「短说明指向名」一节删除
18. `coagent/README.md`
19. `README.md`（英文主档）
20. `README.zh.md`（中文版）

不修改:
- `docs/archived/*`（历史记录，正文当时的写法不作事后篡改）
- `docs/BACKLOG.md` 本条（关闭时移入 §1）
- `tool-consult/src/aliases.ts` 等与旧称无关的文件

## 验证

实做:
- `tool_consult` → `consult_tools` 批量替换 19 个文件（sed, 仅显式列举, 不含归档与 BACKLOG）; `tool-consult/README.md` 三处手工改（含删除作废的「短说明指向名」一节）。
- `pnpm run check` 39 包全绿; `pnpm run build` 全量构建通过（flow-track 等经 `link:` 依赖读到的是 `dist/`, 需重建后测试才反映改动——首次 `pnpm run test` 有 1 例因此失败, 重建后全绿）。
- `pnpm run test` 39 包全绿（flow-track 82 / tool-consult 100 / coagent 77 等）。
- `pnpm run test:e2e` 40/41, 唯一红为计划废弃的 `e2e/ponytail.test.ts`（与本改动无关）。
- `pnpm run check:docs` 通过（120 篇 Markdown / 970 个 .ts, 0 错误 0 警告）。
- `grep -rn "tool_consult"` 仅剩: `docs/BACKLOG.md:79`（本条待关闭）、本追踪文档、两份归档文档（历史记录, 不改）。
