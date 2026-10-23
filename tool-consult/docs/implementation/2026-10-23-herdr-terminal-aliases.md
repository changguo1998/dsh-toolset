# tool-consult：herdr-use 十个新工具的关键词别名

状态：待接取（只建文档，代码未动）　　开启：2026-10-23

## 目标

`herdr-use` 工具面从单工具 `herdr_use`（13 动作）改为 10 个具名工具，本包别名表仍按旧工具名建键（`tool-consult/src/aliases.ts:29` 的 `herdr_use`），十个新工具拿不到口语别名，关键词检索的命中率与排序都会下降。目标是为十个新工具补别名、删掉旧键。

- 契约来源：`docs/implementation/2026-10-23-herdr-use-terminal-surface.md`（2026-10-23 定稿，commit `c061922`）§「工具契约（10 个）」。
- 目标面：`tool-consult/src/aliases.ts`。建议按用途分键（每键 2 至 4 个中英文口语词，与既有表同风格）：`herdr_run`（跑命令、发命令）、`herdr_text`（输入文本）、`herdr_key`（按键、中断）、`herdr_read`（看屏、屏幕内容）、`herdr_wait`（等输出、判稳）、`herdr_create`（开终端、新终端）、`herdr_close`（关终端）、`herdr_list`（终端列表）、`herdr_info`（进程探活、前台进程）、`herdr_label`（改标题、打标签）。
- 依据：`aliases.ts` 表头已写明「工具改名或新增时同步维护本表」，本条即该约定的执行；别名只加权重、不改匹配算法。
- 测试面：本包现有测试未覆盖别名表内容，本次是否需要补一条「每个在册工具都有别名」的断言，留给接取时定。
