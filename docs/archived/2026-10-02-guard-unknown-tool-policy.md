# `security-guard` 未登记工具默认拦（远期方案）（接取条目：`docs/BACKLOG.md` #3）

状态：进行中　　开启：2026-10-02　　关闭：—
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 目标

现在覆盖是**显式白名单**（官方文件工具 `FILE_TOOLS`、shell 工具、两张插件登记表 `PLUGIN_FILE_TOOLS` / `PLUGIN_COMMAND_TOOLS`），**未登记工具一律放行**。真实风险：① 官方新增工具会持续漏（`read_image` 曾漏，已补；`str_replace_editor`（required `path`，读写两面）、`present`（`files[].path`）**当前未挂载**但带路径参数）；② 命令面靠人工登记；③ MCP / 第三方工具名不可控。要给出**迁移路径**与**可执行的差异检查**，且**不改变默认行为**。

## 调研（2026-10-02）

- 判定入口：`security-guard/src/index.ts` 的 `#decide`（工具名分派）→ 未登记走 `return null`；两张登记表查表都用 `Object.hasOwn`（原型链名视同未登记）。
- 可用抓手（本条目已写入 BACKLOG 的可执行化段）：枚举宿主安装树 `@deepseek-ai/dsh-tool-*/lib/index.js` 的工具名（`grep -ho 'name: "[a-z][a-z_0-9]*"' … | sed … | sort -u`，当前 28 个），与 `FILE_TOOLS` + 两张登记表对照；触发时机=宿主升版后。
- 参数面启发：官方/插件的路径参数键名集中在 `FILE_PATH_KEYS`（`file_path` / `path` / `target` / `file`）+ 数组形态（`paths`）+ 命令键（`command` / `script` / `code` / `program` / `measureCmd`）——可据此判断「未登记工具是否携带潜在文件/命令参数」。

## 决策

- **D1（差异检查脚本）**：新增 `security-guard/scripts/tool-surface-check.mjs`：扫描宿主工具包目录（默认从 `DSH_INSTALL`/`node_modules/@deepseek-ai/dsh-tool-*` 解析，可用 `--root` 覆盖），枚举工具名 → 与 `FILE_TOOLS` + 两张登记表（从 `src/index.ts` 文本解析出名字集合，避免运行时导入 dist）对照 → 输出三类：已覆盖 / **未覆盖且带路径或命令参数（需关注）** / 未覆盖但无相关参数。无宿主目录时给可读提示并 **exit 0**（不阻塞 CI）；发现「需关注」项时 exit 1（可作宿主升版后的门禁）。
- **D2（opt-in 策略）**：新增配置 `unknownToolPolicy?: "allow" | "deny"`（**缺省 `"allow"` = 现行为，回归零风险**）。取 `"deny"` 时：未登记工具若**携带潜在路径/命令参数**（参数键名 ∈ 路径键集合 ∪ 命令键集合，含数组元素键）→ 返回可读拦截回执（含工具名、命中的参数键、放行方式：`unknownToolPolicy` / `sensitiveFiles.allowedPaths` 之类的配置指引）；未登记且**无**此类参数 → 仍放行（防误伤，例如纯计算/纯查询工具）。已登记工具与官方工具**行为不变**。
- **D3（不做）**：不做「默认 deny」（会破坏其它插件与未知 MCP 工具，迁移面不可控）；不引入「按 schema 类型判定」的重启发（只用键名启发，口径可预测、可测试）；不改 `sensitive.ts` 规则集。
- **D4（测试）**：① 缺省口径回归：未登记工具（带 `path`）仍放行；② `unknownToolPolicy:"deny"`：未登记 + `path` → 拦（含工具名与参数键）、未登记 + 仅 `symbol`/`id` 等无关参数 → 放行、已登记（`hash_read` / `metric_loop`）与官方（`read` / `bash`）行为不变；③ 脚本：用临时 fixture 目录模拟工具包树（1 个已覆盖名 + 1 个未登记名带 `path`）→ 断言输出含「需关注」项且 exit 1；空目录 → exit 0 + 提示。
- **D5（文档）**：README「未登记工具仍不拦」条改为「默认放行；可用 `unknownToolPolicy:"deny"` 收紧（只拦带路径/命令参数的未登记工具）」，并把差异检查脚本的用法与「宿主升版后跑一次」写进 README 边界节。
- **D6（验证）**：`security-guard` check/build/test；脚本在真实宿主目录上跑一次（记录输出与 exit code，作为证据）；反向验证（把 deny 分支失效 → 新增用例必失败）；全仓 check/test/build；提交前残留自查。

