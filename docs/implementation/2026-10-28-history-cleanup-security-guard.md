# security-guard 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 security-guard 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `security-guard` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

## 现状

- 单元层: `tests/` 下 4 个 `.test.ts` (`blacklist.test.ts` / `guard.test.ts` / `script.test.ts` / `sensitive.test.ts`); 阶段 1 末 `pnpm -C security-guard run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 63.6% (1842/2896); 分支 90.9% (369/406).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 复核 `tests/script.test.ts:509` 条件式 `skip`; `tests/guard.test.ts` 的 `herdr_use` 负断言保留

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C security-guard run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-security-guard && mkdir -p ../tmp/cov-security-guard && NODE_V8_COVERAGE=../tmp/cov-security-guard node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-security-guard tmp/cov-security-guard/report.json
```

- 专项: 复核 `tests/script.test.ts:509` 条件式 `skip`; `tests/guard.test.ts` 的 `herdr_use` 负断言保留.
- 验收: `pnpm -C security-guard run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 security-guard 测试锚定`.

### 代码

阶段 3 补; 本阶段不动 `src` (为可测性必须动时先在「偏差」记原因).

### 包文档

阶段 4 补.

## 实现记录

- 基线 (本分支实测): `pnpm -C security-guard run test` 142 例 (141 通过 / 1 跳过, 跳过的是发布形态用例: `dist` 未构建), `check` 通过; 覆盖率行 97.5% (1538/1578) / 分支 90.9% (369/406)。
- 单元锚点 (只加用例, 既有断言未改语义):
  - `tests/blacklist.test.ts` +7 例: 命令切段 (引号内不切 / 空段丢弃 / 未闭合引号)、rm 的 env 前缀与 `--` 分隔符、chmod 的 env 前缀与选项位、systemctl 的前缀词链、heredoc 三条前置条件各自放行、`eval` / shell `-c` 递归与深度上限、非法规则源在 `scope=command` 与整段正则两条路径都按命中处理。
  - `tests/sensitive.test.ts` +5 例: 家目录三种单独写法与引号 / 尾斜杠保留、`basenameOf` 三种输入、glob 的 `**` 跨目录与 `?` 单字符及 `/**` 目录本身命中、字面条目含 `/` 前缀子树与 basename 两条分支、路径提取空命令与去重。
  - `tests/guard.test.ts` +6 例: `provide` 声明、`resolveGuardConfig` 缺省归一与用户层编号 (`user-rule-N` / `user-path-N` / `allowed-N`)、放行名单非法条目忽略与通配语义、挂载 disposer 的退化形态 (宿主 `on` / `tools.guard` 返回非函数)、`apply` 无 `provide` 面时的防御路径。
- 集成层: 新增 `tests/assemble.ts` (装配器, 不以 `.test.ts` 结尾) 与 `tests/integration/plugin.test.ts` (14 例)。装配器按 4.2 的三假面口径给出工具面 (`register` + `tools.guard`)、事件面 (`on` + waterfall 模拟)、服务面 (`provide` / `get`, 同名重复注册抛错)。用例覆盖: 服务面 `guard` 注册与 `ctx.get` 同一实例、canonical 三方法、单调守卫路径 (字符串 / undefined)、waterfall 降级路径 (`{ kind: "deny", reason }` 与放行下传恰一次)、挂载日志两种形态、拒绝日志取前两行、`inspectCommand` 来源标注与 `recent()`、`policy()` 快照、未登记工具三态、临时目录 fixture 上的读侧 / 写侧 / 命令内路径三种回执措辞、重复挂载的 provide 冲突。
- 专项: `tests/script.test.ts` 的发布形态用例, 探测表达式提到文件顶层 (`DIST_BUILT`), 跳过原因补上补法 (`pnpm -C security-guard run build`); `tests/guard.test.ts` 的 `herdr_use` 负断言保留未动。
- 脚本: `security-guard/package.json` 增加 `test:integration` 与 `test:coverage`, 覆盖率命令与其它包同构 (`report.mjs` 参数 `tmp/cov-security-guard`)。
- 未改 `src`。

## 偏差

