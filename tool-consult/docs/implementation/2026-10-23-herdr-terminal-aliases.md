# tool-consult：herdr-use 十个新工具的关键词别名

状态：进行中（已接取，别名表已改，待验证与收尾）　　开启：2026-10-23

## 目标

`herdr-use` 工具面从单工具 `herdr_use`（13 动作）改为 10 个具名工具，本包别名表仍按旧工具名建键（`tool-consult/src/aliases.ts:29` 的 `herdr_use`），十个新工具拿不到口语别名，关键词检索的命中率与排序都会下降。目标是为十个新工具补别名、删掉旧键。

- 契约来源：`docs/implementation/2026-10-23-herdr-use-terminal-surface.md`（2026-10-23 定稿，commit `c061922`）§「工具契约（10 个）」。
- 目标面：`tool-consult/src/aliases.ts`。建议按用途分键（每键 2 至 4 个中英文口语词，与既有表同风格）：`herdr_run`（跑命令、发命令）、`herdr_text`（输入文本）、`herdr_key`（按键、中断）、`herdr_read`（看屏、屏幕内容）、`herdr_wait`（等输出、判稳）、`herdr_create`（开终端、新终端）、`herdr_close`（关终端）、`herdr_list`（终端列表）、`herdr_info`（进程探活、前台进程）、`herdr_label`（改标题、打标签）。
- 依据：`aliases.ts` 表头已写明「工具改名或新增时同步维护本表」，本条即该约定的执行；别名只加权重、不改匹配算法。
- 测试面：本包现有测试未覆盖别名表内容，本次是否需要补一条「每个在册工具都有别名」的断言，留给接取时定。

## 计划改动文件清单

| 文件 | 改动 |
| --- | --- |
| `tool-consult/src/aliases.ts` | 删 `herdr_use` 键；加 10 个 `herdr_*` 键，各 3 个中英文口语词 |
| `tool-consult/docs/implementation/2026-10-23-herdr-terminal-aliases.md` | 本文件：接取状态、计划清单、实施记录、收尾 |

- 计划外文件不改；本包另一条开发线（咨询插件本体）不动；根 `docs/BACKLOG.md` 等目录外文件不改（条目状态只在本文件记）。
- `matcher.ts` 与匹配算法不动：别名只进 `ALIASES` 表，权重仍由 `matcher.ts` 的 `FIELD_WEIGHT.alias`（4 倍）决定。

## 实施记录

### 别名定稿

| 工具 | 别名 |
| --- | --- |
| `herdr_list` | 终端列表 / 列终端 / 看有哪些终端 |
| `herdr_read` | 看屏 / 屏幕内容 / 读屏 |
| `herdr_info` | 进程探活 / 前台进程 / 终端状态 |
| `herdr_wait` | 等输出 / 判稳 / 等待输出 |
| `herdr_create` | 开终端 / 新终端 / 建终端 |
| `herdr_close` | 关终端 / 关闭终端 / 关掉终端 |
| `herdr_label` | 改标题 / 打标签 / 终端标签 |
| `herdr_text` | 输入文本 / 打字 / 粘贴文本 |
| `herdr_key` | 按键 / 中断 / 组合键 |
| `herdr_run` | 跑命令 / 发命令 / 提交命令 |

- 十键按契约表顺序排在原 `herdr_use` 位置，前面加一行注释标明「工具名即动作，无 action 参数」。
- 表头约定每键 2 至 4 个词，本次每键 3 个；词汇均取短句（2 至 6 字），与既有表（`bash` / `session_channel` 等）同风格。

### 测试面决定

本包现有测试不覆盖别名表：`tests/matcher.test.ts` 用自造的 5 条 docs 断言排序，别名键来自宿主 schemas 的 `doc.name`，包内既无「在册工具清单」也无「在册工具必须有别名」这类断言，无法在不引入宿主夹具的前提下对表。按任务约定：

- 不为别名表新增测试框架；
- 改为一次性脚本抽查：用契约表里的十个工具名 + 英文描述建 matcher，逐条查别名，断言意图工具排第一；脚本不落盘、不进仓库。

### 排序抽查（一次性脚本，非仓库测试）

| 查询 | 首名 | 结果 |
| --- | --- | --- |
| 看屏 | `herdr_read` | ✓ |
| 跑命令 | `herdr_run` | ✓ |
| 开终端 | `herdr_create` | ✓ |
| 关终端 | `herdr_close` | ✓ |
| 按键 | `herdr_key` | ✓ |
| 进程探活 | `herdr_info` | ✓ |
| 等输出 | `herdr_wait` | ✓ |
| 终端列表 | `herdr_list` | ✓ |
| 打标签 | `herdr_label` | ✓ |
| 输入文本 | `herdr_text` | ✓ |

10/10 命中意图工具；`跑命令` 与 `bash`、`开终端` / `关终端` / `终端列表` 与其他 `herdr_*` 同屏竞争时，意图工具仍排首位（靠名称前缀与别名权重区分）。

## 验证

- `cd tool-consult && npm run check`：通过（`tsc --noEmit` 无输出）。
- `cd tool-consult && npm test`：tests 43 / pass 43 / fail 0。
- 说明：worktree 内无 `node_modules`，本地以软链接指向主仓库 `tool-consult/node_modules`（`node_modules` 已被 `.gitignore` 忽略，不进提交）。

## 暂不做

- 不给别名补英文词（如 `run command` / `read screen`）：契约表与既有表都以中文口语词为主，英文名 `herdr_*` 本身已参与名称权重，无词汇鸿沟。
- 不改 `matcher.ts` 的权重与分词；分键粒度按工具用途，不按 pane / tab / workspace 旧抽象。
