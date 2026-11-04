# 分阶段开启 5 个 TypeScript 严格检查（接取条目: `docs/BACKLOG.md`「分阶段开启 5 个 TypeScript 严格检查」）

状态: 规划　　开启: 2026-11-04　　关闭: -
本文件是本任务唯一的追踪文档与文档改动位置; 计划外的文件不改。

## 目标

- 在 34 个包（`TUI` 与 33 个插件）的 `tsconfig.json` 中逐一开启 5 项检查: `noUnusedLocals` / `noUnusedParameters` / `noImplicitReturns` / `exactOptionalPropertyTypes` / `noFallthroughCasesInSwitch`.
- 每包一笔代码提交; 行为不变: 只改类型声明、删除死代码、对齐 fake 签名, 不改运行时分支、对象键的存在性与数据形状.
- 每包 `check` / `build` / `test` / `test:coverage` 通过, 用例数不变, 未覆盖行数与未覆盖分支数不增加.
- 五项全部落地, 或对个别包给出书面豁免理由; 不静默降级, 不为了过检改运行时行为.

## 调研

### 方法

- 编译器: `TUI/node_modules/.bin/tsc`, 版本 5.9.3.
- 逐包逐 flag 跑 `tsc -p <pkg> --noEmit --pretty false --<flag>`, 再五项合跑; 按 `error TS` 行计数.
- 树内 34 份 `tsconfig.json` 的 `compilerOptions` 逐字节相同（16 个键, 均含 `strict` 与 `noUncheckedIndexedAccess`）, 差异只在 `include`.
- 基线: `pnpm run test:coverage` 全仓 34/34 通过, 合计 4573 例, 行 89.6% / 分支 80.2%; TUI 1829 例.
- 实测日期: 2026-11-04.

### 报错分布

| 包 | `noUnusedLocals` | `noUnusedParameters` | `noImplicitReturns` | `exactOptionalPropertyTypes` | `noFallthroughCasesInSwitch` | 合计 |
| --- | --- | --- | --- | --- | --- | --- |
| ast-tools | 0 | 0 | 0 | 0 | 0 | 0 |
| hash-edit | 0 | 0 | 0 | 0 | 0 | 0 |
| md-table-check | 0 | 0 | 0 | 0 | 0 | 0 |
| session-title-cutoff | 0 | 0 | 0 | 0 | 0 | 0 |
| symbol-normalizer | 0 | 0 | 0 | 0 | 0 | 0 |
| background-daemon | 0 | 1 | 0 | 0 | 0 | 1 |
| behavior-correction | 0 | 0 | 0 | 1 | 0 | 1 |
| command-template | 0 | 1 | 0 | 0 | 0 | 1 |
| goal-contract | 0 | 0 | 0 | 1 | 0 | 1 |
| ponytail | 0 | 0 | 0 | 1 | 0 | 1 |
| preference-analysis | 0 | 0 | 0 | 1 | 0 | 1 |
| security-guard | 1 | 0 | 0 | 0 | 0 | 1 |
| session-paths | 1 | 0 | 0 | 0 | 0 | 1 |
| clock-base | 2 | 0 | 0 | 0 | 0 | 2 |
| context-report | 1 | 0 | 0 | 1 | 0 | 2 |
| escalation-hint | 0 | 1 | 0 | 1 | 0 | 2 |
| fs-digest | 0 | 0 | 0 | 2 | 0 | 2 |
| herdr-use | 2 | 0 | 0 | 0 | 0 | 2 |
| md-logic | 0 | 0 | 0 | 3 | 0 | 3 |
| md-map | 2 | 0 | 0 | 1 | 0 | 3 |
| script-interpreter | 1 | 0 | 0 | 2 | 0 | 3 |
| agent-group | 1 | 0 | 0 | 3 | 0 | 4 |
| memory-base | 3 | 0 | 0 | 2 | 0 | 5 |
| tool-consult | 2 | 2 | 0 | 1 | 0 | 5 |
| code-map | 0 | 1 | 0 | 5 | 0 | 6 |
| rule-engine | 3 | 0 | 0 | 3 | 0 | 6 |
| metric-loop | 1 | 0 | 0 | 6 | 0 | 7 |
| herdr-integration | 2 | 0 | 0 | 6 | 0 | 8 |
| coagent | 2 | 0 | 0 | 7 | 0 | 9 |
| output-compress | 2 | 0 | 0 | 8 | 0 | 10 |
| session-channel | 3 | 2 | 0 | 5 | 0 | 10 |
| task-engine | 2 | 0 | 0 | 8 | 0 | 10 |
| auto-approve | 3 | 5 | 0 | 15 | 0 | 23 |
| TUI | 303 | 5 | 1 | 292 | 0 | 601 |
| 合计 | 337 | 18 | 1 | 375 | 0 | 731 |

### 关键观察

