# TUI 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 TUI 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `TUI` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 代码整理: 按总追踪 5.1 的步骤改本包, 行为不变.

## 现状

- 单元层: `tests/` 下 139 个 `.test.ts` (见 `tests/`); 阶段 1 末 `pnpm -C TUI run test` 通过.
- 集成层: 无 `tests/integration/`; 适配器 / 状态 / 渲染链路未装配验证.
- 覆盖率基线 (阶段 1 末): 行 87.4% (24156/27643); 分支 78.3% (6258/7989).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: `tests/app.test.ts:354` 的 `skip` 按 4.4 处理; `tests/fixtures/` 的 2 个夹具复核; 新增 `test:e2e`, 跑 `demo -- --smoke` 与 `smoke:pty`; 端到端只在 TUI 做
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

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

- 分支 `history-cleanup/03-code-tui`, worktree `.worktree/03-code/TUI`; 只改本包源码、本包测试的 import、`package.json` / `pnpm-lock.yaml` 与本文件.
- 开工: 在 worktree 的本包目录跑 `pnpm install --frozen-lockfile`; 有 `link:` 依赖时先在 worktree 里构建被依赖包 (`pnpm -C <被依赖包> run build`), 再跑本包 `check`.
- 顺序: 删失效 → 并定时器族 → 拆长文件 → 收拢判断 → 改注释; 每步跑 `pnpm -C TUI run check` 与 `pnpm -C TUI run test`.
- 任务:
  - 删失效导出: `src/app/adapter/types.ts:114` `ToolResultMetaLike`、`src/app/state.ts:695` `PickerOption`、`src/app/state.ts:2834` `isInputHistoryBrowse`; 删前重扫全仓引用.
  - 按键分派收进 `src/app/keys.ts`: 72 处 `name === "…"` 收成一张 `Record<string, Action>`, 表按现有 `if` 链顺序排, 命中即停.
  - 用户消息识别收进 `src/app/state.ts`: 34 处 `role === "user"` / `kind === "user"` 收成一个谓词, 适配层与渲染层改调它.
  - 沙箱展示映射 (`src/app/layout.ts:278`) 改读 `herdr-use` 的枚举类型, 不自判.
  - 记忆层级判定 (`src/app/index.ts:5843` 起) 改读注入值, 不再自比 `tier`.
  - 拆长文件, 一个文件一层: `src/app/index.ts` (6601 行) → 状态 / 渲染 / 适配 / 工具面; `src/app/adapter/dsh.ts` (4647 行); `src/app/state.ts` (3388 行); `src/app/layout.ts` (2440 行); `src/app/adapter/types.ts` (1803 行). 拆出的文件只从包入口 re-export, 不新增对外入口.
  - 拆分顺序按总追踪 4.1 的 P1: 排版与宽度 → 状态 → 适配 → 类型; 每拆一步跑一次帧基线并逐字节比对; 不清 `src/main.ts` 的启动顺序.
  - 按总追踪 1.3 表改本包路径注释: `layout/hints.ts` 14 处、`layout/width-symbols.ts` 9 处、`adapter/local-log.ts` 3 处、`adapter/types.ts` / `adapter/dsh.ts` / `layout/eaw-table.ts` / `layout/tool-line.ts` / `components/ModelPicker.ts` / `pipeline/types.ts` / `src/types.ts` / `TUI/src/x.ts` 各 1 处, 共 34 处.
  - 删完按 `.ts` 符号扫描复扫本包.
- 验收: `pnpm -C TUI run check` 与 `pnpm -C TUI run test` 全绿, 用例断言不因组织改动而改; 行为不变 (工具名、参数面、`output.render` 投影、配置键、注入文案、帧内容都不动).
- 补充: 每步另跑 `pnpm -C TUI run demo -- --smoke`; `smoke:pty` 需 `TOLLGATE_API_KEY`, 缺凭据记「偏差」.
- 提交: `refactor(TUI): <动作>`, 一个逻辑一笔; 不改本节实现规划, 不改总追踪与阶段追踪.

