# 整理历史代码和文档: 重构计划对照审计 (所属总追踪: `docs/archived/2026-10-28-history-cleanup.md`)

状态: 完成　　开启: 2026-11-01　　关闭: 2026-11-02
本文件是重构完成后的双向核对: 正向确认计划中的每项都落到具体文件与提交, 反向确认改动过的每个文件与每笔提交都能回到计划条目; 只做只读检查与记录, 不改代码与历史.

## 目标

1. 计划到实现: 总追踪「决策 / 规划」、7 份阶段追踪 (01 / 02 / 03 / 03b / 04 / 04b / 05) 与 34 份包追踪里的每项要求, 都能指到具体文件、行或提交.
2. 实现到计划: 从阶段 1 起点到当前 `HEAD` 的每个改动文件、每笔提交, 都能对应到计划条目; 计划外的改动必须被识别并归入「偏差」或「允许的例外」.
3. 产出两份可核对的表与一份例外清单, 给出总体结论 (通过 / 有条件通过 / 不通过).

## 现状

- 阶段 1 至 5 的内容工作与关闭动作均已完成 (2026-11-02: 43 份追踪归档, `BACKLOG #1` 移除, 最后一笔关闭提交); 本审计以关闭前 `HEAD` 为对象, 关闭后如需增量另开核对.
- 计划分散在: 总追踪 `docs/archived/2026-10-28-history-cleanup.md` (决策 / 规划 / 阶段执行顺序 / 验收标准), 7 份阶段追踪 (`...-01-standards.md` / `-02-tests.md` / `-03-code.md` / `-03b-supplement.md` / `-04-package-docs.md` / `-04b-package-docs-fix.md` / `-05-project-docs.md`), 34 份包追踪的「实现规划」节; 原条目 `docs/BACKLOG.md` `#1` 已在关闭时移除.
- 包分支已合并并删除, 只剩 `main`; 改动历史以 `git log` 与追踪文档里的提交号为准.
- 代码与文档改动量大 (34 个包、5 个阶段、数百笔提交), 适合按阶段分组并行核对.

## 检查计划

### 执行顺序

1. 锁定基线: 找到阶段 1 开工前的最后一笔提交 (规划提交之前), 记为 `BASE`; 记下当前 `HEAD`; 把 `BASE..HEAD` 作为反向检查的完整范围.
2. 建计划清单: 从总追踪与 7 份阶段追踪逐节抽取可执行要求, 给每项编号 (如 `P1-01`); 34 份包追踪的逐包规划单独编号 (`PKG-<包>-01`). 清单只保留「可核对」的要求 (文件、命令、删除、改名、口径), 不把背景与论证当条目.
3. 正向检查: 对每条计划项找预期文件与证据 (`git log --oneline -- <文件>`、`git diff BASE..HEAD -- <文件>`、文件现状), 记录 `文件:行` 或提交号, 判定 `✓ / △ / ✗ / ?`.
4. 反向检查: 取 `git diff --name-only BASE..HEAD`, 逐文件映射到计划项; 再抽查提交信息与 diff 内容, 识别「计划外新增 / 计划外删除 / 口径漂移」.
5. 并行分派: 4 个只读检查任务按阶段分工 (见「分派」), 各自返回表与例外; 主会话合并、去重、抽查 10% 证据, 形成最终结论.
6. 复核与收尾: 对 `△ / ✗ / ?` 逐条复核, 区分「未落实」「已落实但证据弱」「文档口径偏差」; 把确认的问题写进本文件「偏差 / 待补」, 不改原计划文档.
7. 输出: 本文件填「计划到实现」「实现到计划」「例外清单」「结论」四节; 关闭动作仍留给阶段 5 收尾, 本审计不合并、不 push.

### 范围与基线

- 正向范围: 总追踪的「决策」「规划」「验收标准」, 阶段 1 / 2 / 3 / 3b / 4 / 4b / 5 追踪文档, 34 份包追踪的「实现规划」, `docs/BACKLOG.md` `#1` 的期望.
- 反向范围: `BASE..HEAD` 的全部改动文件与提交; 已锁定 `BASE = 9796562c` (阶段 1 规划提交 `5da198c` 的父提交), `HEAD = 59f107ec`, 共 720 个改动文件、264 笔提交 (其中 65 笔为阶段合并提交).
- 不计入反向范围: `dist/`、`node_modules/`、`tmp/` 等未跟踪产物; 关闭后才产生的归档移动与 BACKLOG 清理.

### 检查方法

- 正向: 计划项 → 预期文件 / 命令 / 符号 → 证据. 例: 计划「根 `README.md` 与 `README.zh.md` 两侧同构」→ 两文件对应节 + 同一提交.
- 反向: 文件 → 提交 → 计划项. 用 `git log --oneline BASE..HEAD -- <文件>` 找归属; 找不到计划项的进例外清单.
- 内容级抽查: 对代码改动看是否属于计划列的动作 (删死导出 / 并定时器 / 拆文件 / 收判断 / 补测试), 对文档改动看是否只做节名归并、命令与术语同步; 计划外行为变化一律标 `△` 或 `✗`.
- 交叉验证: 每份阶段追踪的「文件清单 / 实现记录 / 测试与证据」互相核对; 提交号、用例数、覆盖率数字要与 git 记录或门禁日志一致.
- 例外判定: 只有以下三类可归「允许的例外」——① 追踪文档自身的记录性改动; ② 计划文件内的纯格式化; ③ 已在本文件或阶段追踪「偏差」中明确记录的修正. 其余一律按「计划外」处理.

### 分派

| 检查任务 | 范围 | 输入 | 产出 |
| --- | --- | --- | --- |
| A | 阶段 1 (标准与工具) + 阶段 2 (测试) | 总追踪对应节、`-01` / `-02` 阶段文档、相关 34 份包追踪 | 计划项表、反向文件表、例外 |
| B | 阶段 3 (代码) + 阶段 3b (复核修正) | 总追踪 5.x、`-03` / `-03b`、相关包追踪 | 同上 |
| C | 阶段 4 (包文档) + 阶段 4b (补正) | `-04` / `-04b`、34 份包追踪的包文档节 | 同上 |
| D | 阶段 5 (项目文档) + 总追踪 / BACKLOG #1 验收 | `-05`、根文档、GLOSSARY、归档符号、门禁记录 | 同上 |

- 执行方式: 4 个只读检查任务并行 (coagent 或 subagent 均可), 每个任务只读、不提交、不改文件; 主会话负责基线、去重、抽查与最终结论.
- 每个任务返回统一表: `编号 | 计划要求 | 预期文件 | 证据 (文件:行 / 提交号) | 判定`; 反向表: `文件 | 提交 | 对应计划项 | 判定`; 例外单列.
- 主会话抽查: 每个任务抽 3 条正向、3 条反向证据回读; 抽查不通过则退回该任务补证.

### 判定标准

