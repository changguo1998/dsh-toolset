# 整理历史代码和文档: 阶段 4b 包文档补正 (所属总追踪: `docs/archived/2026-10-28-history-cleanup.md`)

状态: 完成　　开启: 2026-11-01　　关闭: 2026-11-01
本文件记录阶段 4 包文档合并后遗留的事实与口径问题, 作为阶段 4 与阶段 5 之间的补正; 只改文档与源码注释, 不改行为、测试断言与配置.

## 目标

补正阶段 4 因「只改节名、不新增结论」而留下的过期事实: 测试用例数与分层、拆分后的文件清单、入口路径、模板术语; 并在阶段 5 前完成一次可验证的收口.

## 现状

- 测试数字: `memory-base/README.md:149` 仍写「61 例」, 与当前单元 + 集成规模不符; `task-engine/README.md:136` 写「136 例」, 拆分与补测后需复核.
- 结构清单: `task-engine/README.md:17` 与 `task-engine/docs/DESIGN.md:19` 仍把 `main.ts` 列为入口; `rule-engine/docs/DESIGN.md:22` / `:30` 至 `:32` 仍列 `main.ts` / `match.ts` / `rules.ts` / `persist.ts` 为全部结构, 与阶段 3 拆分后的 `src/` 文件不符.
- 入口与 API: `command-template/docs/DESIGN.md:15` 写 `src/main.ts`, 实际入口为 `src/index.ts`; `:42` 仍提 `availableProviders(ctx)` 与 `main.ts` 接线, 该 API 已在阶段 3 移除.
- 模板术语: `command-template/README.md` 已用「审阅」, `command-template/templates/adversarial-review.md:3` / `:4` / `:14` 与 `code-review.md:3` / `:9` / `:11` / `:20` / `:25` 仍用「评审」, 两侧不一致.
- 源码注释: 同一批入口迁移后, `command-template/src/index.ts:1` / `steps.ts:3` / `types.ts:113` 与 `task-engine/src/acceptance.ts:10` / `tools.ts:4` / `tools.ts:28` / `gate.ts:127` / `engine-types.ts:36` 的注释仍指向 `main.ts`.
- 阶段 4 合并后未发现新的断链与符号变体; 工作区干净, 本地仅 `main`.

## 实现规划

### 执行顺序

1. 取数: 对 `memory-base` / `task-engine` / `rule-engine` / `command-template` 跑当前 `pnpm run test` (需要时加 `test:integration`), 记录实际用例数与分层; 同时按 `src/` 实际文件核对结构清单.
2. 改包文档: `memory-base/README.md` 测试节; `task-engine/README.md` 结构清单与测试节、`task-engine/docs/DESIGN.md` 结构节; `rule-engine/docs/DESIGN.md` 结构节; `command-template/docs/DESIGN.md` 入口与 API 描述.
3. 统一模板术语: `command-template/templates/adversarial-review.md` / `code-review.md` 的「评审」改「审阅」, 与 README 和 `docs/GLOSSARY.md` 对齐.
4. 清源码注释路径: `command-template/src/index.ts` / `steps.ts` / `types.ts` 与 `task-engine/src/acceptance.ts` / `tools.ts` / `gate.ts` / `engine-types.ts` 的 `main.ts` 改 `index.ts` 或当前接线文件; 只改注释.
5. 全仓扫 34 份 `README.md` 的测试节数字断言: 与实际输出不符的按第 1 步口径改; 新命中的文件先补进本文件「文件清单」再改.
6. `format` 全部改动文件, 自查 diff 只含数字、结构清单、路径与术语; 跑 `pnpm run check` 确认注释改动无编译影响.
7. 回写本文件「实现记录 / 偏差 / 测试与证据」, 总追踪补一笔; 关闭本阶段.

### 统一口径

- 数字: 以本次实际 `pnpm run test` / `pnpm run test:integration` 输出为准; 能按层描述就不写死单个数; 不把无法复现的数字留在文档里.
- 结构: 以 `src/` 当前文件为准, 只列入口与主要职责文件, 不重写设计内容, 不新增结论.
- 路径: 入口统一 `src/index.ts`; 其余文件按实际名字与职责; 源码注释同样处理.
- 术语: 按 `docs/GLOSSARY.md`; 「评审」统一「审阅」; 「落点」等按既有口径不动.
- 范围: 只改本文件列出的文档与注释; 代码逻辑、测试断言、`package.json` / `tsconfig` / `cordis.patch.yml` 一律不动.

### 文件清单

