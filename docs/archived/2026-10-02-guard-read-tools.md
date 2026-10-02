# `security-guard` 读面插件工具登记（接取条目：`docs/BACKLOG.md` #4）

状态：进行中　　开启：2026-10-02　　关闭：—
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 目标

上一条目已把写面三工具（`hash_edit` / `md_logic replace` / `ast_replace`）与 `ast_query` 登记进 `security-guard` 的 `PLUGIN_FILE_TOOLS`；但仍有**读面插件工具**不过敏感文件层：`hash_read`（返回行内容，`hash-edit/src/main.ts:278`）、`fs_digest`（读文件内容做摘要）、`code_map{root}`、`md_map{root}`（扫目录 + 读文件）。它们与官方 `read` / `grep` 被拦不对称，同为内容外泄路径。要按同一机制登记读面工具，并评估「未登记工具默认拦」的远期方案。

## 调研（2026-10-02）

- 机制现状（`security-guard/src/index.ts`）：`PLUGIN_FILE_TOOLS` 描述符表（operation / pathKeys / pathArrayKeys / writeWhen）+ `pluginFileTool()`（`Object.hasOwn`）+ `pluginFilePaths()` + `toolOperation(toolName, args)`；未登记工具仍 `return null`（不拦）。
- 待登记工具的真实参数面（需实现时逐一读码确认）：
  - `hash_read`：`hash-edit` 读工具，`{ path }`（行级读取，返回文本）。
  - `fs_digest`：`{ mode, path }`（outline / signatures / pruned）。
  - `code_map`：`{ action, root? ... }`（`root` 为可选仓库根，缺省 cwd）。
  - `md_map`：`{ action, root?, path? }`（`root` 建索引，`path` 查某文档）。
- 口径要点：**读面**工具应走读侧（与官方 `read`/`grep` 同级）——敏感层只有一套规则，读/写同样 DENY（上条 errata），故 `operation: "read"` 只影响回执措辞；`root`/`paths` 形态需按各工具真实键登记；未提供的键（如可选 `root` 缺省）不产路径。
- 「未登记工具默认拦」属远期方案：会让其它插件（`knowledge-base` / `session-channel` 等）的只读工具误伤，且 MCP 工具名不可控 → 本次只登记名单，默认拦记入 BACKLOG 观察项（本条不做，见 D4）。

## 决策

- **D1（登记四项）**：在 `PLUGIN_FILE_TOOLS` 追加（键名以实现时读码为准）：
  - `hash_read` → `{ operation: "read", pathKeys: ["path"] }`
  - `fs_digest` → `{ operation: "read", pathKeys: ["path"] }`
  - `code_map` → `{ operation: "read", pathKeys: ["root"] }`
  - `md_map` → `{ operation: "read", pathKeys: ["root", "path"] }`
    若某工具的真实参数面与上表不符（读码发现），按真实值登记并在追踪文档记偏差。
- **D2（语义）**：一律 `read`；不引入 `writeWhen`（这些工具只读）；`pathArrayKeys` 仅在真实存在数组参数时登记。
- **D3（测试）**：`security-guard/tests/guard.test.ts` 追加用例：① 四工具各自读**敏感名**路径 → 拦（读侧回执 + 工具名）；② 四工具读**普通路径** → 放行（不误伤）；③ 未登记工具仍不拦（既有用例保持）；④ 原型链名字回归保持通过。敏感名 fixture 复用上条（`.env` / `id_rsa` / `notes.md`）。
- **D4（不做／另记）**：不做「未登记工具默认拦」（误伤面大）；把该远期方案 + 各包只读工具清单写成 BACKLOG 观察项（若实现时发现还有其它**经模型入参读文件**的工具，一并列入）。
- **D5（文档）**：`security-guard/README.md` 覆盖清单补读面四工具 + 行为变化说明（此前放行 → 现在拦）；条目关闭。
- **D6（验证）**：`security-guard` check/build/test（用例数 +N）；反向验证（临时移除读面登记 → 新增 deny 用例必失败）；全仓 `check` / `build` / `test`。

## 计划改动文件清单