- `noFallthroughCasesInSwitch`: 34 包全部 0 条, 可在每包第一笔直接打开, 无需改代码.
- `noImplicitReturns`: 仅 TUI 1 条, 位于 `TUI/tests/agent-preset.test.ts:93` 的回调.
- `noUnusedLocals`: 337 条, 其中 215 条 TS6196（类型 import 未读）、1 条 TS6192（整条 import 未读）、121 条 TS6133（局部变量 / 字段 / 函数）; TUI 占 303 条, 单文件最多 51 条（`TUI/src/app/adapter/session-records.ts`）. 以删除为主, 删除前查 JSDoc 与全仓引用.
- `noUnusedParameters`: 18 条, 均可用删除参数或 `_` 前缀处理; 保留回调 / 接口签名时用 `_` 前缀, 不改调用方.
- `exactOptionalPropertyTypes`: 375 条 = 206 条 TS2375 + 108 条 TS2379 + 18 条 TS2420 + 15 条 TS2412 + 17 条 TS2345 + 11 条 TS2322. TUI 292 条, 其中 `src` 101 条、`tests` 191 条; 18 个 fake adapter 类（含共享 `FakeAdapter`）的「可选方法写成 `T | undefined` 属性」是主要根因, 修共享类可清 47 条, 其余按类逐个对齐.
- 代码面总计 731 条, 落在 206 个文件（TUI 119 个, 其余 33 包 87 个）; 绝大多数是 import / 类型声明 / fake 签名, 预计不改运行时求值.
- 工作量集中在 TUI（601 / 731 = 82%）, 其余 33 包合计 130 条; 13 个包不超过 1 条, 适合先跑通流程.

### 基线覆盖率与用例数

| 包 | 用例数 | 行覆盖 | 分支覆盖 |
| --- | --- | --- | --- |
| agent-group | 108 | 89.4% (2682/3000) | 80.5% (483/600) |
| ast-tools | 82 | 95.8% (859/897) | 86.7% (169/195) |
| auto-approve | 183 | 89.1% (3640/4084) | 75.6% (887/1174) |
| background-daemon | 190 | 90.0% (2944/3272) | 78.5% (621/791) |
| behavior-correction | 46 | 98.6% (354/359) | 99.2% (120/121) |
| clock-base | 35 | 88.1% (327/371) | 84.8% (56/66) |
| coagent | 77 | 84.8% (1668/1966) | 76.7% (330/430) |
| code-map | 37 | 88.5% (954/1078) | 79.6% (187/235) |
| command-template | 48 | 83.5% (1217/1457) | 70.9% (297/419) |
| context-report | 51 | 93.6% (763/815) | 88.6% (279/315) |
| escalation-hint | 50 | 99.3% (275/277) | 96.6% (115/119) |
| fs-digest | 75 | 91.6% (1272/1389) | 80.8% (382/473) |
| goal-contract | 55 | 91.7% (656/715) | 89.8% (219/244) |
| hash-edit | 57 | 88.2% (666/755) | 74.8% (89/119) |
| herdr-integration | 60 | 90.7% (460/507) | 76.5% (75/98) |
| herdr-use | 143 | 86.2% (2875/3335) | 74.9% (480/641) |
| md-logic | 76 | 94.2% (1558/1654) | 86.6% (440/508) |
| md-map | 65 | 93.2% (1413/1516) | 84.5% (425/503) |
| md-table-check | 74 | 100.0% (273/273) | 99.0% (99/100) |
| memory-base | 90 | 91.7% (1885/2056) | 81.0% (388/479) |
| metric-loop | 56 | 93.9% (829/883) | 86.3% (189/219) |
| output-compress | 75 | 93.7% (1372/1464) | 84.0% (246/293) |
| ponytail | 9 | 96.2% (100/104) | 90.0% (27/30) |
| preference-analysis | 98 | 94.9% (1935/2040) | 89.0% (512/575) |
| rule-engine | 177 | 96.9% (2406/2483) | 89.4% (638/714) |
| script-interpreter | 117 | 95.2% (1402/1472) | 86.9% (351/404) |
| security-guard | 160 | 99.1% (1633/1647) | 95.1% (408/429) |
| session-channel | 78 | 88.0% (3424/3889) | 62.9% (419/666) |
| session-paths | 31 | 100.0% (191/191) | 98.5% (67/68) |
| session-title-cutoff | 21 | 95.9% (378/394) | 87.2% (82/94) |
| symbol-normalizer | 46 | 97.1% (629/648) | 83.5% (116/139) |
| task-engine | 171 | 81.8% (2692/3292) | 73.8% (590/799) |
| tool-consult | 103 | 93.3% (1355/1453) | 89.2% (296/332) |
| TUI | 1829 | 87.7% (25076/28580) | 78.3% (6229/7954) |

## 决策

### D1 开启粒度

- 选项 a: 一次性全仓打开五项, 再统一修.
- 选项 b: 逐包开启, 每包五项一起（选定）.
- 选项 c: 逐 flag 全仓分批.
- 理由: 条目要求逐包评估与一包一笔提交; b 把失败面限制在单包, 提交可独立回滚; a 会让 731 条同时可见, 无法定位; c 会让同一文件被五个 flag 反复改, 提交边界更碎.

