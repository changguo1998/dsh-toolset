# TUI 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 TUI 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `TUI` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

## 现状

- 单元层: `tests/` 下 139 个 `.test.ts` (见 `tests/`); 阶段 1 末 `pnpm -C TUI run test` 通过.
- 集成层: 无 `tests/integration/`; 适配器 / 状态 / 渲染链路未装配验证.
- 覆盖率基线 (阶段 1 末): 行 87.4% (24156/27643); 分支 78.3% (6258/7989).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: `tests/app.test.ts:354` 的 `skip` 按 4.4 处理; `tests/fixtures/` 的 2 个夹具复核; 新增 `test:e2e`, 跑 `demo -- --smoke` 与 `smoke:pty`; 端到端只在 TUI 做

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C TUI run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/main.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/app.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配状态层 / 渲染层与假适配器: 命令分派、视图投影与帧文本; 复用现有 `demo` 夹具, 不连真 pty.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-TUI && mkdir -p ../tmp/cov-TUI && NODE_V8_COVERAGE=../tmp/cov-TUI node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-TUI tmp/cov-TUI/report.json
```

- 专项: `tests/app.test.ts:354` 的 `skip` 按 4.4 处理; `tests/fixtures/` 的 2 个夹具复核; 新增 `test:e2e`, 跑 `demo -- --smoke` 与 `smoke:pty`; 端到端只在 TUI 做.
- 端到端: `test:e2e` 串 `pnpm run demo:build -- --smoke` 与 `pnpm run smoke:pty`; 两项都通过才记绿.
- 验收: `pnpm -C TUI run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 TUI 测试锚定`.

### 代码

阶段 3 补; 本阶段不动 `src` (为可测性必须动时先在「偏差」记原因).

### 包文档

阶段 4 补.

## 实现记录

- 集成层: 新增 `TUI/tests/assemble.ts`（装配器, 不以 `.test.ts` 结尾）与 `TUI/tests/integration/app.test.ts`（12 条）。装配器用真实 `App` + 真实 `createRenderer`（注入 `write` 捕获报文, `rawMode: false` 不写模式序列, `exitOnClose: false` 不结束进程）+ 假适配器 `FakeAdapter` + 可选假状态查询; 唯一被替换的终端能力是 CPR 宽度实测（立即回空表, App 走「终端不支持 CPR」分支沿用静态宽度表, 真探测归 `smoke:pty` 与 `width-probe` 单测）。断言分三类: 命令分派（未知 `/` 命令进宿主注册表、`/help`、`/theme`、`/new`）、视图投影（用户块、思考 / 正文 / 工具调用与结果、审批面板、问答面板、交付直灌）、帧文本（首帧 80x24 骨架、状态栏时间 / 分支 / cwd、底部提示行、面板提示行）。
- 起始态: 装配器在 `start()` 之后推一条 `session-title` 事件确立活跃会话（生产适配器同为接线后时序）。少了它 `activeSessionId` 停在 null, `/new` 走 `sectionsSessionId === null` 的「会话建立过渡」分支, 旧会话内容不会随切换重建节缓存。
- 单元锚点: 新增 `TUI/tests/terminal.test.ts`（7 条）, 覆盖 `src/renderer/terminal.ts` 的 `setRawMode` 三种判定（非 TTY 静默失败 / TTY 成功 / 底层抛错回落 `isRaw`）与 `createTerminal` 的 raw 开关、`close`、尺寸回落（TTY 读数、非 TTY 与零尺寸回 80x24）、`onResize` 订阅。
- 脚本: `TUI/package.json` 增 `test:integration`（`node --experimental-transform-types --test 'tests/integration/*.test.ts'`）、`test:coverage`（单元 + 集成两轮 glob; 覆盖率原始 JSON 落 `../tmp/cov-tui`（相对 `TUI/`）, 报告落 `tmp/cov-tui/report.json`（相对仓库根））、`test:e2e`（`pnpm run demo:build -- --smoke` 与 `pnpm run smoke:pty` 串联）。
- 专项复核: `tests/app.test.ts:354` 的条件 `skip` 属 4.4 允许的「仓库不在家目录」一类, 保留不动; 本机仓库在家目录下, 本轮实测 `skipped` 为 0。`tests/fixtures/` 两个夹具均在用: `focus-frame-legacy.json` 由 `tests/focus-frame.test.ts` 读取（冻结基线）, `status-column-old.ts` 由 `tests/status-column-equivalence.test.ts` 导入（旧实现快照）, 都保留。
- 缺口取舍: `src/main.ts` 仍是最大未覆盖面（行 47.1%）, 其 `apply()` 属宿主接线, 留代码阶段与包文档阶段; 按「少量缺口锚点」本次只补 `renderer/terminal.ts`。

## 偏差

- 覆盖率命令路径: `report.mjs` 把两个参数按**仓库根**解析（`resolve(root, argv)`）, 而 `NODE_V8_COVERAGE` 由 node 按**当前目录**解析。脚本据此分工: `NODE_V8_COVERAGE=../tmp/cov-tui`（相对 `TUI/`）、报告参数 `tmp/cov-tui` / `tmp/cov-tui/report.json`（相对仓库根）, 两者指向同一目录; 包文档原写法 `node ../dev/coverage/report.mjs ../tmp/cov-TUI ...` 会把产物解析到仓库外, 故按上述分工落地。
- 报告生成前加 `sleep 1`: 首次按新路径实跑时, 报告读到的是尚未落齐的覆盖率 JSON（行 60.05% / 分支 63.72%, 与同目录重算的 87.48% / 78.41% 不一致）, 等 1 秒后连续两次实跑均稳定为 87.48% / 78.41%。属取证稳健性, 不改统计口径。
- `smoke:pty` 本机不绿: 真机会话启动后即报 `MISSING_CREDENTIAL: llm-pi-ai: no credential for provider route "tollgate"`, 环境无 provider 凭据, 工具回合跑不起来, 3 次尝试均未同时出现 `✓` 工具结果行与 `ctx/cache`。属 4.5 的「真 LLM 不进 `test`」与「真机验证留人工验收」, 触发条件 = 有可用模型凭据; 交人工验收。`test:e2e` 的 `demo:build -- --smoke` 段通过（`SMOKE_OK`）。
- 覆盖率分母: 分支分母由 7976 涨到 7996（新跑到的 V8 block range 计入分母）, 比率 78.42% → 78.41%; 用**原测试集**重跑一次得 78.413%, 证明该量级属统计方法噪声。包级行覆盖 87.39% → 87.48%, 只升不降。
- 观察（未改 `src`）: `createTerminal().rawMode(false)` 之后 `rawEnabled` 仍为 `true`（`if (setRawMode(...))` 在关闭时返回 falsy 不再赋值）, 该字段全仓无消费方, 行为无影响, 留给代码阶段。集成层里 `/new` 后旧内容不残留依赖活跃会话已确立, 已在装配器按生产时序补 `session-title`（见实现记录）。
- 本机环境: `pnpm` 的依赖预检会尝试联网安装并因 store 不可写失败, 四个命令统一以 `pnpm_config_verify_deps_before_run=false` 运行; 脚本内容本身不含该变量。

## 测试与证据

工作目录 `TUI/`, node v24.16.0。四条入口实跑:

| 命令 | 结果 |
| --- | --- |
| `pnpm -C TUI run check` | ✓ 0 error（`tsc --noEmit`, 含 `tests/` / `demo/` / `bench/`） |
| `pnpm -C TUI run test` | ✓ 1828 pass / 0 fail / 0 skip / 0 todo, 8.3s |
| `pnpm -C TUI run test:integration` | ✓ 12 pass / 0 fail |
| `pnpm -C TUI run test:coverage` | ✓ 1840 pass / 0 fail, 产物 `tmp/cov-tui/report.json` |
| `pnpm -C TUI run test:e2e` | ✗ `demo:build -- --smoke` ✓（`SMOKE_OK`）; `smoke:pty` ✗（缺凭据, 见偏差） |

覆盖率（只统 `src`）:

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| 行 | 24160/27645 = 87.39% | 24183/27645 = 87.48% |
| 分支 | 6255/7976 = 78.42% | 6270/7996 = 78.41%（分母 +20, 见偏差） |

分文件（只列有变化的行数 / 分支数）:

| 文件 | 行 | 分支 |
| --- | --- | --- |
| `TUI/src/renderer/terminal.ts` | 67.9% → 96.3% | 33.3% → 92.3% |
| `TUI/src/renderer/index.ts` | 90.5% → 91.1% | 76.0% → 76.0% |
| `TUI/src/app/index.ts` | 82.3% → 82.3%（覆盖行 -1） | 67.5% → 67.4% |
| `TUI/src/app/layout.ts` | 96.2% → 96.1%（覆盖行 -2） | 88.7% → 88.7% |

- 新增与删除用例: 新增 19 条（集成 12、单元 7）与装配器 1 个（`tests/assemble.ts`）; 删除 0 条; 存量断言未改语义。
- `skip` 计数: 0（本机环境探测未触发）; 条件式 `skip` 仍保留 1 处（`tests/app.test.ts:354`）。
- 夹具: 2 个保留, 均有引用（见实现记录）; 未删任何夹具。
- 边界: 未改 `src`; 未改总追踪 / 阶段追踪 / 其它包; 未 push / 未合并。
