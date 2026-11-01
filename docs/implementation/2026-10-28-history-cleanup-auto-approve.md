# auto-approve 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 auto-approve 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `auto-approve` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 代码整理: 按总追踪 5.1 的步骤改本包, 行为不变.

## 现状

- 单元层: `tests/` 下 15 个 `.test.ts` (见 `tests/`); 阶段 1 末 `pnpm -C auto-approve run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 87.2% (3678/4216); 分支 72.1% (838/1162).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C auto-approve run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-auto-approve && mkdir -p ../tmp/cov-auto-approve && NODE_V8_COVERAGE=../tmp/cov-auto-approve node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-auto-approve tmp/cov-auto-approve/report.json
```

- 专项: -.
- 验收: `pnpm -C auto-approve run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 auto-approve 测试锚定`.

### 代码

- 分支 `history-cleanup/03-code-auto-approve`, worktree `.worktree/03-code/auto-approve`; 只改本包源码、本包测试的 import、`package.json` / `pnpm-lock.yaml` 与本文件.
- 前置: `clock-base` 已合并, 本分支从含它的 `main` 开.
- 开工: 在 worktree 的本包目录跑 `pnpm install --frozen-lockfile`; 有 `link:` 依赖时先在 worktree 里构建被依赖包 (`pnpm -C <被依赖包> run build`), 再跑本包 `check`.
- 顺序: 删失效 → 并定时器族 → 拆长文件 → 收拢判断 → 改注释; 每步跑 `pnpm -C auto-approve run check` 与 `pnpm -C auto-approve run test`.
- 任务:
  - 删失效导出: `src/audit.ts:266` `AuditRecent`、`src/decide.ts:270` `allowedByRisk`、`src/rules.ts:27` `RuleInput`.
  - 删 `src/timers.ts`; 入口 `src/index.ts` 的 import 改从 `clock-base` 引; `tests/clock.test.ts` 改从入口引.
  - 拆 `src/learn.ts` (1223 行): 观测 / 规则 / 判定分层.
  - `package.json` / `pnpm-lock.yaml` 加 `link:../clock-base`.
- 验收: `pnpm -C auto-approve run check` 与 `pnpm -C auto-approve run test` 全绿, 用例断言不因组织改动而改; 行为不变 (工具名、参数面、`output.render` 投影、配置键、注入文案、帧内容都不动).
- 提交: `refactor(auto-approve): <动作>`, 一个逻辑一笔; 不改本节实现规划, 不改总追踪与阶段追踪.

### 包文档

阶段 4 补.

## 实现记录

2026-10-28 在分支 `history-cleanup/02-tests-auto-approve` 完成, 只动 `auto-approve/tests/` 与 `auto-approve/package.json`.

- 基线: `pnpm -C auto-approve run check` 退出 0; `pnpm -C auto-approve run test` 157 条全过 (0 skip / 0 todo, 约 260 ms); 覆盖率 行 87.2% (3679/4217), 分支 72.1% (838/1162).
- 单元锚点 (新增 3 个文件, 24 条; 原有用例的断言语义不改):
  - `tests/calls.test.ts` (6 条): `CallTable` 首次记录 / 同 id 补写且参数不被 `undefined` 覆盖 / 容量淘汰与容量归一 (0 归一为 1、非整数向下取整) / 裁定缓存只认已记录 callId / `begin` 并发去重与 `end` / 未给 callId 的各查询.
  - `tests/timers.test.ts` (10 条): `systemTimers` 的排期-取消-间隔-负数与非有限延迟; `resolveClock` 的六类回落形状 (缺 ctx / 缺 get / get 抛错 / clock 形状不符 / `scope` 抛错 / `scope` 返回非定时器) 与两组排期器的绑定参数; `createDeadline` 的到点、取消、卸载、`effect` 缺席与抛错、disposer 抛错与拒绝.
  - `tests/index.test.ts` (8 条): `lastRoute` 的三路取值 (观测优先 / live 日志 / 都取不到) 与字段不全时的继续回溯; `activeSessionId` 的结构面; `createInstructionReader` 空白跳过与按 cwd 缓存; `statusOf` 的 `off` 与学习关闭; `apply` 的兜底 (无 `provide` / 无 logger / `on` 返回非函数 / 日志出口抛错 / 单个 disposer 抛错).