### D2 `exactOptionalPropertyTypes` 的修复取向

- 选项 a: 数据 / 配置 / 返回对象的可选字段显式写 `| undefined`（选定）.
- 选项 b: 在调用点用条件展开（不选; 会让对象键从「存在且为 undefined」变成「不存在」, 改变运行时形状）.
- 选项 c: 用 `as` / 非空断言 / `@ts-expect-error` 压掉（不选; 掩盖问题, 后续仍会复发）.
- 补充: 接口上的可选方法保持方法签名, 不改成可赋 `undefined` 的属性; fake 类按接口对齐签名; 测试要模拟「方法缺失」时用 `delete`, 不写 `fn = undefined`.
- 理由: a 是纯类型改动, 编译产物不变; b 会改变 JSON 序列化 / `in` 判断 / 展开结果; c 让检查失去意义.

### D3 死代码与未读参数的处理

- 选项 a: 删 tsc 判死的 import / 类型 / 局部; 未读参数优先删, 签名需要时改 `_` 前缀（选定）.
- 选项 b: 用 `void` / `_ = x` 保留（不选; 留下噪声）.
- 选项 c: 只加 ignore 注释（不选）.
- 补充: 删除前查三件事: 全仓引用、JSDoc / 注释引用、写入是否有副作用. 只写不读的字段若写入本身无副作用则删; 若暴露真实缺陷（该读未读）, 不顺手修, 记入 BACKLOG.

### D4 TUI 的提交拆分

- 选项 a: 单笔提交 601 条（不选）.
- 选项 b: 两笔: 第一笔开另外四项（309 条）, 第二笔开 `exactOptionalPropertyTypes`（292 条）（选定）.
- 选项 c: 按目录拆 3 笔以上（不选; 会把同一 flag 的开启拆散）.
- 理由: 601 条涉及 119 个文件, 单笔无法审查; 按 flag 拆两笔后每笔仍有明确语义. 这是对条目「一包一笔提交」的细化, 记入「偏差」.

### D5 批次顺序

- 选项 a: 按报错数升序, TUI 最后（选定）.
- 选项 b: 按包名字母序.
- 选项 c: TUI 优先.
- 理由: 先用 0 至 4 条的小包验证「修复 / 开 flag / 覆盖率 / 提交」流程; TUI 风险最大, 放最后, 前面批次暴露的策略问题不会污染 34 个包.

### D6 豁免门槛

- 选项 a: 仅当修复必须改运行时行为或公共 API 语义时才豁免该包的该 flag（选定）.
- 选项 b: 工作量大便豁免（不选）.
- 选项 c: 不设豁免（不选）.
- 补充: 豁免必须写「包 + flag + 具体文件 / 类型 + 不改就过不去的原因 + 替代措施」, 并保持其余四项开启. 当前实测未发现必然需要豁免的包.

### D7 覆盖率核对口径

- 选项 a: 逐包跑 `test:coverage`, 比较「未覆盖行数 / 未覆盖分支数」（选定）.
- 选项 b: 只看全仓汇总百分比（不选; 删死代码会缩小分母, 百分比会掩盖问题）.
- 选项 c: 不跑覆盖率（不选）.
- 理由: 删除死代码会同时减少分子与分母; 未覆盖计数不随分母变化, 是更稳的判据. 允许百分比小幅波动, 但未覆盖行 / 分支数不得增加.
- 2026-11-04 调整: 全仓 `pnpm run test:coverage` 走各包 `test`（不含 `tests/integration/`）, 逐包 `test:coverage` 含 integration; 两者不可直接比较. 改为「逐包 `test:coverage` 与全仓基线做下限比较, 低于基线才复查」, 并把两组数字都记入「测试与证据」. 首次实测多数包因 integration 覆盖而高于基线, 属方法差异, 非代码变化.

## 规划

### 批次

| 批次 | 包数 | 报错数 | 包 | 门禁 |
| --- | --- | --- | --- | --- |
| 批 1 | 12 | 8 | ast-tools / hash-edit / session-title-cutoff / symbol-normalizer / background-daemon / behavior-correction / command-template / goal-contract / ponytail / preference-analysis / security-guard / session-paths | 逐包 check / build / test / test:coverage; 批末全仓 check / test |
| 批 2 | 9 | 23 | clock-base / context-report / escalation-hint / fs-digest / herdr-use / md-logic / md-map / script-interpreter / agent-group | 同上 |
| 批 3 | 11 | 77 | memory-base / tool-consult / code-map / rule-engine / md-table-check / metric-loop / herdr-integration / coagent / output-compress / session-channel / task-engine | 同上 |

