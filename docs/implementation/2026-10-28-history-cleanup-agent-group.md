# agent-group 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 agent-group 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `agent-group` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

## 现状

- 单元层: `tests/` 下 3 个 `.test.ts` (`core.test.ts` / `main.test.ts` / `model.test.ts`); 阶段 1 末 `pnpm -C agent-group run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 84.8% (2407/2840); 分支 72.6% (398/548).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C agent-group run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-agent-group && mkdir -p ../tmp/cov-agent-group && NODE_V8_COVERAGE=../tmp/cov-agent-group node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs ../tmp/cov-agent-group ../tmp/cov-agent-group/report.json
```

- 专项: -.
- 验收: `pnpm -C agent-group run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 agent-group 测试锚定`.

### 代码

阶段 3 补; 本阶段不动 `src` (为可测性必须动时先在「偏差」记原因).

### 包文档

阶段 4 补.

## 实现记录

2026-10-28 在分支 `history-cleanup/02-tests-agent-group` 完成, 未改 `src`.

- 基线: `pnpm -C agent-group run test` 63 条通过 (0 fail / 0 skip), `duration_ms` 约 131; 覆盖率行 84.8% (2407/2840) / 分支 72.6% (398/548), 与「现状」一致.
- 单元锚点 (4 个新文件 + 2 处追加):
  - `tests/transport.test.ts` (19 条): `isSessionChannelFace` 判据; 寻址的精确命中 / 别名唯一命中 / 离线 / 歧义 / 别名列表读失败 / 端口抛错; 投递的入参透传 / 失败信封与 `candidates` / 缺 `task.id`; 发完即走的 `waitMs` 与 `delivered` 归一; 任务状态六值归一与 `task_not_found` / 未知状态; `peers` 与 `statusOf` (含旧版无该方法).
  - `tests/store.test.ts` (12 条): 文件存储的 ENOENT 按空书 / 原子写与 0600 / 不留 `.tmp` / 可配文件名 / 以当前会话为准 / 旧版 `peerLinks` 补齐 / 非法 JSON / 形状校验 10 种 / 目录推导抛错 / 读失败非 ENOENT / 写失败不残留; 内存存储的深拷贝与注入失败.
  - `tests/mirror.test.ts` (7 条): `registerKind` 只取一次 / 写入字段口径 / `project` 回落 / 句柄不可写 (不缓存、下次重试) / 注册抛错 / `skipped` 拒收 / 空 `skipped` 与缺返回体.
  - `tests/json.test.ts` (5 条): `pruneUndefined` 的对象键与数组项清理 / 原始值 / 非平凡原型原样 / 同引用去重与环 / 无原型对象.
  - `tests/core.test.ts` 追加 2 条: `resolveConfig` 缺省与非法值回落 / 状态文件名白名单 / `statusPollMs=0`; `memberStatesOf` 缺 lookup / 在线集读失败 / 单成员读失败 / 端口抛错的降级. 现有断言未改语义.
- 集成层 (4.2):
  - `tests/assemble.ts`: 装配器 (不以 `.test.ts` 结尾), 三个假面 —— 假工具面 (收集 `register`)、假事件面 (记录 `on`, 本包零订阅)、假服务面 (`get` / `provide`); 另带假 `sessionChannel` / `sessionPaths` / `sessions` / `memory`.
  - `tests/integration/plugin.test.ts` (13 条): 注册面 (`agent_group` 与 `provide: agentGroup`、静态 `inject`、无 `tools` 面只警告、无 `provide` 面不抛、零事件订阅); 工具契约 (动作枚举与必填参数、建组→加成员→连接→发指令→结算→状态的 canonical 值、返回体 lossless JSON、状态落临时目录、缺调用方 `no_caller`、缺服务 `session_channel_unavailable` / `session_paths_unavailable`、服务解析成功后复用缓存); `output.render` 投影 (缩进 JSON / 字符串原样 / 循环引用回落 `String`); 只读服务面 (`status` 的组清单 / 指定组 / 缺组、缺 `sessionPaths`、状态文件损坏、`memberStates` 四态、只读不写盘不镜像、无 channel 时仍可读).