- `✓`: 计划要求能在当前文件或历史提交中直接看到, 证据可复现.
- `△`: 已做但口径 / 范围 / 位置与计划有差异, 或证据只能间接支持; 需在例外清单写差异.
- `✗`: 计划要求未落实, 或当前状态与计划相反.
- `?`: 依赖外部条件 (如宿主版本、未安装工具) 无法核对; 需写明原因.
- 反向文件: `已计划` / `允许的例外` / `计划外` 三档; 「计划外」必须给出文件、提交与建议处置.

### 输出格式

1. 「计划到实现」表: 按阶段分组, 列编号、计划要求、预期文件、证据、判定.
2. 「实现到计划」表: 按目录分组, 列文件、主要提交、对应计划项、判定.
3. 「例外清单」: 计划外或偏差项, 写现象、证据、影响、建议 (补计划 / 回退 / 接受).
4. 「结论」: 通过 / 有条件通过 / 不通过, 附未决项数量与下一步.

### 明确不做

- 不改任何代码、文档、配置与历史提交; 不修计划文档.
- 不重跑全量门禁 (阶段 5 已跑并记录); 只读取既有日志与结果.
- 不做阶段 5 关闭 (移追踪文档、清 BACKLOG、最后一笔提交).
- 不 push, 不合并, 不删除分支或 worktree.

## 实现记录

### 基线与方法

- 基线: `BASE = 9796562c` (阶段 1 规划提交 `5da198c` 的父提交), `HEAD = 59f107ec`; 反向范围为 720 个改动条目、264 笔提交 (其中 65 笔阶段合并). 规划提交系列 (`0a1be8a9` 至 `9796562c`) 属计划本身, 不在反向范围.
- 正向来源: 总追踪「决策 / 规划 / 验收标准」, 7 份阶段追踪, 34 份包追踪的「实现规划」, `docs/BACKLOG.md` `#1`.
- 反向来源: `git diff --name-status BASE..HEAD` 的 720 条; 逐文件用 `git log --oneline BASE..HEAD -- <文件>` 归口, 再用追踪文档的提交号交叉核对.
- 执行: 4 个只读任务分派 A (阶段 1/2)、B (阶段 3/3b)、C (阶段 4/4b)、D (阶段 5 与验收); B 拆为 B1 / B2, C 的子任务失败后由主会话按同一清单复核. 全部只读, 未改文件、未跑门禁.
- 判定: 正向 `✓ / △ / ✗ / ?`; 反向 `已计划 / 允许的例外 / 计划外`.

### 计划到实现

#### 阶段 1 标准与工具 (31 项)

| 编号 | 计划要求 | 预期文件 | 证据 | 判定 |
| --- | --- | --- | --- | --- |
| P1-01 | 34 份包内 lockfile, 0 份 package-lock | `*/pnpm-lock.yaml` | 34 份; package-lock 0 份; `d559d031` | ✓ |
| P1-02 | 根 check/build 改 `pnpm -C <包> run`, 顺序不变 | 根 `package.json` | `:7-8`; `d559d031` | ✓ |
| P1-03 | 根新增 test:integration / test:e2e / test:coverage | 根 `package.json` | `:10-12`; `0ec16f43` | ✓ |
| P1-04 | 34 包补 `private: true` | 34 份 package.json | 34/34 无缺字段 | ✓ |
| P1-05 | main/types 指 `dist/src/index.js` / `./dist/src/index.d.ts` | 34 份 package.json | agent-group `:7,36`; TUI `:10,45` | ✓ |
| P1-06 | files 固定 dist / README.md / cordis.patch.yml (有 LICENSE 才列) | 34 份 package.json | 34/34 符合; security-guard 已删 `scripts` (2026-11-02) | ✓ |
| P1-07 | scripts 至少 build/check/test, 额外脚本按四类命名 | 34 份 package.json | 34/34 三件齐; 加项均落 demo / smoke / watch / verify / inspect / gen: / example: / check: | ✓ |
| P1-08 | 5 个包补 LICENSE 并在 files 列出 | 5 包 | 5/5 与根 `LICENSE` 相同; `d559d031` | ✓ |
| P1-09 | 覆盖率聚合器只用 Node 标准库, 输出四列表 | `dev/coverage/collect.mjs` / `report.mjs` | 仅 `node:*` import; 四列表齐; `dist` 未排除, 转 `BACKLOG #4` | △ |
| P1-10 | test-parallel.sh 分层、parallel/xargs 两路、`set -u` 累计退出 | `scripts/test-parallel.sh` | `:7,16,40-50,68-77`; 双向校验与 34 包注释已补 (2026-11-02) | ✓ |
| P1-11 | TUI/scripts/test.sh 注释改 pnpm | `TUI/scripts/test.sh` | `:2,5,11,16`; `0ec16f43` | ✓ |
| P1-12 | install.sh 依赖与 build 改 pnpm, 只留两处 npm | `scripts/install.sh` | `:250,267,270,379-387`; `d559d031` | ✓ |
| P1-13 | 34 份 tsconfig 同构, include 固定 src/tests | 34 份 tsconfig.json | 34/34 compilerOptions 相同; include/exclude 全部真实存在 | ✓ |
| P1-14 | 删 5 份 tests/tsconfig.json, 保留 md-table-check | 5 包 | 现仅 `md-table-check/tests/tsconfig.json`; `d559d031` | ✓ |
| P1-15 | 删 8 处 `tests/clock.test.ts` 的 exclude | 8 包 tsconfig | 0 处; 删除落在 `25fce711`; 阶段 1 已补记该落点, 按阶段顺序差接受 | △ |
| P1-16 | 根 .gitignore 收通用规则并合并包内规则 | 根 `.gitignore` | `:2-6,24-25`; 包内并集全覆盖 | ✓ |
| P1-17 | 删 34 份包内 .gitignore | `*/.gitignore` | 0 份; `d559d031` | ✓ |
| P1-18 | 删 13 个根 index.ts | 13 包 | `git diff --diff-filter=D` 13 个; `745ce848` | ✓ |
| P1-19 | 18 个 src/main.ts 改 src/index.ts, TUI 保留 | 18 包 | `git diff --diff-filter=AR` 的 18 个入口文件; TUI main 保留 | ✓ |
| P1-20 | 源码与 package.json 改指 index, 无 main.ts 残留 | 18 包 | 4 个内部 `src/main.ts` 与 TUI 已在 `-01:141` 记录为命名例外; 入口均指 `index` | △ |
| P1-21 | AGENTS 补 36 符号与 20 条映射 | `AGENTS.md` | `:12` | ✓ |
| P1-22 | AGENTS 补术语规则与 GLOSSARY 链接 | `AGENTS.md` | `:13` | ✓ |
| P1-23 | 包数改「本仓 34 个包 = TUI 与 33 个插件」 | `AGENTS.md` | `:13,71` | ✓ |
| P1-24 | 轻量包名单补 tool-consult 共 19 个 | `AGENTS.md` | `:102` 数得 19 个 | ✓ |
| P1-25 | 目录清单补 dev/ 与 GLOSSARY.md | `AGENTS.md` | `:90` | ✓ |
| P1-26 | 格式化跳过三类文件 | `AGENTS.md` | `:47` | ✓ |
| P1-27 | 新建 GLOSSARY: 三行职责、三张表、不写用量 | `docs/GLOSSARY.md` | `:3-5,7,28,49`; `ebc8d76a` | ✓ |
| P1-28 | 流程文档命令改 pnpm、包数改 34 | `docs/WORKFLOW-*.md` | STANDARD `:11,61`; FAST `:18` | ✓ |
| P1-29 | 两处 patch 注释改正 | 2 份 `cordis.patch.yml` | agent-group `:8`; clock-base `:5`; `ebc8d76a` | ✓ |
| P1-30 | 新建阶段 1 追踪文档 | `-01-standards.md` | `:28-155` | ✓ |
| P1-31 | 阶段 1 全量 check/build/test 全绿 | 根脚本 | `-01:148-155` 自述; 2026-11-02 终态复跑 `check` / `build` / `test` / `test:coverage` 退出 0 | ✓ |