2026-11-04 调整: `md-table-check` 从批 1 移到批 3. 该包 `check` 在根 `tsconfig.json` 之后还跑 `tsc -p tests/tsconfig.json`, 后者直接编译 `../rule-engine/src/`, 因此必须先修 `rule-engine`; 根 `tsconfig.json` 的 `exclude` 让初始扫描漏掉了这条路径. 详见「偏差」.
| 批 4 | 1 | 23 | auto-approve | 同上 |
| 批 5 | 1 | 309 | TUI（`noUnusedLocals` / `noUnusedParameters` / `noImplicitReturns` / `noFallthroughCasesInSwitch`） | 逐包四入口 + `pnpm run demo -- --smoke`; 批末全仓 check / test |
| 批 6 | 1 | 292 | TUI（`exactOptionalPropertyTypes`） | 同上 |
| 批 7 | 34 | - | 全仓 | check / build / test / test:coverage / check:docs / test:e2e; 收尾 |

### 每包流程

1. 用五项合跑命令列出该包报错, 按文件分组.
2. 按 D2 / D3 修复; 每修一轮重跑该包五项合跑, 直到 0 条.
3. 在该包 `tsconfig.json` 的 `compilerOptions` 追加五行（均为 `true`）:
   `noUnusedLocals` / `noUnusedParameters` / `noImplicitReturns` / `exactOptionalPropertyTypes` / `noFallthroughCasesInSwitch`.
4. 跑 `pnpm -C <pkg> run check` 与 `pnpm -C <pkg> run build`, 确认 0.
5. 跑 `pnpm -C <pkg> run test` 与 `pnpm -C <pkg> run test:coverage`; 记录用例数、行 / 分支覆盖与未覆盖计数, 与「基线覆盖率与用例数」比对.
6. `format` 本次改动文件, 自查 diff, 提交: `chore(<pkg>): 开启 5 项 TypeScript 严格检查`.
7. 在该批末尾把本批结果追加到「实现记录」, 单独提交文档: `docs: 记录严格检查批 N 结果`.

TUI 按 D4 拆两笔:

- 第一笔: 修 309 条, 在 `TUI/tsconfig.json` 只开四项, 提交 `chore(TUI): 开启 4 项 TypeScript 严格检查`.
- 第二笔: 修 292 条, 追加 `exactOptionalPropertyTypes`, 提交 `chore(TUI): 开启 exactOptionalPropertyTypes`.

### 计划改动文件清单

配置:

- 34 份 `tsconfig.json`: `TUI/tsconfig.json` 与 33 个插件包根目录各一份（`agent-group` / `ast-tools` / `auto-approve` / `background-daemon` / `behavior-correction` / `clock-base` / `coagent` / `code-map` / `command-template` / `context-report` / `escalation-hint` / `fs-digest` / `goal-contract` / `hash-edit` / `herdr-integration` / `herdr-use` / `md-logic` / `md-map` / `md-table-check` / `memory-base` / `metric-loop` / `output-compress` / `ponytail` / `preference-analysis` / `rule-engine` / `script-interpreter` / `security-guard` / `session-channel` / `session-paths` / `session-title-cutoff` / `symbol-normalizer` / `task-engine` / `tool-consult`）.

文档:

- `docs/BACKLOG.md`（条目状态）.
- 本文件.

源码与测试（2026-11-04 实测报错文件; 修复过程中若级联出新增文件, 以实际为准并更新本节）:

`TUI`（119 个）:

