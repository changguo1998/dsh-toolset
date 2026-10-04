# command-template 小项三则（bestOf 首错 / 服务面守卫 / show 预算）（接取条目：`command-template/docs/BACKLOG.md`「小项三则」）

状态：进行中　　开启：2026-10-04　　关闭：—

## 计划改动文件清单（只改这些）

- `command-template/src/steps.ts`（① `bestOf` 候选全灭带首错；③ 抽出 `effectiveBudget()` 与两个缺省常量）
- `command-template/src/main.ts`（② `serviceFace()` 工厂 + `apply` 改用它；③ `/playbook show` 显示预算生效值）
- `command-template/tests/template.test.ts`（① 断言首错；② 服务面守卫用例；③ show 预算用例）
- `command-template/README.md`（服务面守卫落点、预算可见性）
- `command-template/docs/BACKLOG.md`（条目标进行中 → 收尾移除）
- 本追踪文档

## 调研（已核）

- ① `steps.ts` 的 `bestOf` 分支把逐候选结果 `settled` 收集后**只取成功者**，全灭时丢弃全部错误（`步骤 X 的候选全部失败`）→ 用户看不到可执行原因。
- ② `SERVICE_FACE_METHODS`（`main.ts:52`）是「服务面键清单」常量，README 声称有测试守卫，但全仓无该用例（`grep` 已确认）；服务面对象原先在 `apply()` 内联构造，无法在单测里取到。
- ③ `/playbook show` 输出 `name / description / source / model / steps`，**不含预算**；总预算生效值 = `maxSteps × stepTimeoutMs`（缺省 `12 × 600000 = 7200000` ms）只在 `runTemplate` 里算，用户只有跑挂才见 `run_timeout` 文案。

## 决策

1. **① 带首个失败原因**，不用「汇总全部候选错误」：单步 `bestOf ≤ maxBestOf`（缺省 8）时全量错误会很长，而首错通常已足够定位（`候选首错：<错误>`）；不加新字段（`StepFailure` 结构不变）。
1. **② 补守卫而非删 README 声称**：把服务面对象抽成导出工厂 `serviceFace(service)`，用例断言「服务面键 == `SERVICE_FACE_METHODS`（排序后）」且「每个键在 `CommandTemplateService` 上有同名方法」——这才是原声称想守的东西（键漂移 / 方法改名）。
1. **③ 抽出 `effectiveBudget()` 供两处共用**（`runTemplate` 与 `/playbook show`），并把 `maxSteps` / `stepTimeoutMs` 缺省值提成导出常量：避免「show 显示的预算」与「运行真正用的预算」两套算法漂移。输出带**来源标注**（缺省公式 / 显式配置），让旋钮可见。
1. 不改预算语义（仍是 agent 步的启动闸门），也不改 `run_timeout` 文案。

## 实现记录（2026-10-04）

- `steps.ts`：新增导出 `DEFAULT_MAX_STEPS`（12）、`DEFAULT_STEP_TIMEOUT_MS`（600000）、`effectiveBudget(options)`；`runTemplate` 改用常量与 `effectiveBudget`；`bestOf` 全灭分支追加 `（候选首错：<err>）` 与候选总数。
- `main.ts`：新增导出 `serviceFace(service)`（键 `list` / `get` / `errors` / `reload`），`apply()` 的 `provide("commandTemplate", …)` 改用它；`show` 输出新增 `budget: <budgetOrInfinity(this.#config)>`（不设预算时显示「不设预算（非正 / 非有限）」）+ 来源标注；`effectiveBudget` / `budgetOrInfinity` 经 `main.ts` 再导出。
- `steps.ts`（审阅后修订）：新增 `budgetOrInfinity(options)`——`effectiveBudget` 再经「非正 / 非有限 → 不设预算（`Infinity`）」归一，`runTemplate` 与 `show` 共用（`budgetMessage` 的 `used` 计算不受影响：不设预算时闸门不触发）。
- 测试（审阅后补强）：bestOf 用例改为**逐候选不同错误**（`boom-1/2/3`）并断言取首错；show 用例补 `totalTimeoutMs: 0` 与 `NaN` 两个边界；新增 `apply()` 级守卫用例（捕获 `provide` 内容断言键清单）。
- 文档：README 服务面段落写明守卫落点与断言内容；总预算条目补「预算可见性」；用例数 22 → 25。

