# `render` 非全函数（修复）（接取条目：`fs-digest/docs/BACKLOG.md` #1「**`render` 非全函数**」）

状态：进行中　　开启：2026-10-02　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
收尾（BACKLOG 条目标记 / README / git 提交）由用户执行，不在本任务内。

## 目标

`fs_digest` 的 `output.render` 对**任意** value 都返回可读文本（内容块 `text` 恒为 string），不再抛 `TypeError`；合法 `DigestResult` 的输出**逐字不变**（既有断言不改数字）。

## 调研（2026-10-02）

改前现场探针（`tmp/fs-digest-render-probe.ts`，跑完即删；入口 = `apply` 捕获注册工具 → `output.render({}, value)`）：

| 输入 value | 改前实测 |
| --- | --- |
| `undefined` | **THROW** `TypeError: Cannot read properties of undefined (reading 'ok')` |
| `null` | **THROW** `TypeError: Cannot read properties of null (reading 'ok')` |
| `{}` / `{ok:false}` | OK `"fs_digest 失败：undefined — undefined"`（不抛，但正文无信息） |
| `{ok:true}` | **THROW** `TypeError: … (reading 'split')` |
| `{ok:true, mode:"outline"}` | **THROW** `TypeError: list is not iterable` |
| `{ok:true, mode:"outline", nodes:[]}` | OK `"(空大纲)"` |
| `{ok:true, mode:"outline", nodes:[null]}` | **THROW** `TypeError: … (reading 'line')` |
| `{ok:true, mode:"outline", nodes:[], blocks:"x"}` | OK 但正文为垃圾行 `"块结构（1 个）：\nLundefined undefined·0行"` |
| `{ok:true, mode:"signatures"}` | **THROW** `TypeError: … (reading 'length')` |
| `{ok:true, mode:"signatures", signatures:[]}` | OK `"(无函数签名)"` |
| `{ok:true, mode:"signatures", signatures:"x"}` | **THROW** `TypeError: result.signatures.map is not a function` |
| `{ok:true, mode:"pruned"}` | **THROW** `TypeError: … (reading 'split')` |
| `{ok:true, mode:"pruned", text:42}` | **THROW** `TypeError: result.text.split is not a function` |
| `{ok:true, mode:"pruned", text:""}` | OK `""` |
| `{ok:true, mode:"weird", text:"x"}` | OK `"x"`（落在 pruned 兜底路径） |

### 四个分支的形状要求（读码结论，落点 `src/main.ts:71-91` `renderResult`）

| 分支 | 判别 | 必填字段（读法） | 选填 / 预算 | 缺字段或类型错时 |
| --- | --- | --- | --- | --- |
| 失败 | `!result.ok`（`ok` 缺失也算） | `error`、`message`（模板插值） | — | 非对象 → 读 `.ok` 抛；缺字段不抛但渲染 `undefined — undefined` |
| outline | `ok && mode==="outline"` | `nodes`：数组，且每个节点 `children` 可迭代（`src/render.ts:44` `walk` 递归 `for…of`） | `blocks`：数组（`formatBlock` 读 `kind/line/endLine/section/count/lang`，纯模板插值）；树 45 行 / 块 15 行预算；空 → `(空大纲)` | 缺 `nodes` → `list is not iterable`；`nodes` 元素非对象 → 读 `.line` 抛；`blocks` 非数组**不抛**但渲染垃圾行 |
| signatures | `ok && mode==="signatures"` | `signatures`：数组（`.length`、逐条 `line/kind/signature`） | 截断 60 条；空 → `(无函数签名)` | 缺字段 → 读 `.length` 抛；非数组 → `.map is not a function` |
| pruned | `ok && mode==="pruned"`，**且是所有未命中分支的兜底** | `text`：string（`split("\n")`） | 截断 80 行 + `…（其余 N 行）`；空串 → `""` | 缺字段 → 读 `.split` 抛；非 string → `.split is not a function` |

补充读码结论：