#### 阶段 2 测试锚定 (21 项)

| 编号 | 计划要求 | 预期文件 | 证据 | 判定 |
| --- | --- | --- | --- | --- |
| P2-01 | 34 包各有 test:integration | 34 份 package.json | 34/34 同构 | ✓ |
| P2-02 | 34 包各有 test:coverage | 34 份 package.json | 34/34 | ✓ |
| P2-03 | TUI 另加 test:e2e | `TUI/package.json` | `:21` | ✓ |
| P2-04 | 每包新增 tests/integration 与单元锚点 | `*/tests/` | 34 个集成测试文件 | ✓ |
| P2-05 | 装配器放 tests/、不以 .test.ts 结尾、各包自建 | `*/tests/assemble.ts` 等 | 34 个装配器; 无跨包直取 | ✓ |
| P2-06 | 根四个测试入口 | 根 `package.json` | `:9-12` | ✓ |
| P2-07 | session-paths 不设集成层, test:integration 打印缺层原因 | `session-paths/package.json` / README | 实际实跑 12 例 (`:12`); 包追踪 `:72` 记偏差 | ✗ |
| P2-08 | TUI app.test.ts:354 的 skip 按 4.4 处理 | `TUI/tests/app.test.ts` | `:354` 条件式 (仓库不在家目录, 本机不触发) | ✓ |
| P2-09 | behavior-correction 删 rule-engine 契约探针 | 原 `tests/contract.test.ts` | 文件已删 (`e076027c`) | ✓ |
| P2-10 | 两包用例旧名改 herdr_run | 两包 tests | rule-engine 0 处 herdr_use; behavior-correction `:141` 负断言保留 | △ |
| P2-11 | security-guard skip 复核并保留负断言 | `tests/script.test.ts` / `guard.test.ts` | `:41,516`; `guard.test.ts:2522` | ✓ |
| P2-12 | session-title-cutoff:553 的 skip 处理 | `tests/main.test.ts` | `:550-553` 条件式 | ✓ |
| P2-13 | tool-consult skip 收窄为进前二 | `tests/retrieval.test.ts` | `:208-212`; skip 归零 | ✓ |
| P2-14 | 夹具复核 TUI 2 / fs-digest 5 / tool-consult 1 | 三包 fixtures | 8 个夹具均有引用 | ✓ |
| P2-15 | 每包记改前/改后覆盖率 | 34 份包追踪 | 34/34 有「改前」列 | ✓ |
| P2-16 | 每包记用例清单、skip 计数与豁免台账 | 34 份包追踪 | 34/34 已补「四份测试产物」索引 (2026-11-02); 数据未迁出, 转 `BACKLOG #6` | ✓ |
| P2-17 | 每包 README 测试节写层次、三条命令与缺层原因 | 34 份 README | 2026-11-02 补正: 34/34 含 `test:integration` 与 `test:coverage`; `session-paths/README.md:75` 的 `两个 program` 转 `BACKLOG #5` | ✓ |
| P2-18 | 覆盖率整包只升不降 | 阶段 2 记录 | TUI 分支 78.42% → 78.41%, 0.01 点属分母噪声; 已补阶段 2 偏差 | △ |
| P2-19 | 阶段 2 全量 test/check/test:coverage 退出 0 | 根脚本 | `-02:66-67` 自述; 2026-11-02 终态复跑三项退出 0, 首轮 `task-engine` 并行失败后全量复跑通过 | ✓ |
| P2-20 | 集成用例与被测模块同名 `.test.ts` | `*/tests/integration/` | TUI 合规; 33 包统一 `plugin.test.ts`; 已补阶段 2 命名例外 | △ |
| P2-21 | TUI test:e2e 交付 | `TUI/package.json` / 阶段记录 | 阶段 2 demo 段 SMOKE_OK, `smoke:pty` 缺凭据未过; 阶段 5 `P5-27` 已用 `fff-test` + 任意 key 补跑通过; 本条保留阶段 2 历史差 | △ |

#### 阶段 3 代码整理 (10 项)

| 编号 | 计划要求 | 预期文件 | 证据 | 判定 |
| --- | --- | --- | --- | --- |
| P3-01 | 21 个死导出删除且无残留引用 | 12 包 | 全仓 grep 0 命中; 仅 `isInputHistoryBrowseAt` / `GoalContractServiceLike` 等同名变体 | ✓ |
| P3-02 | 定时器族只剩 clock-base 一份 | `clock-base/src/timers.ts` | `find` 仅 1 份; 8 份 `src/timers.ts` 删除 | ✓ |
| P3-03 | 8 包加 link 依赖, tests 改从入口引 | 10 份 package.json / 8 份 `tests/clock.test.ts` | `@dsh-toolset/clock-base` 依赖 10 处; 8 份测试 import 入口 | ✓ |
| P3-04 | 11 个超长文件按职责拆分 | TUI / session-channel / task-engine / security-guard / rule-engine / agent-group / auto-approve | 9 个拆成多文件; TUI 两个长文件转 `TUI/docs/BACKLOG.md` #1/#3, 按后续条目接受 | △ |
| P3-05 | 4 个 1000 至 1200 行文件补不拆理由 | 3 份包追踪 | herdr-use `:149`, session-channel `:110`, tui `:155`; task-engine 已拆到 622 | ✓ |
| P3-06 | 6 组判断各只剩一个出口 | 各包 | 沙箱枚举 / 用户消息 / 按键 / 上下文守卫 / 记忆层级已收; 时钟探测 4 处改用 `clock-base` 的 `readClock` (2026-11-02) | ✓ |
| P3-07 | 一包一提交, 提交信息 `refactor(<包>)` | 264 笔 | 24 个包有 refactor 提交; 3 笔跨包无 scope | ✓ |
| P3-08 | 行为不变, 例外有记录 | 3b / 总追踪 | fs-digest 抛错 `8777399a`、tool-consult 遮罩 `17e1819d`、task-engine 竞态 `c38a0372` 均有记录 | ✓ |
| P3-09 | 阶段 3 门禁 | 记录 | check/build/test/test:coverage 退出 0; 集成层延到 3b | ✓ |
| P3-10 | 总追踪按包记账 | 总追踪 / 34 份包追踪 | 汇总 1 行 + 逐包记录 | ✓ |