- 脚本: `package.json` 加 `test:integration` (`node --experimental-transform-types --test 'tests/integration/*.test.ts'`) 与 `test:coverage` (临时目录 + `NODE_V8_COVERAGE` + `dev/coverage/report.mjs`).
- 4.4 复核: 本包 `skip` 0 / `todo` 0 / 无夹具, 无失效或过时用例, 无需清理.

## 偏差

1. `test:coverage` 的 report 参数与规划不同: 规划写 `node ../dev/coverage/report.mjs ../tmp/cov-agent-group ../tmp/cov-agent-group/report.json`, 但 `report.mjs` 把参数按**仓库根**解析, `../tmp/...` 会落到 `.worktree/02-tests/tmp` (scandir ENOENT); 实际改为 `tmp/cov-agent-group` (仓库根相对), 采集侧 `NODE_V8_COVERAGE=../tmp/cov-agent-group` 仍按包目录解析.
2. 环境注记 (不改仓库文件): worktree 内包目录原本没有 `node_modules`, `pnpm -C agent-group run <脚本>` 会因依赖检查自动 `pnpm install` 并失败 (`unable to open database file`); 把包内 `node_modules` 软链到主仓同名包的依赖后四条命令正常, `node_modules` 已被根 `.gitignore` 忽略, 不进提交.

## 测试与证据

- `pnpm -C agent-group run check`: 退出 0 (`tsc -p tsconfig.json --noEmit`).
- `pnpm -C agent-group run test`: 108 条通过, 0 fail / 0 skip / 0 todo, `duration_ms` 约 150.
- `pnpm -C agent-group run test:integration`: 13 条通过, 0 fail / 0 skip / 0 todo.
- `pnpm -C agent-group run test:coverage`: 退出 0; 报告 `tmp/cov-agent-group/report.json`.
- 覆盖率 (行 / 分支, 改前 → 改后):

| 文件 | 改前行 | 改后行 | 改前分支 | 改后分支 |
| --- | --- | --- | --- | --- |
| `src/core.ts` | 86.9% (975/1122) | 88.0% (987/1122) | 72.4% (184/254) | 76.0% (199/262) |
| `src/index.ts` | 88.6% (381/430) | 97.0% (417/430) | 86.4% (51/59) | 90.9% (70/77) |
| `src/json.ts` | 81.8% (18/22) | 100.0% (22/22) | 69.2% (9/13) | 100.0% (14/14) |
| `src/mirror.ts` | 89.2% (58/65) | 100.0% (65/65) | 55.6% (5/9) | 100.0% (13/13) |
| `src/model.ts` | 88.3% (723/819) | 88.3% (723/819) | 80.4% (123/153) | 80.4% (123/153) |
| `src/store.ts` | 77.4% (103/133) | 97.7% (130/133) | 50.0% (14/28) | 93.6% (44/47) |
| `src/transport.ts` | 59.8% (149/249) | 92.0% (229/249) | 37.5% (12/32) | 81.3% (52/64) |
| 合计 | 84.8% (2407/2840) | 90.6% (2573/2840) | 72.6% (398/548) | 81.7% (515/630) |

- 分支分母从 548 升到 630: v8 的 block 覆盖按**执行到的函数**统计, 集成层首次触达 `index.ts` / `core.ts` 的若干函数, 分母随之变大; 比值仍升.
- `model.ts` 未升: 本包纯迁移层已由 `tests/model.test.ts` 覆盖主要分支, 本阶段新增用例集中在传输 / 存储 / 镜像 / 集成接线, 未动该层.
- 未覆盖余量集中在 `core.ts` 与 `model.ts` 的拒绝路径模板与条件表达式子表达式 (按行归因落到多行 `failure(...)` 的模板片段), 无 `skip` 兜底.