- 集成层: 新增 `tests/assemble.ts` (装配器, 不以 `.test.ts` 结尾) 与 `tests/integration/plugin.test.ts` (12 条). 装配器拼三类假面: 假工具面 (`tools/pre-execute` waterfall + `commands.register` 定义捕获)、假事件面 (`ctx.on` 监听器表与 waterfall 链)、假服务面 (`ctx.get` / `provide` 同一张表); 面板应答者注册在插件之后, 复现宿主装载顺序.
- 集成断言: 契约符号与三个监听器 / 命令各注册一次及启动日志; `provide("autoApprove")` 与 `ctx.get` 同一份、`status` 名单计数; `approval/request` 的 canonical 词表 (`allowed-once` / `rejected` / `cancelled` / `unavailable`) 与「命中不调面板」; `tools/pre-execute` 的 `{kind:"deny", reason}` 与 `{kind:"allow"}` 透传、`enabled: false` 不拦; 两处裁定共用 `callId → 参数` 表; `session/event` 消费者供参数与模型路由; 会话 JSONL 与 memory-base `project` 层同形且不含参数原文; LLM 审查提示注入 `ENVIRONMENT` / `PROJECT_INSTRUCTIONS` (真实读临时目录的 `AGENTS.md`) / `FILTERED_HISTORY` / `PENDING_ACTION`; 命令面 `status` / `mode` / `log` / `clear-fingerprints` / `learn` 的投影文本与错误用法; `dispose` 撤销监听器与命令; `commands` 缺席路径.
- 脚本: `package.json` 加 `test:integration` (跑 `tests/integration/*.test.ts`) 与 `test:coverage` (单元 + 集成一次采集, 再调 `dev/coverage/report.mjs`), 口径见「偏差 2」.
- 分层贡献: 只跑单元层 行 89.8% (3788/4217) / 分支 75.6% (925/1224); 单元 + 集成 行 90.3% (3806/4217) / 分支 75.7% (940/1242); 集成层 +18 行 / +15 分支.

## 偏差

1. 断言口径按本包实际面替换. 任务书与计划写「工具注册 / `execute` canonical 值 / `output.render` 投影」; 本包不注册工具、也没有 `output.render`, 对外可见面是审批应答者、`tools/pre-execute` 监听器与 `/autoapprove` 命令. 集成层对应断言改为: `approval/request` 的 canonical 词表、`tools/pre-execute` 的 `{kind:"deny"|"allow"}` 投影、命令 handler 的投影文本、LLM 审查提示的注入内容.
2. `test:coverage` 里 `report.mjs` 的路径参数改仓库根相对写法. `report.mjs` 用 `resolve(root, argv)` 解析路径, 计划写的 `../tmp/cov-auto-approve` 会落到仓库外; 实际脚本用 `NODE_V8_COVERAGE=../tmp/cov-auto-approve` (相对包目录) 配 `report.mjs tmp/cov-auto-approve ...` (相对仓库根), 两者指向同一目录, 报告仍落仓库 `tmp/`.
3. 计划只列两个新文件; 实际另加 `tests/calls.test.ts` / `tests/timers.test.ts` / `tests/index.test.ts` 三个单元文件. 理由: 这三块是改前未覆盖的大头 (`calls.ts` 行 54.5% / 分支 25.0%, `timers.ts` 分支 21.4%, `index.ts` 分支 48.3%), 且 `calls.ts` / `timers.ts` 原先没有专属用例; 用例只走公开导出, 不改 `src`.
4. 合并轮 (单元 + 集成) 里 `learn.ts` 与 `fingerprint.ts` 的行覆盖比单元轮略低 (`learn.ts` 848 → 838, `fingerprint.ts` 101 → 98). 原因: 集成进程让 V8 对同一函数补出更细的 block range, 原先被外层 range 记成覆盖的行如实记为未覆盖 (如 `FormStore.list` / `remove` 内的遍历, 指纹容量淘汰), 属覆盖率口径变细而非用例减少; 包级仍为 3679 → 3806 行.
5. `tsconfig.json` 的 `exclude: ["tests/clock.test.ts"]` 未动. 该文件跨包 import `clock-base` 的内部模块, 删 `exclude` 会在 `rootDir` 上报错, 按阶段 1 偏差 1 留到阶段 2 统一收口.

## 测试与证据

分支末 (2026-10-28) 四条命令实跑, 均在仓库根经 `pnpm -C auto-approve run <脚本>` 调起:

| 命令 | 结果 |
| --- | --- |
| `check` | 退出 0 |
| `test` | 181 条, pass 181, fail 0, skipped 0, todo 0 (约 470 ms) |
| `test:integration` | 12 条, pass 12, fail 0, skipped 0, todo 0 (约 106 ms) |
| `test:coverage` | 退出 0, 产出 `tmp/cov-auto-approve/report.json` 与下表 |
| `build` (辅助核对) | 退出 0 |

覆盖率 (只统 `src`; 改前 = 分支开工时基线, 改后 = 单元 + 集成):

| 口径 | 行 | 分支 |
| --- | --- | --- |
| 改前 (单元层) | 87.2% (3679/4217) | 72.1% (838/1162) |
| 改后 (单元层) | 89.8% (3788/4217) | 75.6% (925/1224) |
| 改后 (单元 + 集成) | 90.3% (3806/4217) | 75.7% (940/1242) |