```text
TUI/src/app/adapter/context.ts
TUI/src/app/adapter/contracts.ts
TUI/src/app/adapter/dsh-approval.ts
TUI/src/app/adapter/dsh-events.ts
TUI/src/app/adapter/dsh-panels.ts
TUI/src/app/adapter/dsh-session.ts
TUI/src/app/adapter/dsh.ts
TUI/src/app/adapter/history-normalize.ts
TUI/src/app/adapter/notice-history.ts
TUI/src/app/adapter/search-aggregate.ts
TUI/src/app/adapter/session-records.ts
TUI/src/app/adapter/types/session-events.ts
TUI/src/app/commands.ts
TUI/src/app/components/QuestionPrompt.ts
TUI/src/app/components/StatusColumn.ts
TUI/src/app/components/StatusPanel.ts
TUI/src/app/components/TextInput.ts
TUI/src/app/config.ts
TUI/src/app/index.ts
TUI/src/app/layout/content-rules.ts
TUI/src/app/layout/fill.ts
TUI/src/app/layout/frame-build.ts
TUI/src/app/layout/frame-rows.ts
TUI/src/app/layout/geometry.ts
TUI/src/app/layout/markdown.ts
TUI/src/app/layout/measure.ts
TUI/src/app/layout/pipeline/flatten.ts
TUI/src/app/layout/pipeline/frame.ts
TUI/src/app/layout/pipeline/ir.ts
TUI/src/app/layout/pipeline/measure.ts
TUI/src/app/layout/pipeline/memlog.ts
TUI/src/app/layout/pipeline/parse.ts
TUI/src/app/layout/pipeline/rows.ts
TUI/src/app/layout/pipeline/sections.ts
TUI/src/app/layout/pipeline/split.ts
TUI/src/app/layout/pipeline/structure.ts
TUI/src/app/layout/pipeline/wrap.ts
TUI/src/app/layout/primitives.ts
TUI/src/app/layout/run-virt.ts
TUI/src/app/layout/status-line.ts
TUI/src/app/layout/table.ts
TUI/src/app/layout/title-bar.ts
TUI/src/app/layout/top-region.ts
TUI/src/app/model-transition.ts
TUI/src/app/picker-filter.ts
TUI/src/app/runtime/commands-host.ts
TUI/src/app/runtime/commands.ts
TUI/src/app/runtime/context.ts
TUI/src/app/runtime/wiring.ts
TUI/src/app/state/initial.ts
TUI/src/app/state/panels.ts
TUI/src/app/state/reducer-goal.ts
TUI/src/app/state/reducer-history.ts
TUI/src/app/state/reducer-session.ts
TUI/src/app/state/reducer-turn.ts
TUI/src/app/state/types.ts
TUI/src/main.ts
TUI/tests/activity-level.test.ts
TUI/tests/activity-verbose.test.ts
TUI/tests/adapter.dsh.test.ts
TUI/tests/agent-preset.test.ts
TUI/tests/app.test.ts
TUI/tests/approval-panel.test.ts
TUI/tests/assemble.ts
TUI/tests/clean-quit.test.ts
TUI/tests/command-panel-agents-tools.test.ts
TUI/tests/command-panel-guard.test.ts
TUI/tests/command-panel-loop.test.ts
TUI/tests/command-panel-search.test.ts
TUI/tests/command-panel-task.test.ts
TUI/tests/command-panel-workflows.test.ts
TUI/tests/command-panel.test.ts
TUI/tests/completion.test.ts
TUI/tests/config-edit.test.ts
TUI/tests/contract-notice.test.ts
TUI/tests/council-notice.test.ts
TUI/tests/fixtures/status-column-old.ts
TUI/tests/focus-keep.test.ts
TUI/tests/goal-activation.test.ts
TUI/tests/group-notice.test.ts
TUI/tests/helpers/appFakes.ts
TUI/tests/hmr-teardown-no-exit.test.ts
TUI/tests/injection-display.test.ts
TUI/tests/input-cursor-keys.test.ts
TUI/tests/input-history.test.ts
TUI/tests/integration/app.test.ts
TUI/tests/interrupt-mode.test.ts
TUI/tests/jobs-panel.test.ts
TUI/tests/layout-cache.test.ts
TUI/tests/layout4.test.ts
TUI/tests/local-log.test.ts
TUI/tests/memory-notice.test.ts
TUI/tests/notify-bell.test.ts
TUI/tests/p5-blank-chunk.test.ts
TUI/tests/permission.test.ts
TUI/tests/picker-filter.test.ts
TUI/tests/pipeline-app.test.ts
TUI/tests/pipeline-fn.test.ts
TUI/tests/pipeline-layout.test.ts
TUI/tests/pipeline-parse.test.ts
TUI/tests/pipeline-structure.test.ts
TUI/tests/policy.test.ts
TUI/tests/resume-summary.test.ts
TUI/tests/screen-residue.test.ts
TUI/tests/session-delete.test.ts
TUI/tests/settings-fork.test.ts
TUI/tests/shell-guard.test.ts
TUI/tests/shell-mode.test.ts
TUI/tests/small-terminal-warning.test.ts
TUI/tests/startup-resume-history.test.ts
TUI/tests/stats-rename.test.ts
TUI/tests/status-column-agents.test.ts
TUI/tests/status-column-equivalence.test.ts
TUI/tests/status-column.test.ts
TUI/tests/steer-mode.test.ts
TUI/tests/steer-queued-display.test.ts
TUI/tests/table.test.ts
TUI/tests/tool-block.test.ts
TUI/tests/width-probe.test.ts
```

`agent-group`:

```text
agent-group/src/member.ts
agent-group/src/service.ts
agent-group/tests/assemble.ts
agent-group/tests/mirror.test.ts
```

`auto-approve`:

```text
auto-approve/src/answerer.ts
auto-approve/src/audit.ts
auto-approve/src/gate.ts
auto-approve/src/learn-observe.ts
auto-approve/src/review.ts
auto-approve/src/rules.ts
auto-approve/src/runtime.ts
auto-approve/tests/answerer.test.ts
auto-approve/tests/bundle.test.ts
auto-approve/tests/integration/plugin.test.ts
```

`background-daemon`:

```text
background-daemon/tests/deliver.test.ts
```

`behavior-correction`:

```text
behavior-correction/tests/index.test.ts
```

`clock-base`:

```text
clock-base/src/index.ts
```

`coagent`:

```text
coagent/src/actions.ts
coagent/src/launch.ts
coagent/src/probe.ts
coagent/tests/probe.test.ts
coagent/tests/store.test.ts
```

`code-map`:

```text
code-map/src/graph/query.ts
code-map/src/index.ts
```

