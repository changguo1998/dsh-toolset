# md-table-check 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

## 条目详情（待办）

（无。）

## 已裁定不做（备查，口径与代价见 `README.md`「边界」与「已核查形态」）

- **宽度不足导致的退回**、**伪表格（缺分隔行）识别**：均不做，理由见 `README.md`「边界」（2026-10-15 用户裁定）。
- **与 TUI 抽公共切分模块**：不做 —— 本包独立实现 + `tests/tuiParity.test.ts` 与 TUI 源码互证，不引 TUI 内部模块
  （2026-10-15 用户裁定）。
- **表头与分隔行之间有空行的表格**：**不检出**（该形态列数一致、只是没被认成表）；`tests/checker.test.ts` 与形态快照钉住 `tableTotal === 0`（2026-10-16 用户裁定）。
- **行内代码里的竖线按字面切分**：**保持与 TUI 同口径**，不引代码跨度感知（2026-10-16 用户裁定；代价见 `README.md` 形态表）。

> 2026-10-16 关闭：条目 3-6 全部完成并**从本清单移除** —— 追踪文档归档为 `md-table-check/docs/archived/2026-10-16-test-coverage-and-tsconfig.md`。结论：#3 `tsconfig` 改双 program（主 program `exclude` 三个跨包用例 + 新增 `tests/tsconfig.json` 把它们纳入检查面）、修掉 `surfaceDifferential.test.ts:113` 的类型收窄、`check` 串跑两个 program —— 包 check 退出码 0，根仓 `npm run check` 22 包全绿；#4 新增 `tests/integration.test.ts`（真实 rule-engine 端到端：注入 1 次 / `source.summary` / `via === "followup"` / `dedupeInRecord: 0` 两回合各 1 次）；#5 配置四字段透传断言 + 变异反向验证（改坏 `resolved.check` 即转红）；#6 零散补钉（降级两分支、围栏混用标记对齐 TUI、行尾裸 `\`、围栏变体、上限 0 钉口径、互证⑤ 改 import TUI 真实 `FENCE_RE`、`FEEDBACK_SUMMARY` 常量引用、数据行 `\|`、README 口径与用例数）。另同步 rule-engine 2026-10-16 行为变更引发的对拍差异（3 例转绿）。证据：包 `npm test` 73 例全绿（原 61）、`src` 覆盖率行 / 分支 / 函数 100%、两次反向验证、`build` + `check:no-cross-emit` 通过且不再往他包 `src/` 落产物。条目 1 / 2 按用户裁定转入上方「已裁定不做（备查）」。

> 2026-10-16 关闭：「`maxTables: 0` 等上限参数的 0 语义统一为「不设上限」」已完成并**从本清单移除** —— 追踪文档归档为 `md-table-check/docs/archived/2026-10-16-limit-zero-unbounded.md`。结论：三个上限参数（`maxTables` / `maxRowsPerTable` / `headerExcerptLimit`）统一为 **`0` = 不设上限**（`src/checker.ts` 的 `nonNegativeInt` → `limitOrInfinity`，`0` 取 `Infinity`），未设 / 负数 / `NaN` 仍回退缺省 `5` / `3` / `60`；由此消除「判定计数说有、提示为 null」的语义分裂（`maxTables: 0` 现在列出全部表格且提示非 null）。证据：包 `check` 退出码 0、`npm test` 73 例全绿、`src` 覆盖率行 / 分支 / 函数 100%、反向验证（撤掉 `0 → Infinity` 即转红，pass 29 / fail 1 → 恢复 pass 30 / fail 0）。README 配置表与口径段已同步。
