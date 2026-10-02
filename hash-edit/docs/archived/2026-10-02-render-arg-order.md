# `render` 形参顺序修正（接取条目：`hash-edit/docs/BACKLOG.md` #1）

状态：进行中　　开启：2026-10-02　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`hash_read` / `hash_edit` 的**工具结果到不了模型**：`toDshTool` 把 `render` 写成单形参 `(value) => JSON.stringify(value)`，而宿主契约是 `render(args, value)`；宿主因此把**入参**当成 `value` 交给渲染 → 模型只看到入参回显（真机实测 `hash_read(path="tmp/hashread-probe.txt")` 返回 `{"path":"tmp/hashread-probe.txt"}`，无 `hashlines`），**LINE:HASH 锚点在模型侧永远拿不到**、锚定编辑链路实际不可用。

## 调研（2026-10-02）

- **宿主契约（一手证据）**：`@deepseek-ai/dsh-tools/lib/index.js:3548` → `rendered = tool.output.render(exec.arguments, value);` —— **args 第一、value 第二**。
- **本仓对照（审阅订正）**：除本包外共 **11 个包 15 处**工具面 render 实现（另有 2 处接口声明：`fs-digest/src/main.ts:42`、`rule-engine/src/tools.ts:22`）均为 `(args, value)` / `(_args, value)`（如 `task-engine/src/main.ts:566`、`code-map/src/index.ts:376`、`fs-digest/src/main.ts:42`）；`hash-edit/src/main.ts` 的接口声明（`:72`）与实现（`:88`）两处都写成了单形参。宿主 `dsh-tools/lib/index.js:3548` 的 `render(exec.arguments, value)` 是唯一权威依据。
- **后果**：`hash-edit/tests/` 只有纯函数测试（`edit` / `fs` / `hashline`），**没有任何工具面（render / 注册）用例**——所以这个 bug 一直没被测试拦下。
- 非宿主升级引入：0.1.7-rc.2 上同样复现（条目来源）。

## 决策

- **D1（修法）**：`DshTool.output.render` 的接口声明与 `toDshTool` 实现都改为 `(args: unknown, value: unknown) => ContentBlock[]`（`args` 不使用，命名 `_args`；与全仓 15 处同形）。**实现偏差（审阅后补记）**：D1 原计划只改形参，落地时因 D2 ④ 全函数用例失败，另加 `jsonText(value)` 兜底——`JSON.stringify(undefined, null, 2)` 返回 `undefined`（TS 类型却标称 `string`，编译期不提示），会让内容块 `text` 非字符串。
- **D2（契约测试，防回归）**：新增 `hash-edit/tests/tool.test.ts`——经 `apply({tools:{register}})` 注册后取工具定义，断言：① 形状（`name` / `parameters` / `output.schema.type === "object"` / `render` 是函数）；② `render(args, value)` 输出 `value` 的 JSON（对 `hash_read` 形状的样例值含 `hashlines`，且不含入参字段）；③ **形参顺序探针**——**原写法（照 `md-logic` / `md-map` 的 `assert.notEqual(render(args,value), render(value))`）经审阅实测无鉴别力**（变异回单形参仍通过），改为**哨兵式**：第一参传 value 形状、第二参传 `SENTINEL`，断言文本含哨兵且不含 `hashlines`（变异下必失败，已实测）；④ 渲染是全函数、对畸形值不抛、`text` 恒为字符串（该条迫使 D1 增加 `jsonText` 兜底）；⑤ 端到端（`hash_read` / `hash_edit` 两个面各一条）+ value 形状过 `output.schema`。
- **D3（dist 级真机形态证据；审阅订正）**：路径是 **`dist/src/main.js`**（本包 `package.json main`；`dist/index.js` 不存在）→ `apply` → 对真实文件跑 `hash_read.execute`，把真实结果交给 `output.render(args, value)` → 断言文本含 `hashlines`（原写的「含锚点 `行:哈希`」不成立：`line` / `hash` 是分列字段）。**降级说明**：dist 级断言未进测试套件（`npm run test` 不保证先 build），改为「src 级第 ⑤ 条 + 一次性 dist 探针」；据此不再把「dist 级用例」记作承诺。
- **D4（范围）**：同一适配器覆盖两个工具（`hash_read` / `hash_edit`），一次修好；不动 `hashline` / `fs` / `edit` 逻辑；不改工具描述与参数 schema；不新增导出（测试走 `apply` 注册面，不额外暴露 `toDshTool`）。
- **D5（文档）**：`hash-edit/README.md` 若有渲染/输出口径行则同步（无则不动）；追踪文档记证据。

## 计划改动文件清单

- `hash-edit/src/main.ts`（接口声明 + 实现，2 处）
- `hash-edit/tests/tool.test.ts`（新增：形状 / 顺序 / 全函数）
- `hash-edit/docs/BACKLOG.md`（开工标「进行中」→ 关闭时清理）、本追踪文档
- `hash-edit/README.md`（仅在确有必要时同步）

## 实现记录