## 计划改动文件清单

- `security-guard/src/index.ts`（D2）、`security-guard/scripts/tool-surface-check.mjs`（新，D1）、`security-guard/tests/{guard.test.ts, script 相关}`（D4）、`security-guard/README.md`（D5）
- `docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 待办

1. 交子代理审阅本文件「调研 + 决策」。
1. 实现 + 测试 + 反向验证 + 全仓 `check` / `build` / `test`。
1. 关闭条目 → 归档 → 提交（一次提交）。

## 实现记录（2026-10-02，父会话）

- **D1 脚本**：`security-guard/scripts/tool-surface-check.mjs`（新）——递归找宿主 `@deepseek-ai/dsh-tool-*` 包（避开 `node_modules` 嵌套与 `@deepseek-ai/` 同层陷阱）、抽工具名（`name: "x"`）、从 `src/index.ts` 文本解析 `FILE_TOOLS` + 两张登记表 + `SHELL_TOOLS` 名字集合、按「文件里是否出现路径/命令类键名」分三类输出；有「需关注」项 exit 1、找不到宿主目录 exit 0；支持 `--root` / `--json`。
- **D2 配置**：`SecurityGuardConfig.unknownToolPolicy?: "allow" | "deny"`（`ResolvedConfig` 同步 + 解析处默认 `"allow"`）；`#decide` 的未登记分支改为：非 deny → 放行（历史行为）；deny → `unknownToolSensitiveKeys(args)`（顶层键 + 数组元素一层 + 嵌套对象一层）命中路径/命令键集合才拦，回执 `formatUnknownToolReceipt`（工具名 / 命中键 / 原因 / 放行方式）。
- **D5 README**：「未登记工具仍不拦」改写为「默认放行，可选收紧」+ 差异检查脚本用法与退出码语义。
- **D4 测试**：+3 例 —— 缺省 allow 回归（带 `path` / `measureCmd` 仍放行）、deny 三类（`path` / `files[].path` / `spec.command` 拦；`id`/`symbol`/空参数放行）、已登记与官方（`read`/`bash`/`hash_read`/`metric_loop`）在两种策略下判定一致。

## 测试与证据（2026-10-02）

- `security-guard` **70 例全绿**（改前 67，+3）；`npm run check` exit 0、`npm run build` exit 0。
- **反向验证**：把 deny 分支临时置为放行 → **69 pass / 1 fail**（失败恰为 deny 拦截用例）；还原后 70/70。
- **脚本真实宿主证据**（`--root ~/.local/share/fnm/node-versions/v24.16.0/installation/lib/node_modules`）：21 个 `dsh-tool-*` 包；已覆盖 10；**需关注 13**（`str_replace_editor`、`present`、`skill`、`web_fetch`、`web_search`、`load_workspace_dependencies`、`cordis_inspect_list/query`、`create_goal`/`update_goal`/`get_goal`、`ralph`、`list_subagent_models`）；未覆盖无相关参数 7；**exit 1**。
- 全仓：`npm run check` exit 0、`npm run test` **20 包全 `fail 0`**。

## 关闭记录

- 条目从项目级 `docs/BACKLOG.md` 清理；追踪文档移入 `docs/archived/`。
- 残余：① **决策审阅子代理（`14adcc02`）结论在提交时尚未回**（本轮实现与反向验证为父会话自查；若命中必修项按后续修正处理）；② 脚本启发式为**保守多报**（如 `create_goal` 因文件含 `command` 字样被标「需关注」），需人工复核；③ `unknownToolPolicy` 只覆盖**单工具**调用面，命令来自状态文件等旁路（见 README 边界）不受其影响；④ 未跑真机 dsh 会话级验证。