| 组 | 文件 | 动作 |
| --- | --- | --- |
| 测试数字 | `memory-base/README.md` | 测试节用例数与分层改为当前实际 |
| 测试数字 / 结构 | `task-engine/README.md` | 结构清单与测试节改为当前 `src/` 与实际用例数 |
| 结构 | `task-engine/docs/DESIGN.md` | 结构节的入口与模块清单改为当前文件 |
| 结构 | `rule-engine/docs/DESIGN.md` | 结构节改为阶段 3 拆分后的实际文件 |
| 入口 / API | `command-template/docs/DESIGN.md` | `src/main.ts` 改 `src/index.ts`; 删 `availableProviders` 旧句 |
| 模板术语 | `command-template/templates/adversarial-review.md` / `code-review.md` | 「评审」改「审阅」 |
| 源码注释 | `command-template/src/index.ts` / `steps.ts` / `types.ts` | 注释里的 `main.ts` 改实际入口 |
| 源码注释 | `task-engine/src/acceptance.ts` / `tools.ts` / `gate.ts` / `engine-types.ts` | 注释里的 `main.ts` 改实际接线文件 |
| 测试数字 | `ast-tools/README.md` / `auto-approve/README.md` / `context-report/README.md` / `escalation-hint/README.md` / `metric-loop/README.md` / `output-compress/README.md` / `command-template/README.md` | 用例数与分项改为实测 |
| 记录 | 本文件 / 总追踪 | 实现记录、偏差、证据与关闭 |

### 提交批次

1. `docs: 补正包文档测试数字与结构清单` (文档).
2. `docs(command-template): 统一模板术语为审阅` (模板).
3. `refactor: 修正源码注释里的入口路径` (仅注释; 若与第 1 笔同批更清晰也可合并).
4. 关闭提交: 本文件与总追踪收尾.

### 验证与门禁

- 每个改动文件跑 `format`, 复跑无 diff.
- 文档改动自查: README 六节 / DESIGN 四节不被破坏; 断链 0; 符号变体 0; 术语与 `docs/GLOSSARY.md` 一致.
- `pnpm run check` 退出 0; 涉及源码注释的包跑一次包内 `pnpm run test` 确认无影响.
- 全仓复扫测试数字: 抽查 3 个包的 `pnpm run test` 输出与 README 断言一致.

### 明确不做

- 不改任何代码逻辑、类型、测试断言、配置与依赖.
- 不重写 README / DESIGN 的结构与结论; 只改过期事实与路径.
- 不修归档文档与 `docs/host` / `docs/STATUS.md`.
- 不做阶段 5 的根文档、术语表终稿、归档符号归一与追踪文档搬迁.

## 实现记录

- 取数 (2026-11-01): 实际跑单元与集成, 得到 `memory-base` 90 + 6、`task-engine` 171 + 17、`rule-engine` 175 + 13、`command-template` 48 + 12; 另扫 34 份 README 的数字断言, 跑 `ast-tools` 82、`auto-approve` 学习层 43、`context-report` 51、`escalation-hint` 50、`metric-loop` 56、`output-compress` 75, 并复核 `code-map` 36 + 15、`goal-contract` 55 + 9、`herdr-integration` 60 + 11、`md-logic` 76 + 10、`security-guard` 160 + 14、`session-paths` 31 + 12 均与文档一致.
- 文档补正 (提交 `eedfb239`): `memory-base/README.md` 补 `test:integration` 命令与 90 + 6 分项; `task-engine/README.md` 结构树改为当前 20 个 `src` 文件, 用例数改 171 并补集成 17; `task-engine/docs/DESIGN.md` 结构树与依赖方向同步为当前文件; `rule-engine/docs/DESIGN.md` 结构树补 `evaluation` / `consumers` / `delivery` / `engine-state` 等拆分后文件; `command-template/docs/DESIGN.md` 入口改 `src/index.ts`, `availableProviders` 旧句改为 `pickProvider`; 另 7 份 README 的用例数与分项同步实测.
- 模板术语 (提交 `ae8be407`): `command-template/templates/adversarial-review.md` / `code-review.md` 的「评审」全部改「审阅」, 与 README 和 `docs/GLOSSARY.md` 一致.
- 源码注释 (提交 `ba8b8b4a`): `command-template/src/index.ts` / `steps.ts` / `types.ts` 与 `task-engine/src/acceptance.ts` / `engine-types.ts` / `gate.ts` / `tools.ts` 的 `main.ts` 指向改为实际入口或接线文件; 只改注释.

## 偏差

- `auto-approve/README.md` 只写了学习层 43 例, 未写全套 181 例, 保持原有叙述口径, 不新增总量断言.
- `rule-engine/README.md` 只写单测 175 例, 未补集成 13 例; 原文档没有集成行, 本次不扩写.
- 归档文档 (`rule-engine/docs/archived/`) 仍含 `main.ts` 旧引用, 属归档历史, 按范围不动.
- 计划外补一处: `task-engine/docs/DESIGN.md` 机制节的隔离器回收仍写 `main.ts`, 验证时发现, 一并改 `plugin.ts`, 归入 `ba8b8b4a`.

## 测试与证据

- `pnpm run check`: 退出 0.
- 受影响包复测: `command-template` 48 / 48, `task-engine` 171 / 171, 均 0 失败.
- 取数命令: 各包 `pnpm run test` 与 `pnpm run test:integration`; 分文件计数用 `node --experimental-transform-types --test <文件>`.
- 结构校验: 34 份 README 六节 `readme_bad=0`, 15 份 DESIGN 四节 `design_bad=0`.
- 术语校验: `command-template` 的 README / DESIGN / 两模板「评审」命中 0; `main.ts` 仅余 `demo/main.ts`.
- 22 个改动文件 `format` 退出 0; 工作区提交后干净.
