# `security-guard` 覆盖插件写工具（接取条目：`docs/BACKLOG.md` #3）

状态：进行中　　开启：2026-10-02　　关闭：—
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 目标

`security-guard` 的文件层只认工具名白名单 `FILE_TOOLS = {read,write,edit,patch,grep,glob}`（`src/index.ts:130`），**未知工具一律 `return null`（不拦）**（`:342-350`）→ 本仓的插件写工具 **`md_logic`（action=replace，新增）、`hash_edit`、`ast_replace`** 可写敏感文件（凭据目录、env 文件、证书私钥等）而官方 `edit` / `write` 会被拒。要把这三个工具登记进文件层（含各自 path 参数名与写/读写语义）。

## 调研（2026-10-02）

- 分发口径（`src/index.ts`）：`SHELL_TOOLS` → `read-write`；`WRITE_FILE_TOOLS = {write,edit,patch}` → `write`（`:191`）；其余文件工具 → `read`；路径提取用 `FILE_PATH_KEYS`（`:335-350` 一带，只认 string 值）；命中 → `formatFileReceipt` / `formatCommandReceipt` 回执（拦截）。
- 三个待覆盖工具的参数面（本仓现状）：
  - `hash_edit`（`hash-edit/src/main.ts`）：`{ path, edits: [...] }`，**整文件重写**（临时文件 + rename）→ 写面。
  - `md_logic`（`md-logic/src/tools.ts`）：`{ action, path, ... }`——`structure` / `blocks` / `links` 只读、**`replace` 写**（整文件重写、绕开官方版本守卫）→ **读 + 写（按 action 判定）**。
  - `ast_replace`（`ast-tools/src/tools.ts`）：`{ action, path 或 paths, ... }`（多路径）→ 写面（有 dry-run 缺省但允许写）。
- 既有敏感文件规则（`src/sensitive.ts`）：默认含凭据目录 / env / 私钥 / 证书等模式 + `allowedPaths` 放行。
- 风险面：本条只补这三个工具，**不**改成「所有未知工具默认拦」（会让其它插件的只读工具误伤，超出条目范围）。

## 决策

- **D1（描述符表）**：新增 `PLUGIN_FILE_TOOLS: Record<string, { operation: "read" | "write" | "read-write"; pathKeys: readonly string[]; pathArrayKeys?: readonly string[]; writeWhen?: (args) => boolean }>`：
  - `hash_edit` → `{ operation: "write", pathKeys: ["path"] }`
  - `md_logic` → `{ operation: "read-write", pathKeys: ["path"], writeWhen: (args) => args.action === "replace" }`
  - `ast_replace` → `{ operation: "write", pathKeys: ["path"], pathArrayKeys: ["paths"] }`
- **D2（判定合并）**：`toolOperation(toolName, args)` 扩为接受 args：先查 `PLUGIN_FILE_TOOLS`（`writeWhen` 为真 → `write`；否则按 `operation`，其中 `read-write` + 非写 action → `read`），再走既有 `SHELL_TOOLS` / `WRITE_FILE_TOOLS` / 默认 `read`。**官方工具语义不变**。
- **D3（路径提取）**：插件工具走同一 `FILE_PATH_KEYS` 思路 + 自己的 `pathKeys` / `pathArrayKeys`（数组取其中 string 元素）；路径同样过 `resolveAgainstCwd`（与官方工具同口径）。
- **D4（拦截面）**：命中敏感文件 → 写面用**写侧规则**（与 `write`/`edit` 同级），只读 action 用读侧规则；回执文案标明是插件工具（如「工具：md_logic replace」）便于模型理解。**不**把未知工具一律拦截（D1 只登记名单）。
- **D5（测试）**：`security-guard/tests/` 增用例（用临时 cwd + 敏感名 fixture）：
  ① `hash_edit` 写敏感路径 → 拦（回执含工具名与命中规则）；② `md_logic` 的 `structure` 读敏感路径 → 按读侧拦/放行口径断言；③ `md_logic` 的 `replace` 写敏感路径 → 拦；④ `ast_replace` 的 `path` / `paths`（数组）写敏感路径 → 拦；⑤ 三个工具写**普通路径** → 不拦（防误伤）；⑥ 官方 `edit` / `write` 行为不变（回归）。
- **D6（文档）**：`security-guard/README.md` 的覆盖清单补「插件写工具（hash_edit / md_logic replace / ast_replace）」与「未登记工具仍不拦」的边界说明；条目关闭。
- **D7（不做）**：不改 `sensitive.ts` 的默认规则集；不做「未知工具默认拦」；不改三个插件本身。