- `security-guard/src/index.ts`（登记四项）、`security-guard/tests/guard.test.ts`（用例）、`security-guard/README.md`
- `docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 实现记录

登记清单（`security-guard/src/index.ts` 的 `PLUGIN_FILE_TOOLS`，全部 `operation:"read"`，无 `pathArrayKeys`）：
`hash_read → ["path"]`、`fs_digest → ["path"]`、`code_map → ["root"]`、`md_map → ["root","path"]`（键名经读码核实，与 D1 一致）。

## 测试与证据（2026-10-02）

- `security-guard` **51 例全绿**（改前 47，新增 4）：四工具读敏感名路径 → deny（读侧回执 + 工具名，5 变体）、`hash_read` 走真宿主 listener 的 pre-execute deny、四工具读普通路径 → 放行（7 变体）、参数缺失 / `root` 缺省 / 空串 / 非 string → 放行（9 变体）。既有「未登记工具仍不拦」用例把已登记的 `fs_digest` / `md_map` 换成 `context_report` / `rule_list` / `metric_loop`；原型链用例保持通过。
- 反向验证：临时删 4 行读面登记 → `51 / pass 49 / fail 2`（失败恰为新增两条 deny 用例）；还原后 51/51。
- 命令：`security-guard` check/build exit 0、test 51/51；全仓 `check` / `build` exit 0、`test` 20 包全绿。

## 审阅（子代理，2026-10-02）——结论：**有条件通过**（无阻断代码缺陷）

| 审阅发现 | 处置 |
|---|---|
| 【中·文档】D3③「既有用例保持」不成立：旧用例把 `fs_digest` / `md_map` 列在「未登记」清单，登记后必失败（实现已改写为 `context_report` / `rule_list` / `metric_loop`） | 已记 errata（本文档）；实现改写正确 |
| 【中·覆盖】**命令层旁路**：`metric_loop{measureCmd}` 与 task-engine 的 command 后端 / mechanical 验收都经 `/bin/sh -c` 执行模型给的命令，均不在 `SHELL_TOOLS` / 登记表（实测危险命令与「读敏感路径的命令」在 `measureCmd` 下均 ALLOW，而 `bash` 同文本 DENY） | 已开**项目级新条目**（命令层描述符 / 已知边界） |
| 【低】`code_map` 的 `file` 未登记且未记偏差；实测不触盘（纯索引比对 / 纯图查询，LSP 位置不读取内容） | 记偏差：**不登记**（防误伤），理由如上 |
| 【低】`code_map` 缺省 root = **插件进程 cwd**（`code-map/src/index.ts:268/428`），不随会话 cwd | 已记 errata；README 相应表述已改「进程 cwd」 |
| 【低】`notes.md` 是**普通** fixture（敏感名只有 `.env` / `id_rsa`） | 已记 errata |
| 【低】测试缺口：root 为**目录名**命中 basename 型规则、`allowedPaths` 放行读面工具 | 未补 → 记入项目级新条目（连带 `read_image` 漏项） |
| 漏项：**`read_image`（官方工具，`file_path`）不在 `FILE_TOOLS`**，实测 `read_image{file_path:…}` ALLOW 而 `read` 同路径 DENY | 已开项目级新条目 |
| 漏项：D4「未登记工具默认拦」观察项未落 BACKLOG；点名理由不确切（`knowledge-base` 无模型工具、`session-channel` 无路径参数） | 已在项目级条目中用**真实理由**（`read_image` / `metric_loop` / MCP 工具名不可控） |

**误伤复核（审阅实测）**：「`code_map` 扫仓库根被阻塞」**不成立**——`root=<普通目录>` 放行（即便目录内含 `.env` / `id_rsa`）；真实误伤只有「root 指向受保护目录本身」（拦得对）与「root 目录名恰好命中 basename 型规则」（如名为 `.env.d` 的目录），宁严勿宽、README 已写明「只按路径本身过敏感层、不扫描目录内容」。

## 关闭记录

- 条目从项目级 `docs/BACKLOG.md` 清理；追踪文档移入 `docs/archived/`。
- 残余：① 真机会话级端到端未验（引擎单测 + 全仓回归为止）；② 命令层旁路（新条目）；③ `read_image` 与两处测试缺口（新条目）；④ 登记表已覆盖 8 个插件工具（写面 3 + 读面 5），其余插件工具经判定不需登记（无路径参数 / 路径来自配置）。
