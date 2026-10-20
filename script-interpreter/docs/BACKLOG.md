# script-interpreter 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

> 2026-10-19 接取并关闭：语言后端（见 `docs/archived/2026-10-19-script-interpreter-langs.md`）与
> Python venv / uv 自动探测（见 `docs/archived/2026-10-19-script-interpreter-venv.md`）两条均已关闭归档；
> 模块待办清单已空（未完成项无，仅留下方「已裁定不做（备查）」）。

## 已裁定不做（备查）

- 契约清单见 `README.md` 的「不做」与「溢出落点与残留」（REPL / 跨调用状态保持、`sandbox_permissions` 提权、溢出自动清理）与开头（TUI `$` 模式不合并）；条目不再逐条重列。
- 待议：REPL / 跨调用状态保持与官方 `run_code` 拒绝持久 kernel 同口径（2026-10-16 用户裁定），要做属另立条目（底座已在 profile：`terminal` + `terminal-bash`）；提权需求改为改会话沙箱模式或走官方 bash（2026-10-17 用户裁定）。
