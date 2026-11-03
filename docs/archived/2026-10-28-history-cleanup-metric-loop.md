# metric-loop 整理 (所属总追踪: `docs/archived/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 metric-loop 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `metric-loop` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 无代码改动, 不建分支.

## 现状

- 单元层: `tests/` 下 3 个 `.test.ts` (`controller.test.ts` / `engine.test.ts` / `persist.test.ts`); 阶段 1 末 `pnpm -C metric-loop run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 90.5% (801/885); 分支 83.3% (174/209).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C metric-loop run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-metric-loop && mkdir -p ../tmp/cov-metric-loop && NODE_V8_COVERAGE=../tmp/cov-metric-loop node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-metric-loop tmp/cov-metric-loop/report.json
```

- 专项: -.
- 验收: `pnpm -C metric-loop run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 metric-loop 测试锚定`.

### 代码

阶段 3 无代码改动, 不建分支. 本包的整理在阶段 4 (包文档) 完成.

### 包文档

- 分支 `history-cleanup/04-package-docs-metric-loop`, worktree `.worktree/04-package-docs/metric-loop`; 只改本包文档, 不动 `src` / `tests` / 配置文件.
- 文件: `README.md`.
- `README.md`: 现有 7 个二级标题按总追踪 3.9 归并为六节 `## 定位` / `## 能力` / `## 配置` / `## 用法` / `## 边界` / `## 测试`; 无配置项可省 `## 配置`; 只改节名、合并重复段落, 不删内容、不新增结论.
- 命令: 正文与示例里的 `npm` 一律改 `pnpm`, 与根 `package.json` 的脚本名一致.
- 术语: 按 `docs/GLOSSARY.md` 与总追踪 6.6 校一遍本包术语、界面名与旧称.
- 验收: 六节齐 (无配置可省)、正文命令全 `pnpm`、本包非归档断链 0、符号变体 0、术语与 `docs/GLOSSARY.md` 一致; `format` 后自查 diff; 文档改动不跑代码门禁.
- 提交: `docs(metric-loop): 归并包文档为六节`; DESIGN / BACKLOG / 专项改动按文件分笔或并入同一笔.

## 实现记录

- 阶段 2 测试锚定（分支 `history-cleanup/02-tests-metric-loop`）:
  - 基线（改前, 本 worktree 实测）: `pnpm -C metric-loop run test` 47 条全过（116ms）; `check` 绿; 覆盖率行 90.5% (801/885) / 分支 83.3% (174/209).
  - 单元层: 新增 `tests/measure.test.ts`（7 条: 单数字解析的正负例 / stdout+stderr 合并输出 / 成功 / 无数字 / 非零退出 / 50ms 超时 / 尾部 500 字符截断 / `cwd` 透传）; `tests/persist.test.ts` 追加 2 条（缺必填字段报字段名、历史超 500 轮只留尾部）。既有用例语义未改.
  - 集成层: 新增 `tests/assemble.ts`（假工具面 / 假事件面 / 假服务面 + 假时钟, 不以 `.test.ts` 结尾）与 `tests/integration/plugin.test.ts`（17 条, 6 个 describe）:
    - 注册与元数据: `metric_loop` 单工具、四动作与枚举、`output.schema` 为 object; 导出 `name` / `inject` / `provide`; 事件面零订阅、服务面出现 `clock` 与 `metricLoop`; `ctx` 缺 `tools` 时降级告警.
    - `execute` canonical 值: `start` 的完整 `TickResult`（round / state / schedule / summary / `guardScope=tool-args`）与落盘一致; `start` 缺省 id / metricless; `tick` 的 cadence 节流（`deferred`、`nextWakeSec=40`、state 不变）与 explicit 紧急唤醒（累计 token、`nextWakeSec=60`）; `tick` 未知 id 转结构化错误; `status` / `stop` / 未知 action.
    - 停止与超时（假时钟拨表, 无真实等待）: `maxRounds` 到顶、时间边界到点（轮前停止、`round=null`、`schedule=null`）、已停止再 tick 不增轮、测量失败记无改进.
    - `output.render`: 对象投影为缩进 JSON、字符串原样、`undefined` 给占位.
    - 服务面: `metricLoop` 的 `list` / `status` 与状态文件一致; 读钟走 `ctx.get('clock').now()`, `clock` 缺席回落 `Date.now`; `security-guard` 复查按 `guardScope` 分工（`start` 不复查、`tick` 复查并记录来源）、拦截回执转结构化错误且状态文件不变、无可达性依赖.
  - 脚本: `metric-loop/package.json` 增 `test:integration` 与 `test:coverage`（命令与规划一致, 报告写 `tmp/cov-metric-loop`）.
  - `skip` / `todo`: 本包 0 处; 无夹具, 无豁免台账条目; 4.4 专项无需处置.

