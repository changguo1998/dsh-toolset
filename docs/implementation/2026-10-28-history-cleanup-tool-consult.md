# tool-consult 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 tool-consult 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `tool-consult` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 无代码改动, 不建分支.

## 现状

- 单元层: `tests/` 下 8 个 `.test.ts` (`aliases.test.ts` / `config.test.ts` / `degrade.test.ts` / `main.test.ts` / `matcher.test.ts` / `retrieval.test.ts` / `state.test.ts` / `tokenize.test.ts`); 阶段 1 末 `pnpm -C tool-consult run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 89.4% (1292/1445); 分支 80.0% (216/270).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: `tests/retrieval.test.ts:209` 的 `skip` 收窄为「`channel_delegate` 进前二」; 复核 `tests/fixtures/` 的 1 个夹具
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C tool-consult run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-tool-consult && mkdir -p ../tmp/cov-tool-consult && NODE_V8_COVERAGE=../tmp/cov-tool-consult node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-tool-consult tmp/cov-tool-consult/report.json
```

- 专项: `tests/retrieval.test.ts:209` 的 `skip` 收窄为「`channel_delegate` 进前二」; 复核 `tests/fixtures/` 的 1 个夹具.
- 验收: `pnpm -C tool-consult run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 tool-consult 测试锚定`.

### 代码

阶段 3 无代码改动, 不建分支. 本包的整理在阶段 4 (包文档) 完成.

### 包文档

阶段 4 补.

## 实现记录

- 基线 (分支起点): `pnpm -C tool-consult run check` 通过; `pnpm -C tool-consult run test` 81 例 (80 通过 / 1 跳过, 约 0.12 s); 覆盖率行 89.4% (1292/1445), 分支 80.0% (216/270).

- 单元锚点: 新增 `tests/index.test.ts` (12 例) 与 `tests/tool.test.ts` (10 例), 只经 `src/index.ts` / `src/tool.ts` 的导出驱动.

  - `index.ts`: 服务形状不符 (非对象 tools / 缺 list 的 agents); logger 缺失 / 抛错 / 缺方法; `agent/created` 与 `agent/disposed` 非法载荷; 工具服务缺 `schemas`; allowlist / denylist 两种空交集; `restrict` 其他错误与名单失配的降级与「每运行时只告警一次」; 代理作用域缺 `ctx.on` / 缺 `tools.register`; disposer 抛错被吞; `session/event` 非字符串会话 / 缺事件 / 缺回合号; 配置热重载复用运行时并切换缺省档.
  - `tool.ts`: 无参数与空工具面的分组回退; `limit` 下限与非法值回退、非法 `scope` 回退缺省; `names` 的已见 / 预览 / 未知 / 入口自身; query 全可见抬头与部分可见排序; pin 三态 (session 忽略 / turn 名额满 / turn 已钉住); turn 配额文案; 重复揭示不累加; `output.render` 回退与 schema 形状.

- 集成层: 新增 `tests/assemble.ts` (装配器, 不以 `.test.ts` 结尾) 与 `tests/integration/plugin.test.ts` (18 例).

  - 假面: 假工具面 (`schemas` / `register` / `restrict`, 可注入缺服务、重名、名单失配与 disposer 抛错) / 假事件面 (全局 `emit` + 订阅计数, 代理级 `agent.emit`) / 假服务面 (`ctx.get` 的 `tools` / `agents`, 可按名缺席或覆盖返回值); 无落盘面.
  - 断言面: 既有代理热挂载与 9 核心遮罩; 5 条全局订阅; `consult_tools` 注册与 `execute` 的 canonical 文本; `output.render` 三种投影; 按名咨询四类分支; `pre-execute` 的 deny / allow 与缺参放行; turn 档 pin、容量收敛与 LRU (`tools/result` 刷新最近使用); `tools/change` 只刷新索引 (新工具可检索 / 揭示, 不重设遮罩); denylist 组成与 reveal 不改变名单; `maskMode=off` 零遮罩; `applyTo: all` / `roots`; 服务缺失; `agent/disposed` 清理与同 id 重挂; 插件卸载; 咨询工具重名 / 其他注册错误; `enabled: false`; 空工具面; 回读校验缺项告警与漂移恢复.

- 假宿主扩展: `tests/fake-host.ts` 增加缺服务 / 返回值覆盖、`schemas` 作用域视图可返回 undefined 或缺名、logger 三态、代理事件面开关、`register` / `restrict` / disposer 故障注入、`addSchema` 与订阅计数; 原有 15 个用例语义未改.

- 脚本: `package.json` 加 `test:integration` (跑 `tests/integration/*.test.ts`) 与 `test:coverage` (两目录一起跑, `NODE_V8_COVERAGE=../tmp/cov-tool-consult`, 再调 `dev/coverage/report.mjs tmp/cov-tool-consult tmp/cov-tool-consult/report.json`).