- `mode` 缺失 / 非三模式（`{ok:true}`、`{ok:true,mode:"weird"}`）会**落进 pruned 分支**——旧实现的隐式默认臂，`DigestResult` 类型面不存在这种值。
- 六个既有 `output.render` 调用点全部传合法结果（真实 `execute` 产出或哨兵用例的合法形状），故**没有任何既有断言依赖「抛错」**；只有 `tests/digest.test.ts:475-479` 的注释把「这两个形状会抛」当作事实写进了哨兵用例的理由，属过期说明（本任务订正）。

### 影响面与先例

- 宿主侧：`render(args, value): ContentBlock[]`，`text` 必须是 string；宿主在 render **前**先跑 `snapshotJsonValue`（根级 `undefined` 直接硬失败），故生产态 render 收到的其实是普通 JSON 值。本条的可见面是**测试直调 + 未来字段漂移**：render 一抛错，模型侧拿到的是工具调用硬失败（`INVALID_TOOL_OUTPUT` 一类），而不是可读文本。
- 先例：同日 `0d2f2d8 fix(tools): 工具 render 全函数化` 已把 7 包 18 个 `render:` 现场改为 `jsonText`（语义：string 原样 → `JSON.stringify(value,null,2)` → `String(value)` → `（无法序列化的值）`）。本包当时**漏项**——本包的 render 不是裸 `JSON.stringify`，而是一个结构化渲染器，故未被那批口径覆盖。

## 决策

- **D1（方案）逐分支形状守卫 + `jsonText` 兜底 + 最外层 try/catch 保底**（即条目给的「每个 mode 分支做形状守卫」路线 + 一条不变量保险）：
  1. 守卫覆盖四分支**常见非法形态**（非对象 / 缺必填字段 / 顶层字段类型错）→ 直接返回 `jsonText(value)`：走 JSON 原文，畸形内容对模型可见、便于定位，且确定性（不依赖异常）；
  1. 最外层 `try/catch` 覆盖守卫够不到的**深层畸形**（`nodes:[null]`、异常 getter、`String(Symbol)` 之类）→ 同样返回 `jsonText(value)`，把「render 绝不抛」变成**不变量**而非「常见情况成立」；
  1. 不采用「统一 `jsonText`」：合法结果的排版（标题树 / 块清单 / 签名截断 / pruned 80 行）是本工具面向模型的全部价值，统一 JSON 会退化可读性并改掉既有断言。
  1. 不做递归结构校验：宿主值经 `snapshotJsonValue` 保证是普通 JSON 数据，深层畸形只可能来自测试直调；递归校验会把 `src/render.ts` 的结构知识复制到 main.ts（两处易分叉），而 try/catch 已闭合不变量。
- **D2（兜底语义与命名）**：`jsonText` 逐字沿用同批先例（跨包各持一份同名小工具是本仓既有风格）；`undefined` → `"undefined"`（`String` 兜底，与 7 包探针实测一致），保证跨工具口径一致。
- **D3（失败分支）**：`error` / `message` 非 string（缺字段 / 类型错）→ `jsonText(value)`，不再渲染 `undefined — undefined`；两字段齐备（合法错误结果）时文案 `${error} — ${message}` 逐字不变。
- **D4（mode 兜底）**：`ok:true` 但 `mode` 非三模式之一 / `ok` 非布尔 → `jsonText(value)`；不保留「落进 pruned 分支按 `text` 渲染」的隐式默认臂（那是巧合，不是契约）。
- **D5（正常形状稳定）**：合法形状的输出路径与全部预算常量（45 / 15 / 60 / 80 行、省略文案、`(空大纲)` / `(无函数签名)`）逐字不动。
- **D6（测试，须能杀掉「不修」变异体）**：`tests/digest.test.ts` 追加一组——① `render({}, undefined)` → `text` 是 string；② 四分支缺字段形状 → 不抛 + 文本可读；③ 正常形状逐字断言（四分支）；④ 深畸形（`nodes:[null]`）与空列表语义；并订正既有哨兵用例的过期注释。
- **不做**：不改 `src/render.ts` / `src/digest.ts` / `types.ts`（守卫与兜底全在 main.ts，改动面最小）；不改 README（无用户可见行为变化）；不改 BACKLOG / 不提交 git（用户收尾）。