## 偏差

1. `tests/assemble.ts` 取 `ManualClock` 用**非字面量 URL 动态 import**（`new URL("../../clock-base/src/index.ts", import.meta.url)`）, 不是静态 import: 静态写法会把对端源码拉进本包 `tsconfig` 的编译范围, 越出 `rootDir` 触发 TS6059（阶段 1 偏差 1 记录的同类问题）。运行时用的仍是 `clock-base` 导出的同一个 `ManualClock` 类, 形状由装配器内的结构接口 `ManualClockLike`（`now` / `advance`）兜住.
2. 覆盖率报告里会出现 `clock-base/src/*` 两行: 来自偏差 1 的跨包 import, 不属本包口径, 不计入本包合计（与 `ast-tools` 追踪文档同一处理口径）.

## 测试与证据

改前 / 改后覆盖率（只统本包 `src`; 报告行号为 0 基, 照报告原样转述）:

| 文件 | 改前行 | 改后行 | 改前分支 | 改后分支 |
| --- | --- | --- | --- | --- |
| `metric-loop/src/engine.ts` | 96.8% (213/220) | 97.3% (214/220) | 93.2% (82/88) | 95.6% (86/90) |
| `metric-loop/src/index.ts` | 92.4% (495/536) | 94.0% (504/536) | 79.8% (75/94) | 89.6% (95/106) |
| `metric-loop/src/measure.ts` | 50.0% (28/56) | 87.5% (49/56) | 0.0% (0/7) | 81.0% (17/21) |
| `metric-loop/src/persist.ts` | 89.0% (65/73) | 98.6% (72/73) | 85.0% (17/20) | 95.5% (21/22) |
| 合计 | 90.5% (801/885) | 94.8% (839/885) | 83.3% (174/209) | 91.6% (219/239) |

未覆盖行（改后, 报告原样）: `engine.ts` 49,50,51,115,255,267; `index.ts` 224-226, 244-250, 404-407, 460-465, 474, 487, 606-609, 621-622, 635-637, 642; `measure.ts` 59-62, 71-73; `persist.ts` 47。这些行多为 `??` 默认值 / 对象展开的未选分支与函数声明行（报告把零命中 block range 记成未覆盖行）, 不是未执行的业务路径（如 `engine.ts` 的非法 `maxRounds` 已有 `normalizeSpec` 用例、`nextWakeMs` 停止态已有用例）。

分层贡献（两轮取差, 改后）: 只跑单元层 93.6% (828/885) / 86.4% (191/221); 单元加集成 94.8% (839/885) / 91.6% (219/239) → 集成层贡献行 +1.2pp、分支 +5.2pp。

四条命令实跑（本 worktree）:

| 命令 | 结果 |
| --- | --- |
| `pnpm -C metric-loop run check` | 退出 0（无诊断） |
| `pnpm -C metric-loop run test` | 56 tests / 56 pass / 0 fail / 0 skipped / 0 todo（约 200ms） |
| `pnpm -C metric-loop run test:integration` | 17 tests / 17 pass / 0 fail / 0 skipped / 0 todo（约 110ms） |
| `pnpm -C metric-loop run test:coverage` | 绿; 合计行 94.8% (839/885) / 91.6% (219/239); 报告 `tmp/cov-metric-loop/report.json` |

用例增减: 单元 47 → 56（新增 9, 删 0）; 集成 0 → 17（新增 17, 删 0）。`skip` 计数 0（本机未触发环境探测类跳过）; 豁免台账空。端到端不适用（本轮只 `TUI` 做端到端, 见总追踪「后续意向」）。

## 四份测试产物

| 产物 | 位置 |
| --- | --- |
| 覆盖率表 (改前 / 改后) | 见「测试与证据」的覆盖率表 |
| 新增 / 删除用例清单 | 见「实现记录」的「单元锚点 / 集成层」段 |
| `skip` 计数与豁免台账 | 见「测试与证据」的 `skip` / 豁免段 |
| 四个入口实跑 | 见「测试与证据」的入口段 |
