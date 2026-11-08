# 临时脚本落会话目录 .tmp 并清理（接取条目：script-interpreter/docs/BACKLOG.md「临时脚本改落会话目录 `.tmp`, 并补清理」）

状态：关闭　　开启：2026-11-08　　关闭：2026-11-08
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. 临时脚本的默认存放位置改为会话目录下的 `.tmp`, 路径经 `sessionPaths` 服务的 `sessionDirFor` / `ensureSessionDir` 推导, 不自己拼 `~/.dsh/sessions`; 系统临时区只作会话目录不可用时的兜底。
2. 执行结束（成功 / 失败 / 中止）都清掉本次临时文件, 不再把可能含敏感内容的脚本正文留在盘上。
3. 补单测覆盖三条退出路径的清理与兜底路径; 本包 `check` / `build` / `test` 全绿。

## 调研

- **脚本正文不落盘**: `src/langs/python.ts` / `node.ts` / `sh.ts` / `bash.ts` 一律用 `-` / `-s` 从 stdin 读脚本（`python3 -u -`、`node -`、`sh -s`、`bash -s`）, `src/run.ts:8` 的口径写明「`stdin` 写完脚本后立即结束」; 全包 grep `mkdtemp` / `flag: "wx"` 只命中 `SpillStore`（`src/run.ts:52-107`）, 没有「写脚本文件」的代码。
- **`mkdtemp` 建的是溢出落盘根**: `SpillStore`（`src/run.ts:57-93`）惰性建 `<tmpdir>/<prefix>XXXXXX/`, 其下按会话分桶, 每次溢出新建一个 **0600** `-stdout.log` / `-stderr.log`（`src/run.ts:100-107`）——存的是**输出全文**（尾部截断前的溢出部分）, 不是脚本。
- **溢出文件被回执引用**: `src/run.ts:5-6` 与 `README.md:126-135` 写明「回执给落盘路径, 模型可再读」; 提前删除会让回执里的路径失效。
- **不删除是刻意设计**: `README.md:135`（决策 6, 对齐官方 `spill-local`）写明「**不自动删**（可审计）, 残留交给 `/tmp` 生命周期 —— 不自造清理策略」。
- 隐私面: 溢出内容是工具结果的输出文本, 与宿主会话日志里的内容同源; 挪进会话目录不会减少副本, 反而让它在 home 下多留一份（`/tmp` 有系统生命周期, 会话目录没有）。

## 决策

1. 处置: a 弃用条目（不改代码, 更正描述后关闭） / b 只把溢出根改到会话目录 `.tmp`（保留「不自动删」） / c 改位置 + 运行结束删文件。
   选定 a（2026-11-08 用户批准）—— 条目的两条前提（「脚本正文落 0600 临时文件」「跑完不清理导致敏感正文长留」）都不成立; c 会同时破坏「回执路径可再读」与决策 6 的可审计口径; b 让溢出副本从 `/tmp` 搬进没有生命周期的会话目录, 隐私面反而变差, 且它换不来条目原本声称的收益。
2. 记录: 结论写进本文件, BACKLOG 条目移除并在关闭注记里写明「已裁定不做」的理由, 避免以后重复排查。

## 规划

- 计划改动文件清单:
  - `script-interpreter/docs/BACKLOG.md`（移除条目, 关闭注记写明弃用理由）
  - 本追踪文档（结论与证据）, 关闭后移入 `script-interpreter/docs/archived/`
- 明确不做: 不改 `src/run.ts` / `SpillStore`、不加 `sessionPaths` 可选依赖、不改 README 的「溢出与残留」一节（现状即设计）、不新增测试。

## 实现记录

- 2026-11-08: 无代码改动（决策 1 = a）。

## 偏差

- 追踪文档首版「目标」按条目原文写成「临时脚本落 `.tmp` + 清理」; 调研后确认前提不成立, 目标仅作留档, 实际执行为「弃用条目」。证据见上文「调研」两条 grep 结论与 `README.md:135`。

## 测试与证据

- 证据（代码面）: `grep -n "mkdtemp" script-interpreter/src/*.ts` 只命中 `src/run.ts:77`（`SpillStore.ensureRoot`）; `grep -n '"wx"' script-interpreter/src/*.ts` 只命中 `src/run.ts:107`（溢出文件创建）。
- 证据（文档面）: `README.md:130-135` 记根目录与「不自动删」; `README.md:126` 记「回执给落盘路径, 模型可再读」。
- 无代码改动, 故不跑 `check` / `build` / `test`; `pnpm run check:docs` 通过（119 篇现行 Markdown / 957 个 .ts, 错误 0 / 警告 0）。

## 收尾

- BACKLOG 条目已移除, 关闭注记写明弃用结论; 本文件移入 `script-interpreter/docs/archived/`。
- 回写: 无（README 现状即设计, 无需改）。
- 遗留: 无。
