# 五个 BACKLOG 条目连做（接取条目：`auto-approve/docs/BACKLOG.md`「项目层审计行的 `source.kind` 与 memory-base `SourceKind` 闭集对齐」；`TUI/docs/BACKLOG.md`「给「清理并退出」加一个别名」「处置 `/memory review` 审阅面板与 `candidates` 适配（候选队列下沉后失去数据源）」；`docs/BACKLOG.md`「`output-compress` 真机验证与 smoke 脚本更新（每会话 digest.db 口径）」；`auto-approve/docs/BACKLOG.md`「巡检工具：从会话日志还原「哪些调用被自动放行」」）

状态：关闭　　开启：2026-10-18　　关闭：2026-10-18
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

按工作量升序完成 5 条 BACKLOG：两个 `auto-approve` 条目、两个 TUI 条目、一个跨包条目（`output-compress` 真机验证与 smoke）。提交点由用户预授权（「不用向我提问，直接提交并继续下一步」），仍按标准流程逐条实现、验证、提交。

## 调研

- **auto-approve #1**：`src/audit.ts:224-228` 写 memory-base 项目层时传 `source: {kind: "approval", ref: callId}`；memory-base 的 `SourceKind` 闭集为 `session | file | url | tool_result | manual`（`memory-base/src/knowledge.ts:29`）。`MemoryScopeLike.put` 的 `source` 类型（`auto-approve/src/audit.ts:43`）只声明 `kind` / `ref`，缺 `label`。测试 `tests/audit.test.ts:161` 钉了 `kind === "approval"`。
- **TUI #3**：`/cleanquit` 走 `CLEAN_QUIT_PANEL_ID`（`src/app/index.ts:193`）合成确认面板；本地命令目录 `LOCAL_COMMANDS`（`src/app/commands.ts`）现有 5 个别名，`/exit` 已指 `/quit`。条目推荐 `/clean`。
- **TUI #4**：候选链分布在 `src/app/index.ts`（面板 5112-5330 一带、类型与状态 387 起）、`src/app/adapter/dsh.ts:4022-4090`、`src/app/adapter/types.ts:498-516`、`tests/memory-review.test.ts`；memory-base 已删 `candidates.*`。
- **项目 #3（output-compress）**：`smoke/smoke.mjs` 仍给两包配 `dbPath` 并按旧库结构断言；`~/.dsh` 在工作区外只读（`dsh --profile fff --dump-config` 报 EROFS），故真机验证改用工作区内临时 `DSH_HOME` + 自建 profile。
- **auto-approve #2**：审计两处留痕已存在（会话 JSONL + memory-base `approval_audit`）；缺的是只读还原入口。

## 决策

1. **执行顺序**：按估时升序 —— auto-approve #1（15 分钟）→ TUI #3（≤0.5 小时）→ TUI #4（2 至 4 小时）→ output-compress 真机与 smoke（0.5 天）→ auto-approve #2（0.5 天）。
2. **TUI #3 别名**：(a) `/clean`；(b) `/cq`；(c) `/bye`。**选定 (a)**：条目推荐、可从 `/cleanquit` 前缀补全、语义直白；同路由同确认面板，入目录即可补全。
3. **TUI #4 处置**：(a) 整块移除审阅面板与候选适配，保留 `search` / `add`；(b) 改造为只读列举。**选定 (a)**：候选队列在 memory-base 已不存在，只读列举与 `/memory search` 重复；`review` 子命令保留一句指引，不留死键调用。
4. **项目 #3 真机方式**：(a) 工作区内临时 `DSH_HOME` + 自建 verify profile；(b) 改用户 `~/.dsh/profiles/fff`。**选定 (a)**：沙箱内 `~/.dsh` 只读，且不改用户环境。
5. **auto-approve #2 形态**：(a) 独立只读脚本 `auto-approve/scripts/inspect-session.mjs`；(b) 模型侧工具。**选定 (a)**：只读巡检不需要模型面，也避免 `security-guard` 登记面扩张。

## 规划

逐条实现，每条走「改 → `npm run check` / 定向 `test` → 提交」；5 条完成后整体 `npm run test`、文档回写与归档。计划改动文件：

- `auto-approve/src/audit.ts`、`auto-approve/tests/audit.test.ts`、`auto-approve/README.md`
- `auto-approve/scripts/inspect-session.mjs`（新增）、`auto-approve/package.json`（脚本项）
- `TUI/src/app/commands.ts`、`TUI/src/app/index.ts`、`TUI/src/app/adapter/dsh.ts`、`TUI/src/app/adapter/types.ts`、`TUI/tests/memory-review.test.ts`（删或改写）、`TUI/docs/COMMANDS.md`
- `output-compress/smoke/smoke.mjs`、`output-compress/README.md`
- 三份 `BACKLOG.md` 与 `docs/STATUS.md`（按需）
- 本文件

明确不做：不改 memory-base 的 `SourceKind` 闭集（选方案 ①）；不改用户 profile；不改 `archived/` 下历史文档。

## 实现记录