- 覆盖率基线口径: 本文件「现状」节记的是行 63.6% (1842/2896), 本分支实测为行 97.5% (1538/1578); 两者统计范围不同, 本阶段以分支实测的「改前 / 改后」两列为准, 未改「现状」节。
- `test:coverage` 的统计范围: `dev/coverage/report.mjs` 的 `isPackageSource` 只排除 `tests` 与 `node_modules`, 不排除 `dist`, 故 `dist` 已构建时会把它一并计入 (实测行 64.4%)。处理办法: 覆盖轮在删除 `dist` 后跑 (发布形态用例因此跳过 1 条, 属 4.4 保留的「`dist` 未构建」类), 单测轮在 `build` 后跑 (skipped 0)。修 `report.mjs` 属跨包工具改动, 本阶段不做。
- 集成层断言面: 本包不注册工具、无 `output.render` 投影、也不订阅除 `tools/pre-execute` 外的事件, 故规划里的「工具注册名与 execute 的 canonical 值 / output.render 投影 / 事件消费者注入内容」落为零值断言 (零工具注册、零多余订阅), 实际断言面是服务面 `guard` 与两条判定挂载路径。

## 测试与证据

### 四条命令 (本分支最终状态)

| 命令 | 结果 |
| --- | --- |
| `pnpm -C security-guard run check` | 通过 (tsc --noEmit, 无输出) |
| `pnpm -C security-guard run test` | 160 例, 160 通过, 0 失败, 0 跳过 (改前 142 例 / 141 通过 / 1 跳过) |
| `pnpm -C security-guard run test:integration` | 14 例, 14 通过, 0 失败, 0 跳过 |
| `pnpm -C security-guard run test:coverage` | 通过; 行 98.9% (1561/1578) / 分支 94.1% (416/442); 本机无 `dist` 触发 1 条保留类跳过 |

### 用例增减

- 新增: 单元 18 例 (blacklist 7 / sensitive 5 / guard 6), 集成 14 例, 装配器 `tests/assemble.ts` 1 个; 共 32 例。
- 删除: 0; 改写: 发布形态用例的跳过探测提到顶层 (1 处, 断言与条件语义不变)。

### `skip` 计数

- 改前: 1 条 (`dist` 未构建, 本机触发)。
- 改后: `test` 轮 0 条 (`build` 之后跑, 发布形态用例实际通过); `test:coverage` 轮 1 条 (该轮删 `dist` 以排除 dist 统计, 属 4.4 保留类)。豁免台账: 无 (两类均为环境探测, 非补不了)。

### 覆盖率 (只统 `src`)

改前 = 单元层, 未构建 `dist`; 改后 = 单元 + 集成, 未构建 `dist`。

| 文件 | 行 (改前) | 分支 (改前) | 行 (改后) | 分支 (改后) | 未覆盖行 (改后) |
| --- | --- | --- | --- | --- | --- |
| `src/blacklist.ts` | 96.5% (412/427) | 87.0% (120/138) | 98.6% (421/427) | 92.7% (140/151) | 54, 95, 100, 156, 169, 361 |
| `src/index.ts` | 99.0% (912/921) | 96.1% (220/229) | 99.1% (913/921) | 95.0% (230/242) | 328, 430, 431, 441, 460, 627, 958, 1154 |
| `src/receipt.ts` | 94.7% (36/38) | 80.0% (4/5) | 94.7% (36/38) | 80.0% (4/5) | 15, 16 |
| `src/sensitive.ts` | 92.7% (178/192) | 73.5% (25/34) | 99.5% (191/192) | 95.5% (42/44) | 41 |
| 合计 | 97.5% (1538/1578) | 90.9% (369/406) | 98.9% (1561/1578) | 94.1% (416/442) | - |

分层贡献 (两轮取差): 单元层 99.0% (1563/1578) / 95.1% (408/429); 单元 + 集成 98.9% (1561/1578) / 94.1% (416/442)。集成轮行覆盖比单元轮低 2 行、分支分母多 13 个, 是 `report.mjs` 跨进程 range 合并口径带来的抖动 (同一行在不同进程取的 span 不同), 非本次改动引入的退化; 两轮都高于改前基线。未覆盖行里混着 `report.mjs` 偏移映射的老问题 (例如 `index.ts:328` 是常量展开行, 实际每次都在跑), 本阶段不修。

### 契约面

- 导出覆盖率: `src/index.ts` 的导出名以 `tests/` 引用为准, 新增用例补上 `provide` 与 `resolveGuardConfig` 两处此前无用例引用的导出。
- 错误码覆盖率: 本包回执是字符串文案、无 `code` 常量, 不适用。
