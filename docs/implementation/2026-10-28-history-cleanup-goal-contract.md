# goal-contract 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 goal-contract 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `goal-contract` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 代码整理: 按总追踪 5.1 的步骤改本包, 行为不变.

## 现状

- 单元层: `tests/` 下 4 个 `.test.ts` (`clauses.test.ts` / `contract.test.ts` / `interview.test.ts` / `tool.test.ts`); 阶段 1 末 `pnpm -C goal-contract run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 87.6% (626/715); 分支 81.8% (189/231).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C goal-contract run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-goal-contract && mkdir -p ../tmp/cov-goal-contract && NODE_V8_COVERAGE=../tmp/cov-goal-contract node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-goal-contract tmp/cov-goal-contract/report.json
```

- 专项: -.
- 验收: `pnpm -C goal-contract run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 goal-contract 测试锚定`.

### 代码

- 分支 `history-cleanup/03-code-goal-contract`, worktree `.worktree/03-code/goal-contract`; 只改本包源码、本包测试的 import、`package.json` / `pnpm-lock.yaml` 与本文件.
- 开工: 在 worktree 的本包目录跑 `pnpm install --frozen-lockfile`; 有 `link:` 依赖时先在 worktree 里构建被依赖包 (`pnpm -C <被依赖包> run build`), 再跑本包 `check`.
- 顺序: 删失效 → 并定时器族 → 拆长文件 → 收拢判断 → 改注释; 每步跑 `pnpm -C goal-contract run check` 与 `pnpm -C goal-contract run test`.
- 任务:
  - 删失效导出 `src/types.ts:29` `GoalContract`.
  - `src/index.ts:5` 的路径注释补成完整路径 `task-engine/src/index.ts`.
- 验收: `pnpm -C goal-contract run check` 与 `pnpm -C goal-contract run test` 全绿, 用例断言不因组织改动而改; 行为不变 (工具名、参数面、`output.render` 投影、配置键、注入文案、帧内容都不动).
- 提交: `refactor(goal-contract): <动作>`, 一个逻辑一笔; 不改本节实现规划, 不改总追踪与阶段追踪.

### 包文档

阶段 4 补.

## 实现记录

- 基线: `pnpm -C goal-contract run test` 41 例全绿 (clauses 8 / contract 11 / interview 8 / tool 14), `check` 通过; 覆盖率行 87.6% (626/715)、分支 81.8% (189/231), 与现状记录一致.
- 单元锚点: 新增 14 例, 只加不断 (现有断言语义未改).
  - `tests/clauses.test.ts`: 非对象条目 (`null` / 数组 / 字符串 / 数字) 逐条报错; `camelCase` 的 `outputSchema` 归一化; 只有 `[level]` 前缀或只有箭头的空 check 行被跳过且 id 顺延; 全为空 check → 空集报错.
  - `tests/contract.test.ts`: `summaryWidth` 逐段覆盖宽字符区间 (谚文 / 假名 / 扩展 A / 基本区 / 彝文 / 谚文音节 / 兼容 / 全角 / 扩展 B), 窄字符仍按 1 列; CRLF objective 的嵌入与回读往返.
  - `tests/interview.test.ts`: 无 `custom` 时目标按 `selected` 空格拼接、条款按换行拼接; `renderContract` 预览的 canonical 文本.
  - `tests/tool.test.ts`: `max_goal_rounds` 缺省不上送; `goals` 无 `get` 时回落 `create` 返回值; 回读解析异常时 `ok` 不翻转且带 `readback.error`; `clauses` 与 `clauses_text` 同给时 `clauses` 优先; `exec` 缺席仍可落 goal; objective 自带 `Done-when:` 标记行 → 契约嵌入失败; 每轮空答案 3 次后中止.