### 包文档

阶段 4 补.

## 实现记录

- 集成层: 新增 `TUI/tests/assemble.ts`（装配器, 不以 `.test.ts` 结尾）与 `TUI/tests/integration/app.test.ts`（12 条）。装配器用真实 `App` + 真实 `createRenderer`（注入 `write` 捕获报文, `rawMode: false` 不写模式序列, `exitOnClose: false` 不结束进程）+ 假适配器 `FakeAdapter` + 可选假状态查询; 唯一被替换的终端能力是 CPR 宽度实测（立即回空表, App 走「终端不支持 CPR」分支沿用静态宽度表, 真探测归 `smoke:pty` 与 `width-probe` 单测）。断言分三类: 命令分派（未知 `/` 命令进宿主注册表、`/help`、`/theme`、`/new`）、视图投影（用户块、思考 / 正文 / 工具调用与结果、审批面板、问答面板、交付直灌）、帧文本（首帧 80x24 骨架、状态栏时间 / 分支 / cwd、底部提示行、面板提示行）。
- 起始态: 装配器在 `start()` 之后推一条 `session-title` 事件确立活跃会话（生产适配器同为接线后时序）。少了它 `activeSessionId` 停在 null, `/new` 走 `sectionsSessionId === null` 的「会话建立过渡」分支, 旧会话内容不会随切换重建节缓存。
- 单元锚点: 新增 `TUI/tests/terminal.test.ts`（7 条）, 覆盖 `src/renderer/terminal.ts` 的 `setRawMode` 三种判定（非 TTY 静默失败 / TTY 成功 / 底层抛错回落 `isRaw`）与 `createTerminal` 的 raw 开关、`close`、尺寸回落（TTY 读数、非 TTY 与零尺寸回 80x24）、`onResize` 订阅。
- 脚本: `TUI/package.json` 增 `test:integration`（`node --experimental-transform-types --test 'tests/integration/*.test.ts'`）、`test:coverage`（单元 + 集成两轮 glob; 覆盖率原始 JSON 落 `../tmp/cov-tui`（相对 `TUI/`）, 报告落 `tmp/cov-tui/report.json`（相对仓库根））、`test:e2e`（`pnpm run demo:build -- --smoke` 与 `pnpm run smoke:pty` 串联）。
- 专项复核: `tests/app.test.ts:354` 的条件 `skip` 属 4.4 允许的「仓库不在家目录」一类, 保留不动; 本机仓库在家目录下, 本轮实测 `skipped` 为 0。`tests/fixtures/` 两个夹具均在用: `focus-frame-legacy.json` 由 `tests/focus-frame.test.ts` 读取（冻结基线）, `status-column-old.ts` 由 `tests/status-column-equivalence.test.ts` 导入（旧实现快照）, 都保留。
- 缺口取舍: `src/main.ts` 仍是最大未覆盖面（行 47.1%）, 其 `apply()` 属宿主接线, 留代码阶段与包文档阶段; 按「少量缺口锚点」本次只补 `renderer/terminal.ts`。
- 阶段 3 第一批（2026-10-28, 分支 `history-cleanup/03-code-tui`）: 长文件拆分留第二批, 本轮只做五步里的删失效、收拢判断与注释。逐项:
  - 删失效导出: 删 `src/app/adapter/types.ts` 的 `ToolResultMetaLike`、`src/app/state.ts` 的 `PickerOption` 与 `isInputHistoryBrowse`; 删前重扫 `src` / `tests` / `scripts` / `docs`, 除定义处零引用; 删后复扫（含 `dist` 之外全仓）无残留。
  - 按键分派: 新增 `src/app/keys.ts`, 10 张上下文表（审批 / 选择面板 / 状态选项 / 任务面板 / 列表面板 / 历史 list·view·confirm·error / 编辑区）共 75 条键位映射, 收成 51 个动作名; `App.keyActions` 是 `Record<KeyActionName, (k) => void>` 的动作实现表, 函数体与拆分前的 if / switch 分支逐行对应。`handleKey` 从 800 行降到约 330 行, 各上下文一律 `lookupKey(表, name)` 命中即执行并返回; 文件头注明三类留在代码里的特殊分支（Ctrl 组合键与修饰键、按面板内部状态判的兜底、编辑区模式键与可打印字符）。原 `handleKey` 里的两个本地闭包提为私有方法 `finishApproval` / `moveApprovalFocus`。
  - 用户消息谓词: `state.ts` 新增 `isUserMessage(value)`（role 与 kind 同一口径）, 适配层（`dsh.ts` / `tool-bootstrap.ts`）、状态层（`appendStream`）、渲染层（`layout.ts` / `commands.ts` / `HistoryPanel.ts` / `index.ts`）共 21 处调用点改调它。
  - 记忆层级: `adapter/types.ts` 新增 `ManagedTier` 类型、`isManagedTier` 判定与 `SESSION_TIER` 常量, 5 处层级字面联合收成 `ManagedTier`; `index.ts` 的 `/memory list|add|remove|replace` 校验改调 `isManagedTier`（3 处）与会话层常量（1 处）。
  - 注释路径: 按总追踪 1.3 表把仓内简写改成包内完整路径（`layout/hints.ts` → `src/app/layout/hints.ts` 等）共 32 处; 计数类注释未动。
  - 沙箱展示映射: 核对 `src/app/layout.ts:277` 的 `MODE_SHORT`, 仅是 `read-only/workspace-write/danger-full-access` → `ro/wr/full` 的标题栏缩写, 与 `herdr-use` 的沙箱判定枚举非同源, 本轮不引依赖（见偏差）。
