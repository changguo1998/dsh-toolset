# session-paths 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 session-paths 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `session-paths` 补单元锚点 (不设集成层), 落地 `test:integration` (打印缺层原因) 与 `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 代码整理: 按总追踪 5.1 的步骤改本包, 行为不变.

## 现状

- 单元层: `tests/` 下 2 个 `.test.ts` (`encode.test.ts` / `service.test.ts`); 阶段 1 末 `pnpm -C session-paths run test` 通过.
- 集成层: 无, 且按 4.2 不设 (纯函数包).
- 覆盖率基线 (阶段 1 末): 行 93.8% (180/192); 分支 85.5% (53/62).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 不新增集成层; `test:integration` 打印缺层原因并退出 0; 单元层补锚点
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C session-paths run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 不新增; `test:integration` 打印「纯函数包, 由单元层覆盖」并退出 0.
- 脚本: `package.json` 加 `test:integration` = `node -e 'console.log("session-paths 无集成层: 纯函数包, 由单元层覆盖")'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-session-paths && mkdir -p ../tmp/cov-session-paths && NODE_V8_COVERAGE=../tmp/cov-session-paths node --experimental-transform-types --test 'tests/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-session-paths tmp/cov-session-paths/report.json
```

- 专项: 不新增集成层; `test:integration` 打印缺层原因并退出 0; 单元层补锚点.
- 验收: `pnpm -C session-paths run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 session-paths 测试锚定`.

### 代码

- 分支 `history-cleanup/03-code-session-paths`, worktree `.worktree/03-code/session-paths`; 只改本包源码、本包测试的 import、`package.json` / `pnpm-lock.yaml` 与本文件.
- 开工: 在 worktree 的本包目录跑 `pnpm install --frozen-lockfile`; 有 `link:` 依赖时先在 worktree 里构建被依赖包 (`pnpm -C <被依赖包> run build`), 再跑本包 `check`.
- 顺序: 删失效 → 并定时器族 → 拆长文件 → 收拢判断 → 改注释; 每步跑 `pnpm -C session-paths run check` 与 `pnpm -C session-paths run test`.
- 任务:
  - `src/index.ts` 的上下文对象守卫收进入口, 只判一次.
- 验收: `pnpm -C session-paths run check` 与 `pnpm -C session-paths run test` 全绿, 用例断言不因组织改动而改; 行为不变 (工具名、参数面、`output.render` 投影、配置键、注入文案、帧内容都不动).
- 提交: `refactor(session-paths): <动作>`, 一个逻辑一笔; 不改本节实现规划, 不改总追踪与阶段追踪.

### 包文档

阶段 4 补.

## 实现记录

- 基线: `pnpm -C session-paths run test` 24 例通过 (73ms); `check` 通过; 覆盖率 (仅单元层) 行 93.8% (180/192) / 分支 85.5% (53/62), `src/index.ts` 未覆盖段 61, 63, 140, 145-146, 155-156, 158-162 (报告按 0 基行号).
- 单元锚点: `tests/service.test.ts` 24 → 31 例, 补的都是原有未走到的防御分支 —— `resolveRoot` 空串与相对路径, `readService` 的 ctx 非对象 / `get` 是抛错 getter / `get` 返回 null 三条兜底, `apply` 的 ctx 为 null / ctx 不可写 / 读 `provide` getter 抛错三条降级路径; 现有断言未改语义.
- 集成层: 新增装配器 `tests/assemble.ts` (假服务面 `get` / `provide` + 假宿主 `sessions`, 临时 HOME) 与 `tests/integration/plugin.test.ts` 12 例; 断言 `apply` 挂服务 → `ctx.get("sessionPaths")` 取用 → `root` / `projectKey` / `projectDir` / `sessionDir` / `sessionDirFor` / `ensureSessionDir` 的 canonical 值, 其中 `ensureSessionDir` 真在临时 HOME 下落盘 (0700、幂等、`_no-cwd` 桶), `dispose` 删临时目录并还原 `HOME` / `DSH_HOME`.
- 脚本: `package.json` 加 `test:integration` (实跑 `tests/integration/*.test.ts`) 与 `test:coverage` (两层合并, `dev/coverage/report.mjs` 参数 `tmp/cov-session-paths`).
- 包文档: `README.md` 的「测试」节改为四条命令与分层说明.
- 阶段 3 上下文守卫: `src/index.ts:178` 的 `apply` 把 `ctx === null || typeof ctx !== "object"` 移到入口首句 (`src/index.ts:179-185`), 只判一次; 读 `provide` 与直接属性挂载都用同一收窄结果 `c`, 删掉尾部重复守卫与 `(ctx ?? {})` 兜底; 判定条件、告警文案与两条注册路径不变.
- 阶段 3 零引用导出: 复查本包原有 12 个导出在全仓 (`src` / `tests` / `scripts` / `docs`) 的引用, 删掉 `Config` (`SessionPathsConfig` 的别名, 除 `dist/` 的 `.d.ts` 外无引用); 其余保留: `name` / `provide` / `apply` 属 bundle 装配面与入口, 四个纯函数与 `SessionPaths` / `SessionPathsConfig` / `resolveRoot` / `SessionPathsService` 被测试和 `README.md` 的 API 示例引用.
- 阶段 3 路径注释: `src/index.ts:4` 的 `src/encode.ts` 补成 `session-paths/src/encode.ts`; 本包其余路径注释 (`docs/host/DSH-CTX-API.md`、宿主 `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`) 已是完整路径或外部引用, 本包无计数注释.

