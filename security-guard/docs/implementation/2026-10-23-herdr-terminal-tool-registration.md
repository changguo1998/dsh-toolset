# security-guard：herdr-use 终端面契约变更后的命令工具登记

状态：待接取（只建文档，代码未动）　　开启：2026-10-23

## 目标

配合 `herdr-use` 终端面重构（工具面由单工具 `herdr_use` + 13 动作改为 10 个具名工具，旧名与旧动作不留别名），把本包的插件命令工具登记从旧工具名改到新工具名，保证终端里提交的命令文本、注入文本与按键串仍然逐条过命令层与敏感路径层。

- 契约来源：`docs/implementation/2026-10-23-herdr-use-terminal-surface.md`（2026-10-23 定稿，commit `c061922`）§「工具契约（10 个）」与 §「准入与安全」。
- 目标面：`security-guard/src/index.ts` 的 `PLUGIN_COMMAND_TOOLS`（现为 `herdr_use: { commandKeys: ["command", "text"], commandPaths: ["keys[]"] }`，`src/index.ts:273`）改为按新工具名登记：`herdr_run.command` 与 `herdr_text.text` 走 `commandKeys`，`herdr_key.keys[]` 走 `commandPaths`（数组值必须走路径面，`commandKeys` 对数组静默失效），其余 7 个工具（`herdr_list` / `herdr_read` / `herdr_info` / `herdr_wait` / `herdr_create` / `herdr_close` / `herdr_label`）无命令面。
- 为什么不能漏：登记表是命令层的唯一派发点，未登记工具走「未知工具不拦」（`unknownToolPolicy` 缺省 `allow`）——工具改名后旧键永不命中，等于 `herdr_run` 的命令复审整体失效，属安全面缺口。
- 同步面：`src/index.ts:249-256` 的注释、`tests/guard.test.ts:8,932-1050,2506` 的登记与放行断言、`README.md` 的登记表说明。