- 集成层: 新增 `tests/assemble.ts` (三假面装配器, 不以 `.test.ts` 结尾) 与 `tests/integration/plugin.test.ts` (9 例).
  - 装配器: 假工具面 (present / missing / throwing)、假事件面 (订阅计数)、假服务面 (经 `ctx.get` / 直连属性 / 完全缺席三种形态); 另带假 dsh-goal (`create` 记请求与 `goal/change` 事件, 可选不暴露 `get`) 与假 userQuestions (按脚本应答, 可拒绝).
  - 用例: bundle 契约符号与工具注册的 canonical 值 (name / inject / 工具名 / 描述 / 参数 schema / output schema / 零事件订阅); 全量预填的 canonical 结果与 `goal/change` 落点; `output.render` 的 JSON 投影可还原; 访谈路径经 `ctx.get` 取服务并透传 `agent` / `signal`; tools 面缺席与 register 抛错的降级; 服务缺席的告警与 canonical 错误; 无 `ctx.get` 时直连属性回落; 访谈取消 / `create` 抛错 / 首行超限 / 回读解析异常的失败路径; `NO_PROVIDER` 与空答案重问上限.
- `package.json`: 加 `test:integration` (`tests/integration/*.test.ts`) 与 `test:coverage` (`NODE_V8_COVERAGE=../tmp/cov-goal-contract` 跑单元加集成, 再跑 `dev/coverage/report.mjs`).
- 改动的文件: `goal-contract/tests/assemble.ts` (新)、`goal-contract/tests/integration/plugin.test.ts` (新)、`goal-contract/tests/clauses.test.ts`、`goal-contract/tests/contract.test.ts`、`goal-contract/tests/interview.test.ts`、`goal-contract/tests/tool.test.ts`、`goal-contract/package.json`、本追踪文档.

## 偏差

无. `src` 未改动; 包 `README.md` 的「测试」节按实现规划留到阶段 4.

## 测试与证据

四条命令均在本分支实跑 (2026-10-28):

```text
pnpm -C goal-contract run check            # tsc --noEmit, 通过 (无输出)
pnpm -C goal-contract run test             # tests 55 / pass 55 / fail 0 / skipped 0 / todo 0
pnpm -C goal-contract run test:integration # tests 9 / pass 9 / fail 0
pnpm -C goal-contract run test:coverage    # 见下表, 退出码 0
```

覆盖率 (只统 `src`; 改前列为阶段 1 基线, 改后列为单元加集成):

| 文件 | 行 (改前) | 行 (改后) | 分支 (改前) | 分支 (改后) |
| --- | --- | --- | --- | --- |
| `src/clauses.ts` | 94.5% (103/109) | 97.2% (106/109) | 91.4% (53/58) | 95.3% (61/64) |
| `src/contract.ts` | 93.4% (99/106) | 100.0% (106/106) | 78.7% (37/47) | 96.1% (49/51) |
| `src/index.ts` | 39.5% (17/43) | 100.0% (43/43) | n/a (0/0) | 100.0% (18/18) |
| `src/interview.ts` | 92.3% (180/195) | 93.8% (183/195) | 80.9% (38/47) | 83.3% (40/48) |
| `src/tool.ts` | 86.6% (227/262) | 94.3% (247/262) | 77.2% (61/79) | 85.1% (74/87) |
| 合计 | 87.6% (626/715) | 95.8% (685/715) | 81.8% (189/231) | 90.3% (242/268) |

分层贡献 (同一次改动两轮取差): 只跑单元层为行 91.7% (656/715)、分支 89.8% (219/244); 加集成层后行 95.8% (685/715)、分支 90.3% (242/268) — 集成层贡献 +29 行、+23 分支. 分支分母 231 → 268 是因为本轮首次跑到 `src/index.ts` 与更多工具分支, V8 记录的 block range 随之增多; 分子只增不减.

剩余未覆盖行集中在防御分支: `src/tool.ts:251` (`objective` 为空或 `clauses` 为空, 状态机已保证不可达)、`src/interview.ts:173` 起的空回答与重问分支 (同一表达式的其他臂已覆盖, 报告的 range 归属噪声)、`src/clauses.ts` 自由文本循环内的表达式行 (同类路径已由其他用例执行). 无 `skip` / `todo`; 未连接 Redis / pty / 真宿主, 真机联调仍走 `pnpm run smoke`.
