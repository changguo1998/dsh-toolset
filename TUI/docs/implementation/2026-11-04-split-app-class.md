# 拆分 `App` 类体（接取条目: `TUI/docs/BACKLOG.md`「拆分 `TUI/src/app/index.ts` 的 `App` 类体」）

状态: 测试　　开启: 2026-11-04
本文件是本任务唯一的追踪文档与文档改动位置; 计划外的文件不改.

## 目标

把 `TUI/src/app/index.ts` 的 6497 行（`App` 类 6201 行）收成「显式上下文对象 + 按职责拆文件」: 原 `App` 的 59 个显式字段 + `deps` 与构造器收进 `app/runtime/context.ts`, `keyActions` 表与 174 个方法按职责搬进 11 个模块（`setLogger` 留在壳）, `index.ts` 只剩 `App` 壳（`private ctx` + 8 个公开方法委托）与装配; 对外可见集合（`App` 的 8 个公开成员、`smallTerminal` 与 3 个常量、5 组重导出）与帧内容一律不变.

## 调研

### 现状结构（`TUI/src/app/index.ts`, 6497 行）

| 行段 | 内容 | 行数 |
| --- | --- | --- |
| 1-224 | 文件头注释 + import + 兼容重导（类型 / 纯函数 / 子模块） | 224 |
| 225-296 | 模块级常量与纯函数（`smallTerminal` / `parseActivitySwitch` / `formatActivitySwitches`） | 72 |
| 297-447 | `App` 的字段声明（`state` / `deps` / 计时器 / 流水线缓存 / 宽度探测状态 …） | 151 |
| 448-905 | 六步流水线交付 + 滚动派生 + 帧排版（`replaySectionsFromRows` … `paneScrollMaxOf`） | 458 |
| 906-952 | 构造器: 依赖归一化（shell guard / bell / 帧率）+ `initialState` | 47 |
| 953-1651 | 启动期与宽度探测: `start` / 会话清理 / 目录刷新 / 会话状态快照 / 模型状态 / 思考解析 | 699 |
| 1652-1881 | `dispose` 家族 + 响铃 + 面板定时刷新 + 别名保鲜 | 230 |
| 1882-2328 | `handleEvent` + 回合开始 + 符号 / rule-engine 懒读 + 外部日志 | 447 |
| 2329-2948 | `keyActions` 表（565 行）+ `finishApproval` / `moveApprovalFocus` | 620 |
| 2949-3612 | 按键路由、提问 / 审批、退出 / 重启 / 清理确认、kickoff、`sendUserText`、`/init` | 664 |
| 3613-3845 | `submit` + `$` 本地执行 | 233 |
| 3846-4330 | `handleSlash` + 模型 / 主题 / 详略 / 符号 / 宽度命令 | 485 |
| 4331-4711 | 历史面板的记录操作与会话恢复 | 381 |
| 4712-4907 | 模型选择面板与启动参数模型 | 196 |
| 4908-5318 | 状态面板、`/stats` `/rename` `/skills` `/tools` `/settings` `/config` `/new` `/fork` | 411 |
| 5319-5800 | `/search` `/council` `/workflows` `/contract` `/loop` `/group` `/memory` | 482 |
| 5801-6047 | 共享面板、`/jobs`、通知与本地日志 | 247 |
| 6048-6497 | `/help` 表、补全与提及、输入编辑、`paint` / `flushPaint` / `apply` / 审批倒计时 | 450 |

### 计数（实测）

- 实例字段 61 个（60 个显式声明 + 构造器参数属性 `deps`）; 方法 175 个（另 1 个构造器）, 方法体约 5390 行; `keyActions` 表 565 行是类内最大的单个成员.
- 最大方法: `handleEvent` 332 / `handleKey` 249 / `handleSlash` 194 / `helpLines` 191 / `handleConfigCommand` 125 / `start` 116 / `submit` 113 / `runLocalShell` 93 / `runPendingHistoryOp` 91 / `handleQuestionKey` 79 / `resumeToSession` 75.
- `this.` 引用 1483 处: 方法调用 773、字段 537、`deps` 173; 无裸 `this` 求值（仅 3 处注释文字 `this`）; 1 处非调用引用 `void this.openHistoryView`（原样保留）.
- 按拟定分组统计跨职责调用 494 处, 其中 404 处指向帧模块（`apply` / `paint` / `notice` 是事实上的中枢）, 故上下文对象必须提供统一的成员分派面, 否则模块间会成导入网.

