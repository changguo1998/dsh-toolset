# ast-tools `minSeverity` 类型枚举修正（接取条目：`ast-tools/docs/BACKLOG.md` #1）

状态：进行中　　开启：2026-10-02　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`src/types.ts` 的 `RunRulesParams.minSeverity` 写成了 `"info" | "warning" | "error" | "help"` —— `help` 不是 ast-grep 的 severity（库类型非法，模型侧 schema 已绕开）；修正为 CLI 真值域。

## 调研（2026-10-02，ast-grep 0.45.3 实测）

用一条 `severity: warning` 的规则（`rule.yml` 落盘，`ast-grep scan -r rule.yml --json=compact --min-severity <v> a.ts`）实测：

> 命令细节：`-r/--rule` 必给，否则不给规则＝无命中（审阅提醒：漏 `-r` 照抄会得到 `[]`）。

| 取值 | 退出码 | 结果 |
|---|---|---|
| `help` | **2** | `error: invalid value 'help' for '--min-severity <SEVERITY>': Invalid severity level: help` |
| `hint` / `info` / `warning` | 0 | 命中（warning 级 ≥ 过滤线） |
| `error` | 0 | `[]`（warning < error，被过滤） |
| `off` | 0 | 命中（＝不过滤） |

即真值域＝`hint | info | warning | error | off`（`off` ＝不过滤，**也是 CLI 默认值**）；大小写不敏感（`Hint` / `WARNING` / `OFF` 与小写同义，审阅实测）；`none` / `warn` / `INFORMATION` / 空串同样 exit 2。

被拒值实测：`help` / `none` / `warn` / `INFORMATION` / 空串（均 exit 2）。**大小写不敏感**（`Hint` / `WARNING` / `OFF` 与小写同义），类型只收小写规范形。

模型侧工具 `ast_query` 的 `minSeverity` schema 枚举是 `["hint","info","warning","error"]` —— **不含 `off` 也正确**（对模型而言「省略」已是不过滤，无需第二个表达），只有**库类型**错列了非法值 `help`。

## 决策

- **D1（类型值域）**：`minSeverity?: "hint" | "info" | "warning" | "error"`（与模型侧 schema 一致，按「严重度阶梯」——`hint` < `info` < `warning` < `error`）。
- **D2（`off` 进类型，审阅后改定）**：库**类型**按 CLI 真值域写成 `"hint" | "info" | "warning" | "error" | "off"`——原先把 `off` 排除在类型外，却在新 README 里写「`off` / 省略 = 不过滤」，TS 调用方照 README 写会编译失败（自相矛盾）。审阅实测 `off ≡ 省略`（同输出、同 exit code、`--include-metadata` 无差别），故保留在类型内、不引入特例。模型侧 schema 仍只列四级阶梯（对模型「省略」即不过滤）。
- **D3（不加运行时校验）**：本包既定风格是「未知值原样透传给 CLI 校验」（`langs.ts:6`、`types.ts:98`），且 CLI 报错已可读（`Invalid severity level: help`，exit 2 → `binary.ts:203-213` 转 `AstGrepProcessError`，`message` 含原文、`stderr` 完整）→ 不新增校验分支。**措辞订正（审阅 P4）**：「非空未知值」透传 CLI；**空串**被 `rules.ts` 的真值判断（`tools.ts` 的 `str()` 同口径）归一为「未传」→ 不报错也不过滤（实测 `minSeverity: ""` 正常返回命中）。
- **D4（文档）**：`README.md` 的参数行（`rules`：`… minSeverity?`）补上取值与 `off` 说明；`types.ts` 注释同步。
- **D5（验证；已完成，见下方「实现记录 / 测试与证据」）**：① 真值表实测；② 正向用例（真跑 ast-grep：`hint` 命中 / `warning` 滤空 / `off` 不过滤 + 命中 `ruleId`）；③ `@ts-expect-error` 负向断言锁定 `help` 非法（`check`/`build` 编译 tests → 守护有效，审阅已独立复验）；④ 全仓 `check` / `build` / `test`。
- **D6（不做）**：不动模型侧 schema（本就正确）；不改 `rules.ts` 的调用面；不加 severity 别名映射（如 `warn`）。

## 计划改动文件清单

- `ast-tools/src/types.ts`（值域 + 注释）
- `ast-tools/tests/rules.test.ts`（正向用例 + 负向类型断言）
- `ast-tools/README.md`（参数行取值说明）
- `ast-tools/docs/BACKLOG.md`（开工标「进行中」→ 关闭时清理）、本追踪文档

## 实现记录

| 文件 | 改动 |
|---|---|
| `ast-tools/src/types.ts` | `RunRulesParams.minSeverity` 值域改为 `"hint" \| "info" \| "warning" \| "error"`（注释写明阶梯与「`off` / 省略 = 不过滤」） |
| `ast-tools/README.md` | 参数行补取值与语义（`hint`/`info`/`warning`/`error` 阶梯过滤；`off` / 省略 = 不过滤；非法值由 CLI 报错） |
| `ast-tools/tests/rules.test.ts` | ① 正向用例（真跑 ast-grep）：`severity: info` 的规则在 `minSeverity: "hint"` 下命中 1 条、在 `"warning"` 下被滤成 `[]`；② **类型层守护**：`minSeverity: "help"` 配 `@ts-expect-error`（由 `npm run check` 守护，`tsconfig.include` 含 `tests`） |

## 测试与证据（2026-10-02）

- 包内：`npm run check` exit 0、`build` 通过、`npm run test` **38 例全绿**（改前 37 例）。
- 全仓：`npm run check` exit 0、`npm run build` exit 0、`npm run test` **20 包全 OK**。
- **守护机制实测**（本会话中真实发生）：类型修好但 `@ts-expect-error` 位置放错时，`tsc` 报 `TS2578: Unused '@ts-expect-error' directive` + `TS2322: Type '"help"' is not assignable…` —— 即：若有人把 `help` 加回值域，`TS2322` 消失 → `TS2578`（未用指令）会让 `npm run check` **失败**；把指令移到出错属性上方后 check 归零 ✓。
- CLI 真值表（ast-grep 0.45.3，实测见「调研」）：`help` exit 2；`hint`/`info`/`warning` 命中；`error` 过滤掉 warning 级；`off` 命中。
- 未做（记边界）：运行时校验（沿用「非空未知值透传 CLI」的既定风格；空串按缺省处理）、模型侧 schema 未动（本就正确，且与库类型的关系见 README 参数行）。
- 其它边界：**老版本 ast-grep 若没有 `--min-severity`**，本用例会硬失败而非 skip（`helpers.ts` 只在二进制缺失时 skip）；README 未定版本下限（P 级增强，未做）。
- **流程检查点**：本条目沿用用户 2026-10-02 的常驻指令「按 BACKLOG 顺序依次接取并完成（…）每个条目单独提交」——即每条目的提交已获预授权；决策/实现/关闭三点未再逐点阻塞询问（沿用前 10 个条目的既有做法）。
- **顺带发现（不属本任务，未改）**：`docs/STATUS.md:32` 记 ast-tools「27 单测」，实际 38（改动前已漂移）；STATUS 由用户择时更新，项目级 BACKLOG #2「`docs/STATUS.md` 对齐现状」覆盖此事。

## 待办

1. 等子代理审阅结论 → 按需修正 → 关闭条目 → 归档 → 提交（每条目一次提交）。