| 文件 | 改前行 | 改后行 | 改前分支 | 改后分支 | 未覆盖行 (改后) |
| --- | --- | --- | --- | --- | --- |
| src/answerer.ts | 92.3% (96/104) | 92.3% (96/104) | 79.1% (34/43) | 79.5% (35/44) | 73, 81-82, 84-85, 96, 103-104 |
| src/audit.ts | 86.8% (190/219) | 86.8% (190/219) | 66.7% (28/42) | 67.4% (29/43) | 52, 64, 71-72, 89-92, 111-112, 117, 140-143, 156-159, 167, 195, 200-205, 220-221 |
| src/calls.ts | 54.5% (36/66) | 98.5% (65/66) | 25.0% (1/4) | 94.4% (17/18) | 45 |
| src/command.ts | 75.6% (192/254) | 82.3% (209/254) | 57.6% (34/59) | 62.7% (42/67) | 36, 40-41, 55, 59, 61-63, 73, 76-77, 90, 95-98, 123-127, 133-135, 141-148, 155, 193-197, 220, 223-224, 277-279, 282 |
| src/config.ts | 97.9% (425/434) | 97.9% (425/434) | 91.0% (91/100) | 91.0% (91/100) | 85, 87, 106-107, 110, 130, 132, 172-173 |
| src/decide.ts | 91.7% (253/276) | 91.7% (253/276) | 80.0% (88/110) | 80.0% (88/110) | 83-90, 138, 172-173, 178, 192, 196, 252-254, 263, 265-266, 282, 286, 292 |
| src/fingerprint.ts | 93.5% (101/108) | 90.7% (98/108) | 87.9% (29/33) | 85.3% (29/34) | 85-86, 91-93, 98-99, 116, 119-120 |
| src/gate.ts | 89.5% (94/105) | 91.4% (96/105) | 76.6% (36/47) | 83.7% (41/49) | 43, 45-46, 97, 102, 107-110 |
| src/index.ts | 79.9% (354/443) | 92.8% (411/443) | 48.3% (29/60) | 73.8% (62/84) | 110, 113-114, 173-175, 180, 200-201, 225, 310-311, 314-319, 324-326, 336, 339-341, 343, 345, 364-365, 388, 411, 441 |
| src/learn.ts | 84.0% (848/1010) | 83.0% (838/1010) | 66.4% (221/333) | 65.9% (222/337) | 132-137, 179-180, 209, 212, 217-218, 228-230, 250-251, 274, 283-284, 286, 295, 325, 334, 338-340, 359-360, 363-364, 371, 390-391, 394, 396, 417, 422, 431, 433-439, 456-457, 460, 487-494, 514, 517-520, 523-524, 528, 543, 549, 580, 590-591, 596-597, 635-637, 640, 654-655, 661-662, 664-669, 689, 697, 734-736, 739-741, 746, 762, 766-767, 770-772, 776-777, 782-783, 804, 810, 812, 814-816, 824-826, 838, 841, 846, 861, 874-876, 887, 893, 895-898, 900, 904, 921, 925, 928-929, 931, 967, 972, 975-976, 991, 1009-1010, 1019-1021, 1031, 1041, 1043, 1046-1048, 1059, 1062-1063, 1071, 1074, 1083-1085, 1090-1092, 1097, 1101, 1109-1110, 1124-1125, 1157, 1159-1161 |
| src/patterns.ts | 99.1% (111/112) | 99.1% (111/112) | 94.3% (50/53) | 94.3% (50/53) | 41 |
| src/review.ts | 92.0% (438/476) | 92.0% (438/476) | 76.3% (90/118) | 76.3% (90/118) | 89-92, 121, 191-193, 204, 217, 219-221, 237-238, 252-253, 255-256, 283, 349-350, 352-354, 365-366, 368-369, 373, 416, 418, 423-424, 428, 451, 453-454 |
| src/rules.ts | 96.2% (176/183) | 96.2% (176/183) | 81.2% (56/69) | 81.2% (56/69) | 79, 110-111, 156-157, 162, 187 |
| src/runtime.ts | 94.9% (93/98) | 94.9% (93/98) | 86.7% (13/15) | 86.7% (13/15) | 60, 65, 69-71 |
| src/sessions.ts | 90.1% (137/152) | 90.1% (137/152) | 70.0% (28/40) | 70.0% (28/40) | 50, 52-53, 58, 63, 100-101, 106, 117, 121, 160-161, 163-165 |
| src/timers.ts | 74.2% (115/155) | 96.8% (150/155) | 21.4% (6/28) | 80.8% (42/52) | 47, 59, 123-124, 144 |
| src/types.ts | 90.9% (20/22) | 90.9% (20/22) | 50.0% (4/8) | 55.6% (5/9) | 12, 22 |

- 用例增减: 新增 24 条单元用例 + 12 条集成用例; 删除 0 条; `skip` 0 / `todo` 0 (与改前一致). `tests/` 现有 18 个单元 `.test.ts`、1 个集成用例 (`tests/integration/plugin.test.ts`)、1 个装配器 (`assemble.ts`) 与 1 个假件 (`fakes.ts`).
- 夹具: 无新增夹具文件; 临时目录由 `tempDir()` 落在系统 tmp, 覆盖率原始数据与报告落在仓库 `tmp/` (已忽略), 都不入库.
- 提交: 分支提交 `test: 补 auto-approve 测试锚定`.