### 公开面与被引用面

- `index.ts` 导出: `App`; `smallTerminal`; `SMALL_TERMINAL_COLS` / `SMALL_TERMINAL_ROWS` / `SMALL_TERMINAL_NOTICE`; 重导 `formatModelCatalog` / `resolveModelSpec`、`exit-guards` 6 个符号、`focusedLineScroll` / `focusedPageScroll`、类型 `PaneScrollMax` / `AppDeps`.
- `App` 公开成员 8 个: `start` / `dispose` / `paintNow` / `flushPaint` / `applyStartupModel` / `appendExternalLog` / `applyTheme` / `setLogger`; `main.ts` 全部使用, `tests/` 使用前 6 个（`setLogger` / `applyTheme` 仅 `main.ts`）.
- 测试只经构造器与公开方法驱动 `App`: 无 `app["..."]` 式私有成员访问、无 `as any` 强转; 私有字段改名 / 搬家不影响测试.

### 与既有约定的一致性

`TUI/docs/design/REFACTOR.md` 原则「副作用（adapter 调用 / paint / notice / 异步）一律留在 `App`（`index.ts`）」与条目「把类体拆出」字面冲突. 本任务按以下解释执行: 新模块仍是 **App 层内部实现**（不是 `commands.ts` 那类纯逻辑模块）, 副作用编排留在 App 层、只是分文件; 收尾把 `REFACTOR.md` 的「当前文件归属」补 `runtime/*` 一行, 并把「留在 `index.ts`」改为「留在 App 层（`index.ts` 壳 + `runtime/`）」, 避免约定与现状不符.

### 基线（2026-11-04 实测, 拆分前）

| 命令 | 结果 |
| --- | --- |
| `pnpm -C TUI run check` | 退出 0 |
| `pnpm run test:tui` | tests 1829 / pass 1829 / fail 0 / skipped 0, 8257 ms |
| `pnpm -C TUI run demo -- --smoke` | 末行 `SMOKE_OK` |
| `node dev/standard/index.mjs` | 错误 0 / 警告 648 |
| 帧基线 `tests/focus-frame.test.ts` | 1 例现成; 本任务**不重冻** |

### 前史

`TUI/docs/archived/2026-11-04-split-dsh-adapter.md` 刚按同一形态拆完 `adapter/dsh.ts`（3633 → 577 行, 上下文对象 + 四个职责模块 + 装配）; 其决策与验证手法（一次性脚本搬迁、成员总数断言、全量测试 + 帧基线）在本任务沿用. 条目本身来自 `docs/archived/2026-10-28-history-cleanup-tui.md` 阶段 3 的偏差登记.

## 决策

01. **上下文对象形态**: a 分节 state（`ctx.session` / `ctx.events` / `ctx.paint` 各一节）; b 单一扁平 `AppContext`（`deps` + 61 个字段 + `self` 分派面）.
    选定 **b**: 字段被大量方法共享（`state` 79 个方法 / `disposed` 30 / `sections` 10 …）, 分节会造成大量跨节引用与重复守卫; 扁平表与 `adapter/context.ts` 的 `AdapterState` 同构, 迁移成本最低, 归属由模块边界与注释表达.
02. **方法分派与装配形态**: a 模块函数接收 `(ctx, ...)`, 跨模块直接 import; b 每模块导出 `createXPart(ctx)`, 装配成扁平 `ctx.self` 后按名调用.
    选定 **b**: 跨组调用 494 处, 直接 import 会形成模块网状循环; 工厂 + 扁平成员面与 `adapter/dsh.ts` 的 `assembleAdapter` 同构; 组内调用仍是本地函数, 不经过 `ctx.self`.