- 专项: `tests/retrieval.test.ts` 的 `skip` 收窄为「`channel_delegate` 进前二」并转正, 全包 `skip` 归零; `tests/fixtures/real-descriptions.ts` 复核后被 `retrieval.test.ts` 使用, 仅把注释里的 `src/main.ts` 更正为 `src/index.ts`, 语料未动 (`src/tool.ts` 的同类注释未改, 属 `src`, 留阶段 3).

- 4.4 复核: 本次未新增 `skip` / `todo`; 未新增夹具; 未删除用例.

- 阶段 3 补丁 (2026-11-01): `isVisible` 按 `maskMode` 解释 `initialNames` (`denylist` 下为隐藏集, `off` 全可见, 已授权优先), 修遮罩与 `pre-execute` 判定不一致; 包 BACKLOG 对应条目关闭.

## 偏差

- 实现规划写「服务 provide / get」, 本包没有 `ctx.provide` 面; 集成层用 `ctx.get` 的 `tools` / `agents` 与 5 条全局事件订阅做等价断言, 不写不存在的 provide.
- 集成过程中发现 `denylist` 模式的可见性判定与遮罩不一致 (`isVisible` 把 `initialNames` 当可见, 在 denylist 里这批恰是被隐藏的工具); 本阶段不改 `src`, 已记入 `tool-consult/docs/BACKLOG.md` 待办 1, 集成只锚遮罩组成与 reveal 不改变名单, 不把缺陷固化成 pre-execute 期望.
- 覆盖率表里 `src/state.ts` 行覆盖 96.1% → 86.2% 是 V8 range 偏移漂移的度量误差, 不是用例缺失: 单独跑 `tests/state.test.ts` 为 95.6% (173/181), 且 `grant` 的重复揭示、pin 分支在新增用例中均有断言; 全量合并时经 `src/index.ts` 入口的 transform range 把 139 至 158 行记成零. 包合计仍从 89.4% 升到 96.1%.

## 测试与证据

五条命令 (全部在 `tool-consult/` 下跑):

| 命令 | 结果 |
| --- | --- |
| `pnpm run check` | 通过 |
| `pnpm run build` | 通过 |
| `pnpm run test` | 103 例全绿, 0 失败, 0 跳过; 约 0.14 s |
| `pnpm run test:integration` | 18 例全绿, 0 失败, 0 跳过; 约 0.11 s |
| `pnpm run test:coverage` | 通过, 121 例全绿; 报告见下 |

覆盖率 (只统 `src`; 改前取同一命令在分支起点的基线):

| 文件 | 改前行 | 改后行 | 改前分支 | 改后分支 |
| --- | --- | --- | --- | --- |
| `src/aliases.ts` | 100.0% (65/65) | 100.0% (65/65) | n/a | n/a |
| `src/config.ts` | 100.0% (123/123) | 100.0% (123/123) | 96.0% (24/25) | 96.4% (27/28) |
| `src/degrade.ts` | 98.3% (57/58) | 98.3% (57/58) | 92.9% (13/14) | 92.9% (13/14) |
| `src/index.ts` | 82.6% (400/484) | 96.5% (467/484) | 59.2% (45/76) | 93.1% (122/131) |
| `src/matcher.ts` | 94.5% (138/146) | 96.6% (141/146) | 87.5% (35/40) | 91.1% (41/45) |
| `src/state.ts` | 96.1% (174/181) | 86.2% (156/181) | 88.5% (23/26) | 86.2% (25/29) |
| `src/tokenize.ts` | 98.5% (129/131) | 98.5% (129/131) | 97.5% (39/40) | 97.5% (39/40) |
| `src/tool.ts` | 80.2% (206/257) | 97.3% (250/257) | 75.5% (37/49) | 89.9% (62/69) |
| 合计 | 89.4% (1292/1445) | 96.1% (1388/1445) | 80.0% (216/270) | 92.4% (329/356) |

- 行分母不变 (1445), 分支分母 270 → 356 是新增用例带来的 V8 block range 合并结果, 同一份 `src` 未改.
- 未覆盖行 (改后, 按报告): `degrade.ts` 75; `index.ts` 106,219 至 227,270,289,291,292,339 至 341,498; `matcher.ts` 106,133,145,174,175; `state.ts` 132 至 136,138 至 154,157,195,232; `tokenize.ts` 64,65; `tool.ts` 32,33,74,155,193,199,225。其中 `index.ts` 219 至 227 是 `teardownRuntime` 的清理分支, 498 是热重载重建运行时的初始化分支, `tool.ts` 32,33 是接口字段, 均属防御 / 类型声明, 不写空用例凑数.
- 新增用例清单: `tests/index.test.ts` 12 例, `tests/tool.test.ts` 10 例, `tests/integration/plugin.test.ts` 18 例; `tests/assemble.ts` 为装配器 (不计入用例与覆盖率). 原 `retrieval.test.ts` 的 1 例跳过转为通过, 全包 0 跳过.
- 删除用例与夹具: 无.
- 豁免台账: `denylist` 可见性缺陷见偏差与包 BACKLOG; `state.ts` 的度量误差只在本文件说明, 不改报告脚本.
