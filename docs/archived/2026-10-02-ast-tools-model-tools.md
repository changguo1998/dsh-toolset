# `ast-tools` 注册模型侧工具（接取条目：`docs/BACKLOG.md`「`ast-tools` 注册模型侧工具（把语法级结构归纳交到模型手上）」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`ast-tools` 目前只有库 / 服务面（`searchAst` / `replaceAst` / `outlineFile` / `runRules`），**不注册模型侧工具**，模型够不着语法级查询（「所有 `foo(` 调用点」「某 AST 形态」），只能经 `code-map` 间接用。本条把四操作交给模型：查询类合成**单工具 + action 分派**（与 `code_map` 同风格），改写类**独立且默认 dry-run**。

不做：不新增 ast-grep 子命令封装（只用现有四操作）、不改库 API 签名、不加新配置项、不做「把 ast-grep 用法教给模型」的提示词工程。

## 现状（2026-10-02 读码 + 实测）

- `ast-tools/src/index.ts`：`export const name` + `BundleHost{logger?}` + `AstToolsConfig{bin?,timeoutMs?}` + `createAstToolsBundle()`（`{bin, search, replace, outline, rules, dispose}`）+ `apply()`。**无 `inject`**（第 5 行注释明说），`apply` 只探二进制 + 记一行日志——即当前挂载等于「不接任何模型面」。
- 库面参数（`src/types.ts`）：`SearchParams{pattern,language,path,strictness?}`、`ReplaceParams{+replacement,write?}`、`OutlineParams{path,language?,items?,types?}`、`RunRulesParams{rule: file|inline, paths[], includeMetadata?, minSeverity?}`；坐标 **0 基**（`AstPos` 注释与 search 测试断言）。
- 二进制：`ensureAstGrepBin()` 缺失时抛 `AstGrepMissingError`（含 `INSTALL_GUIDANCE`），`apply` 捕获后**降级禁用**（不抛）。本机实测 ast-grep **0.45.3 已装**（`fnm` shim）。
- 测试：`tests/helpers.ts` 的 `astTest` = 「有二进制才跑，否则 skip」，`binary.test.ts` 专门覆盖缺失降级路径（无需二进制）。
- 参照实现：`code-map/src/index.ts:310 toToolDef()`（单工具 + action 分派 + `tool.output.render`），`code-map` 用 `export const inject = ["tools"]`。

## 决策

- **D1（工具面形态）**：两个模型侧工具：
  - **`ast_query`**：单工具 + `action` 分派 —— `search`（AST 模式搜索）/ `outline`（语法骨架）/ `rules`（YAML 规则）。与 `code_map` 同风格，参数按 action 取用。
  - **`ast_replace`**：独立工具，**默认 dry-run**（`write` 缺省 false，只返回替换预览）；写回必须显式 `write: true`，描述里写明风险。
  - 理由：查询与改写分级——改写有副作用，独立工具才能让描述承担风险提示，也让模型的选择成本可见（与 `hash_edit` 的「读后改」分家同理）。
- **D2（注入面）**：新增 `export const inject = ["tools"]`；`BundleHost` 增 `tools?: { register(def: unknown): unknown }`。**保持库导出与 `createAstToolsBundle` 不变**（服务面给 TUI / 命令侧仍可用）；`ctx.tools` 缺失时静默跳过注册（对齐其它包）。`apply` 里注册时以 bundle 为服务实例。
- **D3（参数口径）**：保留 `language` / `path` / `strictness`（条目要求），action 决定附加必填：
  - `search`：`pattern`（必填）、`language`（必填）、`path`（必填）、`strictness?`（透传给 CLI；**缺省由 CLI 决定 = smart**，库不设默认）。
  - `outline`：`path` 必填；`language?`、`items?`、`types?`。
  - `rules`：`rulePath` 或 `rules`（内联 YAML）**二选一**；`paths[]` 必填且**空数组显式报 error**（CLI 零 path 会扫当前工作目录）；`includeMetadata?`、`minSeverity?`（工具侧枚举 `hint|info|warning|error`——库类型 `types.ts` 里写的 `help` 是 **CLI 非法值**，见 §审阅与 `ast-tools/docs/BACKLOG.md` #1）。
  - `ast_replace`：`pattern` / `replacement` / `language` / `path` 必填，`strictness?`、`write?`。
  - 参数缺失 / 互斥冲突 / 未知 action → 返回**带 `error` 字段的值**（不抛），与 `code_map` 的 `{ error: "…" }` 同风格。