## 偏差

- 规划写「不设集成层, `test:integration` 打印缺层原因并退出 0」; 分支任务明确要求新增集成层并实跑, 按当次指令执行: 该包有服务面, 落在总规范 4.2「服务提供与消费归集成」的必备范围内. 缺层原因不再成立, 故脚本改为实跑.
- 覆盖率命令在规划的单层命令上追加 `tests/integration/*.test.ts` (4.3 的分层贡献另跑单元层对照, 数字见下).
- 未改 `src`.
- 阶段 3: 总追踪 5.2 的 21 符号表未列本包, 按任务复查后发现 `Config` 零引用, 按 5.2 执行口径「有就删」删除; 其余导出都至少被测试、入口或 bundle 装配面引用.
- 阶段 3: 5.1 把注释里的路径归第 6 章, 本次按任务第 3 条只补 `src/index.ts:4` 一处, 其余路径与计数不动.

## 测试与证据

改前 (仅单元层, 24 例):

| 文件 | 行 | 分支 | 未覆盖行 |
| --- | --- | --- | --- |
| session-paths/src/encode.ts | 100.0% (46/46) | 100.0% (26/26) | - |
| session-paths/src/index.ts | 91.8% (134/146) | 75.0% (27/36) | 61, 63, 140, 145-146, 155-156, 158-162 |
| 整包 | 93.8% (180/192) | 85.5% (53/62) | - |

改后 (单元层 31 例 / 单元加集成 43 例):

| 文件 | 行 | 分支 (单元) | 分支 (单元加集成) | 未覆盖行 |
| --- | --- | --- | --- | --- |
| session-paths/src/encode.ts | 100.0% (46/46) | 100.0% (26/26) | 100.0% (26/26) | - |
| session-paths/src/index.ts | 100.0% (146/146) | 97.7% (42/43) | 93.5% (43/46) | - |
| 整包 | 100.0% (192/192) | 98.6% (68/69) | 95.8% (69/72) | - |

- 剩余 3 个未覆盖分支块: `src/index.ts` 76 行 (注释块)、152-155 与 155-163 (`sessions` 缺失与会话取不到的两处抛错). 这两处行为已由单元层「sessions 服务不可用」「不在宿主的 sessions」两条断言锚住; 计数为 0 是 `--experimental-transform-types` 映射回源码后的字面量块产物, 不为数字补空跑用例.
- 加集成层后分支分母由 69 升到 72 (集成进程多报 3 个块), 覆盖率按整包仍从 85.5% 升到 95.8%.

四条命令 (改后):

| 命令 | 结果 |
| --- | --- |
| `pnpm -C session-paths run check` | ✓ 通过 (无输出) |
| `pnpm -C session-paths run test` | ✓ 31/31 通过 |
| `pnpm -C session-paths run test:integration` | ✓ 12/12 通过 |
| `pnpm -C session-paths run test:coverage` | ✓ 行 100.0% (192/192), 分支 95.8% (69/72) |

阶段 3 代码整理:

- 改前 (本分支): `check` ✓ 无输出; `test` ✓ 31/31.
- 改后: `check` ✓ 无输出; `test` ✓ 31/31; `test:integration` ✓ 12/12; `build` ✓; `test:coverage` ✓ 行 100.0% (191/191), 分支 97.2% (69/71); 分母各减 1 是删掉尾部重复守卫与 `Config` 别名后少掉的块, 百分比未降.
- 用例断言未改, `tests/` 本次零改动; 运行期行为只有「`ctx` 非对象时提前返回」一步顺序变化, 告警文案与注册结果相同.
- 改动范围: `session-paths/src/index.ts` (11 增 13 删) 与本文件的「实现记录 / 偏差 / 测试与证据」.
