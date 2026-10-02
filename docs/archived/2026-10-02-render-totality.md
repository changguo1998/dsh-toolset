# 工具 `render` 的全函数性（接取条目：`docs/BACKLOG.md` #3）

状态：进行中　　开启：2026-10-02　　关闭：—
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 目标

`render` 只要求返回内容块数组；裸 `JSON.stringify(value, null, 2)` 在 `value === undefined` 时返回 **非字符串**（`undefined`），模型侧会拿到畸形块（`{type:"text", text: undefined}`）。`hash-edit` 已修（`jsonText()` 兜底）；本条把其余 **6 处**改成全函数：`code-map/src/index.ts:377`、`metric-loop/src/index.ts:414`、`rule-engine/src/tools.ts:106`、`session-channel/src/index.ts:1228/1286/1342`、`context-report/src/main.ts:520`（末者是三元分支的回退臂）。

## 调研（2026-10-02）

- 六处形态一致：`render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]`（`context-report` 为 `typeof value.text === "string" ? value.text : JSON.stringify(...)`）。
- 既有先例：`hash-edit/src/main.ts` 的 `jsonText(value)`（本仓 2026-10-02 条目引入）——字符串原样返回（避免二次编码）、其余 `JSON.stringify(value, null, 2)`、若 `undefined` 或抛错（循环引用 / BigInt）则回退 `String(value)`。**语义以它为准**（跨包不共享代码，各包自带同名小工具，与本仓既有多处小工具重复的风格一致）。
- **可达性（审阅后订正）**：宿主 `createSuccessResult` 在调 `render` **之前**先跑 `snapshotToolValue` → `snapshotJsonValue`，**根级 `undefined` 直接抛** `ToolOutputError: … value is not lossless JSON`；`render` 的返回值之后还要过同一守卫。故：① 生产态 `render` **收不到** `undefined`，症状是**响亮的工具调用硬失败**（`INVALID_TOOL_OUTPUT`）而非静默畸形块；② 本条清除的是**测试直调**可见的隐性契约违背（全函数不变量）+ 防御未来；③ 类型面另有一处不同频：宿主 `render(args, value: JsonValue)`（不含 `undefined`），本仓各包写 `value: unknown`，而 `JSON.stringify` 返回 `string | undefined` —— 这正是缺陷的可见性来源。
- 真实契约位置：宿主 `packages/core/tools/src/index.ts:213`（`render(args: unknown, value: JsonValue): ContentBlock[]`）；`docs/host/DSH-CTX-API.md` 里**没有** render 契约（原决策引用有误）。

## 决策

- **D1（语义）**：每处引入包内 `jsonText(value: unknown): string`：
  1. `typeof value === "string"` → 原样返回；
  1. 否则 `JSON.stringify(value, null, 2)`；结果为 `string` → 返回；
  1. 否则（`undefined` / 函数 / symbol / 循环引用 / BigInt 抛错）→ `String(value)`；`String` 仍抛（极罕见）→ `"（无法序列化的值）"`。
     `render` 的 `text` 类型因此**恒为 string**。注：`hash-edit` 先例是 3 行版（无 try/catch），本批 14 行版是**超集**（额外兜 try/catch + 文案），六份实现已分叉——口径以「全函数」为准，不追求逐字一致。
- **D2（落点与命名）**：**7 个包**各加自己的 `jsonText`（`code-map` / `metric-loop` / `rule-engine` / `session-channel` / `context-report` / **`task-engine`** / **`goal-contract`**——后两者是审阅发现的漏项，见下），放各包既有的工具辅助位置（就近 render 定义处）。不新建共享包的理由是**依赖边与 profile 配套的成本**（本仓已有 `link:../` 跨包先例，如 `code-map`→`ast-tools`，故原「`link:` 约束」说法不成立）。
- **D3（context-report 特例）**：`main.ts:520` 保留「`value.text` 是 string 就原样用」的分支，只把回退臂换成 `jsonText(value)`。
- **D4（测试，必须能杀掉「不修」变异体）**：每包加一条**契约测试**：取到该工具定义 → `render({}, undefined)` → 断言 `typeof blocks[0].text === "string"`（旧实现下为 `undefined`，断言必失败 → 有鉴别力）；再断言 `render({}, {a:1})` 走 JSON 分支、`render({}, "s")` 原样返回（session-channel / rule-engine 各自覆盖其全部工具注册点）。
- **D5（docs）**：无用户可见行为变化，各包 README 不必改；本追踪文档 + 项目级 BACKLOG 关闭即文档面。
- **D6（验证，订正）**：`npm run check` / `build` / `test`（全仓 + 受影响 7 包）；**dist 级探针覆盖全部 `render:` 现场**（7 包 18 个工具），逐个 `render({}, undefined)` 断言 `text` 是 string；对 `context-report` 追加 `render({},{text:"x"})` 走分支的断言。**注册入口不统一**：多数包走 `ctx.tools.register`，但 `rule-engine` 走 `ctx.get("tools")`（其可靠入口是导出的 `toToolDefs(engine)`）——探针需按包用法入口，不能单一 ctx 形状。

## 计划改动文件清单