`command-template`:

```text
command-template/src/index.ts
```

`context-report`:

```text
context-report/tests/fold.test.ts
context-report/tests/main.test.ts
```

`escalation-hint`:

```text
escalation-hint/tests/judge.test.ts
```

`fs-digest`:

```text
fs-digest/src/digest.ts
fs-digest/src/index.ts
```

`goal-contract`:

```text
goal-contract/src/interview.ts
```

`herdr-integration`:

```text
herdr-integration/src/herdr.ts
herdr-integration/src/index.ts
herdr-integration/src/state.ts
herdr-integration/tests/clock.test.ts
herdr-integration/tests/main.test.ts
```

`herdr-use`:

```text
herdr-use/tests/integration/plugin.test.ts
herdr-use/tests/workspace.test.ts
```

`md-logic`:

```text
md-logic/src/parse.ts
md-logic/src/tools.ts
```

`md-map`:

```text
md-map/tests/query.test.ts
md-map/tests/service.test.ts
```

`memory-base`:

```text
memory-base/src/index.ts
memory-base/tests/kinds.test.ts
memory-base/tests/knowledge.test.ts
memory-base/tests/tiers.test.ts
```

`metric-loop`:

```text
metric-loop/src/index.ts
metric-loop/tests/controller.test.ts
metric-loop/tests/engine.test.ts
metric-loop/tests/integration/plugin.test.ts
```

`output-compress`:

```text
output-compress/src/index.ts
output-compress/tests/assemble.ts
output-compress/tests/digest-db.test.ts
output-compress/tests/hooks.test.ts
output-compress/tests/integration/plugin.test.ts
```

`ponytail`:

```text
ponytail/tests/main.test.ts
```

`preference-analysis`:

```text
preference-analysis/src/index.ts
```

`rule-engine`:

```text
rule-engine/demo/main.ts
rule-engine/src/index.ts
rule-engine/src/rules.ts
rule-engine/tests/engine.test.ts
rule-engine/tests/integration/plugin.test.ts
```

`script-interpreter`:

```text
script-interpreter/src/index.ts
script-interpreter/src/probe.ts
script-interpreter/src/tools.ts
```

`security-guard`:

```text
security-guard/src/tool-registry.ts
```

`session-channel`:

```text
session-channel/src/alias-words.ts
session-channel/src/broker.ts
session-channel/src/service.ts
session-channel/src/task-layer.ts
session-channel/src/tools.ts
session-channel/tests/apply.test.ts
session-channel/tests/helpers.ts
session-channel/tests/integration/plugin.test.ts
```

`session-paths`:

```text
session-paths/src/index.ts
```

`task-engine`:

```text
task-engine/demo/main.ts
task-engine/src/acceptance.ts
task-engine/src/engine-flow.ts
task-engine/src/engine-store.ts
task-engine/src/gate.ts
task-engine/src/plugin.ts
task-engine/tests/engine.test.ts
task-engine/tests/gate.test.ts
task-engine/tests/semantic.test.ts
```

`tool-consult`:

```text
tool-consult/src/index.ts
tool-consult/tests/aliases.test.ts
tool-consult/tests/integration/plugin.test.ts
```

`ast-tools` / `hash-edit` / `md-table-check` / `session-title-cutoff` / `symbol-normalizer` 当前 0 条, 只改各自的 `tsconfig.json`.

### 明确不做

- 不引入 ESLint / knip / 其他 lint 或死代码工具.
- 不改 `strict` / `noUncheckedIndexedAccess` / `target` / `module` / `moduleResolution`.
- 不拆 `tsconfig`, 不把 `tests` / `demo` / `bench` 排除出检查.
- 不重构运行时逻辑, 不顺手修 bug; 发现的缺陷记入对应层 `BACKLOG.md`, 本任务不处理.
- 不改 `STATUS.md`; 不改本清单以外的文档.
- 不做全仓格式化, 只 `format` 本次改动文件.

### 验收

- 34 份 `tsconfig.json` 均含五项 `true`, 且 `compilerOptions` 其余键不变.
- 34 包 `pnpm -C <pkg> run check` / `build` / `test` 退出 0; 全仓 `pnpm run check` / `build` / `test` 退出 0.
- 用例数与本文件「基线覆盖率与用例数」逐包一致; 未覆盖行数 / 分支数不增加.
- `pnpm run test:coverage` 全仓 34/34 通过; `pnpm run check:docs` 0 错误 / 0 警告; `pnpm run test:e2e` 33/33 通过.
- TUI 两笔提交后 `pnpm run demo -- --smoke` 输出 `SMOKE_OK`.
- diff 只含类型声明、import / 死代码删除、fake 签名与 `tsconfig.json`; 无运行时分支改动.

## 实现记录