- 阶段 3 第二批（2026-10-28, 拆长文件, 顺序按总追踪 4.1 的 P1: 排版与宽度 → 状态 → 适配 → 类型）:
  - `src/app/layout.ts`（2440 行）拆成 7 个模块 + 入口重导出, 一行代码未改（只挪位置与补 import）:
    | 新文件 | 行数 | 职责 |
    | --- | --- | --- |
    | `layout/frame-rows.ts` | 211 | 行文本、提示区折行、渐进窗口常量、半屏与用户块跳转量 |
    | `layout/geometry.ts` | 464 | 三区高度、顶部切分、`FrameGeometry` 与面板可见性判定 |
    | `layout/title-bar.ts` | 211 | 标题栏状态符号、状态列渲染 |
    | `layout/top-region.ts` | 606 | 顶部区域装配（状态列 + 会话区 + 活动区面板选型） |
    | `layout/status-line.ts` | 278 | 底部状态栏（模型 / 用量 / 分支 / 沙箱段） |
    | `layout/run-virt.ts` | 270 | 运行指示（虚拟速度 / 虚拟 token / ●○ 与用户块符号） |
    | `layout/frame-build.ts` | 442 | 分区、滚动回落、`buildFrame` 与焦点 |
  - `src/app/layout.ts` 只剩入口重导出（外部既有 import 路径 `./layout.ts` 不变, 包内其它模块与 `tests/` 全部不改 import）。跨模块复用的私有辅助（`capRows` / `panelShownInActivity` / `MODE_SYMBOL` / `runningSymbol` / `userBlockSymbolResolver` / `activeSessionFields` / `buildTopRegion`）只在子模块间 `export`, 不加入口重导出, 对外可见集合与拆分前一致。
  - 依赖方向为单向: `frame-rows` → `geometry` → `title-bar` / `top-region` → `status-line` / `frame-build`; 唯一的反向引用是 `top-region` 对 `FrameScrollReport` 的 `import type`（仅类型, 编译期擦除, 不形成运行时环）。
  - 偏差: 逐字节帧比对的做法与理由见「测试与证据」; 拆分只挪位置与补 import, 未改名、未合并判断、未动 `src/main.ts` 启动顺序。

