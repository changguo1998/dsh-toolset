# ast-tools 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块（含库面）的条目。

| # | 条目 | 来源 | 落点 | 工作量 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 1 | **`minSeverity` 类型枚举含非法值 `help`**：`src/types.ts` 的 `RunRulesParams.minSeverity` 写 `"info" \| "warning" \| "error" \| "help"`，而 ast-grep CLI 的 `--min-severity` 只接受 `hint` / `info` / `warning` / `error`（`off` 为「不过滤」）；传 `help` 会 `error: Invalid severity level: help`（exit 2）。模型侧工具 schema 已绕开该值（`src/tools.ts` 用 `hint\|info\|warning\|error`），但**库类型仍是错的** | 2026-10-02 子代理审阅发现（AST 工具面条目的过程记录见 `docs/archived/2026-10-02-ast-tools-model-tools.md`） | `src/types.ts`（+ 可能的 `src/rules.ts` 校验与 README 参数行） | 0.2 h | P1 |