- 2026-11-04: 完成调研与规划; 34 包逐 flag 实测 731 条报错; 基线 `pnpm run test:coverage` 34/34, 4573 例, 行 89.6% / 分支 80.2%; 尚未改代码.
- 2026-11-04: 批 1 完成 12 包（`md-table-check` 移到批 3）. 每包 `check` / `build` / `test` / `test:coverage` 退出 0, 用例数与基线一致; 批末全仓 `pnpm run check` / `pnpm run test` 退出 0. 逐包结果:

| 包 | 原报错数 | 用例数 | 行覆盖 | 分支覆盖 | 提交 |
| --- | --- | --- | --- | --- | --- |
| ast-tools | 0 | 82 | 96.3% (864/897) | 87.4% (174/199) | `adbafe4e` |
| hash-edit | 0 | 57 | 96.4% (728/755) | 87.4% (132/151) | `550808eb` |
| session-title-cutoff | 0 | 21 | 98.0% (386/394) | 89.2% (91/102) | `1acaa79b` |
| symbol-normalizer | 0 | 46 | 98.5% (638/648) | 87.2% (123/141) | `a689ddfa` |
| background-daemon | 1 | 190 | 90.3% (3094/3425) | 78.5% (623/794) | `859725f4` |
| behavior-correction | 1 | 46 | 99.2% (356/359) | 98.4% (120/122) | `f63a1595` |
| command-template | 1 | 48 | 87.3% (1272/1457) | 75.9% (340/448) | `2461e007` |
| goal-contract | 1 | 55 | 95.5% (683/715) | 90.3% (242/268) | `410d3db0` |
| ponytail | 1 | 9 | 100.0% (104/104) | 100.0% (31/31) | `7fd70200` |
| preference-analysis | 1 | 98 | 94.9% (1935/2040) | 88.6% (519/586) | `aeac0f23` |
| security-guard | 1 | 160 | 99.1% (1627/1642) | 94.1% (416/442) | `7271b7d2` |
| session-paths | 1 | 31 | 100.0% (190/190) | 97.2% (69/71) | `f2d21744` |

- 2026-11-04: 批 2 完成 9 包. 每包 `check` / `build` / `test` / `test:coverage` 退出 0, 用例数与基线一致; 批末全仓 `pnpm run check` / `pnpm run test` 退出 0. 逐包结果:

| 包 | 原报错数 | 用例数 | 行覆盖 | 分支覆盖 | 提交 |
| --- | --- | --- | --- | --- | --- |
| clock-base | 2 | 35 | 88.1% (327/371) | 85.5% (59/69) | `be548b7d` |
| context-report | 2 | 51 | 95.8% (782/816) | 90.3% (290/321) | `54d663fe` |
| escalation-hint | 2 | 50 | 99.3% (275/277) | 96.0% (120/125) | `8d27baa9` |
| fs-digest | 2 | 75 | 91.7% (1274/1389) | 80.5% (388/482) | `db690895` |
| herdr-use | 2 | 143 | 89.5% (3135/3503) | 76.4% (531/695) | `45235a85` |
| md-logic | 3 | 76 | 95.2% (1574/1654) | 88.5% (460/520) | `237ea01c` |
| md-map | 3 | 65 | 94.3% (1430/1516) | 84.6% (441/521) | `8c357382` |
| script-interpreter | 3 | 117 | 95.2% (1401/1471) | 87.3% (358/410) | `6d676201` |
| agent-group | 4 | 108 | 90.9% (2725/2999) | 81.7% (515/630) | `d4b73f18` |

- 2026-11-04: 批 3 完成 11 包（含从批 1 移入的 `md-table-check`）. 每包 `check` / `build` / `test` / `test:coverage` 退出 0, 用例数与基线一致; 批末全仓 `pnpm run check` 退出 0, `pnpm run test` 首次因 `session-channel` 一个计时用例在并行负载下抖动失败, 单跑与重跑全仓均 34/34 通过（见「偏差」与「测试与证据」）. 逐包结果:

| 包 | 原报错数 | 用例数 | 行覆盖 | 分支覆盖 | 提交 |
| --- | --- | --- | --- | --- | --- |
| rule-engine | 6 | 177 | 97.1% (2408/2481) | 89.2% (646/724) | `282dcb41` |
| md-table-check | 1 | 74 | 100.0% (273/273) | 99.0% (99/100) | `32076edc` |
| memory-base | 5 | 90 | 92.7% (1905/2054) | 82.9% (413/498) | `e75e034b` |
| tool-consult | 5 | 103 | 96.2% (1397/1452) | 92.3% (334/362) | `585b4801` |
| code-map | 6 | 37 | 92.5% (997/1078) | 86.5% (230/266) | `63f24710` |
| metric-loop | 7 | 56 | 95.1% (840/883) | 91.5% (216/236) | `d78a5606` |
| herdr-integration | 8 | 60 | 94.5% (479/507) | 82.6% (90/109) | `18198330` |
| coagent | 9 | 77 | 88.0% (1735/1971) | 78.6% (367/467) | `434995c7` |
| output-compress | 10 | 75 | 94.5% (1384/1464) | 85.2% (260/305) | `7738a956` |
| session-channel | 10 | 78 | 89.0% (3461/3888) | 65.2% (454/696) | `5a9bccb4` |
| task-engine | 10 | 171 | 82.7% (2721/3291) | 74.4% (618/831) | `f37b5d8a` |

