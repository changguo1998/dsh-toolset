# 工具面「形参顺序探针」鉴别力（接取条目：`docs/BACKLOG.md` #3）

状态：进行中　　开启：2026-10-02　　关闭：—
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 目标

`md-map/tests/tool.test.ts`、`md-logic/tests/tool.test.ts`、`ast-tools/tests/tool.test.ts` 里的
`assert.notEqual(render(args, value), render(value)[0]?.text)` 这类探针**无鉴别力**：把 `render` 变异回单形参（`render(value)`）时它照样通过（两种实现下两个文本本来就不同）→ 挡不住「`render` 形参写反 / 少参」这类回归。要换成有鉴别力的哨兵探针，并做变异验证。

## 调研（2026-10-02）

- 宿主契约：`render(args, value)`（**args 在前**）——`dsh-tools/lib/index.js:3548`、`:3310`（`execute(exec.arguments, exec)`）；本仓证据见 `hash-edit/docs/archived/2026-10-02-render-arg-order.md`。
- 有鉴别力的先例（`hash-edit/tests/tool.test.ts`，已做变异验证）：**第一参传 value 形状的值、第二参传哨兵字符串**，断言渲染文本**含哨兵**且**不含**第一参的特征文本。原理：若 `render` 把形参写反（把 args 当 value / 少一个参数），哨兵不可能出现在文本里 → 断言必失败；而旧探针比较的两个文本在两种实现下都不同，故无鉴别力。
- 三处现场形态相同（各包 `tool.test.ts` 的一条 render 用例）。

## 决策

- **D1（探针形态，实现期订正）**：三包的 `render` 实现都是 `(_args, value)` —— **args 不参与输出**，故哨兵必须放**第二参（value 位）**；第一参用 args 形状并带一个「不该被渲染」的标记，断言它**不**出现。订正后的形态：
  - `const sentinel = "SENTINEL_VALUE_MARKER";`（放 **value 位**，即第二参）
  - `const argsLike = { probe: "ARGS_MARKER_NOT_RENDERED" };`（放 **args 位**，即第一参）
  - 取该包工具定义的 `output.render(argsLike, { tag: sentinel })` → 断言 `typeof text === "string"`、`text.includes("SENTINEL_VALUE_MARKER")`、`!text.includes("ARGS_MARKER_NOT_RENDERED")`。
  - 语义：**第一参是 args、第二参是 value**；value 位的哨兵必须出现在文本里（形参写反 / 单形参时不可能出现），args 位的标记不该被渲染（这三包的 render 本就与 args 无关——Args 位断言只防「把 args 当 value 渲染」的写反形态）。
  - 订正理由（实测）：三包 render 都忽略 args，若按原 D1 把哨兵放第一参，**正确实现也恒为红**（args 不出现在输出里）——这会引入恒失败断言，比原弱探针更糟。
- **D2（变异验证，逐包做）**：临时把该包 `render` 实现改成**单形参**（`(value) => [{type:"text", text: jsonText(value)}]`，即形参写反/少参的等价形态）→ 该包新探针**必须失败**；还原后全绿。把两态结论写进追踪文档。
- **D3（范围）**：只改这 3 份测试文件的对应用例；**不动**各包的 `render` 实现（它们是对的）；不改其它包（`hash-edit` 已是哨兵式）。
- **D4（文档）**：不改 README（测试内部质量）；追踪文档 + BACKLOG 关闭即文档面。
- **D5（验证）**：三包 `npm run check` / `test`；全仓 `npm run check` / `test`（探针是测试代码，不涉 dist，故不要求 build 证据，但跑一次根 `build` 确认无碍）。

## 计划改动文件清单

