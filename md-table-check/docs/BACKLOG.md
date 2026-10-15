# md-table-check 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

- **表头与分隔行之间有空行的表格不报**（2026-10-16 登记）：现象 / 现状 见条目详情 1 → 落点 `src/checker.ts` / `src/main.ts` → 验收 见条目详情 1 → 估时 0.5 天 → 优先级 P2 → 来源 漏检形态筛查的实测发现（追踪文档 `docs/implementation/2026-10-16-three-surface-text-consistency.md` 任务 B 的 S3 缺口一）。
- **跨包对拍用例越出本包 tsconfig 的 rootDir，check / build 失败**（2026-10-16 登记）：现象 / 现状 见条目详情 3 → 落点 `md-table-check/tsconfig.json` / `md-table-check/tests/` → 验收 见条目详情 3 → 估时 0.5 天 → 优先级 P1 → 来源 合并 `worktree/md-table-check` 后的 `npm run check` / `npm run build` 验证。

## 条目详情（待办）

**1. 表头与分隔行之间有空行的表格不报**〔待办〕（2026-10-16 登记）

**现象 / 现状** —— 模型输出的表格常在表头行后空一行再写分隔行; TUI 只认**相邻**两行为表头 + 分隔行（`TUI/src/app/layout/build-box.ts:697-701`）, 这种块整块退回原始竖线文本（用户可见的「排版失败」）, 而本插件同样不报 —— 两侧都沉默。实测：表头 2 格 + 空行 + 分隔行 2 格 + 数据行 3 格 → `tableTotal=0`。

**期望** —— 定下口径：或「只有相邻表头 + 分隔行才算表」（则本条转为「已裁定不做」备查）, 或补一条候选判定把空行分隔也认作表并给新的提示措辞。

**建议方案（待用户裁定）** —— 倾向不检出：现有提示文案与 `summary` 全按「列数不一致」写（`src/checker.ts:224-245`）, 而该形态列数一致、只是没被认成表, 硬套文案与事实不符, 要新增提示类别与措辞。若裁定做, 实现时注意只吃**恰好一行**空行, 避免把「表头 + 隔多行的另一张表」误并。

**落点** —— `src/checker.ts`（候选判定）、`src/main.ts`（配置透传, 如需开关）、`tests/checker.test.ts`。

**验收** —— ① 口径写进 `README.md` 的形态表; ② 若做检出：补判定 + 单测（含「隔多行不合表」的反例）且 `npm --prefix md-table-check run check` 与测试全绿; ③ 真机复验一个该形态的回复。

**估时** —— 0.5 天。**优先级** —— P2。**来源** —— 漏检形态筛查实测发现（追踪文档 `docs/implementation/2026-10-16-three-surface-text-consistency.md` 任务 B 的 S3 缺口一）。

**2. 行内代码里的竖线按字面切分导致误报**〔待办〕（2026-10-16 登记）

**现象 / 现状** —— `splitCells` 不做代码跨度感知：表头里用反引号包住含竖线的片段时被按字面切成多格（例：表头字面 4 格 / 分隔行与数据行各 3 格 → 报 2 处）, 而该表在 GFM 下是 3 列表（代码跨度内的 `|` 不切）→ 多报。TUI 用同一 `splitCells`（`TUI/src/app/layout/table.ts:72-100`）, 所以两侧都按 4 格判, 口径自洽但都与 GFM 不同。

**期望** —— 定下口径：保持与 TUI 同口径（则本条转「已裁定不做」备查, 代价是多报一处）, 或两侧同时改成代码跨度感知切分。

**落点** —— `src/checker.ts`（切分）、`tests/checker.test.ts` / `tests/tuiParity.test.ts`; **跨模块**：同步 `TUI/src/app/layout/table.ts`（需用户分出独立 worktree 另开任务）。

**验收** —— ① 口径写进 `README.md` 的形态表; ② 若改：两侧切分都改且互证用例覆盖代码跨度形态, 全量 `npm run check` / `npm test` 全绿。

**估时** —— 0.5 天（含 TUI 侧）至 1 天。**优先级** —— P3。**来源** —— 漏检形态筛查实测发现（追踪文档 `docs/implementation/2026-10-16-three-surface-text-consistency.md` 任务 B 的 S3 缺口二）。

**3. 跨包对拍用例越出本包 tsconfig 的 rootDir，check / build 失败**〔待办〕（2026-10-16 登记）

**现象 / 现状** —— 2026-10-16 合并 `worktree/md-table-check`（`a2102b0`）之后, `npm run check` 与 `npm run build` 在本包失败, 共 7 处类型错误：① `tests/reasoningSeparation.test.ts:13` 与 `tests/surfaceDifferential.test.ts:23` 直接 `import "../../rule-engine/src/engine.ts"`, 递归引入的 6 个 rule-engine 源文件（`engine` / `inject` / `match` / `persist` / `rules` / `types`）不在本包 tsconfig 的 `rootDir: "."` 之内 → TS6059 六处; ② `tests/surfaceDifferential.test.ts:113` 把 `reason` 断言成 `{ kind?: unknown }` 后 `kind` 仍是 `unknown` 就传给 `INJECTABLE.has()` → TS2345 一处。`npm test` 全绿（`node --test` 不做类型检查）, 故单测不暴露此缺陷。**附带影响** —— `tsc` 在报错状态下仍 emit, build 把上述 6 个 rule-engine 源文件的编译产物落到 `rule-engine/src/`（`engine.js` 等 12 个未跟踪文件, 已清理）, 会污染他包工作区。

**期望** —— 先定口径再动手, 二选一：① 给跨包对拍用例单独的 `tests/tsconfig.json`（`rootDir` 上移 / project references 指向 rule-engine, 主 program 排除这两个文件）, 保住「与真实实现同输入对拍」的强度; ② 改为经 rule-engine 的构建产物（`rule-engine/dist`）引用, 代价是对拍对象变成编译后实现且需先 build。无论选哪条, 都要修掉 `tests/surfaceDifferential.test.ts:113` 的类型收窄。

**落点** —— `md-table-check/tsconfig.json`（或新增 `tests/tsconfig.json`）、`md-table-check/package.json` 的 `check` 脚本、`tests/reasoningSeparation.test.ts` / `tests/surfaceDifferential.test.ts`。**接取时裁定** —— ① 单独 tsconfig vs 引用构建产物; ② 这两个对拍用例是否纳入 `npm run check` 的检查面; ③ 是否顺带加一道「build 后 `git status` 必须干净」的自检（防再次往他包 `src/` 落产物）。

**验收** —— ① `npm run check` 与 `npm run build` 全仓绿; ② 两个跨包对拍用例仍在类型检查覆盖内（或写明放弃覆盖的理由）; ③ `npm test` 全绿; ④ build 后 `git status` 干净, 不再往 `rule-engine/src/` 落产物。

**估时** —— 0.5 天。**优先级** —— P1（本仓 check / build 门禁在本包整包红）。**来源** —— 2026-10-16 合并 `worktree/md-table-check` 后的验证（`npm run check` / `npm run build` / `npm test` 三条命令的实际输出）。

## 已裁定不做（备查）

- **宽度不足导致的退回**：属终端与窗口，非回复正文缺陷（2026-10-15 用户裁定）。
- **伪表格（缺分隔行）识别**：正文里带竖线的普通行很常见，误报代价高于收益（2026-10-15 用户裁定）。
- **与 TUI 抽公共切分模块**：本包独立实现 + `tests/tuiParity.test.ts` 与 TUI 源码互证，不引 TUI 内部模块
  （2026-10-15 用户裁定）。
