# 任务：hash-edit

> 本文件为 herdr worktree 任务契约。**只允许修改本 worktree 的 `hash-edit/` 目录内文件**（pre-commit 钩子强制，其他目录/根文件的提交会被拒绝）。

## 目标

实现 LINE:HASH 锚定编辑：以 `行号:内容哈希` 锚点写文件/改文件，写入前校验各行哈希，锚点失效（内容已被改动）即拒绝写入，防止脏写。

## 来源

`docs/DEVELOPMENT-BACKLOG.md` #19（readseek 拆项 1）：行:哈希校验防脏写；dsh 侧当前 `fs-observation-policy` 仅版本守卫，无行级锚定。

## 复用底座（不新建）

- `tool-fs` / `tool-fs-search`：文件读写底座
- `fs-observation-policy`：版本守卫（可结合，锚定是行级补充）
- 参考主仓 `knowledge-base/` 的插件模板（`package.json` 的 `dsh.bundle` + `cordis.patch.yml` + `src/` + `tests/`）

## 接口对齐

`DSH-CTX-API.md`（0.1.5-rc.2 契约）+ 词汇表。锚定语义可对照主仓 TUI 与 readseek 思路：锚点 = `行号:HASH_BLOCK`，HASH_BLOCK 为完整行内容哈希或前缀；写入时逐锚点核对当前内容与哈希一致，不一致报 stale 并拒绝。

## 交付物（均在 `hash-edit/` 下）

- `hash-edit/package.json`（含 `dsh.bundle` 键）
- `hash-edit/cordis.patch.yml`
- `hash-edit/src/`：锚点解析、哈希校验、编辑指令（编辑/替换/插入/删除）核心逻辑 + DSH bundle 接入面
- `hash-edit/tests/*.test.ts`：锚点哈希校验、stale 拒绝、多锚点串行编辑、边界（空行/CRLF/超长行）
- 可选 `hash-edit/demo/` 或轻量 smoke：不强制真实 dsh 会话

## 完成门槛

1. `npm --prefix hash-edit run check`（tsc --noEmit 严格）通过
2. `npm --prefix hash-edit run test` 全绿（node --test）
3. `npm --prefix hash-edit run build` 产出 `dist/`
4. 改动文件执行 `format <文件...>`（TS→prettier）
5. 逻辑改动附可运行的检查样例（`demo()` 或单测），便于人工回归

## 硬约束

- 只改 `hash-edit/` 目录；`TUI/`、`knowledge-base/`、`task-engine/`、`herdr-integration/`、`docs/`、根文件一律禁止改动
- 提交仅限本 worktree 的 `feat/hash-edit` 分支；不 merge main、不 push、不 rebase 到 main 以外
- 不装全仓依赖，自包依赖按需最小；新增依赖需注明理由
- 不实现任务未提及的额外功能（YAGNI）；代码注释用中文、标识符用英文