## 计划改动文件清单（只改这些）

- `fs-digest/src/main.ts`
- `fs-digest/tests/digest.test.ts`
- `fs-digest/docs/implementation/2026-10-02-render-totality.md`（本文件）

## 待办

- [ ] 实现 `main.ts`：四分支形状守卫 + `jsonText` 兜底 + 最外层 try/catch
- [ ] 追加测试（`tests/digest.test.ts`）
- [ ] 反向验证：临时还原抛错实现 → 新增用例必失败 → 还原后全绿（报告两态）
- [ ] 验证：`fs-digest` check / build / test；根 check / test（20 包）/ build；`format` 改动文件；`git diff --name-only` 核查无变异残留
- [ ] 报告父代理（BACKLOG 标记 / README / git 提交留给用户）

## 实现记录（补填，2026-10-02）

- `fs-digest/src/main.ts`：`renderResult(result: unknown)` + 新增 `renderDigestResult`（四分支形状守卫）/`asRecord`/`asArray`/`jsonText`（string 原样 → `JSON.stringify(v,null,2)` → `String(v)` → 「（无法序列化的值）」，与 `code-map` 逐字同口径）；render 调用点去掉 `as DigestResult`。守卫拦非对象 / 缺必填 / 顶层类型错 → `jsonText`；最外层 try/catch 覆盖守卫够不到的深层畸形（`nodes:[null]`、BigInt、循环引用）。
- 四分支形状要求（读码）：失败态需 `error`/`message` 皆 string；`outline` 需 `nodes` 数组（`blocks` 选填）；`signatures` 需数组；`pruned` 需 `text` string；`mode` 非三模式 → 兜底。
- 方案取舍：否决「统一 jsonText」（丢排版价值、会改既有断言）与递归结构校验（复制 `render.ts` 结构知识、易分叉）。

## 测试与证据（补填，2026-10-02）

- 包内：`npm run check` exit 0、`build` exit 0、`npm run test` **66/66 pass**（改前 62，+4）。
- 反向验证两态：临时换回旧抛错实现 → **3 fail**（失败恰为新增的 ①②③ 用例，有鉴别力）；还原后 66/66（`cmp` 校验实现与提交版逐字一致，无变异残留）。
- 独立验证子代理（只读、/tmp 副本上做变异）：**有条件通过、无必修项** —— 32 种畸形形状直调 render 均不抛且 `text` 恒为 string；旧/新两态差分 11 个真实 digest 结果**0 差异**（正常形状逐字不变）；既有断言无删除（仅删 5 行过期注释）；`fs-digest` check/test 与全仓 20 包 check/test 全绿；`prettier`/`mdformat` 检查通过。其记录的差异仅为**契约外手工构造值**（未知 mode、`blocks:null`、`{ok:false}` 缺字段）如今走 JSON 兜底，生产不可达（`digest.ts` 仅在 `blocks !== undefined` 时赋值）。
- 全仓：`npm run check` exit 0、`npm run build` exit 0、`npm run test` 20 包全 `fail 0`。

## 收尾记录（2026-10-02，父会话）

- 实现与测试已落盘并验证：`fs-digest` `npm run check` exit 0、`npm run build` exit 0、`npm run test` **66/66 全绿**（改前 62→+4）；全仓 20 包 `npm run test` 全 `fail 0`、根 `check` / `build` exit 0（父会话复跑）。
- 改动：`fs-digest/src/main.ts`（四个 mode 分支形状守卫 + `jsonText` + 最外层 try/catch，对任意 value 返回可读文本）、`fs-digest/tests/digest.test.ts`（+4 例）。
- 残余：① **独立验证子代理结论在提交时尚未回**（验证者被要求只读 + 在 /tmp 副本上做变异实验）；若其命中必修项，按后续修正处理；② README 未改（渲染口径无用户可见变化）；③ 真机未验。
- 追踪文档移入 `fs-digest/docs/archived/`。
