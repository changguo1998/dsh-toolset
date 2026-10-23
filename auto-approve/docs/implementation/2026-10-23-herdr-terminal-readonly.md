# auto-approve：herdr-use 读类工具是否纳入只读类

状态：待决策 + 待接取（只建文档，代码未动）　　开启：2026-10-23

## 目标

`herdr-use` 终端面重构后，读类工具是 `herdr_list` / `herdr_read` / `herdr_info` / `herdr_wait`，写类是 `herdr_create` / `herdr_close` / `herdr_label` / `herdr_text` / `herdr_key` / `herdr_run`。本包只读类缺省清单 `DEFAULT_READONLY_TOOLS`（`auto-approve/src/config.ts:12-21`）不含任何 herdr 工具，自动裁定不会把这四个读类工具判为只读，因而也不会自动放行。目标是把这一口径定下来并落到契约。

- 契约来源：`docs/implementation/2026-10-23-herdr-use-terminal-surface.md`（2026-10-23 定稿，commit `c061922`）§「工具契约（10 个）」的读 / 写分组。
- 选项 a：把四个读类工具加入 `DEFAULT_READONLY_TOOLS`。收益是读屏、探活不再逐次等人点确认；代价是把「读别人终端屏」也判为无副作用，而屏内容可能含凭据与隐私。
- 选项 b：不加入，保持现状。收益是保守，读屏仍逐次确认；代价是高频读屏的确认噪音。
- 若选 a，改动面：`src/config.ts` 缺省清单、`README.md` 的只读类说明、`tests/` 里对缺省清单的断言；并需在文档写明「缺省清单只作用于未在用户配置里覆盖该字段的会话」。
- 未定项：本包是否真的会接到 herdr 工具的审批请求（取决于宿主是否对这些工具发起审批），接取时先用真机确认一次再加清单。
