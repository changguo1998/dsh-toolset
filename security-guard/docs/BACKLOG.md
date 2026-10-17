# security-guard 待办

> 职责：security-guard 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、防护口径与边界（见 `security-guard/README.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `security-guard/tests/`，不在此重复。
> 条目结构（2026-10-17 起）：现象 / 现状 → 期望 → 前置 → 落点 → 验收 → 估时 → 来源·状态·优先级。

## 待办

**#1 登记两个新插件工具的命令参数面（`script_run` / `herdr_pane`）**（〔进行中: 2026-10-17〕 2026-10-17 登记，来源：`docs/implementation/2026-10-16-script-interpreter-design.md`、`docs/implementation/2026-10-16-herdr-pane-design.md`）：**现象 / 现状** —— `PLUGIN_COMMAND_TOOLS`（`src/index.ts:249`）现只登记两项：`metric_loop`（`commandKeys: ["measureCmd"]`）与 `task_decompose`（两条 `commandPaths`）。覆盖范围是**显式白名单**，未登记的工具缺省不参与判定（`README.md:22`「未登记工具缺省不拦」，可用 `unknownToolPolicy: "check" / "deny"` 收紧，非本轮范围）；`README.md:22` 末句已写明「新增插件工具需按真实参数面在对应登记表登记」。两个待落地的新插件各有一处命令参数面落在这个口子外：`script_run` 的 `script`（脚本正文，可内含 `sudo` 等黑名单命令）、`herdr_pane` 的 `command` / `text` / `keys`（向 pane 注入的命令、文本与按键）；两份设计都把该登记写成**跨包改动、实现时随计划一并请批**，并要求开工前写进各自条目。**期望** —— 登记表加两条（参数名以两包实现时的真实工具面为准）：`script_run: { commandKeys: ["script"] }`、`herdr_pane: { commandKeys: ["command", "text", "keys"] }`；`TOOL_SURFACE.registered`（`src/index.ts`，由 `...Object.keys(PLUGIN_COMMAND_TOOLS)` 组装）与 `scripts/tool-surface-check.mjs` 的扫描面自动随动，实现时核对一遍即可。**前置** —— `script-interpreter` 与 `herdr-pane` 两个包尚未落地（条目在项目级 `docs/BACKLOG.md` §4）；若某个包最终不做，对应登记一并撤销。**接取时裁定** —— `herdr_pane` 的 `keys`（按键序列，不是 shell 命令串）是否纳入命令面：设计取保守口径（误拦代价低于漏拦），可复核。**落点** —— `security-guard/src/index.ts`（`PLUGIN_COMMAND_TOOLS`）、`security-guard/tests/`（命中与不误拦各若干用例）、`security-guard/README.md`（登记表口径一行）。**验收** —— `script_run` 的脚本正文含 `sudo` → deny 且未执行；`herdr_pane run` 的 `command` 命中黑名单 → deny；非命令键（如 `pane_id` / `lines`）不误拦；`scripts/tool-surface-check.mjs` 的登记键集与实现一致。**估时** —— 0.5 小时以内（两行登记 + 用例 + 文档一行；不含两个新包本身）。**优先级** —— P2（安全面，随对应新包的实现批次做）。〔待办: 2026-10-17 登记〕

**实现顺序** —— 项目级序列**第 8 位**（深度 1 · 0.5 小时以内 · 前置 = 顺位 6 脚本解释器与顺位 7 herdr-pane 落地）；见项目级 `docs/BACKLOG.md` §2 的「实现顺序（2026-10-17 裁定：依赖深度 > 工作量）」。
