# herdr-use 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 herdr-use 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `herdr-use` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

## 现状

- 单元层: `tests/` 下 12 个 `.test.ts` (见 `tests/`); 阶段 1 末 `pnpm -C herdr-use run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 84.5% (2952/3494); 分支 71.3% (464/651).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C herdr-use run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-herdr-use && mkdir -p ../tmp/cov-herdr-use && NODE_V8_COVERAGE=../tmp/cov-herdr-use node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-herdr-use tmp/cov-herdr-use/report.json
```

- 专项: -.
- 验收: `pnpm -C herdr-use run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 herdr-use 测试锚定`.

### 代码

阶段 3 补; 本阶段不动 `src` (为可测性必须动时先在「偏差」记原因).

### 包文档

阶段 4 补.

## 实现记录

### 改动文件

| 文件 | 改动 |
| --- | --- |
| `herdr-use/tests/assemble.ts` | 新增集成层装配器（不以 `.test.ts` 结尾）：假工具面 / 假事件面 / 假服务面（`guard` / `sandboxPolicy` / `clock`），外加假 herdr CLI runner、假 socket connector、假后台会话控制器与假时钟 |
| `herdr-use/tests/integration/plugin.test.ts` | 新增 22 条集成用例 |
| `herdr-use/tests/actions.test.ts` | 追加 3 条单元锚点（create 响应缺字段、label 部分失败、wait stable 读失败） |
| `herdr-use/tests/main.test.ts` | 追加 2 条单元锚点（探活抛错、pre-execute 参数面边界） |
| `herdr-use/tests/workspace.test.ts` | 追加 2 条单元锚点（cwd 四级回退、label 归一与回退） |
| `herdr-use/package.json` | 加 `test:integration` 与 `test:coverage` |

### 集成层覆盖的接线

- 注册面：十个工具名与顺序、`provide("herdrUse")`、`tools/pre-execute` 订阅、`effect` 卸载器、`clock.scope` 装配期调用两次。
- canonical 回执：`herdr_create`（前台 / 后台）、`herdr_read`、`herdr_list`、`herdr_wait`（stable / match）、`herdr_info` / `label` / `text` / `key` / `close`。
- `output.render` 投影：上述动作逐条断言文本（含 lane 标记、命中行、判稳依据、失败行与放行提示）。
- lane：后台命令统一带 `--session dshbg`；读通道前台取握手的 `HERDR_SOCKET_PATH`，后台取 `dshbg` 探活返回的 socket。
- 失败路径：guard 拒绝（命令未送达）、guard 抛错（fail-open 且只告警一次）、CLI 错误信封、`session-unavailable`、后台会话起不来（不回退前台）、后台 socket 不可用（首次报错、二次走缓存）、二进制不可解析、探活失败、探活抛错、`ctx.tools` 缺席、`register` 抛错。
- 卸载：`apply` 返回的卸载器与 `ctx.effect` 卸载器都解绑 `tools/pre-execute` 并清空登记，服务面仍可读且幂等。

### 单元锚点

- `actions.ts`：`tab create` 缺 `tab_id` / 缺 `root_pane.pane_id` 均为 `herdr-bad-response`（后者不登记）；`label` 的 pane rename 失败带「tab 标题已改」notes 且登记 label 不变；`wait stable` 读通道失败归一为 `socket-error`。
- `main.ts`：`preExecuteVerdict` 对非对象参数按空参数处理、缺 `name` 放行、只读回执带目标终端；探活抛错时告警一次且不注册。
- `workspace.ts`：`readSessionContext` 的 cwd 依次取 `header` / `meta` / `session` / `process.cwd()`，id 缺失即无会话；`workspaceLabel` 的空白与斜杠归一、取不到目录名回退 `dsh`。

## 偏差

1. 装配器不建临时目录：本包 `src` 无落盘路径（只有 `homedir()` 参与 socket 路径推导），4.2 的「落盘写临时目录再断言」没有对象。
2. 退出清理的 `spawnSync` 不进集成层：装配器缺省 `closeOnExit: false`，dispose 只清登记，不在用例里起子进程；`tab close` / `workspace close` 的 argv 面已由 `tests/registry.test.ts` 的单元用例锁住。
3. 集成层经 `apply(ctx, config, deps)` 的第三参注入替身（包内既有的测试注入面，`HerdrUseDeps`），未改 `src`；握手缺省仍走真实 `readHerdrHandshake` 读 env，路径指向当前 node 可执行文件。
4. `tests/clock.test.ts` 的 `tsconfig` `exclude` 与跨包 import 未动（按任务留在阶段 2/3 收口）；因此覆盖率表里带出 `clock-base`，不计入本包结论。
5. 装配器从 `src/types.ts` 取 `SandboxMode`（`src/index.ts` 未导出该类型；仅类型级 import，不触运行时）。
6. 文件级覆盖率的行 / 分支分母随新增执行路径增长（V8 block range 计数变化），个别文件百分比有 1 至 3 个百分点波动；整包行与分支均上升，未退化。