| 文件 | 改动 |
|---|---|
| `hash-edit/src/main.ts` | ① `DshTool.output.render` 的接口声明与 `toDshTool` 实现都改为 `(args, value)`（`args` 命名 `_args`，不用）；② 抽出 `jsonText(value)`：`JSON.stringify` 对 `undefined` / 函数返回 `undefined` 时退化为 `String(value)`——**render 必须全函数**（自测顺手抓到：`value === undefined` 时文本块 `text` 会是 `undefined`，宿主拿到非字符串块） |
| `hash-edit/tests/tool.test.ts`（新） | 5 例：注册形状（两工具 + `schema.type === "object"` + `render` 是函数）；`render(args, value)` 渲染的是 **value**（含 `hashlines` / 锚点哈希，且不含入参字段）；**形参顺序探针**（把 `value` 当第一参必须得不到同一文本）；全函数（6 种畸形值不抛、`text` 恒为字符串）；工具面端到端（真读临时文件 → 渲染文本含 `"line": 1` 与 `"text": "alpha"`） |

## 测试与证据（2026-10-02）

- 包内：`npm run check` exit 0、`build` 通过、`npm run test` **48 例全绿**（改前 43 例）。
- **dist 级真机形态核对**（加载 `hash-edit/dist/src/main.js` → `apply` 注册 → 对真实文件跑 `hash_read.execute` → 真实结果交 `output.render(args, value)`）：
  ```
  { "ok": true, "path": "/tmp/…/a.txt", "file_hash": "4fdbc441…", "line_count": 3, "hashlines": [ { …
  含 hashlines: true | 含入参回显字段 offset: false
  ```
  即条目里真机症状（`{"path":"tmp/hashread-probe.txt"}` 无 `hashlines`）的**逆** ✓——锚点现在能到模型侧。
- 全仓：`npm run check` / `build` / `test` 见关闭前复跑。
- **顺带发现（不在本条目改）**：同款「非全函数 render」模式在其它包仍存在——`code-map/src/index.ts:377`、`metric-loop/src/index.ts:414`、`rule-engine/src/tools.ts:106`、`session-channel/src/index.ts:1228/1286/1342`、`context-report/src/main.ts:520` 都是裸 `JSON.stringify(value, null, 2)`（`value` 为 `undefined` 时文本块 `text` 非字符串）。已按流程记 BACKLOG 条目（项目级）交后续处理。

## 审阅（子代理，2026-10-02，决策 + 并行落地实现一并审）

**结论：有条件通过**（修复本身正确可用：48/48 → 现已 50/50、check exit 0、dist 已重建）→ 4 处文档事实错误 + 1 条决策实测不成立 + 7 项漏项，全部处置：

| 审阅发现 | 处置 |
|---|---|
| 【中】D2 ③「形参顺序探针」**无鉴别力**（变异回单形参仍通过；`md-map` / `md-logic` / `ast-tools` 同款断言同样无鉴别力） | 改为**哨兵式**探针（第一参 value 形状、第二参 `SENTINEL`；断言含哨兵且不含 `hashlines`）；**变异实验复验**：改回单形参 → 该用例 ✖（连同 value 断言与两条 e2e 共 4 例失败），正确实现 → ✓。三个参照包的探针已记项目级 BACKLOG #4 |
| 【低】D2 ④ 迫使实现超出 D1 计划（`jsonText` 兜底），文档未记 | D1 补「实现偏差」；`jsonText` 写入实现记录 |
| 【低】证据行号/计数不符：`task-engine:506`→**566**、`fs-digest:41`→**42**、「其余 12 处」→**11 包 15 处**（+2 接口声明） | 调研节按当前工作区订正 |
| 【中】D3 路径与断言口径错：`dist/index.js` 不存在（应 `dist/src/main.js`）、「行:哈希」不成立（`line`/`hash` 分列） | D3 订正 + 降级说明（dist 断言不进套件，改 src 级 + 一次性探针） |
| 【中】`execute(args)` 丢弃宿主 `exec` → 相对路径拿不到会话 cwd（属缺陷、不属本条） | 记一行 + 模块 BACKLOG #2（含审阅建议措辞与契约证据） |
| 【漏项】README 测试段「43 例」过期、缺渲染口径 | README 改 **50 例**（含 `tool`）+ 补渲染口径（`render(args, value)` 渲染 value；`undefined` 退化 `String`） |
| 【漏项】BACKLOG 原文参照「task-engine 的 render 用例」不存在（task-engine 无 render 用例） | 本条目关闭即移除该错误参照；跟踪记录写明 |
| 【漏项】`docs/STATUS.md:31` 记「43 单测」将过期 | 按约定不改，收尾提醒用户（项目级 #2 覆盖） |
| 【漏项】`hash-edit/docs/DESIGN.md` 不存在 | README 作契约唯一落点（不新建 DESIGN，记为裁定） |

## 关闭记录

- 条目从 `hash-edit/docs/BACKLOG.md` 清理；模块 BACKLOG 新增 #2（相对路径基准拿不到会话 cwd）；项目级 BACKLOG 新增 #3（工具 render 全函数性：其余 6 处裸 `JSON.stringify`）与 #4（探针鉴别力：`md-map` / `md-logic` / `ast-tools`）。
- **残余**：① 会话内生效需重启 TUI（`dist` 已重建，包已在 fff 挂载）；② `docs/STATUS.md:31`「43 单测」待用户择时更新（本次后为 50）；③ 模块 BACKLOG #2；项目级 #3 / #4。
- 本追踪文档移入 `hash-edit/docs/archived/`。
