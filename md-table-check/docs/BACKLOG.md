# md-table-check 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

- **表头与分隔行之间有空行的表格不报**（2026-10-16 登记）：现象 / 现状 见条目详情 1 → 落点 `src/checker.ts` / `src/main.ts` → 验收 见条目详情 1 → 估时 0.5 天 → 优先级 P2 → 来源 漏检形态筛查的实测发现（追踪文档 `docs/implementation/2026-10-16-three-surface-text-consistency.md` 任务 B 的 S3 缺口一）。
- **跨包对拍用例越出本包 tsconfig 的 rootDir，check / build 失败**（2026-10-16 登记）：现象 / 现状 见条目详情 3 → 落点 `md-table-check/tsconfig.json` / `md-table-check/tests/` → 验收 见条目详情 3 → 估时 0.5 天 → 优先级 P1 → 来源 合并 `worktree/md-table-check` 后的 `npm run check` / `npm run build` 验证。
- **真实 rule-engine 端到端注入无用例**（2026-10-16 登记）：现象 / 现状 见条目详情 4 → 落点 新增 `tests/integration.test.ts` → 验收 见条目详情 4 → 估时 2-3 h → 优先级 P2（依赖条目 3 的口径先定） → 来源 2026-10-16 测试覆盖评估。
- **配置透传断言过弱（变异存活）**（2026-10-16 登记）：现象 / 现状 见条目详情 5 → 落点 `tests/main.test.ts` → 验收 见条目详情 5 → 估时 40 min → 优先级 P2 → 来源 2026-10-16 测试覆盖评估。
- **测试覆盖零散补钉（降级分支 / 围栏边界 / 互证复刻 / 文档口径）**（2026-10-16 登记）：现象 / 现状 见条目详情 6 → 落点 `tests/`、`README.md`、本文件 → 验收 见条目详情 6 → 估时 4 h → 优先级 P3 → 来源 2026-10-16 测试覆盖评估。

## 条目详情（待办）

**1. 表头与分隔行之间有空行的表格不报**〔待办〕（2026-10-16 登记）

**现象 / 现状** —— 模型输出的表格常在表头行后空一行再写分隔行; TUI 只认**相邻**两行为表头 + 分隔行（`TUI/src/app/layout/build-box.ts:697-701`）, 这种块整块退回原始竖线文本（用户可见的「排版失败」）, 而本插件同样不报 —— 两侧都沉默。实测：表头 2 格 + 空行 + 分隔行 2 格 + 数据行 3 格 → `tableTotal=0`。

**期望** —— 定下口径：或「只有相邻表头 + 分隔行才算表」（则本条转为「已裁定不做」备查）, 或补一条候选判定把空行分隔也认作表并给新的提示措辞。

**建议方案（待用户裁定）** —— 倾向不检出：现有提示文案与 `summary` 全按「列数不一致」写（`src/checker.ts:224-245`）, 而该形态列数一致、只是没被认成表, 硬套文案与事实不符, 要新增提示类别与措辞。若裁定做, 实现时注意只吃**恰好一行**空行, 避免把「表头 + 隔多行的另一张表」误并。

**落点** —— `src/checker.ts`（候选判定）、`src/main.ts`（配置透传, 如需开关）、`tests/checker.test.ts`。

**验收** —— ① 口径写进 `README.md` 的形态表; ② 若做检出：补判定 + 单测（含「隔多行不合表」的反例）且 `npm --prefix md-table-check run check` 与测试全绿; ③ 真机复验一个该形态的回复。（2026-10-16 测试覆盖评估补充：若做检出，用例落点 = `tests/checker.test.ts` + `tests/formMatrixSnapshot.test.ts` 快照，断言 = 「恰好一行空行 → `tableTotal === 1` 且表头行号正确」「隔 2 行 → 仍 `tableTotal === 0`」，文案不得与「列数不一致」措辞混淆。）

**估时** —— 0.5 天。**优先级** —— P2。**来源** —— 漏检形态筛查实测发现（追踪文档 `docs/implementation/2026-10-16-three-surface-text-consistency.md` 任务 B 的 S3 缺口一）。

**2. 行内代码里的竖线按字面切分导致误报**〔待办〕（2026-10-16 登记）

**现象 / 现状** —— `splitCells` 不做代码跨度感知：表头里用反引号包住含竖线的片段时被按字面切成多格（例：表头字面 4 格 / 分隔行与数据行各 3 格 → 报 2 处）, 而该表在 GFM 下是 3 列表（代码跨度内的 `|` 不切）→ 多报。TUI 用同一 `splitCells`（`TUI/src/app/layout/table.ts:72-100`）, 所以两侧都按 4 格判, 口径自洽但都与 GFM 不同。

**期望** —— 定下口径：保持与 TUI 同口径（则本条转「已裁定不做」备查, 代价是多报一处）, 或两侧同时改成代码跨度感知切分。

**落点** —— `src/checker.ts`（切分）、`tests/checker.test.ts` / `tests/tuiParity.test.ts`; **跨模块**：同步 `TUI/src/app/layout/table.ts`（需用户分出独立 worktree 另开任务）。

