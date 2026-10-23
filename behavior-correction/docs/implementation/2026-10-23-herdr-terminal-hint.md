# behavior-correction：指路文案改到 herdr-use 的十个新工具

状态：待接取（只建文档，代码未动）　　开启：2026-10-23

## 目标

`herdr-use` 终端面重构后旧工具名 `herdr_use`（含 `pane_*` / `tab_*` 动作）不再存在，本包缺省规则的拦截理由与描述仍指向旧名——被拦下的调用拿不到可执行的下一步。目标是把指路文案换到新工具名，并同步注释、包描述、README、profile 注释与测试断言。

- 契约来源：`docs/implementation/2026-10-23-herdr-use-terminal-surface.md`（2026-10-23 定稿，commit `c061922`）§「工具契约（10 个）」。
- 目标面：`src/main.ts:99` 的拦截理由（注释 `src/main.ts:10`、`:83`）、`package.json:4` 的包描述、`README.md:11,31,69`、`cordis.patch.yml:3` 的注释、`tests/main.test.ts:120,131,290,304` 中对旧名的断言。
- 文案口径：拦下 `bash` 里跑 herdr CLI 后，指向写类三工具 `herdr_run` / `herdr_text` / `herdr_key` 与查看类 `herdr_read` / `herdr_list`，不再出现 `pane_*` / `tab_*` 字样。
- 不动判定逻辑：规则 id `no-herdr-in-bash`、`bash` 命令正则与命中后的拒绝路径保持不变，只改文案与断言。
- 范围提示：旧计划把它记作「一行文案」，实际涉及 6 个文件（源码 1、包描述 1、README 1、YAML 注释 1、测试 1、追踪文档）。