## 测试与证据（2026-10-04）

- `command-template`：`npm run check` ✓、`npm test` **25 例全绿**（既有 22 + 新增 3，另强化 1 处既有断言）。
- 用例：① 既有 bestOf 用例加断言 `候选首错：boom-1`（逐候选不同错误）；② 新用例「服务面：键清单与 `SERVICE_FACE_METHODS` 同步 + 实现同名方法（守卫）」；③ 新用例「服务面：`apply()` 提供的对象键清单同步（守卫）」；④ 新用例「/playbook show 显示总预算生效值」（缺省 7200000 / 显式 1000 + 来源标注 / `maxSteps=2, stepTimeoutMs=500` → 1000 / `0` 与 `NaN` → 不设预算）。
- **反向验证（四处各一次，脚本式、未留痕）**：① 改 `候选首错` 为空串 → bestOf 用例红；② 删 show 的 budget 行 → 预算用例红；③ 服务面键改名 `list → listAll` → 守卫用例红；④ show 改回显示原值（不归一）→ 预算用例的 `0` / `NaN` 断言红；恢复后 25 例全绿。

## 子代理审阅

（决策后 / 收尾前各一轮，记录见下）

### 决策后（2026-10-04）

只读审阅（25 例前的 24 例全绿 + `check` 通过）。结论「需改」，一条实施性 + 三条小幅：

1. **[重要] show 显示的预算未走运行期归一**：`runTemplate` 把「非正 / 非有限 → `Infinity`（不设预算）」，而 `show` 直接打印原值 → `totalTimeoutMs: 0 / -1 / NaN` 时显示 `budget: 0 ms`，与实际生效值不符（与 README「生效值」及 `types.ts` 口径矛盾）。→ 抽 `budgetOrInfinity()` 两处共用；`show` 对不设预算显示「不设预算（非正 / 非有限）」；补 `0` / `NaN` 边界断言。
1. **[次要] bestOf 用例证不了「取首个」**：三个候选同抛 `boom`。→ 改逐候选不同错误（`boom-1/2/3`）并断言 `候选首错：boom-1`。
1. **[次要] README 用例数过期（22 → 现 25）、测试 import 未过 prettier**。→ 已更新计数并在收尾前跑 `format`。
1. **[提示] 守卫未覆盖 `apply()` 实际 provide 的内容**（回退成内联写错键不会红）。→ 新增 `apply()` 级守卫用例（捕获 `provide` 断言键清单）。

已核无问题：`StepFailure` 结构未变（全仓仅本包消费该文案）；`settled` 由有序 `Promise.all` 产生故「首错 = 首候选」成立；`#config` 与运行期 options 字段一一对应（唯一差异即上述归一）；`maxSteps` 超限早退顺序未变；diff 无越界。

### 收尾前（2026-10-04）

只读审阅（`check` ✓、25 例全绿）。结论「需修」，三条（均已处理）：

1. **[重要] `dist/` 产物过期**（构建停在改源码之前，不含 `budgetOrInfinity` / 候选首错 / 不设预算）→ 收尾前补 `npm run build`（`dist/` 已 gitignore，不影响提交内容）。
1. **[提示] README「共用 `effectiveBudget()` 一处口径」措辞不准**（实际共用 `budgetOrInfinity()`）→ 已改措辞并注明二者的层级关系。
1. **[提示] 追踪文档实现记录自相矛盾**（首条写 `effectiveBudget`、次条才修订）→ 已合并为一条口径。

两轮审阅的四条修复实测到位：`budgetOrInfinity` 被 `show` / `runTemplate` 共用且 `Infinity` 时 `budgetMessage` 永不触发；首错取自有序 `Promise.all` 且 `boom-1` 断言有效；README 用例数与实测一致、prettier / mdformat 干净；apply 级守卫键漂移可红；diff 仅计划内文件。

## 收尾

- 条目从 `command-template/docs/BACKLOG.md` 移除（三则同批完成，无新增后续条目）。
- 本追踪文档移入 `command-template/docs/archived/`；本次变更合并为一次提交（`steps.ts` + `main.ts` + 测试 + README + BACKLOG + 归档文档），提交见 git 历史。
- 复跑记录：`npm run check`（根，20 包）✓、`npm run build` ✓、`command-template` `npm test` **25 例** ✓。