- `md-map/tests/tool.test.ts`、`md-logic/tests/tool.test.ts`、`ast-tools/tests/tool.test.ts`
- `docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 实现记录（落地形态）

三份测试的对应用例改成哨兵探针，形态（**与 D1 订正一致**）：哨兵 `SENTINEL_VALUE_MARKER` 嵌在**包内 value 形状的可回显字段**里（md-map `orphans[]`、md-logic `links[].href`、ast-tools `files[].path` / `matches[].file`）；第一参（args）用**同形**结构 + `ARGS_MARKER_NOT_RENDERED`，断言文本**含哨兵**且**不含** args 标记。ast-tools 用 `[query, replace]` 循环 + 各自 value 形状（`ast_replace` 的渲染读 `matches`）覆盖**两个** render。三包 `src/` 逐字节未变。

## 测试与证据（2026-10-02）

- **旧探针无鉴别力（实测）**：把 HEAD 版测试文件与「单形参」变异实现组合跑 → 三包旧断言**仍通过**；历史形态 M3（`(v)=>JSON.stringify(v)`）下同样通过。
- **新探针鉴别力（实测）**：正确实现 → md-map 42/42、md-logic 45/45、ast-tools 38/38 全绿；变异（`render: (_args, value)` → `(value)`，函数体不动）→ md-map **38 pass / 4 fail**（目标用例 `AssertionError: 渲染的必须是第二参（value）`）、md-logic 39/6 fail、ast-tools 33/5 fail；还原后三包全绿（md5 基线对照 + `git diff -- src` 为空）。
- **审阅二次修正后的复验**：args 标记从「渲染器不读的 `path` 字段」改到**可回显字段**后，负断言才有牙（原形态下变异态文本 `(无孤儿文档)`/`(无链接)`/`(空结果：outline)` 不含标记 → 恒真）；ast-tools 扩到 `query` + `replace` 双工具后复跑全绿。
- 命令：三包 `check` / `test` exit 0；全仓 `npm run check` exit 0、`npm run test` 20/20 包 OK（2115 例）、`npm run build` exit 0；`git diff --name-only | grep src/` = **0**（无变异残留）。

## 审阅（子代理，2026-10-02）——结论：**有条件通过** → 4 项全部处置

| 审阅发现 | 处置 |
|---|---|
| 【中】D1 原示例（哨兵放第一参）在正确实现下**恒红**（三包 render 都是 `(_args, value)`，args 不参与输出：`md-map/src/tools.ts:183`、`md-logic/src/tools.ts:350`、`ast-tools/src/tools.ts:321/443`） | 决策文档已改：哨兵放 **value 位**、args 位放不该被渲染的标记；示例改成包内可回显形状 |
| 【中】第二条负断言三包**无鉴别力**（args 标记放在渲染器不读的 `path` 字段，变异态仍为真） | 已改：args 与 value **同形**、标记放可回显字段；md-map 变异复验 4 fail、还原全绿 |
| 【低】`ast_replace` 的 render 未覆盖 | 已改：`[query, replace]` 循环 + 各自 value 形状 |
| 【低】D2 术语（`jsonText` 是 hash-edit 专有）；D5 缺防变异残留守卫与可复现记录；严重性表述偏强 | 变异口径改为「删第一形参」；证据与命令已写进本文档；表述改为「旧探针无鉴别力、套件靠内容断言偶然拦截、新探针价值 = 精准指向形参顺序 + 失败信息可读」；`git diff --name-only | grep src/` = 0 作为提交前守卫 |
| 漏项：其余 12 包 18 处 `render:` 无顺序探针（多数只调 `render({}, value)`） | 记入项目级 BACKLOG 新条目（观察项，附 hash-edit 曾因此真出 bug 的教训） |

## 关闭记录

- 条目（`docs/BACKLOG.md`）清理；追踪文档移入 `docs/archived/`。
- 残余：① 其余包的 render 顺序探针未补（新条目）；② 三包测试未跑 `format`（会引入 30+ 行无关重排，新增块本身已是 prettier 规范形态，已手查）；③ 真机宿主未验（探针为测试域契约）。