**验收** —— ① 口径写进 `README.md` 的形态表; ② 若改：两侧切分都改且互证用例覆盖代码跨度形态, 全量 `npm run check` / `npm test` 全绿。

**估时** —— 0.5 天（含 TUI 侧）至 1 天。**优先级** —— P3。**来源** —— 漏检形态筛查实测发现（追踪文档 `docs/implementation/2026-10-16-three-surface-text-consistency.md` 任务 B 的 S3 缺口二）。

**3. 跨包对拍用例越出本包 tsconfig 的 rootDir，check / build 失败**〔待办〕（2026-10-16 登记）

**现象 / 现状** —— 2026-10-16 合并 `worktree/md-table-check`（`a2102b0`）之后, `npm run check` 与 `npm run build` 在本包失败, 共 7 处类型错误：① `tests/reasoningSeparation.test.ts:13` 与 `tests/surfaceDifferential.test.ts:23` 直接 `import "../../rule-engine/src/engine.ts"`, 递归引入的 6 个 rule-engine 源文件（`engine` / `inject` / `match` / `persist` / `rules` / `types`）不在本包 tsconfig 的 `rootDir: "."` 之内 → TS6059 六处; ② `tests/surfaceDifferential.test.ts:113` 把 `reason` 断言成 `{ kind?: unknown }` 后 `kind` 仍是 `unknown` 就传给 `INJECTABLE.has()` → TS2345 一处。`npm test` 全绿（`node --test` 不做类型检查）, 故单测不暴露此缺陷。**附带影响** —— `tsc` 在报错状态下仍 emit, build 把上述 6 个 rule-engine 源文件的编译产物落到 `rule-engine/src/`（`engine.js` 等 12 个未跟踪文件, 已清理）, 会污染他包工作区。2026-10-16 测试覆盖评估复测：`npm --prefix md-table-check run check` 退出码 2、`error TS` 计 7 处（TS6059 六处 + `tests/surfaceDifferential.test.ts:113` 的 TS2345 一处）；根仓 `npm run check` 链尾本包失败而其余 21 包通过；`npm test` 61 例全绿（`node --test` 不做类型检查）；`npm run build` 在报错态仍 emit —— 复现时往 `rule-engine/src/` 落了 12 个未跟踪产物（评估后已清理）。

**期望** —— 先定口径再动手, 二选一：① 给跨包对拍用例单独的 `tests/tsconfig.json`（`rootDir` 上移 / project references 指向 rule-engine, 主 program 排除这两个文件）, 保住「与真实实现同输入对拍」的强度; ② 改为经 rule-engine 的构建产物（`rule-engine/dist`）引用, 代价是对拍对象变成编译后实现且需先 build。无论选哪条, 都要修掉 `tests/surfaceDifferential.test.ts:113` 的类型收窄。

**落点** —— `md-table-check/tsconfig.json`（或新增 `tests/tsconfig.json`）、`md-table-check/package.json` 的 `check` 脚本、`tests/reasoningSeparation.test.ts` / `tests/surfaceDifferential.test.ts`。**接取时裁定** —— ① 单独 tsconfig vs 引用构建产物; ② 这两个对拍用例是否纳入 `npm run check` 的检查面; ③ 是否顺带加一道「build 后 `git status` 必须干净」的自检（防再次往他包 `src/` 落产物）。

**验收** —— ① `npm run check` 与 `npm run build` 全仓绿; ② 两个跨包对拍用例仍在类型检查覆盖内（或写明放弃覆盖的理由）; ③ `npm test` 全绿; ④ build 后 `git status` 干净, 不再往 `rule-engine/src/` 落产物。

**估时** —— 0.5 天。**优先级** —— P1（本仓 check / build 门禁在本包整包红）。**来源** —— 2026-10-16 合并 `worktree/md-table-check` 后的验证（`npm run check` / `npm run build` / `npm test` 三条命令的实际输出）。

**4. 真实 rule-engine 端到端注入无用例**〔待办〕（2026-10-16 登记）

**现象 / 现状** —— 本包唯一交付物是「经 rule-engine 注入的汇总提示」，但现有最强证据只到「注册参数 + `decide` 返回值」（`tests/main.test.ts` 用假 engine）与「探针消费者收到载荷」（`tests/displaySurface.test.ts` / `tests/reasoningSeparation.test.ts` 注册的是 decide 恒返回 null 的 `probe`）—— `apply` → 真实 `RuleEngine` → injector 的整链路无用例，summary 呈现与 `dedupeInRecord` 去重语义无回归网。`src/` 行覆盖 100% 反映不出该缺口（属集成面）。

**期望** —— 补端到端用例；依赖条目 3 的 tsconfig 口径先定，否则新跨包用例会继续让 `npm run check` 红。

**落点** —— 新增 `tests/integration.test.ts`（或并入 `tests/reasoningSeparation.test.ts`）。

**验收** —— ① 坏表回复 → `inject` 恰好 1 次、`payload.summary === FEEDBACK_SUMMARY`、`payload.delivery === "followup"`、`payload.text` 含表头行号与「完整重发一次」；② 好表 0 次；③ `dedupeInRecord: 0` 下连续两回合各 1 次；④ `npm test` 全绿。

