# behavior-correction：指路文案改到 herdr-use 的十个新工具

状态：完成（2026-10-23，4 个提交）　　开启：2026-10-23

## 目标

`herdr-use` 终端面重构后旧工具名 `herdr_use`（含 `pane_*` / `tab_*` 动作）不再存在，本包缺省规则的拦截理由与描述仍指向旧名——被拦下的调用拿不到可执行的下一步。目标是把指路文案换到新工具名，并同步注释、包描述、README、profile 注释与测试断言。

- 契约来源：`docs/implementation/2026-10-23-herdr-use-terminal-surface.md`（2026-10-23 定稿，commit `c061922`）§「工具契约（10 个）」。
- 目标面：`src/main.ts:99` 的拦截理由（注释 `src/main.ts:10`、`:83`）、`package.json:4` 的包描述、`README.md:11,31,69`、`cordis.patch.yml:3` 的注释、`tests/main.test.ts:120,131,290,304` 中对旧名的断言。
- 文案口径：拦下 `bash` 里跑 herdr CLI 后，指向写类三工具 `herdr_run` / `herdr_text` / `herdr_key` 与查看类 `herdr_read` / `herdr_list`，不再出现 `pane_*` / `tab_*` 字样。
- 不动判定逻辑：规则 id `no-herdr-in-bash`、`bash` 命令正则与命中后的拒绝路径保持不变，只改文案与断言。
- 范围提示：旧计划把它记作「一行文案」，实际涉及 6 个文件（源码 1、包描述 1、README 1、YAML 注释 1、测试 1、追踪文档）。

## 改动

| 文件 | 改动 |
| --- | --- |
| `src/main.ts` | `:99` 理由改为「改用 herdr_run / herdr_text / herdr_key（写类）与 herdr_read / herdr_list（查看类）」；文件头 `:10` 与 `DEFAULT_RULES` 注释 `:83` 同步，不再出现旧名 |
| `tests/main.test.ts` | 缺省规则用例逐个断言五个工具名，并加反向断言（理由不得含 `herdr_use` / `pane_` / `tab_`）；非法正则用例的夹具理由改为 `herdr_run` |
| `package.json` | `:4` 包描述由「改用 herdr_use」改为「改用 herdr_run / herdr_text / herdr_key 等专用工具」 |
| `README.md` | `:11` 典型场景、`:25` 起的缺省规则表、`:69` profile 示例理由；规则表原三行被裸 `\|` 撑破，一并合并回两行并把「唯一一条」改为「两条」 |
| `cordis.patch.yml` | `:3` 注释指向新工具（该文件带注释，按约定不跑 yq） |

- 提交：`07daf48` 源码文案与注释、`e8c2f21` 测试断言、`3658adc` 包描述 / README / YAML，本文件随第 4 个提交归档。
- 验证：`cd behavior-correction && npm run check` 通过；`npm test` = 29 个用例，28 通过、1 跳过（contract 探针因 `@dsh-toolset/rule-engine` 不可解析而 skip）、0 失败。
- 不动：规则 id、命中正则、拒绝路径；测试里作样本命令的 `herdr pane list` 保留（herdr CLI 子命令仍在，非工具名）。

## 未做 / 存疑

- 本包无 `docs/BACKLOG.md`，没有条目需要清理。
- 本文件按仓库约定移入 `docs/archived/`；`docs/implementation/2026-10-23-herdr-use-terminal-surface.md`（另一个 worktree）里对旧路径的引用会失效。