## 计划改动文件清单

- `security-guard/src/index.ts`（描述符 + 判定 + 路径提取 + 回执文案）
- `security-guard/tests/*.test.ts`（新增用例；按既有测试布局放）
- `security-guard/README.md`、`docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 实现记录

`security-guard/src/index.ts`：新增 `PLUGIN_FILE_TOOLS` 登记表（`hash_edit{write,[path]}`、`md_logic{read-write,[path],writeWhen:replace}`、`ast_replace{write,[path]}`、**`ast_query{read,[path],[paths]}`**）+ `pluginFileTool()` 助手（`Object.hasOwn` 判自身属性）+ `pluginFilePaths()`（pathKeys 取 string、pathArrayKeys 逐元素取 string）+ `toolOperation(toolName, args)` 扩参 + 分发处纳入文件层（未登记工具仍 `return null`）+ 回执 `工具：md_logic replace` 形态（读写面随 action 变时带 action）。官方工具分支逐字未动。

## 测试与证据（2026-10-02）

- `security-guard` **47 例全绿**（改前 37，新增 10）：三工具敏感路径写/读拦截、`ast_query` 的 `path`/`paths` 读侧拦截、`allowedPaths` 放行（写侧/读侧/数组）、普通路径不误伤、官方工具语义回归、未登记工具仍不拦、**原型链属性名工具名放行不抛**。
- 反向验证（两态）：删掉插件分支 → 4 条 deny 用例失败（40/4）；去掉 `Object.hasOwn` → 原型链用例抛 `TypeError: tool.pathKeys is not iterable`（3 例中 fail 1）；把 `pathArrayKeys:["paths"]` 加回 `ast_replace` → 该用例失败（死参数回归即被拦）。三处还原后全绿。
- 命令：`security-guard` check/build exit 0、test 47/47；全仓 `check` / `build` exit 0、`test` 20 包全绿；`dist` 已重建（含登记表）。

## 审阅（子代理，2026-10-02）——结论：**有条件通过** → 必修项已处置

| 审阅发现 | 处置 |
|---|---|
| 【中】D1 把 `paths` 挂在 `ast_replace`（真实参数面 `{pattern,replacement,language,path,write?}`，**无 paths**）→ 死代码 + README/测试**假覆盖**；真实多路径读工具 `ast_query` 漏登记 | 已改：删 `ast_replace.pathArrayKeys`，**新登记 `ast_query`（read，path/paths）**；假覆盖用例改为 `ast_replace path（写侧）` + `ast_query path/paths（读侧）` 两条，并加「死参数回归即失败」断言；README 同步 |
| 【中】新引入原型链查表崩溃（`PLUGIN_FILE_TOOLS` 普通对象字面量 + 直接下标 → `constructor`/`toString` 等工具名抛 `TypeError`） | 已改：`pluginFileTool()` 用 `Object.hasOwn`，三处调用点统一；补原型链用例 + 反向验证 |
| 【低】`allowedPaths` 放行插件工具无用例 | 已补（写侧/读侧/数组 + 未列入清单仍拦） |
| 【低】D3 引用的 `resolveAgainstCwd` 全仓不存在；`PreExecuteExecution` 无 cwd 字段 | 记 errata：实现走与官方工具**同一** `normalizePath` / `checkSensitivePath` 代码路径；相对路径只有 basename 规则能命中（pre-existing，非本次回归） |
| 【低】D4「写侧/读侧规则」易误读 | 记 errata：敏感层只有一套规则（读/写同样 DENY），`operation` / `writeWhen` **只影响回执措辞** |
| 【低】读面插件工具未登记（`hash_read` / `ast_query`（已补）/ `fs_digest` / `code_map` / `md_map`） | 已开项目级新条目（见 BACKLOG）；`ast_query` 本次已登记 |
| 【低 Prometheus】临时文件 `tmp-root-verify.log` 残留 | 已确认不存在（`find` + `git status --ignored` 均无） |

## 关闭记录

- 条目从项目级 `docs/BACKLOG.md` 清理；追踪文档移入 `docs/archived/`。
- 残余：① 未做真机会话级端到端验证（引擎监听器单测 + 全仓回归为止）；② `security-guard` `npm run smoke` 未跑（需真机 dsh + 模型 API + zstd）；③ 读面插件工具（`hash_read` / `fs_digest` / `code_map` / `md_map`）仍未登记 → 新条目；④ 相对路径只有 basename 规则能命中（官方工具同样如此，属既有口径，未在本条修）。