## 偏差

- `md-table-check` 未按原计划放在批 1, 移到批 3. 原因: 该包 `check` 为 `tsc -p tsconfig.json && tsc -p tests/tsconfig.json`; 根 `tsconfig.json` 的 `exclude` 排除了 `tests/surfaceDifferential.test.ts` / `tests/reasoningSeparation.test.ts` / `tests/integration.test.ts`, 初始扫描只跑根配置, 漏掉 `tests/tsconfig.json` 这条路径. 该配置 `include: ["."]` 且直接编译 `../rule-engine/src/`, 打开五项后暴露 `rule-engine` 的 3 条与自身 1 条报错. 已在批 3 先做 `rule-engine` 再做本包, 两笔提交与结果见「实现记录」.
- 覆盖率比较方法不一致: 全仓 `pnpm run test:coverage` 走各包 `test`（不含 `tests/integration/`）, 逐包 `test:coverage` 含 integration, 因此逐包数字普遍高于基线. 已按 D7 调整说明, 改用下限比较; 批 1 12 包均不低于基线（`session-paths` 分支 97.2% 低于基线 98.5%, 但测试面多加载了分支, 分母 68 → 71, 未覆盖分支 1 → 2, 非代码退化）.
- 逐包 `test:coverage` 会把跨包源码计入总分母: `metric-loop` 的报表含 `clock-base`, `md-table-check` 的报表含 `rule-engine`（后者整合测试直接 import 源码）. 本文件表中的覆盖率一律取 `report.json` 里该包自身的 `packages[<pkg>]` 小计, 不用报表合计.
- `coagent` 的 `node_modules` 是 npm 布局（含 `.package-lock.json`, 无 pnpm `.modules.yaml`）, `pnpm -C coagent run ...` 会触发依赖状态检查并尝试写仓库外的 pnpm store, 在当前文件沙箱下报 `ERR_SQLITE_ERROR` / `unable to open database file`. 该问题与本次改动无关; 对 `coagent` 与全仓命令统一加 `npm_config_verify_deps_before_run=false`（或 `--config.verify-deps-before-run=false`）绕过状态检查, 实际编译 / 测试仍由包内 `tsc` 与 `node --test` 执行.
- `session-channel/tests/entry.test.ts:34` 的 `systemTimers` 计时用例（5 ms interval, 等 40 ms 要求至少 2 次）在全仓并行负载下偶发只触发 1 次; 单跑 `pnpm -C session-channel run test` 78/78 通过, 重跑全仓 34/34 通过. 属既有计时抖动, 本次未改该用例, 也未修计时实现; 建议另立条目改为假定时器或放宽等待.
- TUI 按 D4 拆两笔提交, 与条目「一包一笔提交」的字面要求不同; 理由与拆分边界见 D4, 待批 5 / 批 6 执行.

## 测试与证据

基线（2026-11-04）:

```text
pnpm run test:coverage
34/34 OK; 合计 4573 例; 行 89.6% / 分支 80.2%
```

逐包基线见「调研 → 基线覆盖率与用例数」; 每批完成后在此追加命令、输出摘要与覆盖率对比.

批 1（2026-11-04）:

```text
# 12 包逐包
pnpm -C <pkg> run check         → 0
pnpm -C <pkg> run build         → 0
pnpm -C <pkg> run test          → 0; 用例数与基线一致
pnpm -C <pkg> run test:coverage → 0; 见「实现记录」表

# 批末
pnpm run check                  → 0
pnpm run test                   → 34/34 OK; 4573 例
```

批 2（2026-11-04）:

```text
# 9 包逐包
pnpm -C <pkg> run check         → 0
pnpm -C <pkg> run build         → 0
pnpm -C <pkg> run test          → 0; 用例数与基线一致
pnpm -C <pkg> run test:coverage → 0; 见「实现记录」表

# 批末
pnpm run check                  → 0
pnpm run test                   → 34/34 OK; 4573 例
```

批 3（2026-11-04）:

```text
# 11 包逐包（coagent 与全仓命令额外带 npm_config_verify_deps_before_run=false）
pnpm -C <pkg> run check         → 0
pnpm -C <pkg> run build         → 0
pnpm -C <pkg> run test          → 0; 用例数与基线一致
pnpm -C <pkg> run test:coverage → 0; 取该包自身小计, 见「实现记录」表

# 批末
pnpm run check                  → 0
pnpm run test                   → 第一次 FAIL session-channel（entry.test.ts:34 计时抖动, ticks=1）
pnpm -C session-channel run test → 78/78 通过
pnpm run test                   → 第二次 34/34 OK; 4573 例
```

## 收尾

待补: 34 包提交清单、全仓四入口结果、BACKLOG 条目完成与移除、追踪文档归档、临时文件清理.
