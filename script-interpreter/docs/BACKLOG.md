# script-interpreter 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

## 待办

（当前无未完成项。）

## 已裁定不做（备查）

- **临时脚本改落会话目录 `.tmp`, 并补清理** —— 2026-11-08 弃用。条目前提不成立: 脚本正文经 stdin 送入、不落盘（`src/langs/*.ts` 的 `-u -` / `-` / `-s`）, `mkdtemp` 建的是**溢出全文**落盘根（`src/run.ts:57-107`）, 且该路径要回执给模型再读、刻意不自动删（`README.md:126-135`, 决策 6, 对齐官方 `spill-local`）。改落会话目录反而让副本离开 `/tmp` 生命周期、隐私面变差。理由与证据见 `script-interpreter/docs/archived/2026-11-08-session-tmp-scripts.md`。