- `code-map/src/index.ts`、`metric-loop/src/index.ts`、`rule-engine/src/tools.ts`、`session-channel/src/index.ts`、`context-report/src/main.ts`
- 各包对应测试文件（新增 render 契约用例；文件名按各包既有测试布局）
- `docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 实现记录

**7 个包**各加包内 `jsonText(value)`（14 行；语义见 D1）；**全部 18 个 `render:` 现场**改为 `jsonText(value)`：`code-map` 1、`metric-loop` 1、`rule-engine` 1（共享 `OUTPUT` 常量，覆盖 5 个工具）、`session-channel` **4**（BACKLOG 只列了 3，漏 `channel_task_result`；实际 4 处全改）、`context-report` 1（保留 `value.text` 字符串分支，只换回退臂）、**`task-engine` 1**（覆盖 5 个工具；审阅发现的漏项）、**`goal-contract` 1**（审阅发现的漏项）。`task-engine` 那句自称「SAFETY：`JSON.stringify` 不会抛」的注释一并改对（返回类型是 `string | undefined`，漏了「可能非字符串」这半）。

## 测试与证据（2026-10-02）

- 7 份测试各新增 render 契约用例（经 `apply` 取注册工具，**逐个**断言）：`code-map/tests/bundle.test.ts`、`metric-loop/tests/controller.test.ts`、`rule-engine/tests/main.test.ts`（5 注册点）、`session-channel/tests/apply.test.ts`（4 注册点）、`context-report/tests/main.test.ts`、`task-engine/tests/semantic.test.ts`（5 注册点）、`goal-contract/tests/tool.test.ts`；断言含 `typeof text === "string"`、对象走 JSON 分支、字符串原样、循环引用 / BigInt 兜底。
- **变异体鉴别力（逐个包实测）**：把 `jsonText(value)` 换回裸 `JSON.stringify(value)` → 该包新增用例**必失败**（`actual: 'undefined'` vs `expected: 'string'`）：code-map / metric-loop / rule-engine / session-channel / context-report / task-engine（82 pass / 1 fail）/ goal-contract（35 pass / 1 fail）全被杀死，还原后各自全绿。
- 命令与结论：7 包 `check` exit 0；7 包 `test` 全绿（code-map 22 / metric-loop 36 / rule-engine 84 / session-channel 46 / context-report 43 / task-engine 83 / goal-contract 36）；**全仓 `npm run test` 20 包全绿**、根 `check` / `build` exit 0；`grep "text: JSON.stringify"` 在 19 包 src 内**无残留**。
- dist 级探针：7 包 dist 加载 → 假 ctx 注册面 → **18 个工具**逐个 `render({}, undefined)` 断言 `text` 是 string（实得字符串 `"undefined"`），`context-report` 文本分支 `= "x"`，**0 违规**；`rule-engine` 需走其导出 `toToolDefs(engine)`（该包是 `ctx.get("tools")` 而非 `ctx.tools`）。

## 审阅（子代理，2026-10-02）——结论：**有条件通过**

| 审阅发现 | 处置 |
|---|---|
| 【P1 必修】漏 2 处同类缺陷：`task-engine/src/main.ts:885`（5 工具）、`goal-contract/src/tool.ts:288`（1 工具）仍裸 `JSON.stringify`，源码 + dist 探针实测 24 violations | 已补（见实现记录）；两包各加契约用例并做变异体实验 |
| 根基事实错：宿主 `createSuccessResult` 在 render **前**先跑 `snapshotJsonValue`，根级 `undefined` 直接抛 `ToolOutputError: value is not lossless JSON`；render 返回值再过一次守卫 → 生产态**收不到** `undefined`，症状是**硬失败**不是「静默畸形块」 | 追踪文档「可达性」段已重写（含类型不同频：宿主 `value: JsonValue` vs 本仓 `unknown`） |
| D2 理由错：本仓已有 `link:../` 跨包先例，「`link:` 约束」不成立 | 理由改为「依赖边 + profile 配套成本」 |
| D1「与 hash-edit 逐行一致」不实（先例 3 行无 try/catch；`Symbol` 实际不抛；真会抛的只有 null-prototype 对象且被宿主挡掉） | 文档改为「以先例为起点，本批为超集；六份实现已分叉，口径以全函数为准」 |
| `session-channel` 处数少算（3 → 4） | 已按 4 处落地（文档订正） |
| D6 引用的 `docs/host/DSH-CTX-API.md` 无 render 契约；探针入口不统一（`rule-engine` 走 `ctx.get("tools")`） | 文档换真实契约位置（宿主 `packages/core/tools/src/index.ts:213`）并写明入口差异 |

## 关闭记录

- 条目从项目级 `docs/BACKLOG.md` 清理；追踪文档移入 `docs/archived/`。
- 残余：① 真机 dsh 宿主接入未验（探针为 dist 结构面；宿主 materialize 截断路径未覆盖）；② `reportData.refEdges` 类 `undefined` 渲染在 md-map 已单独兜底（`?? 0`），不在本条范围；③ `docs/host/DSH-CTX-API.md` 缺 `output.render` 契约一节（审阅建议，属宿主面文档，另开条目）。
