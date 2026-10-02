# 其余包的 `render` 形参顺序探针（接取条目：`docs/BACKLOG.md` #3）

状态：进行中　　开启：2026-10-02　　关闭：—
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 目标

`md-map` / `md-logic` / `ast-tools` 三包已有**有鉴别力**的哨兵探针（模板：`md-map/tests/tool.test.ts`）；`hash-edit` 是先例。其余有模型工具的包多数只调 `render({}, value)`，**挡不住「形参写反 / 少参」**。本条给其余包各补一条最小哨兵探针。

## 调研（2026-10-02）

- 探针形态（模板，已实测有鉴别力）：**哨兵放 value 位**（嵌在该包渲染器**会回显**的字段里）、args 位放**同形**标记 `ARGS_MARKER_NOT_RENDERED`；断言 ① `typeof text === "string"`、② `text.includes("SENTINEL_VALUE_MARKER")`、③ `!text.includes("ARGS_MARKER_NOT_RENDERED")`。原理：形参写反 / 单形参时渲染器拿到 args → 无哨兵 → ②必失败；③有牙的前提是 args 标记确实会被回显（放 `path` 这类不读的字段会变死断言——上一轮的教训）。
- 待覆盖包（实现时 grep `render` 枚举确认）：`code-map`、`metric-loop`、`rule-engine`、`session-channel`、`context-report`、`task-engine`、`goal-contract` 等有 `tools.register` 的包；`hash-edit`（已有）、`md-map` / `md-logic` / `ast-tools`（已完成）跳过。
- 无模型工具的包（TUI 辅助包等）不涉及。

## 决策

- **D1（逐包探针）**：每个有 render 的包，在其**既有测试文件**里追加一条用例：经该包既有注册入口取工具定义（多数 `apply` + 假 ctx 的 `tools.register`；`rule-engine` 走导出的 `toToolDefs(engine)`），对该包**全部**注册工具逐个断言上述三条；value 形状用各包渲染器**会回显**的最小结构（实现时按各包 render 代码确认字段）。
- **D2（args 标记有牙）**：args 用与 value **同形**结构、标记放在同一可回显字段，保证 ③ 真有鉴别力（若某包渲染器完全不回显任何字段，则只保留 ①② 并在注释说明理由）。
- **D3（鉴别力自证）**：逐包做变异验证——把 `render` 改成单形参（删第一形参、函数体不动）→ 该包新用例**必失败**；还原后全绿。记录两态结论。
- **D4（不做）**：不改任何 `src/` 实现（本轮只加测试）；不引共享 helper（跨包依赖成本）；不动已完成的三包与 `hash-edit`。
- **D5（验证）**：受影响包各自 `check` / `test`；全仓 `check` / `test` / `build`；提交前 `git diff --name-only` 只允许测试文件 + 文档（防变异残留）。
- **D6（文档）**：无用户可见变化，各包 README 不改；追踪文档 + 条目关闭即文档面。

## 计划改动文件清单

- 各待覆盖包的**既有测试文件**（每包 1 条用例）
- `docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 实现记录（8 包 19 工具）

| 包 | 用例位置 | value 形状（可回显字段） | 覆盖工具 |
|---|---|---|---|
| code-map | `tests/bundle.test.ts` | `{ marker: S }`（jsonText 整值回显） | 1 |
| metric-loop | `tests/controller.test.ts` | 同上 | 1 |
| rule-engine | `tests/main.test.ts` | 同上（经导出 `toToolDefs(engine)`） | 5 |
| session-channel | `tests/apply.test.ts` | 同上（`apply(host, {disabled:true})`） | 4 |
| context-report | `tests/main.test.ts` | `{ text: S }`（直通分支）+ `{ marker: S }`（JSON 分支） | 1 |
| task-engine | `tests/semantic.test.ts` | `{ marker: S }` | 5 |
| goal-contract | `tests/tool.test.ts` | 同上（`createGoalContractTool`） | 1 |
| fs-digest | `tests/digest.test.ts` | `{ ok:false, error:S, message:"m" }` + `{ ok:true, mode:"pruned", text:S }` | 1 |

三条断言齐全（`typeof text === "string"` / 含 `SENTINEL_VALUE_MARKER` / 不含 `ARGS_MARKER_NOT_RENDERED`）；无包降级为只留 ①②。

## 变异验证与证据（2026-10-02）

- **逐包变异（删第一形参、函数体不动）**：8 包新用例**全部必失败**（失败断言一律为②「渲染的必须是第二参（value）」，actual false / expected true）；共突变 **11 处 render 站点**（session-channel 4 处、rule-engine / task-engine 各 1 处共享 render 覆盖 5 工具）。
- **③ 也有牙的取证**：突变态下 19 个工具渲染文本 `hasSentinel=false`、`hasArgsMarker=true`（如 `code_map` 得 `{"marker":"ARGS_MARKER_NOT_RENDERED"}`）。
- 还原后 8 包 check/test 全绿，`git diff --name-only | grep src/` **为空**（无变异残留）。
- 用例数（before→after，均 fail 0）：code-map 22→23、metric-loop 36→37、rule-engine 84→85、session-channel 46→47、context-report 43→44、task-engine 83→84、goal-contract 36→37、fs-digest 61→62。
- 全仓：`npm run check` exit 0、`npm run build` exit 0、`npm run test` **20/20 包 fail 0**。

## 审阅（子代理，2026-10-02）——结论：**有条件通过** → 处置

| 审阅发现 | 处置 |
|---|---|
| 【中】清单漏 `fs-digest`（`src/main.ts:197`，测试只调 `render({}, result)`） | 已补第 8 包探针（合法形状：失败 / pruned 两组），审阅已实测其有鉴别力 |
| 【中】D1 未写「各包最小 ctx/config 集」：`session-channel` 必须 `{disabled:true}`（否则持续重连持句柄）、`rule-engine`/`metric-loop` 需临时 `stateDir`、`context-report` 走导出工厂 | 实现已按此落地；本文档已记录 |
| 【低】D2 退路逻辑不成立（不回显时 ② 必失败，只剩无鉴别力的 ①） | 订正：该情形应**记条目、不加探针**；本轮 8 包都能回显，未触发 |
| 【低】D3 两态结论未回写 | 已回写（见上「变异验证与证据」） |
| 漏项：排除项未说明 | 记：`security-guard`（inject tools 但无工具定义，只挂 tool/pre-execute）、`output-compress`（`renderSummaryRecord` 只在 hook 面）、`TUI`（renderer API，非工具面） |
| 漏项：`fs-digest` 的 `render` **不是全函数**（`render({}, undefined)` 抛 TypeError、`{ok:true,mode:"outline"}` 抛 "list is not iterable"） | 本轮不改 src（D4）→ 已开 `fs-digest/docs/BACKLOG.md` 条目 |

## 关闭记录

- 条目从项目级 `docs/BACKLOG.md` 清理；追踪文档移入 `docs/archived/`。
- 残余：① 真机未验（测试域探针）；② `fs-digest` render 全函数性（新模块条目）；③ 探针只覆盖「形参顺序」，不覆盖「args 语义」（args 位标记仅验证「不该被渲染的 args 没被渲染」）。