1. **auto-approve 审计来源对齐**（`e8faf41`）：`src/audit.ts` 的项目层写入改 `source: {kind: "manual", label: "auto-approve", ref: callId}`，`MemoryScopeLike.put` 的 source 类型补 `label?`；`tests/audit.test.ts` 断言同步并新增 label 断言。`npm --prefix auto-approve run check` 通过、单测 115 例全绿。
2. **TUI `/clean` 别名**（`92ac6a4`）：`LOCAL_COMMANDS` 增 `clean → cleanquit`（同路由同确认面板），`tests/clean-quit.test.ts` 增别名用例，`tests/completion.test.ts` 的 `/cl` 补全期望补入 `clean`，`TUI/docs/COMMANDS.md` 计数改 41 条 / 6 别名。TUI 单测 1629 例全绿。
3. **移除 `/memory review` 面板**（`4eff49a`）：删 `index.ts` 的 `openMemoryReview` / `finishMemoryReview` / 面板 id / 三个状态字段 / 宿主提问覆盖时的草稿暂存分支，`adapter/dsh.ts` 五个候选方法，`adapter/types.ts` 五个可选方法与三个候选类型，删 `tests/memory-review.test.ts`；`review` 子命令改为一句指引（指向 `search` / `add`），usage 串与 `TUI/README.md` 的 `/memory` 行同步。TUI 单测 1625 例全绿。
4. **output-compress smoke 改口径**（`e680588`）：`smoke/smoke.mjs` 去掉两包 `dbPath` / `sessionDir`，改临时 `DSH_HOME` + 三包 `link:` 符号链接挂载（不经 pnpm store），断言改为 `<会话目录>/digest.db`（指纹 / `digests` 行 / spill locator + 切片 / `digests_fts`）与 `<会话目录>/session.db` 的 `kind_digest` 行；缺模型凭据时以明确提示失败。**真机跑通**：改用本机 tollgate 网关（`TOLLGATE_API_KEY` 缺省占位值 `local`，`TOLLGATE_BASE_URL` 缺省 `http://127.0.0.1:8787/v1`）后跑 `npm --prefix output-compress run smoke` → PASS（digest.db 指纹 / `digests` / 切片定位 / FTS / 无 `session-dir-missing`）。
5. **auto-approve 巡检脚本**（`7afb5e5`）：新增 `scripts/inspect-session.mjs`（只读；`--session` / `--dir` / `--file` 三入口，`--json`），按事件 id 配对 `approval/asked` + `approval/decided`、按 `callId` 关联本包审计行，输出自动 / 人工与命中的 `source` / `ruleId`；多帧 zstd 走 `zstd -dc`（缺 CLI 时提示只解首帧）。`package.json` 增 `inspect`；README 增「巡检（只读）」一节。

## 偏差

- **`is_error` 推送路径未能在 smoke 里触发**：宿主 `dsh-tool-bash` 把非零退出记为结果文本（`[exit code: N]`），只有 spawn 失败 / 中止才置 `isError`，故真实会话产出的是 `is_error=0` 摘要，memory-base S 层 `kind_digest` 行未生成；smoke 在该情形下打印「跳过」并继续，推送逻辑由单测（hooks / scope 用例）覆盖。
- **用户 profile 的过渡 `sessionDir` 行未删**：`~/.dsh/profiles/fff` 在工作区外只读（EROFS）。已并入 `docs/BACKLOG.md` 的「后续补条目候选」⑤。
- 巡检脚本的列对齐按字符数而非显示宽度（CJK 工具名会让列宽略有参差），未引入宽度表。

## 测试与证据

- `npm --prefix auto-approve run check` / `test`：115 例全绿（改动后）。
- `npm --prefix TUI run check` / `test`：1629 例（加别名后）→ 1625 例（移除审阅面板后）全绿。
- `node --check output-compress/smoke/smoke.mjs`：通过；`npm --prefix output-compress run smoke`（tollgate 网关）→ PASS：`digest.db 指纹 OK；digests 1 条（is_error=0）；切片 L1181-1298 定位 marker 成功；FTS 命中 1`、`落点解析正常`、`kind_digest 跳过（无 is_error 摘要）`。
- 巡检脚本：真实会话 `tui-ac4bde29-…` → 「审批对 0 条 / 审计行 0 条」正常退出；`tmp/inspect-fixture` 合成夹具 → 3 条审批对（自动 1 / 人工 2）+ 1 条未配对审计行，`--json` 摘要字段一致。
- 全仓 `npm run test`：29 包全绿（exit 0，无 FAIL 行）；`npm run check`：exit 0。

## 收尾

- 回写：`auto-approve/README.md`（巡检节、`inspect` 脚本）、`output-compress/README.md`（smoke 口径与凭据要求）、`TUI/README.md`（`/memory` 行）、`TUI/docs/COMMANDS.md`（别名计数）。
- BACKLOG：`auto-approve` #1 / #2 与 `TUI` #3 / #4 标完成并移除；`docs/BACKLOG.md` 的 output-compress 条目真机跑通后也标完成并移除（仅剩 profile 过渡行，已并入候选）。
- 临时产物：`tmp/dshhome`、`tmp/big-output.txt`、`tmp/inspect-fixture` 已删。
- 本文件移入 `docs/archived/`。
