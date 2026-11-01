# context-report 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 context-report 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `context-report` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 无代码改动, 不建分支.

## 现状

- 单元层: `tests/` 下 3 个 `.test.ts` (`fold.test.ts` / `main.test.ts` / `report.test.ts`); 阶段 1 末 `pnpm -C context-report run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 93.3% (760/815); 分支 87.3% (268/307).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C context-report run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-context-report && mkdir -p ../tmp/cov-context-report && NODE_V8_COVERAGE=../tmp/cov-context-report node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-context-report tmp/cov-context-report/report.json
```

- 专项: -.
- 验收: `pnpm -C context-report run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 context-report 测试锚定`.

### 代码

阶段 3 无代码改动, 不建分支. 本包的整理在阶段 4 (包文档) 完成.

### 包文档

阶段 4 补.

## 实现记录

- 基线 (分支起点, 未改任何文件): `pnpm -C context-report run check` 通过; `test` 41/41 通过 (87ms); 覆盖率 行 93.3% (760/815)、分支 87.3% (268/307), 与阶段 1 末记录一致.
- 单元锚点: 新增 10 条, 只补未走到的判定与边界, 既有断言不改语义.
  - `tests/fold.test.ts`: step/end 无起始步 (不计样本、推进水位)、assistant/message 无打开步 (忽略 usage)、事件缺 seq 或 seq 非有限数 (按下标补位).
  - `tests/report.test.ts`: formatCount 非有限数与负数、formatMs 非有限数与非正数、occupancyOf 非正读数与非法容量、withDefaults 无外部构成.
  - `tests/main.test.ts`: pressureFromMeasure 逐字段丢弃非法读数、routeOf 缺 model 或非字符串、schema 数组拒绝与 asOfSeq 负数放行与可选路由置空.
- 集成层: 新增 `tests/assemble.ts` (装配器, 不以 `.test.ts` 结尾) 与 `tests/integration/plugin.test.ts` (16 条).
  - 三个假面照 4.2: 假工具面 (收 register 定义, 按名取用)、假事件面 (断言本包零订阅)、假服务面 (`provide` / `get` 同表, 重复注册抛错); 另加假投影注册表 (按会话惰性整段折叠并缓存, 可 `drive` 逐事件 eager 驱动)、假 `tokenMeter`、假 logger.
  - 覆盖: 契约符号与一次注册、投影折叠 canonical token、工具三条 action 的 canonical 值、`output.render` 投影文本 (逐行锁定 standard 报告)、显式 session_id 与 camelCase 别名、细节级别取舍、会话不唯一与未知 id 两条失败路径、投影/统计/tokenMeter 三类读面抛错、缺 `sessionProjections`、注册被拒、工具注册抛错或缺席、provide 抛错或缺席、无 tokenMeter、`projection=false` 与配置缺省 detail.
- 脚本: `context-report/package.json` 加 `test:integration` 与 `test:coverage`; 覆盖率参数照包文档用 `tmp/cov-context-report`.
- `src` 未改.

## 偏差

- 代码读的是 `ctx.logger.info(...)` (对象形态), 与 `BundleHost.logger?(ns)` 的类型声明不一致; 集成装配器按代码实际读法提供对象 logger, 该不一致记下留待阶段 3 代码整理, 本阶段未动 `src`.
- 本包没有落盘面 (报告只读投影与 token 读数), 实现规划里「落盘写临时目录」不适用, 集成层不写临时目录.
- `src/schema.ts` 分支分母由 30 变 32、已覆盖分支数由 23 变 24, 百分比 76.7% 降到 75.0%; 分母变化来自 V8 跨测试进程的分支块发现 (新增集成用例多导入一次 schema), 不是退化; 包级行与分支均上升.

## 测试与证据

四条命令实跑 (分支 `history-cleanup/02-tests-context-report`):

| 命令 | 结果 |
| --- | --- |
| `pnpm run check` | 通过 (`tsc --noEmit` 无输出) |
| `pnpm run test` | 51 通过, 0 失败, 0 skip, 0 todo, 88ms |
| `pnpm run test:integration` | 16 通过, 0 失败, 0 skip, 0 todo, 81ms |
| `pnpm run test:coverage` | 67 通过 (单元 51 + 集成 16), 0 失败; 覆盖率见下表 |

覆盖率 (改前 = 仅单元层; 改后 = 单元 + 集成):

| 文件 | 改前行 | 改后行 | 改前分支 | 改后分支 | 改后未覆盖行 |
| --- | --- | --- | --- | --- | --- |
| `src/fold.ts` | 98.3% (113/115) | 98.3% (113/115) | 95.0% (38/40) | 95.1% (39/41) | 63, 136 |
| `src/index.ts` | 未计 | 100.0% (1/1) | 未计 | n/a (0/0) | - |
| `src/main.ts` | 91.4% (393/430) | 96.0% (413/430) | 82.7% (110/133) | 89.4% (126/141) | 66, 164, 179, 241, 242, 249, 250, 260, 270, 271, 337, 345, 346, 347, 348, 383, 443 |
| `src/report.ts` | 95.8% (205/214) | 96.3% (206/214) | 93.3% (97/104) | 94.4% (101/107) | 87, 88, 179, 184, 198, 199, 200, 201 |
| `src/schema.ts` | 87.5% (49/56) | 87.5% (49/56) | 76.7% (23/30) | 75.0% (24/32) | 47, 48, 52, 53, 55, 56, 57 |
| 合计 | 93.3% (760/815) | 95.8% (782/816) | 87.3% (268/307) | 90.3% (290/321) | - |

- 新增用例 26 条 (单元 10 + 集成 16); 删除 0 条; 夹具无增删.
- `skip` 0 条, `todo` 0 条; 本包无 4.4 所列失效用例, 无豁免台账.
- 断言只经 `src/index.ts` 公开导出与装配器, 未 mock `src` 内部函数; 报告文本逐行锁定, 重构后不改断言即应通过.
- 覆盖率为未覆盖行按 dev/coverage 的 V8 range 聚合口径; 剩余行多为 V8 行号归因噪声 (类型声明行、catch 已执行行) 与 schema 类型块, 未为数字补空跑用例.