- **D4（渲染与宿主契约）**：每个工具都给 `output.schema`（`{ type: "object", additionalProperties: true, properties: {} }`，与 `code-map` / `metric-loop` 同款——宿主 `register()` 强制要求并逐次校验返回值）与**全函数** `render(_args, value)`（对 `undefined` / 畸形值不抛；不 dump `updatedSource` 等大字段）。`output.render` 输出紧凑文本（非 JSON dump）：`search` = `path:line:col text`（**渲染转 1 基**，库 API 仍 0 基，README 写明换算）、`outline` = 缩进符号树、`rules` = `path:line:col severity ruleId message`、`replace` = dry-run 差异预览 + 「未写回」提示；每类各自**行上限 80**，超出以「…（其余 N 条略）」收尾。理由：模型只看得见 `render` 文本（先例：hash-edit 的 render 形参缺陷导致模型只拿到入参回显）。
- **D5（二进制缺失 fail-closed；审阅后修订）**：`apply` 捕获 `AstGrepMissingError` → 记日志，并注册**降级版工具**：工具可见，每次调用返回含 `INSTALL_GUIDANCE` 的错误值（**不假装成功**，仍属 fail-closed），模型侧仍可发现能力并读到安装指引。
  - 修订理由（子代理审阅）：① 本仓对「外部依赖缺失」的统一口径就是**注册 + 调用时降级报错**（`code-map` 同依赖 ast-grep 即如此、`session-channel` 无 Redis、`fs-digest` 无 LSP、`metric-loop` 无 schedule）；原 D5 是本仓唯一的「不注册」；② 「减少工具噪声」的论据不成立（工具数量与有二进制时相同）；③ 不注册时模型零可发现性，且事后装好二进制也要重启才能用；④ 原 D5 会把 D7 的无二进制用例全部变成条件跳过。
  - 实现：`AstOperations.unavailable?` + `unavailableOps(message)`，两个工具的 `execute` 首行短路返回 `{ error }`。
- **D6（描述写清选择成本）**：`ast_query` 描述写明「**文本 / 正则 → 宿主 `grep` / `glob`**；**结构快览 → `fs_digest`**（outline 带行范围）；**引用 / 影响面 → `code_map`**；**AST 形态（调用点、参数结构、元变量捕获 `$VAR` / `$$$VAR`）→ 本工具**」，并点明渲染行号是 1 基。`ast_replace` 描述写明：默认 dry-run、写回是**整文件重写且无版本守卫**（直接 `node:fs`，绕开官方 `fs-observation-policy` 与 `ctx.fs` 沙箱）、单点精确改写用 `hash_edit`（行级锚点 + 整批原子拒绝）。
- **D7（测试）**：新增 `tests/tool.test.ts`（mock `ctx.tools` 捕获注册定义）：① 注册两个工具且名字正确；② 缺参数 / 未知 action / rule 与 rulePath 冲突 → 返回 `{error}` 不抛；③ `ast_replace` **默认不写文件**（dry-run）与 `write: true` 写回（后者用 `astTest` 走真二进制）；④ 渲染格式与上限（含 0 基→1 基换算、截断标记）；⑤ 二进制缺失（`config.bin` 指向不存在路径）→ 不注册任何工具、记日志含安装指引。
- **D8（文件落点修正）**：条目建议落 `src/main.ts`；本包入口是 `src/index.ts`（`package.json` main → `dist/src/index.js`），故工具定义单独落 **`src/tools.ts`**，`index.ts` 只做接线（不把 60+ 行定义塞进入口）。

## 计划改动文件清单

- `ast-tools/src/tools.ts`（新：`ast_query` / `ast_replace` 定义 + 渲染）
- `ast-tools/src/index.ts`（`inject`、`BundleHost.tools?`、`apply` 注册；库导出不变）
- `ast-tools/tests/tool.test.ts`（新）
- `ast-tools/README.md`（能力表加模型工具面、参数、渲染与 1 基换算、二进制缺失降级、与 `grep`/`hash_edit` 的分工）
- `docs/BACKLOG.md`（开工标「进行中」→ 关闭时清理）
- 本追踪文档（唯一过程记录）

## 实现记录

| 文件 | 改动 |
|---|---|
| `ast-tools/src/tools.ts`（新） | `ast_query`（action 分派 search / outline / rules）+ `ast_replace`（默认 dry-run）；`AstOperations`（含 `unavailable?`）、`unavailableOps`、四个渲染函数与 `RENDER_LIMIT`；`output.schema` + 全函数 render |
| `ast-tools/src/index.ts` | 新增 `inject = ["tools"]`；`BundleHost.tools?`；`apply` 注册两工具；缺二进制时注册降级版并记日志；新增导出（`toToolDefs` / `unavailableOps` / `RENDER_LIMIT` / 渲染函数 / `AstOperations`），**库面签名不变** |
| `ast-tools/tests/tool.test.ts`（新） | 5 个恒跑用例（注册 + 契约面 / 降级注册 / 参数矩阵 / 事实描述与 `minSeverity` 枚举 / 渲染与全函数）+ 2 个 `astTest` 真机用例（dry-run 与写回、search + outline） |
| `ast-tools/README.md` | 新增「模型侧工具」段（工具表 / 渲染口径 1 基 / 选择成本）、导出表补 `inject`、降级口径改写、边界补「两类错误分界 / 4 空格缩进围栏 / 写回无版本守卫」、用例数 27 → 37 |
| `ast-tools/docs/BACKLOG.md`（新） | 模块级条目 #1：库类型 `minSeverity` 含 CLI 非法值 `help`（模型侧 schema 已绕开） |
| `docs/ARCHITECTURE-REUSE.md` | 两格更新（`ast-tools` 已注册模型侧工具、`inject` 现状） |
| `README.md` / `README.zh.md` | 能力表 `ast-tools` 行补两个工具名（双语同步） |
| `docs/BACKLOG.md` | 开工标「进行中」→ 关闭时清理并重编 |
| 本追踪文档 | 唯一过程记录 |