#### 阶段 3b 复核修正 (6 项)

| 编号 | 计划要求 | 预期文件 | 证据 | 判定 |
| --- | --- | --- | --- | --- |
| P3B-01 | 三例集成失败修复, 根 test:integration 退出 0 | tool-consult / md-map / task-engine | `17e1819d`、`bbcffc00`、`c38a0372`; 03b `:167` 记连跑 4 次通过 | ✓ |
| P3B-02 | 方向控制符正则并入字符类 | `session-title-cutoff/src/index.ts` | `3fdede6d` 改 `/[\u202a-\u202e]/gu`; 用例补 4 个码点 | ✓ |
| P3B-03 | 11 份包追踪回写 | 11 份追踪 | 均含 3b 条目与不拆理由; 3 处 tsconfig 声明已于 2026-11-02 回写 (`herdr-use` / `herdr-integration` / `task-engine`) | ✓ |
| P3B-04 | code-map / TUI 新条目 | 两份 BACKLOG | code-map `:11` #1; TUI `:14-15` #3/#4 | ✓ |
| P3B-05 | 阶段文档「最近修订」与分支数 25 | 01/02/03 / 总追踪 | `:3` 均更新; `-03:62` 记 25 个分支 | ✓ |
| P3B-06 | fs-digest 与 tool-consult 偏差记录 | 总追踪 / 两包追踪 | tool-consult 三处齐; fs-digest 已补 `8777399a` 与 `-03` 的 91.7% / 80.5% (2026-11-02) | ✓ |

#### 阶段 4 包文档 (15 项)

| 编号 | 计划要求 | 预期文件 | 证据 | 判定 |
| --- | --- | --- | --- | --- |
| P4-01 | 34 份 README 归并六节 | 34 份 README | 34/34 六节齐 (无配置项省配置节) | ✓ |
| P4-02 | 15 份 DESIGN 归并四节 | 15 份 DESIGN | 15/15 四节齐 (output-compress 围栏内示例标题不计) | ✓ |
| P4-03 | 22 份 BACKLOG 与 TUI 专项同步命令/术语 | `*/docs/BACKLOG.md` / TUI 四份专项 | 命令均 pnpm; 术语 0 命中 (2026-11-02 复扫) | ✓ |
| P4-04 | 修 7 条非归档断链 | 7 份包文档 | 目标均在 `docs/archived/`; 全仓非归档断链实测 0 | ✓ |
| P4-05 | 工具数、动作数去数字 | herdr-use / auto-approve / coagent / hash-edit / ast-tools / agent-group | 计划列的行均改; 无「十个工具」「10 个动作」命中 | ✓ |
| P4-06 | 包数改 34 | `md-logic/README.md` | `:55` 已改 | ✓ |
| P4-07 | 界面四组术语 | TUI / security-guard | 状态栏 / 输入框 / 底部提示 0 命中; 旧界面名全量替换转 `docs/BACKLOG.md` #3, 按后续条目接受 | △ |
| P4-08 | 评审改审阅 | 包文档 / 两模板 | 模板 0 命中; TUI README `:351` 与 DESIGN `:378` 仍有旧称, 转 `BACKLOG #5` | △ |
| P4-09 | 34 笔文档提交, 一包一笔 | 34 个 docs(\<包>) | 34 笔; 合并用 cherry-pick (偏差) | ✓ |
| P4-10 | `format` 与 `pnpm run check` | 75 个文件 | `-04:86-89` 记录退出 0 | ✓ |
| P4-11 | TUI README 测试节保留 test:integration 等写法 | `TUI/README.md` | 2026-11-02 补正: 测试节已列 `test:integration` / `test:coverage` | ✓ |
| P4-12 | 六节只改节名、合并重复段落, 不新增结论 | 34 份 README | 结构改动为主; 个别测试数字在 4b 补正 | ✓ |
| P4-13 | 断链/符号/包数复扫 | 全仓 | `-04:88-90` 记录 0 | ✓ |
| P4-14 | 不改代码/测试/配置 | 本阶段 | 34 笔均为 docs(\<包>) | ✓ |
| P4-15 | 包追踪追加实现记录 | 34 份 | 34/34 非空 | ✓ |

#### 阶段 4b 包文档补正 (5 项)

| 编号 | 计划要求 | 预期文件 | 证据 | 判定 |
| --- | --- | --- | --- | --- |
| P4B-01 | 补正 12 份包文档测试数字与结构清单 | 12 份文档 | `eedfb239`: memory-base 90+6、task-engine 171+17、rule-engine 175+13、command-template 48+12 等 | ✓ |
| P4B-02 | 两模板评审改审阅 | 2 份模板 | `ae8be407`: 8 处; 现 0 命中 | ✓ |
| P4B-03 | 7 个源码文件入口注释改 index / 接线 | 7 个 src | `ba8b8b4a`: 9 行, 全为注释 | ✓ |
| P4B-04 | 偏差记录 | `-04b` | auto-approve 43 例、rule-engine 175 例、归档旧引用、task-engine 计划外一处 | ✓ |
| P4B-05 | `check` 与 `format` | 22 个文件 | `-04b:91-96` 记录退出 0 | ✓ |

#### 阶段 5 项目文档与验收 (37 项)