03. **拆分粒度**: a 严格条目三组（会话控制 / 面板交互 / 插件接线）, 单文件约 1500 至 3100 行; b 三组语义保留, 另加「帧」与「生命周期」两组, 共 7 个职责模块 + 上下文对象, 最大 1500 行; c 在 b 之上再把命令面按 model / config / memory / host 拆开, 共 11 个职责模块 + 上下文对象, 最大 1264 行.
    ~~选定 b~~ 选定 **c**（用户 2026-11-04 裁定, 取代初稿的 b）: b 仍把 1499 行命令面压在一个文件里, 而命令面天然按宿主域（模型 / 配置 / 记忆 / 列表查询）分组, 拆开后每块 175 至 553 行、可独立阅读与审阅; 代价是多 4 个文件与 `handleSlash` 内约 26 处跨模块分派（经 `ctx.self`, 与原调用同形）, 无状态耦合. 7 模块方案的其余理由（三组之外单列帧与生命周期）仍然成立.
04. **新文件位置与命名**: a 直接放 `TUI/src/app/` 顶层; b 放新目录 `TUI/src/app/runtime/`.
    选定 **b**: 顶层已有 `keys.ts` / `commands.ts` / `state.ts`, 直接放会撞名; `runtime/` 与 `layout/pipeline/`、`adapter/` 的分层风格一致; `index.ts` 留在 `app/` 作为唯一入口.
    模块: `context.ts`（上下文对象与装配类型）/ `frame.ts`（交付、绘制、滚动、提示写出）/ `interaction.ts`（按键路由、确认面板、编辑与补全）/ `session.ts`（提交、shell、会话历史与恢复、会话状态快照）/ `panels.ts`（列表面板、状态面板、模型选择）/ `commands.ts`（slash 分派、本地 / UI 命令与 `/help`）/ `commands-model.ts`（模型 / provider / effort 与启动参数模型）/ `commands-config.ts`（`/config` `/policy` `/permission` `/settings`）/ `commands-memory.ts`（`/memory` 系列）/ `commands-host.ts`（skills / tools / search / council / workflows / contract / loop / group / guard / task 列表命令）/ `wiring.ts`（事件桥、服务懒读、状态行刷新）/ `lifecycle.ts`（启动、退出、清理、宽度探测、响铃）.
05. **`keyActions` 表位置**: a 留在 `AppContext` 字段; b 搬进 `interaction.ts` 作模块内 `const`.
    选定 **b**: 只有 `handleKey` 使用（10 处）, 放上下文会把 565 行闭包表塞进状态对象; 该表的闭包在装配完成后才被调用, 局部 `const` 时序安全.
06. **`App` 壳形态**: 只留 `private readonly ctx` + 构造器（建 ctx、建 11 个 part、`assembleApp` 合并回 `ctx.self`）+ 8 个公开方法委托.
    理由: 公开签名与调用时序不变; 类型面上 60 个私有字段收成一个; 公开方法不再持有状态, 只转调.
07. **装配方式**: `assembleApp(parts)` 用 `Object.defineProperties` 合并（与 `assembleAdapter` 同款）; 构造器内不调用任何成员, `ctx.self` 先占位后回填.
    理由: 成员面是普通方法, 无 getter, 但保持与既有装配同一手法, 避免将来加 getter 时静默固化.
08. **搬迁方式**: a 分步搬（每步 `check` + `test` 绿）; b 一次性脚本搬迁 + 统一编译修复.
    选定 **b**: 175 个方法与 494 处跨组调用互相牵连, 任一组先搬都会留下「半搬状态」的临时类型层并二次改写调用点; 一次性脚本 + 统一编译修复在 adapter 拆分中已验证（原记录的偏差 1）. 风险由「成员总数断言 + 全量 1829 例 + 帧基线 + 冒烟」兜.
09. **迁移规约（move-only）**: 方法体除 `this.` 改写外逐字保留（含注释、空行、分支顺序、不可达代码与既有错位注释）; 不改测试、不改事件 / 按键 / 绘制顺序; 不合并 / 不重命名方法; 发现真缺陷只记「偏差」并在 BACKLOG 另开条目.
10. **验证门**: 搬迁后依次 `check` → `test:tui` → 帧基线专项 → `demo -- --smoke` → `build` → 全仓 `check` / `test` → `check:docs`; 另加脚本断言（174 个方法 + `keyActions` 全部有归属、无重名、`index.ts` 仅 8 个公开成员、公开导出集合不变、方法体归一化后与原文件逐字一致）.
11. **提交粒度**: 按 `docs/WORKFLOW-STANDARD.md` §5 逐点询问; 默认建议合并为关闭后一次提交.

## 规划

### 步骤

