# security-guard：herdr-use 终端面契约变更后的命令工具登记

状态：完成（2026-10-23）　　开启：2026-10-23　　关闭：2026-10-23

## 目标

配合 `herdr-use` 终端面重构（工具面由单工具 `herdr_use` + 13 动作改为 10 个具名工具，旧名与旧动作不留别名），把本包的插件命令工具登记从旧工具名改到新工具名，保证终端里提交的命令文本、注入文本与按键串仍然逐条过命令层与敏感路径层。

- 契约来源：`docs/implementation/2026-10-23-herdr-use-terminal-surface.md`（2026-10-23 定稿，commit `c061922`）§「工具契约（10 个）」与 §「准入与安全」。
- 目标面：`security-guard/src/index.ts` 的 `PLUGIN_COMMAND_TOOLS`（现为 `herdr_use: { commandKeys: ["command", "text"], commandPaths: ["keys[]"] }`，`src/index.ts:273`）改为按新工具名登记：`herdr_run.command` 与 `herdr_text.text` 走 `commandKeys`，`herdr_key.keys[]` 走 `commandPaths`（数组值必须走路径面，`commandKeys` 对数组静默失效），其余 7 个工具（`herdr_list` / `herdr_read` / `herdr_info` / `herdr_wait` / `herdr_create` / `herdr_close` / `herdr_label`）无命令面。
- 为什么不能漏：登记表是命令层的唯一派发点，未登记工具走「未知工具不拦」（`unknownToolPolicy` 缺省 `allow`）——工具改名后旧键永不命中，等于 `herdr_run` 的命令复审整体失效，属安全面缺口。
- 同步面：`src/index.ts:249-256` 的注释、`tests/guard.test.ts:8,932-1050,2506` 的登记与放行断言、`README.md` 的登记表说明。

## 实现记录（2026-10-23）

- 执行分支：`.worktree/security-guard`（`group/security-guard`，起点 `09f8bda`）；只在 `security-guard/` 内改动。
- 改动文件与要点：
  - `src/index.ts`：`PLUGIN_COMMAND_TOOLS` 删 `herdr_use` 键，新增 `herdr_run: { commandKeys: ["command"] }`、`herdr_text: { commandKeys: ["text"] }`、`herdr_key: { commandPaths: ["keys[]"] }`；登记表注释改为三个命令面工具 + 其余七个无命令面，保留「登记即脱离未登记工具策略」口径。
  - `tests/guard.test.ts`：原 `herdr_use` 六个用例按新工具名分测（三条 deny + 按键名 / 非命令参数放行 + 十个工具健康入参放行 + 敏感路径 deny）；`TOOL_SURFACE` 名单改为三个新工具名，并加「旧名 `herdr_use` 不得在册」反向断言。
  - `README.md`：插件命令面、三条写法口径、未登记工具边界三处同步新工具名。
- 验证：
  - `cd security-guard && npm run check` → exit 0。
  - `npm test` → 135 例，134 pass / 0 fail / 1 skipped（`tool-surface-check` 的「发布形态」用例因 worktree 未构建 `dist` 跳过，与本次改动无关）。
  - 反证实验：把 `herdr_key` 临时改为 `commandKeys: ["keys"]`，`herdr_key.keys[]` 用例失败；恢复 `commandPaths: ["keys[]"]` 后全绿，证明用例锁得住「数组走路径面」。
- 提交：`2e13f38`（登记表 + 注释）、`a4defb6`（测试）、`37ec474`（README），本条记录随收尾提交归档。
- **真机验收（2026-10-23，合并后）通过**：`herdr_run "echo mkfs-probe"` 被拦，回执明写「拦截来源：插件命令工具「herdr_run」的命令参数（command）」——改名后登记仍生效。另注：`rm -rf /tmp/...` 未被拦（黑名单不含通用 `rm`，属既有策略，与本次改名无关）。证据见 `docs/implementation/2026-10-23-real-machine-verification.md` #6。
- 未验证 / 存疑：
  - ~~真机未跑~~（已于 2026-10-23 验，见上）；七个无命令面工具未登记进 `PLUGIN_COMMAND_TOOLS`（按契约无命令面）；若把 `unknownToolPolicy` 调成 `check` / `deny`，它们按未登记工具口径处理（其中 `herdr_create.cwd` 属路径键，`deny` 下会被整工具拦），属既有边界，本次不改。