| 编号 | 计划要求 | 预期文件 | 证据 | 判定 |
| --- | --- | --- | --- | --- |
| P5-01 | 宿主索引 rc.3 / 上一份 rc.2, 两侧同改 | `README*.md` | `:7,177`; `59d5c3fd` | ✓ |
| P5-02 | 审计口径 31 包快照, 3 包未审 | 同上 | `:165`; `59d5c3fd` | ✓ |
| P5-03 | DESIGN 名单补 coagent 成 15 个 | 同上 | `:184` | ✓ |
| P5-04 | Documentation 加 GLOSSARY | 同上 | `:168` | ✓ |
| P5-05 | 命令改 pnpm | 同上 | `:103-108,111,128` | ✓ |
| P5-06 | 两侧逐节同构 | 同上 | 各 194 行; 标题、包行、列表、围栏与顺序一致 | ✓ |
| P5-07 | 英文 32 → 33 并记偏差 | `README.md` / `-05:85` | `59d5c3fd`; 已记 | ✓ |
| P5-08 | ROADMAP 包数 34 | `docs/ROADMAP.md` | `:10` | ✓ |
| P5-09 | ARCHITECTURE-REUSE 34 包 + 31 快照 | `docs/ARCHITECTURE-REUSE.md` | `:3,7,9`; 总表 31 行 | ✓ |
| P5-10 | GLOSSARY 终稿三表、三行头、不写用量 | `docs/GLOSSARY.md` | `:3-5,7,28,49` | ✓ |
| P5-11 | GLOSSARY 与 AGENTS / 3.9 链接 | `AGENTS.md` / 总追踪 | `AGENTS.md:13,90`; 总追踪 `:559` | ✓ |
| P5-12 | 场景表覆盖 BACKLOG 条目 | `docs/GLOSSARY.md:9-26` | 缺「BACKLOG 条目」行, 转 `BACKLOG #5` | △ |
| P5-13 | 宿主链接改 archived, 结论不动 | `docs/host/HOST-UPGRADE-0.2.1-rc.2.md` | `:106`; 全文件仅此 1 行差异 | ✓ |
| P5-14 | 8 个归档文件正文符号归一, 单独一笔 | 8 份归档 | `459f70ab`: 43 行 53 处 | ✓ |
| P5-15 | 只换正文, 行内代码与围栏零改动 | 同上 | 2026-11-02 已还原 2 份文件 15 处; 终态行内代码 0 改动, 正文 38 处 | ✓ |
| P5-16 | 现行文档 8 处行内代码命中不误改 | TUI 三份 | 仍为 2+4+2, 均在反引号内 | ✓ |
| P5-17 | 非归档正文符号变体 0 | 全仓 | 正文命中 0 | ✓ |
| P5-18 | 项目术语按 6.6 处理 | README / ROADMAP / ARCH / WORKFLOW | 2026-11-02 复扫: 9 组术语 0 命中; 仅 `模块` 类技术表述按 6.6 分支保留 | ✓ |
| P5-19 | `docs/BACKLOG.md` 术语 | `docs/BACKLOG.md` | 2026-11-02 复扫: 过程记录 / 回归 / 插件包 / 符号规则 / 落点 0 命中 | ✓ |
| P5-20 | BACKLOG 命令改 pnpm | 同上 | `:71` | ✓ |
| P5-21 | 总追踪 npm --prefix 改 pnpm -C | 总追踪 | `59d5c3fd` 改 8 行 | ✓ |
| P5-22 | STATUS.md 不改 | `docs/STATUS.md` | 范围内无 diff | ✓ |
| P5-23 | docs/host 结论与包数快照不动 | `docs/host/*` | 仅导航链接 1 行; HOST-PACKAGES 864 仍 29 包 | ✓ |
| P5-24 | 四条门禁退出 0 | `-05` | `:79,91` 记录 | ✓ |
| P5-25 | 覆盖率不低于基线 | `-05:91` | 86.6% (70416/81275) / 80.0% (16407/20497); 与阶段 3 口径不同, 排除 `dist` 转 `BACKLOG #4` | △ |
| P5-26 | demo --smoke 42 条 SMOKE_PASS | `-05:79,92` | 与阶段 3 / 3b 一致 | ✓ |
| P5-27 | smoke:pty 退出 0 | `-05:92` | fff-test, SMOKE_OK + SMOKE OK | ✓ |
| P5-28 | 34 README 六节 / 15 DESIGN 四节 | 全包 | `-05:93`; 实测 34/34、15/15 | ✓ |
| P5-29 | 非归档断链 0 | 全仓 | 实测 0 (8 条命中均为行内代码示例) | ✓ |
| P5-30 | 34 份包追踪三节非空 | 34 份 | 34/34 | ✓ |
| P5-31 | 阶段追踪有规划与记录 | 7 份 | 01/02/03 用 `## 规划`/`## 范围` 等; 按结构差异接受, 不改历史标题 | △ |
| P5-32 | 总追踪覆盖阶段 1-5 | 总追踪 | 2026-11-02 已补阶段 5 行与收尾记录 | ✓ |
| P5-33 | 包追踪记合并提交 | 34 份 | 均无提交号; 合并在 `-02` / `-03`; 按记录口径差接受 | △ |
| P5-34 | 关闭动作 (移文档、清 #1、最后提交) | 43 份 / BACKLOG | 2026-11-02 已执行: 43 份归档, #1 移除, #4 至 #6 保留, 关闭提交为最后一笔 | ✓ |
| P5-35 | 只剩 main, worktree 干净 | git | `git branch` 仅 main; `git worktree list` 仅主仓 | ✓ |
| P5-36 | 新建审计追踪 | 本文件 | `59f107ec` | ✓ |
| P5-37 | 「行内代码零改动」证据表述与事实一致 | `-05:84` | 2026-11-02 已改为首轮 15 处越界 / 终态 38 处正文; 表述与实测一致 | ✓ |

### 实现到计划

反向范围为 720 个改动条目; 按路径归口结果:

| 范围 | 条目数 | 主要提交 | 对应计划 | 判定 |
| --- | --- | --- | --- | --- |
| 34 包元数据 / tsconfig / lockfile / .gitignore / LICENSE | 约 140 | `d559d031` | 清单 1 | 已计划 |
| 入口迁移 (13 删 + 18 改 + import) | 约 60 | `745ce848`、`cfbcbe64` | 清单 1 | 已计划 |
| 34 包 tests 与装配器 | 204 | 34 笔测试锚定 + `0ec16f43` | 清单 2 | 已计划 |
| 34 包 src | 约 160 | refactor 提交 + `8777399a`、`17e1819d`、`c38a0372` | 清单 3 / 3b | 已计划 |
| 34 包文档与模板 | 78 | 34 笔 docs(\<包>) + `eedfb239`、`ae8be407`、`ba8b8b4a` | 清单 4 | 已计划 |
| 项目文档与归档 | 13 | `ebc8d76a`、`59d5c3fd`、`459f70ab` | 清单 5 | 已计划 |
| 脚本与 dev 工具 | 5 | `d559d031`、`0ec16f43` | 清单 1 / 2 | 已计划 |
| 追踪文档 (含本文件) | 43 | 各阶段记录提交 | 例外 ① | 允许的例外 |
| `scripts/test-one.sh` | 1 | `0ec16f43` | 阶段 1 偏差 4 | 允许的例外 |
| 根 `pnpm-lock.yaml` | 1 | `d559d031` | 无 | 计划外 |

合计: 已计划 675 / 允许的例外 44 / 计划外 1. 计划外文件仅根 `pnpm-lock.yaml` (9 行, `importers: .: {}`), 无功能影响.

### 例外清单

| 编号 | 文件 / 提交 | 现象 | 证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- | --- |
| E-01 | `TUI/docs/archived/2026-10-01-lazy-width-table.md`、`md-table-check/docs/archived/2026-10-16-test-coverage-and-tsconfig.md` (`459f70ab`) | 行内代码内 15 处禁用变体被替换; 前者把被测字符 `➡ ➠ ➢ ➣ ⬅ ⚠` 压成 `→ → → → ← △`, 码点对应关系失真 | `git show 459f70ab`; 前者 `:46,80,85,92`, 后者 `:85,86` | 归档记录被改写, 违反 6.5「代码内命中保留」与「不改归档内容」 | 已补正 (2026-11-02): 15 处还原; 终态 7 文件 38 处正文 |
| E-02 | `-05:84` (`191ffa2a`) | 写「已用脚本确认围栏代码块与行内代码零改动」, 与 E-01 矛盾 | 同上 | 证据声明失真, 不可引用 | 已补正: `-05:83/84/96` 改为首轮越界 15 处、终态 38 处正文 |
| E-03 | 项目级与包文档术语 | 审计时 落点 37、回归 39、收口 2、过程记录 5、符号规则 3、工具集 6、评审 2、影子 1; `docs/BACKLOG.md` 最集中; `WORKFLOW-STANDARD.md:11` 写「模块 = …」 | 逐文件计数见「测试与证据」; D 审计 | 与 `docs/GLOSSARY.md`「不写」列相反; 6.3 的同句「模块」改「包」未做 | 已补正 (2026-11-02): 现行文档 0 命中; 仅规则句与词内命中保留 |
| E-04 | TUI 文档与 BACKLOG | `对话区` 9 处、`回合区` 18 处, 另有 `活动区` / `历史区` / `系统状态区` 等旧称; 2026-11-02 用户裁定统一为 状态列 / 会话区 / 回合区 / 工具区 / 状态行 / 输入区 / 提示行 | `TUI/README.md`、`docs/DESIGN.md`、`docs/SPEC.md`、`docs/BACKLOG.md`; `docs/GLOSSARY.md` | 与 GLOSSARY 旧表冲突; 全量替换影响面大 | 已记录七名口径 (`docs/GLOSSARY.md`「界面名称」); 全量替换转 `docs/BACKLOG.md` #3, 不阻塞本次关闭 |
| E-05 | 34 份 README 测试节 | 审计时 20/34 缺 test:integration, 25/34 缺 test:coverage; TUI 计划明示保留但未写 | 逐包 grep; `-tui:68` | 4.6 的「三条命令」要求在规划里未派活 | 已补正 (2026-11-02): 34/34 含两命令, 25 份有改动 |
| E-06 | 时钟能力探测 | `background-daemon/src/main.ts`、`metric-loop/src/index.ts`、`session-channel/src/service.ts`、`TUI/src/main.ts` 仍各自探测; 2026-11-02 已补正 | `git grep` BASE 11 包 → HEAD 5 包 (含 clock-base 自身) | 5.6「收进 clock-base」未完全落实, 无偏差记录; 补正后 4 处不再自写探测 | 已补正: 4 处改用 `readClock` + `isTimers`; 见「E-06 补正记录」 |
| E-07 | TUI `app/index.ts` 6497 行、`adapter/dsh.ts` 3604 行 | 11 个长文件中的两个只部分拆分 | 阶段 3 偏差; `TUI/docs/BACKLOG.md` #1/#3 | 与验收「11 个长文件完成拆分」有差 | 已有条目, 关闭时接受为后续 |
| E-08 | `session-paths` 集成层 | 计划写「不设集成层」, 实际 12 例实跑 | 包追踪 `:72` | 与 4.2「有服务面必须有集成层」一致, 属计划写错 | 接受并在计划侧记偏差 |
| E-09 | 根 `pnpm-lock.yaml` (`d559d031`) | 计划只列 34 份包内 lockfile | `pnpm-lock.yaml:1-9` | 口径不符, 无功能影响 | 已保留并补记 (2026-11-02): 根 `pnpm run` 会重建该空文件, 阶段 1 证据单列 |
| E-10 | 3 处 `npm --prefix` 文案; `session-paths/README.md:75`「两个 program」; `security-guard` `files` 与 `test-parallel.sh:10` 已补正 (2026-11-02) | 3.6 / 1.3 口径未收敛 | 逐处 grep; 均 BASE 已存在 | 文档与脚本文案失真 | 余 2 处转 `BACKLOG #5` |
| E-11 | TUI 分支覆盖 78.42% → 78.41% | 4.3 要求只升不降 | `-02:48` 只进实现记录 | 门禁例外未入偏差 | 已补阶段 2 偏差 (2026-11-02) |
| E-12 | 3b 回写遗漏 | `herdr-use:141`、`herdr-integration:67`、`task-engine:84,92` 仍称 tsconfig 未动; fs-digest 偏差缺 `8777399a`; `-03:60` 覆盖率过期; 门禁「3 次 / 4 次」并存; 3 处行号漂移 | B2 审计 | 追踪文档与仓库不一致 | 已补正 (2026-11-02): 三处 tsconfig 声明、`8777399a`、`91.7% / 80.5%`、门禁统一 4 次 |
| E-13 | 阶段追踪结构 | 01/02/03 用 `## 规划` / `## 范围` 等, 非模板的 `## 实现规划`; 34 份包追踪无合并提交号 | D 审计 | 不影响内容, 验收第 4 条口径有差 | 接受或补标题 |
| E-14 | GLOSSARY 场景表 | 缺「BACKLOG 条目」行, 仅条件列提到 | `docs/GLOSSARY.md:9-26,42` | 6.6.1 列举场景未全覆盖 | 转 `BACKLOG #5` |
| E-15 | 覆盖率口径 | `-05` 只有 86.6% / 80.0%, 无分子分母; 阶段 3 记 87.7 / 80.1 (report 不排 dist) | `-05:91`; 总追踪 `:1397` | 「不低于基线」只能与阶段 2 对照 | 已补 86.6% (70416/81275) / 80.0% (16407/20497); 排除 dist 转 `BACKLOG #4` |
| E-16 | `profiles/README.md:25` | 仍有可执行 `npm run build` | 未在本轮 diff | 命令口径漏项 | 转 `BACKLOG #5` |
| E-17 | 总追踪与 `-05` | 缺阶段 5 实现记录 / 偏差 / 证据; `## 收尾` 空; STATUS 交付说明未写 | 总追踪 `:1372-1403` | 验收第 4、5 条差收尾文字 | 已补 (2026-11-02): 阶段 5 记录、偏差、证据、收尾与 STATUS 交付说明 |

### 补正记录 (2026-11-02)

用户指示解决 P0 四项, 补正如下:

- 归档还原 (E-01): `TUI/docs/archived/2026-10-01-lazy-width-table.md` 与 `md-table-check/docs/archived/2026-10-16-test-coverage-and-tsconfig.md` 的 15 处行内代码替换已还原; 8 个归档文件的 `git diff 9796562c` 现为 7 个文件 37 行 38 处, 均在正文; 后者与 BASE 完全一致.
- 证据修正 (E-02): `-05:83/84/96` 改为「首轮 53 处中 15 处越界, 终态 7 文件 38 处 37 行, 行内代码零改动」.
- 术语 (E-03): 按 GLOSSARY 替换 落点 / 回归 / 收口 / 过程记录 / 符号规则 / 工具集 / 评审 / 影子覆盖事件 / 插件包; 现行文档 0 命中 (排除归档 / host / 追踪 / GLOSSARY / STATUS); `WORKFLOW-STANDARD.md:11` 改为「本仓 34 个包 = TUI 与 33 个插件」. 仅 `AGENTS.md:13` 的规则句、`herdr-integration/README.md:43` 的「夺回归属」、`preference-analysis/README.md:103` 的「验收口径」为词内命中, 保留.
- README (E-05): 25 份包 `README.md` 测试节补 `test:integration` / `test:coverage` (含 TUI), 34/34 齐; 注释写明层次.
- 界面名称 (E-04): 用户 2026-11-02 裁定统一为 状态列 / 会话区 / 回合区 / 工具区 / 状态行 / 输入区 / 提示行; 旧称映射写入 `docs/GLOSSARY.md`「界面名称」, 全量替换另立 `docs/BACKLOG.md` #3, 本次不执行.
- P0 补正后判定: P5-15 / P5-19 / P5-37 / P2-17 / P4-11 转 `✓`; 合计 `✓ 98` / `△ 23` / `✗ 1` / `? 2`; 剩余 `✗` 为 P2-07 (已记录偏差).
- 未处理: E-12 (3b 回写), 以及阶段 5 收尾; E-04 已转条目 (#3).

### E-06 补正记录 (2026-11-02)

- 改动: `background-daemon/src/main.ts` / `metric-loop/src/index.ts` / `session-channel/src/service.ts` / `TUI/src/main.ts` 4 处改用 `clock-base` 的 `readClock`; `scope` 返回值用 `isTimers` 校验. 四包均依赖 `@dsh-toolset/clock-base`; `background-daemon` / `metric-loop` / `TUI` 新增 link 依赖与 lockfile, `session-channel` 原已有. `metric-loop/tests/assemble.ts` / `controller.test.ts` 与 `session-channel/tests/helpers.ts` 的假时钟面同步补 `scope` / `get`.
- TUI 口径: 根 `README.md` / `README.zh.md`、`TUI/README.md`、`TUI/docs/DESIGN.md` 的「零运行时依赖」改为「零第三方运行时依赖」, 注明仅复用本仓 `clock-base`; `dependencies` 不再为空.
- 验证: 根 `pnpm run check` 退出 0; 四包 `build` 退出 0; 四包 `test` / `test:integration` 退出 0; TUI `demo -- --smoke` 42 条 `SMOKE_PASS`.
- 判定: P3-06 转 `✓`.

### P1-06 / P1-10 / P2-16 补正记录 (2026-11-02)

- P1-06: `security-guard/package.json` 的 `files` 删除 `scripts`, 与 3.6 的固定列一致; 包行为无改动.
- P1-10: `scripts/test-parallel.sh` 增加 `default_pkgs` 与仓库目录的双向校验 (缺目录 / 漏列均告警), 注释「30 个包」改 34; 与 `scripts/install.sh:346-354` 同口径.
- P2-16: 34 份包追踪各追加「四份测试产物」索引 (覆盖率表 / 用例清单 / `skip` 与豁免 / 四入口); 具体数据仍在各包「实现记录」与「测试与证据」, 未搬移.
- 判定: P1-06 / P1-10 / P2-16 转 `✓`; 合计 `✓ 102` / `△ 19` / `✗ 1` / `? 2`.

### 关闭记录 (2026-11-02)

- 补 3 条 BACKLOG: #4 覆盖率口径 / #5 文档残留 / #6 测试产物数据; E-12 全部回写; P4-03 / P5-18 术语复扫 0 命中; P1-31 / P2-19 终态复跑通过; P5-32 / P5-34 完成.
- 43 份追踪文档移入 `docs/archived/`; `BACKLOG #1` 移除; STATUS 补 `escalation-hint` 行, 32 → 33 个插件 / 33 → 34 个包 / 34 → 35 个 bundle; 关闭提交为最后一笔.
- 终态计数: `✓ 110` / `△ 14` / `✗ 1` / `? 0`.

### 结论

**通过.**

理由: 计划的骨架已落到文件并可复现 —— 34 包元数据与 lockfile 统一、入口迁移、34 份 README 六节与 15 份 DESIGN 四节、21 个死导出删除、定时器只剩 `clock-base` 一份、7 条断链修复、正文符号变体 0、包数统一 34、门禁与冒烟记录齐全; 反向 720 个条目中 675 个可归计划项, 仅 1 个计划外文件.

审计时未决项: 正向 125 项中 `✓ 93` / `△ 25` / `✗ 4` / `? 2`, 另有 P5-34 待关闭. 2026-11-02 补正 P0 四项、E-06 与 P1-06 / P1-10 / P2-16, 随后补 E-12 / P4-03 / P5-18、复跑 P1-31 / P2-19、补阶段 5 与关闭动作, 终态 `✓ 110` / `△ 14` / `✗ 1` / `? 0`; 唯一 `✗` 是 P2-07 (`session-paths` 集成层), 已记录且被接受的计划偏差.

关闭前置条件: 无. 2026-11-02 已完成 E-12 回写、阶段 5 记录、43 份追踪归档、`BACKLOG #1` 清除、STATUS 交付说明与最后一笔提交.

E-06 已补正; E-04 已按用户裁定记录七名口径, 全量替换转入 `docs/BACKLOG.md` #3; E-09 删除; E-10 / E-14 / E-16 转 `BACKLOG #5`; E-15 转 `BACKLOG #4`.

已做核对: 2026-11-02 终态复跑 `check` / `build` / `test` / `test:coverage`, 覆盖率为 86.6% (70416/81275) / 80.0% (16407/20497); 首轮 `task-engine` 一例并行失败, 单包复跑 171/171、全量复跑通过. 覆盖率报告仍含 `dist`, 排除方案留在 #4.

2026-11-03 口径补正: `BACKLOG #4` 已落地 —— `dev/coverage/report.mjs` 排除 `dist/`, 连跑三次 `pnpm run test:coverage` 退出 0 且报告内 `dist` 文件 0 条; 同 commit 行 69437~69440 / 77567 (89.5%), 分支 16269~16272 / 20298~20303 (80.2%). 上表 P5-25 与 E-15 的 86.6% / 80.0% 为审计时旧口径快照, 保留不改; 复跑非确定 (±3 行 / ±4 分支) 属并行测试的时序分支, 过程与证据见 `docs/archived/2026-11-03-backlog-batch-four.md`.

## 偏差

- 审计执行: 首轮 B 与 C 的子任务各失败一次 (无收尾消息), B 重试的 B1 也失败; 主会话用 `git grep` / `git diff` / 读文件重建 B1 的 10 项表, 并按同一清单全量复核 C; B2 / A / D 用任务返回结果. 抽查记录见下节.
- 基线取 `5da198c` 的父提交 `9796562c`; 规划提交系列 (`0a1be8a9` 至 `9796562c`) 属计划本身, 不计入反向范围. 若按「任务接取提交之前」取 `c3245d1a`, 会多出 7 笔纯追踪文档提交, 不改变结论.
- `session-paths` 集成层按计划判 `✗` (P2-07), 同时在例外 E-08 记为「计划写错、实现按 4.2 执行」; 若按「已记录偏差」口径可降为 `△`, 结论不变.
- 时钟探测 (E-06) 与 README 测试节 (E-05) 是规划缺口: 计划总表写了要求, 逐包清单未派活; 审计按「计划要求是否落地」判 `△`, 未归入实现错误. E-06 已补正, E-05 已补正.
- 2026-11-02 已复跑 `check` / `build` / `test` / `test:coverage`; TUI `demo -- --smoke` 与 `smoke:pty` 沿用阶段 5 记录. 首轮全量 `test` 中 `task-engine` 一例并行失败, 单包复跑 171/171、全量复跑通过; 覆盖率 86.6% (70416/81275) / 80.0% (16407/20497), 报告仍含 `dist`.
- 2026-11-02 补正: 按用户指示处理 P0 四项 (E-01 / E-02 / E-03 / E-05), 详见「补正记录」; 上表与计数保留审计时快照, 补正后计数单列.

## 测试与证据

### 抽查记录

- A: 抽 `P1-01` (34 份 lockfile / 0 份 package-lock)、`P2-07` (session-paths 实跑)、`P2-17` (README 测试节 20/34) 回读, 与主会话独立扫描一致; 反向抽 `pnpm-lock.yaml` (计划外)、`scripts/test-one.sh` (偏差 4)、`745ce848` 的 13 个删除, 一致.
- B2: 抽 `P3B-01` (`17e1819d` / `c38a0372` 的 diff)、`P3B-02` (`3fdede6d` 正则)、`P3B-06` (fs-digest 缺 `8777399a`) 回读, 一致.
- D: 抽 `P5-15` (归档行内代码 15 处)、`P5-19` (BACKLOG 术语)、`P5-22` (STATUS 未改) 回读, 一致; `P5-14` 的 53 处与 `459f70ab` 的 43 行一致.
- C: 由主会话全量复核: 34/34 README 六节、15/15 DESIGN 四节、78 个包文档路径全部归口到 34 笔 `docs(<包>)` 或 4b 三笔, 计划外 0.

### 独立扫描

- 34/34 包 `package.json` 含 name/version/private/main/types/files/engines/dsh; 34 份 `pnpm-lock.yaml`, 0 份 `package-lock.json`; 仅 `md-table-check/tests/tsconfig.json` 一份测试配置.
- `find -name timers.ts` 仅 `clock-base/src/timers.ts`; 21 个死导出名在 `src` / `tests` 0 命中.
- 34/34 README 六节; 15/15 DESIGN 四节; 非归档断链实测 0 (8 条命中均为行内代码示例 `<source>` / `来源` / `url` / `href` / `a.md`).
- 正文禁用变体 0 (剔除围栏与行内代码后扫全部 tracked `*.md`); 现行文档 8 处行内代码命中未被误改.
- `git branch` 仅 `main`; `git worktree list` 仅主仓; `docs/STATUS.md` 在 `BASE..HEAD` 无 diff; `docs/host` 仅 `HOST-UPGRADE-0.2.1-rc.2.md` 一行导航链接.
- 8 个归档文件在 `459f70ab` 中 43 行 53 处; 其中 15 处在行内代码内, 见 E-01. 补正后 `git diff 9796562c` 为 7 个文件 37 行 38 处, 行内代码 0 处.
- 补正后: 34/34 包 README 测试节含 `test:integration` 与 `test:coverage`; 9 组术语在现行文档 0 命中 (`AGENTS.md:13` 规则句、`herdr-integration/README.md:43`「夺回归属」、`preference-analysis/README.md:103`「验收口径」为词内命中).

### 术语残留计数 (现行文档, 排除 `docs/archived`、`docs/host`、`docs/implementation`、`archive/`、GLOSSARY 自身)

| 术语 | 处数 | 主要文件 |
| --- | --- | --- |
| 落点 | 37 | `TUI/docs/COMMANDS-SPEC.md` 5、`COMMANDS.md` 5、`BACKLOG.md` 5、`README.zh.md` 4、`TUI/docs/DESIGN.md` 3 等 |
| 回归 | 39 | `TUI/docs/SPEC.md` 23、`TUI/docs/DESIGN.md` 10、其余 3 份 |
| 收口 | 2 | `TUI/docs/SPEC.md` |
| 过程记录 | 5 | `docs/WORKFLOW-STANDARD.md` 3、`AGENTS.md` 1、`preference-analysis/docs/BACKLOG.md` 1 |
| 符号规则 | 3 | TUI README / DESIGN / SPEC 各 1 |
| 工具集 | 6 | `docs/ROADMAP.md` 2、`AGENTS.md` 2、`security-guard/README.md` 1、`README.zh.md` 1 |
| 评审 | 2 | `TUI/README.md:351`、`TUI/docs/DESIGN.md:378` |
| 影子覆盖事件 | 1 | `TUI/docs/DESIGN.md` |
| 对话区 / 回合区 | 9 / 18 | TUI README / DESIGN / SPEC / BACKLOG |

以上为审计时快照; 2026-11-02 补正后, 落点 / 回归 / 收口 / 过程记录 / 符号规则 / 工具集 / 评审 / 影子覆盖事件 在现行文档 0 命中 (`AGENTS.md:13` 的规则句、`herdr-integration/README.md:43` 的「夺回归属」、`preference-analysis/README.md:103` 的「验收口径」为词内命中, 保留); `对话区` / `回合区` 未改, 七名口径与后续处理见 E-04 与 `docs/BACKLOG.md` #3.

### 统计

- 正向: 审计时 125 项 = `✓ 93` / `△ 25` / `✗ 4` / `? 2`; 终态 = `✓ 110` / `△ 14` / `✗ 1` / `? 0`; P5-34 已关闭计入 `✓`.
- 反向: 720 条 = 已计划 675 / 允许的例外 44 / 计划外 1.
- 例外: 17 条 (E-01 至 E-17); E-01 / E-02 / E-03 / E-05 / E-06 / E-11 / E-12 / E-17 已补正; E-04 转 `docs/BACKLOG.md` #3; E-09 删除; E-10 / E-14 / E-16 转 #5; E-15 转 #4; E-07 / E-08 / E-13 按例外接受.