| 步 | 内容 | 目标文件 | 预计行数 | 验证 |
| --- | --- | --- | --- | --- |
| 0 | 记录基线（已完成, 见「调研」） | — | — | 1829/1829、check 0、`SMOKE_OK`、docs 648 警告 |
| 1 | 建上下文对象: `AppContext` / `createAppContext(deps)`（61 字段 + 构造器归一化 + `initialState`）与 `ctx.self` 占位; 建 `assembleApp` | 新增 `runtime/context.ts` | ~230 | check |
| 2 | 脚本抽取 174 个方法 + 构造器到 11 个 part 模块（`setLogger` 留壳）（含 `keyActions` 表）; `this.<字段>` → `ctx.<字段>`、同组方法 → 本地函数名、跨组方法 → `ctx.self.<方法>`; `index.ts` 收成壳 | 新增 `runtime/frame.ts` / `interaction.ts` / `session.ts` / `panels.ts` / `commands.ts` / `commands-model.ts` / `commands-config.ts` / `commands-memory.ts` / `commands-host.ts` / `wiring.ts` / `lifecycle.ts`; 改 `index.ts` | 643 / 1264 / 974 / 386 / 553 / 211 / 247 / 313 / 175 / 669 / 553; index ~150 | check |
| 3 | 清理 import（按模块实际使用裁剪、同源合并、补新文件头）与编译错误修复 | 12 个新源文件 + `index.ts` | — | check |
| 4 | 全量验证与断言: 测试、帧基线、冒烟、构建、成员与导出断言、方法体对拍 | 新增临时脚本（`tmp/`, 用后删除） | — | 见决策 10 |
| 5 | 回写 `DESIGN.md` 文件树 / 控制层职责与 `REFACTOR.md` 归属表 | 改 `TUI/docs/DESIGN.md` / `TUI/docs/design/REFACTOR.md` | — | check:docs |
| 6 | 关闭: 条目「完成」并从 BACKLOG 移除, 追踪文档移入 `TUI/docs/archived/`, 删临时脚本 | 改 `TUI/docs/BACKLOG.md`; 移动本文档 | — | git diff 自查 |

### 条目三组与本任务模块的映射

| 条目三组 | 本任务模块 |
| --- | --- |
| 会话控制 | `session.ts`（提交、shell、会话历史与恢复、会话状态快照）+ `lifecycle.ts` 的启动 / 退出 / 清理 |
| 面板交互 | `interaction.ts`（按键 / 确认 / 补全）+ `panels.ts`（列表面板 / 模型选择）+ `commands.ts` 与 `commands-model.ts` / `commands-config.ts` / `commands-memory.ts` / `commands-host.ts`（slash 分派与四域命令） |
| 插件接线 | `wiring.ts`（事件桥 / 服务懒读 / 状态行） |
| 条目未列（新增） | `frame.ts`（交付 / 绘制 / 滚动）+ `lifecycle.ts`（启动 / 退出 / 宽度探测 / 响铃） |

### 计划改动文件清单

新增:

- `TUI/src/app/runtime/context.ts`
- `TUI/src/app/runtime/frame.ts`
- `TUI/src/app/runtime/interaction.ts`
- `TUI/src/app/runtime/session.ts`
- `TUI/src/app/runtime/panels.ts`
- `TUI/src/app/runtime/commands.ts`
- `TUI/src/app/runtime/commands-model.ts`
- `TUI/src/app/runtime/commands-config.ts`
- `TUI/src/app/runtime/commands-memory.ts`
- `TUI/src/app/runtime/commands-host.ts`
- `TUI/src/app/runtime/wiring.ts`
- `TUI/src/app/runtime/lifecycle.ts`
- `TUI/docs/implementation/2026-11-04-split-app-class.md`（本文档）

改动:

- `TUI/src/app/index.ts`
- `TUI/docs/BACKLOG.md`（条目状态「进行中」→「完成」, 关闭时移除）
- `TUI/docs/DESIGN.md`（步骤 5 回写）
- `TUI/docs/design/REFACTOR.md`（步骤 5 回写）

明确不改（出现需求先请示并补进清单）:

- `TUI/tests/**`、`TUI/demo/**`、`TUI/src/main.ts`、`TUI/src/app/{state.ts,state/**,layout/**,components/**,adapter/**,commands.ts,app-deps.ts,...}` 的其余文件
- 其它 33 个包、根 `package.json` 与 `scripts/`
- 不改任何方法体行为; 不重冻 `tests/focus-frame.test.ts` 的逐行基线; 不顺手修 `handleSlash` 的不可达分支与第 3195-3197 行的错位注释（记「偏差」）; 不新增依赖

### 风险与对策

| 风险 | 对策 |
| --- | --- |
| 成员漏搬 / 重名被装配覆盖 | 脚本按起始行切分并断言 174 个方法 + `keyActions` 全部有归属; 装配前断言 part 成员名无重复 |
| `ctx.self` 的类型循环（part 返回类型引用 `AppContext`） | 已用最小原型验证 `ReturnType<typeof createXPart>` 的循环类型可编译; 若实际报循环引用, 退回显式 `XxxPart` 接口（多约 250 行签名, 语义不变） |
| 跨组调用改错 | 脚本按「同组 → 本地名、跨组 → `ctx.self.`」映射改写; `tsc` 兜未知成员; 全量 1829 例兜行为 |
| 初始化 / 调用时序变化 | 构造器只建 ctx 与 part、不调用成员; `start()` 前公开方法的调用路径与原来一致 |
| 大 diff 审阅困难 | 方法体归一化对拍（去掉 `this.` / `ctx.` / `ctx.self.` 前缀后逐 token 比较）; 提交前 diff 自查只应出现「位置 + 前缀」变化 |
| 私有字段外泄 | `App` 只保留 `private readonly ctx`; 断言 `index.ts` 中无 `private state` 等旧字段 |

## 用户裁定记录

1. **拆分粒度**（2026-11-04）: 选「再细拆 10+ 模块」—— 即决策 3 的 c, 在 7 个职责模块之上再把命令面按 model / config / memory / host 拆开, 共 11 个职责模块 + 上下文对象; 该项取代规划初稿的 b.
2. **检查点 1（决策后）**（2026-11-04）: 先选「先停下, 等检查」; 复查后裁定「提交后继续任务」—— 规划文档单独提交, 随后进入实现.
3. **检查点 2（实现后）**（2026-11-04）: 选「现在提交代码与实现记录」—— 本次实现单独提交; 关闭收尾（DESIGN / REFACTOR 回写、归档、BACKLOG 清理）留到收尾阶段.

## 实现记录

按决策 8 用一次性脚本 `tmp/split-app.mjs` 搬迁（脚本读原文件副本 `tmp/app.orig.ts`, 二者用后删除）:

1. 成员切分: 按缩进 2 的声明行识别 236 个成员（60 字段 + 175 方法 + 构造器）, 成员前的连续注释随成员走.
2. 改写规则: `this.<字段>` → `ctx.<字段>`, 同组方法 → 本地函数名, 跨组方法 → `ctx.self.<方法>`, `this.keyActions` → `keyActions`; 注释 / 字符串 / 模板字面量文本跳过, 模板 `${...}` 内按代码改写.
3. 模块生成: 每个 part 导出 `createXPart(ctx)`, 返回本组方法对象; `keyActions` 表留 `interaction.ts` 作模块内 `const`; 顶层常量 / 纯函数按归属搬到使用它的模块, `smallTerminal` 与 3 个常量在 `lifecycle.ts` 导出并由 `index.ts` 重导.
4. `context.ts`: 59 个显式字段 + `deps` 收成 `AppContext`; 字段初值与构造器归一化逻辑收进 `createAppContext`; `AppSelf` 用 11 个工厂的 `ReturnType` 交集声明, 构造器回填 `ctx.self`.
5. `index.ts`: 只剩 `App` 壳（`private readonly ctx` + 8 个公开方法委托 + 测试兼容的私有成员）+ `assembleApp`（defineProperties 合并）与兼容重导.
6. 生成后: `format` 统一格式; 删 7 个因 `.join(` 误判而带入的 `node:path` 未使用 import; 修 1 处局部变量与新上下文参数同名.

行数变化（`wc -l`）:

| 文件 | 行数 |
| --- | --- |
| `app/index.ts` | 6497 → 151 |
| `app/runtime/context.ts` | 新增 366 |
| `app/runtime/frame.ts` | 新增 704 |
| `app/runtime/interaction.ts` | 新增 1386 |
| `app/runtime/session.ts` | 新增 1094 |
| `app/runtime/panels.ts` | 新增 423 |
| `app/runtime/commands.ts` | 新增 631 |
| `app/runtime/commands-model.ts` | 新增 239 |
| `app/runtime/commands-config.ts` | 新增 281 |
| `app/runtime/commands-memory.ts` | 新增 346 |
| `app/runtime/commands-host.ts` | 新增 206 |
| `app/runtime/wiring.ts` | 新增 710 |
| `app/runtime/lifecycle.ts` | 新增 643 |

（合计 7180 行, 比原文件多 683 行: 12 个文件头 / import / 工厂包装与 `AppContext` 类型声明.）

## 偏差

1. **计数口径修正**: 规划原文写「175 个方法搬进 11 个模块 / 61 个实例字段进上下文」; 实测 175 个方法 = **174 个搬出 + `setLogger` 留壳**, 另 1 个构造器; `context.ts` 收 **59 个原字段 + `deps`**（`keyActions` 按决策 5 进 `interaction.ts`）. 文档已在实现阶段按实测修正.
2. **测试私有成员兼容层（非计划内新增）**: 既有用例经 `as unknown as` 读 `App.state` / `App.sections` / `App.groupCount`, 并直接调用 `apply` / `resumeToSession` / `startNewSession`; 为不改测试, `App` 增加 3 个私有 getter + 1 个 setter + 3 个私有转调方法（TS 私有, 不进公开类型面; 运行时落在原型上）. 这是对内契约的兼容层, 不是新功能; 若后续允许改测试, 可连同这 6 个成员一起删.
3. **非前缀改写 1 处**: `panelRefreshTick` 的局部变量原名 `ctx`（`const ctx = this.panelRefreshCtx`）, 与新的上下文参数同名 → 改名 `panelCtx`; 逐 token 对拍确认仅此 1 处.
4. **死常量**: `RETIRED_COMMAND_NOTICE` 在原文件即未使用, 随组搬到 `commands.ts` 保留（未删, 守 move-only）; 项目未开启 `noUnusedLocals`, 不影响检查.
5. **未分步落盘**: 决策 8 已定一次性脚本; 任一组先搬都无法独立编译, 故实现记录按一次性描述（与 adapter 拆分的偏差 1 同因）.
6. **注释路径**: 搬入方法的注释保留原文（含 `src/app/...` 简写路径存量）, 新文件头用完整路径; `check:docs` 警告 647（基线 648, 少 1, 无新增）.

## 测试与证据

| 命令 | 结果 |
| --- | --- |
| `pnpm -C TUI run check` | 退出 0（`tsc -p tsconfig.json --noEmit`） |
| `pnpm run test:tui` | tests 1829 / pass 1829 / fail 0, 8238 ms |
| `pnpm run test:tui -- tests/focus-frame.test.ts` | pass 1 / fail 0（帧逐行基线未重冻） |
| `pnpm -C TUI run demo -- --smoke` | 输出含 `SMOKE_OK` |
| `pnpm -C TUI run build` | 退出 0 |
| `pnpm run check`（全仓 34 包） | 退出 0 |
| `pnpm run test`（全仓 34 包） | 退出 0 |
| `node dev/standard/index.mjs` | 错误 0 / 警告 647（新增 0）; .ts 901 篇（新增 12） |
| `node tmp/verify-split.mjs` | 174 个搬出方法 + `setLogger` + 构造器逐 token 对拍: 仅 `panelRefreshTick` 的 `panelCtx` 改名 1 处; 导出集合 15 = 15（无缺 / 无多）; `App` 公开方法 8 个 + 构造器; part 成员 174 个无重名 |

对拍方法: 去掉注释后按 token 比较, 归一化三类预期差异（`ctx.` / `ctx.self.` → `this.`、同组本地调用 → `this.<name>`、prettier 行尾逗号）, 模板字面量 `${...}` 内的 `ctx.` 单独归一.

拆分前后对拍: `index.ts` 导出集合 15 个符号逐名一致; `App` 公开面 8 个方法 + 构造器; 测试零改动（`git status` 无 `TUI/tests/**` 变更）; 编译产物 `dist/src/app/index.d.ts` 的公开成员与原公开面一致（新增成员均为 `private`）.

## 收尾

（待关闭阶段补记）