## 偏差

- 覆盖率命令路径: `report.mjs` 把两个参数按**仓库根**解析（`resolve(root, argv)`）, 而 `NODE_V8_COVERAGE` 由 node 按**当前目录**解析。脚本据此分工: `NODE_V8_COVERAGE=../tmp/cov-tui`（相对 `TUI/`）、报告参数 `tmp/cov-tui` / `tmp/cov-tui/report.json`（相对仓库根）, 两者指向同一目录; 包文档原写法 `node ../dev/coverage/report.mjs ../tmp/cov-TUI ...` 会把产物解析到仓库外, 故按上述分工落地。
- 覆盖率读数抖动: 首次按新路径实跑时报告读到 60.05%（行）/ 63.72%（分支）, 对同一目录重算即得 87.48% / 78.41%; 当时同一 worktree 有另一路在重建 `tmp/cov-tui`（并发覆盖率运行共用该目录, 目录被清空重建）→ 报告读到半落盘的 JSON。随后连续多次实跑（含提交前复跑）均稳定为行 87.48%、分支 78.41%, 统计口径与脚本均无需改动。
- `smoke:pty` 本机不绿: 真机会话启动后即报 `MISSING_CREDENTIAL: llm-pi-ai: no credential for provider route "tollgate"`, 环境无 provider 凭据, 工具回合跑不起来, 3 次尝试均未同时出现 `✓` 工具结果行与 `ctx/cache`。属 4.5 的「真 LLM 不进 `test`」与「真机验证留人工验收」, 触发条件 = 有可用模型凭据; 交人工验收。`test:e2e` 的 `demo:build -- --smoke` 段通过（`SMOKE_OK`）。
- 覆盖率分母: 分支分母由 7976 涨到 7996（新跑到的 V8 block range 计入分母）, 比率 78.42% → 78.41%; 用**原测试集**重跑一次得 78.413%, 证明该量级属统计方法噪声。包级行覆盖 87.39% → 87.48%, 只升不降。
- 观察（未改 `src`）: `createTerminal().rawMode(false)` 之后 `rawEnabled` 仍为 `true`（`if (setRawMode(...))` 在关闭时返回 falsy 不再赋值）, 该字段全仓无消费方, 行为无影响, 留给代码阶段。集成层里 `/new` 后旧内容不残留依赖活跃会话已确立, 已在装配器按生产时序补 `session-title`（见实现记录）。
- 本机环境: `pnpm` 的依赖预检会尝试联网安装并因 store 不可写失败, 四个命令统一以 `pnpm_config_verify_deps_before_run=false` 运行; 脚本内容本身不含该变量。
- 阶段 3 第一批偏差:
  - `isInputHistoryBrowseAt` 在删掉 wrapper 后也成了零引用（导出仍在, 全仓无调用方）, 但它不在 5.2 的删除清单里, 本轮按「计划外不改、不顺手改」留在原处, 待后续按 5.2 口径处置。
  - 用户消息谓词只覆盖 21 处: `src/app/layout/pipeline/sections.ts`（6 处）与 `pipeline/replay.ts`（1 处）的 `delivery.kind === "user"` 是 `switch (delivery.kind)` 判别式下方的收窄条件, 换成普通谓词会丢类型收窄、连带改结构, 保留字面比较; 总追踪 1.3 与 5.1 的「34 处」含这些判别式与 3 处注释说明。
  - 记忆层级: 规划写「改读注入值（适配层已给的层级）」, 但 TUI 侧的 tier 只来自 `/memory` 的命令参数, 没有注入值可读; 落地为从适配层声明的层级派生 `ManagedTier` / `isManagedTier` / `SESSION_TIER`, 4 处自比字面量改调它们, 行为与提示文案不变。
  - 注释路径: 总追踪 1.3 表列 TUI 34 处, 其中 `app/layout/tool-line.ts:18` 的 `TUI/src/x.ts` 是路径缩短的**示例**、`app/adapter/types.ts:920` 的 `src/types.ts` 实为宿主仓路径 `packages/interaction/commands/src/types.ts`, 两处都不是仓内简写, 未改; 实改 32 处。
  - 沙箱展示映射: `MODE_SHORT` 只是标题栏缩写表（`ro` / `wr` / `full`）, `herdr-use` 侧是命令放行判定用的沙箱模式读取器, 两者不同源; 本轮不引 `herdr-use` 类型（规划未给 TUI 加该 link 依赖）。
  - `smoke:pty` 仍需 `TOLLGATE_API_KEY`, 本机缺凭据, 本轮跳过, 与阶段 2 同一条偏差。

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

