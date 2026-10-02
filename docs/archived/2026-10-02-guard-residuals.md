# `security-guard` 覆盖残余（接取条目：`docs/BACKLOG.md` #3）

状态：进行中　　开启：2026-10-02　　关闭：—
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 目标

三项残余：① **`read_image`（官方宿主工具，参数 `file_path`）不在 `FILE_TOOLS`** —— 实测 `read_image{file_path:<敏感名>}` 放行而 `read` 同路径被拦（一行可修）；② 测试缺口：root 为**目录名**命中 basename 型规则（如名为 `.env.d/` 的目录）无用例、`allowedPaths` 放行读面四工具（`hash_read` / `fs_digest` / `code_map` / `md_map`）无用例；③ 「未登记工具默认拦」远期方案的观察记录（真实理由：`read_image`、`metric_loop` 命令面、MCP 工具名不可控）。

## 调研（2026-10-02）

- `FILE_TOOLS = {read, write, edit, patch, grep, glob}`（`security-guard/src/index.ts:130`）；`read_image` 不在其中 → 走「未知工具 `return null`」分支，其 `file_path` 不过敏感文件层。
- 敏感规则口径（`src/sensitive.ts`）：basename 型规则按 basename 匹配**任意深度**；前缀型按路径前缀；`allowedPaths` 只放开敏感层。
- 读面登记（上一条目）已覆盖 8 个插件工具；本条补官方 `read_image` 与两处测试。

## 决策

- **D1（`read_image`）**：把 `"read_image"` 加入 `FILE_TOOLS`（读面），并在路径键集合里补 `file_path`（若既有 `FILE_PATH_KEYS` 不含它）；回执按读侧。**不改其它官方工具语义。**
- **D2（测试）**：`security-guard/tests/guard.test.ts` 追加：① `read_image{file_path:<敏感名文件>}` → 拦（读侧 + 规则 id + 工具名 `read_image`）；② `read_image{file_path:<普通文件>}` → 放行；③ root 为**目录名**命中 basename 型规则（如临时目录里建 `x/.env.d/`，用 `code_map{action:"index",root:<该目录>}`）→ 拦（冻结「宁可误拦」口径）；④ `allowedPaths` 放行读面四工具（各 1 断言或循环）。
- **D3（观察记录）**：把「未登记工具默认拦」的远期方案与真实理由写进项目级 BACKLOG（本条只记录，不实现）。
- **D4（不做）**：不实现默认拦；不改 `sensitive.ts` 默认规则集；不动其它包。
- **D5（验证）**：`security-guard` check/build/test（+N 例）；反向验证（临时把 `"read_image"` 从 `FILE_TOOLS` 移除 → 新增 deny 用例必失败）；全仓 `check` / `build` / `test`；提交前 `git diff --name-only` 只允许本次改动文件。
- **D6（文档）**：`security-guard/README.md` 覆盖清单补 `read_image`（官方读面）；条目关闭。

## 计划改动文件清单

- `security-guard/src/index.ts`（`FILE_TOOLS` + 路径键）、`security-guard/tests/guard.test.ts`、`security-guard/README.md`
- `docs/BACKLOG.md`（标进行中 → 关闭 + 新观察项）、本追踪文档

## 实现记录

- `security-guard/src/index.ts`：`FILE_TOOLS` 加入 `"read_image"`（官方宿主工具，参数 `file_path`；`FILE_PATH_KEYS` 本就含 `file_path`，未改）→ 读侧回执，与 `read` 同级。
- `security-guard/tests/guard.test.ts`：+4 例 —— `read_image` 敏感名文件 → 拦（读侧 + 规则 id + 工具名）、`read_image` 普通文件 → 放行、root 为**目录名**命中 basename 型规则（目录名为 `.env.d`）→ 拦（冻结「宁可误拦」口径）、`allowedPaths` 放行读面四工具（`hash_read` / `fs_digest` / `code_map` / `md_map`）。
- `security-guard/README.md`：覆盖清单补 `read_image`（官方读面工具，`file_path`）。

## 测试与证据（2026-10-02）

- `security-guard` **61 例全绿**（改前 57，+4）。
- **反向验证（本轮自查）**：临时移除 `"read_image",` 一行 → **60 pass / 1 fail**（失败即新增的 `read_image` 敏感名拦截用例）；还原后 61/61。
- 全仓：`npm run check` exit 0、`npm run build` exit 0、`npm run test` **20 包全 `fail 0`**；`git diff --name-only | grep src/` 仅本包一处（非变异残留）。

## 关闭记录

- 条目从项目级 `docs/BACKLOG.md` 清理；追踪文档移入 `docs/archived/`。
- 残余：① 审阅子代理（`01cd7e1c`）结果在提交时尚未回（本条实现与反向验证均为我方自查；若审阅命中必修项，按后续修正处理）；② 「未登记工具默认拦」的远期方案已落 BACKLOG 观察项（D3）；③ 真机未验。