## 测试与证据

### 四条入口（改后）

| 命令 | 结果 |
| --- | --- |
| `pnpm -C herdr-use run check` | 通过（`tsc --noEmit`，无输出） |
| `pnpm -C herdr-use run test` | 143 条通过 / 0 失败 / 0 跳过 |
| `pnpm -C herdr-use run test:integration` | 22 条通过 / 0 失败 / 0 跳过 |
| `pnpm -C herdr-use run test:coverage` | 165 条通过 / 0 失败 / 0 跳过；报告写入 `tmp/cov-herdr-use/report.json` |
| `pnpm -C herdr-use run build` | 通过 |

基线（改前）：`test` 136 条通过 / 0 失败 / 0 跳过；`check` 通过。

### 覆盖率（改前 → 改后，只统 `src`）

| 范围 | 行 | 分支 |
| --- | --- | --- |
| `herdr-use` 整包 | 84.5% (2952/3494) → 88.6% (3246/3664) | 71.3% (464/651) → 75.1% (537/715) |

| 文件 | 行（改前 → 改后） | 分支（改前 → 改后） | 未覆盖行（改后） |
| --- | --- | --- | --- |
| `src/actions.ts` | 80.2% (779/971) → 83.2% (808/971) | 67.9% (133/196) → 73.2% (150/205) | 57,59,90,91,133-137,140,141,147-154,157-163,174,177,222,223,240,253-256,270-273,280,282,283,294-297,301,311-314,317,322,378-382,385-389,397,398,401-417,458,480-485,487-489,494,507,508,530,535,539,542,543,546-549,557,563-567,594-601,617,654,682-687,717-720,731-743,775,776,794-800,810-814,904,949-953 |
| `src/background.ts` | 81.3% (157/193) → 81.3% (157/193) | 72.3% (34/47) → 72.3% (34/47) | 68,71,78,79,83-87,92,108-110,114,115,118-120,123-130,138,153-155,177,178,184-186,195 |
| `src/cli.ts` | 87.6% (248/283) → 87.6% (248/283) | 80.4% (78/97) → 80.4% (78/97) | 28,29,91,149-155,195-203,206-213,217-220,258,262,292,293 |
| `src/index.ts` | 未计入 → 100.0% (170/170) | 未计入 → n/a | - |
| `src/main.ts` | 76.7% (244/318) → 93.1% (296/318) | 57.1% (32/56) → 78.5% (62/79) | 75,103,105,117,131,139,146-148,177,180,193,194,228-230,248-250,256,264,265 |
| `src/policy.ts` | 100.0% (129/129) → 100.0% (129/129) | 96.6% (28/29) → 97.0% (32/33) | - |
| `src/registry.ts` | 91.7% (188/205) → 91.7% (188/205) | 65.6% (21/32) → 63.6% (21/33) | 61,76,136,149-151,157-159,162,198,199,209,210,238-240 |
| `src/service.ts` | 95.5% (147/154) → 95.5% (147/154) | 100.0% (2/2) → 100.0% (2/2) | 59-65 |
| `src/socket.ts` | 89.4% (288/322) → 89.8% (289/322) | 79.7% (47/59) → 79.7% (47/59) | 67,68,92,93,98,126-129,135-140,145,209-213,245-250,292,331,351,352,365,370 |
| `src/timers.ts` | 69.7% (108/155) → 69.0% (107/155) | 30.0% (6/20) → 28.6% (6/21) | 16-19,31-34,37,39,41,47,57-62,69,72,73,91-93,102-107,113-117,122-125,127-129,133,134,144,157-159 |
| `src/tools.ts` | 83.3% (369/443) → 92.6% (410/443) | 68.2% (30/44) → 67.6% (46/68) | 38-41,46,49,55,63,64,77,79,89,101,102,124,129,130,133-135,141,147,151-154,164,166-169,175,176 |
| `src/types.ts` | 97.6% (123/126) → 97.6% (123/126) | 82.6% (19/23) → 82.6% (19/23) | 98,133,141 |
| `src/workspace.ts` | 88.2% (172/195) → 89.2% (174/195) | 73.9% (34/46) → 83.3% (40/48) | 29,56,108,109,112,183-190,194,196-201,219 |

### 用例增删与跳过

| 项 | 数量 |
| --- | --- |
| 新增单元用例 | 7（136 → 143） |
| 新增集成用例 | 22 |
| 新增装配器 | 1（`tests/assemble.ts`） |
| 删除用例 / 夹具 | 0 |
| `skip` / `todo` | 0 / 0（改前改后一致；本包无 skip、无夹具） |