### 阶段 3 第一批（2026-10-28）

工作目录 `TUI/`, 每步实跑 `check` + `test`, 收尾跑 demo 冒烟:

| 命令 | 结果 |
| --- | --- |
| `pnpm -C TUI run check` | ✓ 0 error（删导出后 / 谓词后 / 层级后 / 按键表后 / 格式化后各跑一次） |
| `pnpm -C TUI run test` | ✓ 1828 pass / 0 fail / 0 skip / 0 todo, 8.2 至 8.5s（同上各步各跑一次） |
| `pnpm -C TUI run build` | ✓ 编译到 `dist/` |
| `pnpm -C TUI run demo -- --smoke` | ✓ 末行 `SMOKE_OK sent=[...] interrupts=1`, 全程 `SMOKE_PASS preset-badge` / `jobs-panel` / `jobs-kill` 等断言通过 |
| `pnpm -C TUI run smoke:pty` | - 跳过（缺 `TOLLGATE_API_KEY`, 见偏差） |

- `demo` 直接跑需要先 `build`（`dist/` 不存在时 `node dist/demo/main.js` 报 MODULE_NOT_FOUND）, 本次按 `build` → `demo -- --smoke` 顺序执行。
- 按键表读数: 10 张上下文表 / 75 条键位 / 51 个动作名; `handleKey` 内 `name === "…"` 由 72 处降到 31 处, 其余为动作体内部的方向三元、Ctrl 组合键分支、编辑区模式键。
- `check` / `test` 均在格式化后复跑, 结果不变; 已有 1828 条用例未改断言。

### 阶段 3 第二批 · layout.ts（2026-10-28）

| 命令 | 结果 |
| --- | --- |
| `pnpm -C TUI run check` | ✓ 0 error（拆分后与格式化后各一次） |
| `pnpm -C TUI run test` | ✓ 1828 pass / 0 fail / 0 skip / 0 todo, 8.3s |
| `pnpm -C TUI run build` | ✓ 编译到 `dist/` |
| `pnpm -C TUI run demo -- --smoke` | ✓ 42 条 `SMOKE_PASS` + 末行 `SMOKE_OK sent=[...] interrupts=1` |

- 帧基线: 逐字节比对不靠 `TUI_FRAME_DUMP` 的两次实跑（帧序列随真实时间推进, 虚拟速度 / job 计时 / 动画帧数每次都不同, 实测两次 581 与 584 行且内容错位）, 改由测试里的冻结帧基线承担: `tests/focus-frame.test.ts` 对 `tests/fixtures/focus-frame-legacy.json` 逐行比对、`tests/status-column-equivalence.test.ts` 对旧实现快照比对、其余布局用例断言精确行文本; 拆分前后全量用例均 1828 通过, 断言一字未改。
- 拆分前后各跑一次 `demo -- --smoke`（`git checkout HEAD~1 -- TUI/src/app/layout.ts` + 重建 `dist/`）, 两次均 `SMOKE_OK` 且 42 条帧断言全过; 对比完成后已恢复拆分版并重建。
