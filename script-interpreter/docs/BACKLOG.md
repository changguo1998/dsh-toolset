# script-interpreter 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

> 2026-10-19 接取：`#1` / `#2` 标〔进行中: 2026-10-19〕，每条各一份追踪文档：`script-interpreter/docs/implementation/2026-10-19-script-interpreter-langs.md` / `2026-10-19-script-interpreter-venv.md`。

## 条目详情（待办）

**#1 打开 bash 语言后端与二期语言（node / sh）**（〔进行中: 2026-10-19〕）：**现象 / 现状** ——
首期只启用 Python，bash 后端（`src/langs/bash.ts`）已随包实现但不在 `languages` 缺省表内；
node / sh 未实现。**期望** —— 若实测确有需要，按 `LangBackend` 契约新增 `langs/<语言>.ts` 并在
配置里追加，不改工具名与协议；bash 只需把 `bash` 加进 `languages`（官方 `tool-bash` 已覆盖 shell
命令，打开前先确认不与官方工具面重复）。**落点** —— `src/langs/*.ts`、`src/index.ts` 的语言表、
`tests/` 的语言相关用例、`README.md` 参数表。**验收** —— 新语言一例真实执行断言；未启用语言
仍明确报错。**估时** —— 0.5 天 / 语言。**优先级** —— P3。

**#2 Python venv / uv 自动探测**（〔进行中: 2026-10-19〕）：**现象 / 现状** —— 首期只提供解释器
路径覆盖（`pythonPath` / `SCRIPT_PY_INTERPRETER`），不探测项目内 `.venv`、不调 `uv run`。
**期望** —— 按工作区探测 `.venv/bin/python`，或支持 `uv` 前缀，且**不**自作主张改 `sys.path`；
探测不到时仍回落到当前解释器。**落点** —— `src/probe.ts` 的探测顺序与 `README.md` 的探测表。
**验收** —— 有 / 无 `.venv` 两态各一例，且解释器路径写进回执。**估时** —— 0.5 天。**优先级** —— P3。

## 已裁定不做（备查）

- 契约清单见 `README.md` 的「不做」与「溢出落点与残留」（REPL / 跨调用状态保持、`sandbox_permissions` 提权、溢出自动清理）与开头（TUI `$` 模式不合并）；条目不再逐条重列。
- 待议：REPL / 跨调用状态保持与官方 `run_code` 拒绝持久 kernel 同口径（2026-10-16 用户裁定），要做属另立条目（底座已在 profile：`terminal` + `terminal-bash`）；提权需求改为改会话沙箱模式或走官方 bash（2026-10-17 用户裁定）。