## 测试与证据（2026-10-02）

- `npm run check`：通过；`npm run build`：通过。
- `npm run test`：**37 例全绿**（原 27 例 + 新 10 例；其中 5 例无需二进制恒跑，真机 2 例在缺 ast-grep 时自动 skip）。
- **dist 产物真机核对**（用 `node --input-type=module` 直接加载 `dist/src/index.js`，与宿主加载同一份编译产物）：
  - 注册：`ast_query, ast_replace`，`inject = ["tools"]`，`output.schema = {"type":"object","additionalProperties":true,"properties":{}}`。
  - `search`（`str($A, $B)` @ `src/tools.ts`）：`src/tools.ts:222:22  str(args, "action")  {$B="action", $A=args}` → **1 基行号** + 元变量摘要 ✓。
  - `outline`（`src/tools.ts`）：`src/tools.ts（TypeScript）` + `L15 constant RENDER_LIMIT …` ✓。
  - `ast_replace` dry-run（同模式）：`预览：将替换 16 处（未写回；写入需 write:true）`，文件未改 ✓。
  - 降级路径（`bin: "/nonexistent/ast-grep"`）：仍注册 2 个工具，调用返回 `未找到 ast-grep 二进制（探测顺序：…）` + 完整安装指引 ✓。
- 会话内 `ast_query` / `ast_replace` 的生效确认需重启 TUI（插件在启动时载入），记入残余。

## 审阅（子代理，2026-10-02，实现前设计评审）

**结论：有条件通过** → 3 处必修 + 4 处漏项全部落进实现（另附 4 条低优先建议）：

| 审阅发现 | 处置 |
|---|---|
| 【高】工具侧 `minSeverity` 继承了库类型的非法值 `help`（CLI 只接受 `hint/info/warning/error`） | 工具 schema 改为 `hint\|info\|warning\|error`；**库类型 bug 另立** `ast-tools/docs/BACKLOG.md` #1（计划外文件不改） |
| 【高】设计漏写宿主强制的 `output.schema`；render 未要求全函数 | 两工具均给 `object` 根 schema；render 对 `undefined` / 畸形值不抛（用例覆盖），不 dump `updatedSource` |
| 【高】D5「不注册」与本仓统一口径冲突且拖累测试 | 改为「注册 + 调用返回含 `INSTALL_GUIDANCE` 的错误」（见 D5 修订理由） |
| 【中】D7 缺「不碰子进程」的注入缝 | 实现即按缝做：`toToolDefs(ops)` 可注入桩 ops，注册与校验用例用 `bin: process.execPath` 冒充可执行文件，恒跑 |
| 【中】D6 缺 `fs_digest` 指路、`hash_edit` 分工措辞不准、未写 `ast_replace` 写回无版本守卫 | 描述与 README 同步（四条指路 + 粒度/原子性措辞 + 整文件重写与绕开沙箱的提示） |
| 【中】`paths: []` 等于扫当前工作目录 | `execute` 显式返回 `{ error }`，并入参数矩阵用例 |
| 【低】`strictness` 缺省表述不准 / 1 基只影响渲染 | 决策与 README 改写；描述里点明「输出行号 1 基」 |
| 【低】「不抛」范围未划清 | README 补「两类错误分界」（入参 → `{error}`；执行期 → 抛给宿主转工具错误） |
| 【低】`exec.signal` 未转发 | 显式接受该取舍（与 `code-map` / `fs-digest` 同现状），写入 README 边界 |
| 【漏项】`ARCHITECTURE-REUSE.md` 两格 / 根 README 双语行 / 本包 README 导出表与用例数 / 追踪文档缺测试与收尾章节 | 全部补齐（见「实现记录」） |
| 【流程】审阅时发现 `docs/BACKLOG.md` 漏标「进行中」 | 已补标（本轮疏漏，关闭时一并清理） |

## 关闭记录

- 条目从 `docs/BACKLOG.md` §2 清理；其余条目重编（`md-logic` → #1，`md-map` → #2，usage 口径 → #3，命令模板终态 → #4，executor 隔离 → #5，STATUS 对齐 → #6）；§1 索引 / §2 顺序依据 / §3 里程碑同步。
- **残余**：① 会话内生效确认需重启 TUI（进程外已验：check / build / 37 例 / dist 产物真机跑通 search + outline + dry-run + 降级路径）；② 库类型 `minSeverity` 非法值另立模块条目；③ `exec.signal` 取消未转发（与本仓既有包同现状）；④ 只做现有四操作的模型化，不新增 ast-grep 子命令封装。
- 本追踪文档移入 `docs/archived/`。