**估时** —— 2-3 h。**优先级** —— P2（依赖条目 3）。**来源** —— 2026-10-16 测试覆盖评估（61 例实测 + 读码）。

**5. 配置透传断言过弱（变异存活）**〔待办〕（2026-10-16 登记）

**现象 / 现状** —— `resolveConfig` 单测齐全，但 `apply(ctx, config)` → `registerConsumer` 参数与 `decide` → `renderFeedback(text, resolved.check)` 的**非缺省**透传无断言（`src/main.ts:126-128` 是唯一配置落地行）：去掉 `resolved.check` 或把 `delivery` 写死，61 例仍全绿（读码判定，未做变异运行）。

**期望** —— 补集成层透传断言。

**落点** —— `tests/main.test.ts`。

**验收** —— ① `apply(engine, {sources:["step-end"], delivery:"steer", dedupeInRecord:2, maxTables:1})` 后注册参数四字段分别等于传入值；② 同一 `decide` 对含 2 张坏表的文本只列 1 张且含「另有 1 处不一致未列出。」（证明 `check` 真的透传）；③ 反向验证：故意改坏 `src/main.ts:127` 时该用例必须失败。

**估时** —— 40 min。**优先级** —— P2。**来源** —— 2026-10-16 测试覆盖评估（同上）。

**6. 测试覆盖零散补钉（降级分支 / 围栏边界 / 互证复刻 / 文档口径）**〔待办〕（2026-10-16 登记）

**现象 / 现状** —— 覆盖率（`src/` 行 100% / 分支 97.56%）之外的一批空洞与弱断言：① `apply()` 不传 ctx 的 `ctx ?? {}` 降级与 `ruleEngine` 无 `registerConsumer` 分支（`src/main.ts:108` 是分支度量里唯一未覆盖区间；`:114` 属度量盲区）；② 围栏**混用标记**（```` ``` ```` 开 / `~~~` 闭）：检查器要求闭栅同前缀（`src/checker.ts:156-157`）而 TUI 是无条件布尔翻转（`TUI/src/app/layout/build-box.ts:702-708`）→ 实测该文本 `tableTotal=0` 而 TUI 已退回纯文本，**两侧都沉默且无用例**（README 宣称「与 TUI 同口径」与实测不符，需先裁定）；③ 行尾裸 `\` 的 `next === undefined` 分支（`src/checker.ts:38-42`，两套覆盖率度量都漏计）；④ 围栏变体（```` ```js ```` info string / 1-3 空格缩进 / 四反引号）无用例（实测行为正确，属钉口径）；⑤ 上限为 0 的语义不一致：`maxTables:0` → `tableTotal=1` 但 `renderFeedback(...) === null`（判定说有、提示为 null）、`headerExcerptLimit:0` 摘录只剩 `…`；⑥ 互证⑤ 的 TUI 围栏守卫是本地复刻（`tests/tuiParity.test.ts:129-141` 自写正则，未走 TUI 真实入口，会掩盖 ②）；⑦ `tests/displaySurface.test.ts:210-213` 硬编码 `"表格列数提醒"` 而未 import `FEEDBACK_SUMMARY`（常量改名不漏红）；⑧ 数据行 / 分隔行含 `\|` 无用例；⑨ 文档口径：条目 2 详情仍标〔待办〕但 `README.md` 形态表与 `tests/checker.test.ts:288` 已写「已裁定不修」，且归档追踪文档被引作 `docs/implementation/…`（实际在 `docs/archived/`）；⑩ 归档文档自述「真机复验 ≥2 个形态」未做（`docs/archived/2026-10-16-three-surface-text-consistency.md:422`）。

**期望** —— 随下次触碰测试时逐项补齐；② 需先裁定（对齐 TUI 的布尔翻转，或把差异写进 README 形态表并用断言钉住当前口径）。

**落点** —— `tests/{checker,main,tuiParity,displaySurface,formMatrixSnapshot}.test.ts`、`README.md`、本文件（条目 2 状态与引用路径）。

**验收** —— ① ② 有裁定结论与对应用例（或 README 形态表新增一行 + 快照钉住）；② ③④⑤⑧ 各有正向断言（含 `tableTotal` 精确值）；⑥ 复刻守卫改为导入 TUI 的 `FENCE_RE` 或注明无法直调的理由；⑦ 改为 import 常量；⑨⑩ 文档对齐；③ 全部完成后 `src/main.ts` 分支覆盖回到 100%。

**估时** —— 4 h。**优先级** —— P3（② 若裁定需改行为则另计）。**来源** —— 2026-10-16 测试覆盖评估（同上）。

## 已裁定不做（备查）

- **宽度不足导致的退回**：属终端与窗口，非回复正文缺陷（2026-10-15 用户裁定）。
- **伪表格（缺分隔行）识别**：正文里带竖线的普通行很常见，误报代价高于收益（2026-10-15 用户裁定）。
- **与 TUI 抽公共切分模块**：本包独立实现 + `tests/tuiParity.test.ts` 与 TUI 源码互证，不引 TUI 内部模块
  （2026-10-15 用户裁定）。
