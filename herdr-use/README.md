# @dsh-toolset/herdr-use

DSH（DeepSeek Harness）进程内集成插件：把 **herdr 的 pane / tab 当作可控伪终端层** —— 建 pane、建 / 列 / 关 tab、注入文本 / 按键、取屏、等输出、进程探活、关闭，让需要「屏幕状态 + 按键时序」的交互式命令（TUI 程序、REPL、安装器、需要应答的命令）可被程序化驱动。

模型侧工具：**`herdr_use`**（单工具 + `action` 分派十三个动作）；同时导出库面，供编排类插件与真机验证脚本直接调用，不必经模型工具链。

设计依据与取舍（tab / 会话 workspace 的调研与决策）见 `herdr-use/docs/archived/2026-10-21-herdr-pane-tab-workspace.md`；本包按**轻量包**口径只留 `README.md` + `docs/BACKLOG.md`。

## 能力

| 动作 | 作用 | 通道 | 必填 | 参数 |
| --- | --- | --- | --- | --- |
| `pane_create` | 在**本会话 workspace 的活动 pane** 上切兄弟 pane（缺省按该 pane 宽高选 `right` / `down`，`--no-focus` 不抢焦点，成功自动打 label；刚建完 tab 时不必调用，tab 自带 root pane） | CLI `pane split` | 无 | `direction?`（`right` / `down`）· `cwd?`（缺省会话工作目录）· `label?`（缺省配置 `label`） |
| `pane_list` | 列全部 pane 摘要 + 本插件登记标记（可跨 workspace 观察，不回传 workspace 面） | CLI `pane list` | 无 | 无 |
| `tab_create` | 在**本会话 workspace** 建 tab（`--no-focus`）；新 tab 自带 root pane——返回的 `pane_id` 即该 pane，可直接 `pane_run` / `pane_send_text` / `pane_read`，无需再 `pane_create` | CLI `tab create` | 无 | `cwd?`（缺省会话工作目录）· `label?`（缺省配置 `label`） |
| `tab_list` | 列本会话 workspace 的 tab + 本插件登记标记 | CLI `tab list` | 无 | 无 |
| `tab_close` | 关闭本插件用 `tab_create` 建出并登记的 tab（跨 workspace / 未登记一律拒） | CLI `tab close` | `tab_id` | — |
| `pane_read` | 取屏，回执带 `revision` / `truncated` | **socket** `pane.read` | `pane_id` | `source?`（缺省 `recent-unwrapped`）· `lines?`（缺省 120）· `format?`（缺省 `text`） |
| `pane_wait` | 等输出：`match` 字面量 / `regex` 正则 / `stable` 静默判稳（三选一） | CLI `wait-output`（前两者）/ **socket**（`stable`） | `pane_id` + 三者之一 | `match?` / `regex?` / `stable?`（三选一，互斥）· `settle_ms?`（缺省 400）· `source?` / `lines?` · `timeout_ms?`（缺省 30000） |
| `pane_send_text` | 注入字面量文本（**不回车**） | CLI `pane send-text` | `pane_id`、`text` | — |
| `pane_send_keys` | 发按键（如 `["ctrl+c"]` / `["esc"]` / `["up"]`） | CLI `pane send-keys` | `pane_id`、`keys`（非空字符串数组） | — |
| `pane_run` | 文本 + 回车一次提交 | CLI `pane run` | `pane_id`、`command` | — |
| `pane_label` | 打 / 清归属标记（显式空串 = 清除） | CLI `pane rename` | `pane_id` | `label?`（缺省写配置值；显式空串清除） |
| `pane_info` | 进程探活（`foreground_processes` / `shell_pid` / `running`） | CLI `pane process-info` | `pane_id` | — |
| `pane_close` | 关闭 pane（`force` 需配置 `allowForeignPanes: true`） | CLI `pane close` | `pane_id` | `force?` |

动作名按对象分组：pane 类一律加 `pane_` 前缀（10 个 pane 动作），tab 类一律 `tab_` 前缀（`tab_create` / `tab_list` / `tab_close`）；动作集合、参数面与闸门顺序不变。

**workspace 面不出工具面**：模型看不到、也传不进 workspace id / 名字（没有 `workspace` 动作，也没有 `workspace` 参数）。每个 dsh 会话由插件内部绑定一个 herdr workspace，`pane_create` / `tab_create` 的落点固定在其中，写操作不出这个 workspace；它的创建 / 查找 / 收尾都由程序完成。

### `pane_create` 的行为（与旧版差异）

旧版切**调用者所在 pane**（`pane split --current`，pane 会落到用户自己的 workspace）；现在改为切**本会话 workspace 活动 tab 的 pane**（`pane split <pane_id> --direction … --cwd … --no-focus`）。原因：dsh 不一定跑在 herdr 内（tmux / 普通终端没有调用者 pane），且「每个会话只能改自己的 workspace」需要一个固定落点。缺省 `cwd` 也随之改为**会话工作目录**（`session.header.cwd`，取不到时回退 dsh 进程 cwd）。

### 通道划分（为什么只有读走 socket）

CLI 与 socket 两面都可用；socket 相对 CLI 的**硬优势只有一处** —— `pane.read` 返回 `revision` / `truncated`，而 CLI 的 `pane read` 只输出纯文本。因此：

- `pane_read` 走 socket（拿 `revision` / `truncated`）；
- `pane_wait` 的 `stable` 走 socket（相邻两次 `revision` 相同即判稳；服务端未给 `revision` 时回退文本比对）；
- 其余动作走 CLI（参数校验失败更早、漂移面更浅、退出清理天然同步、代码与测试面更薄）。

CLI 调用一律 `spawn(bin, args)` **参数数组、不过 shell**：模型给的文本是 argv 元素，不做字符串拼接，避免二次解释。

## 参数

取屏口径：缺省 `recent-unwrapped`（官方技能给日志与转录的首选，软换行已拼接）、120 行、剥 ANSI；**TUI / alternate-screen 程序改用 `visible`**（alternate-screen 的行不进普通 scrollback）；`format=ansi` 仅在需要颜色证据时用。

等待与超时：`match` / `regex` 由**服务端**完成（先搜既有输出再轮询，无需自建轮询循环）；`stable` 以 `revision` 判稳（`settle_ms` 间隔 + `timeout_ms` 兜底）。**超时返回结构化结果（`ok: false` + `code: "timeout"`），不抛错**，回执带可操作的放宽提示。

输出截断：回执按 `renderLimit`（缺省 200 行 / 16000 字符）截断并提示用 `lines` / `source` 收窄；截断只影响显示，不改库面数据。

## 配置（`cordis.patch.yml` 的 `config`）

| 键 | 缺省 | 说明 |
| --- | --- | --- |
| `requireApproval` | `"foreign"` | `foreign` 只对**非本插件创建**的 pane / tab 动输入 / 关闭时审批；`always` 每次输入 / 关闭都弹；`never` 从不弹（仍有 guard 硬拒层与归属限制） |
| `allowForeignPanes` | `false` | pane 面归属限制的总开关：打开后允许对**非自建** pane 动输入 / 关闭（`pane_close` 另需 `force: true`；审批仍按 `requireApproval` 档先打断一次）；**不作用于 tab**（`tab_close` 只认登记过的 tab） |
| `closeOnExit` | `true` | dsh 退出时关闭本次创建的 pane（要保留现场供退出后查看的部署置 `false`，残留靠 label 清理） |
| `label` | `"dsh-pane"` | 归属标记（`pane_create` / `tab_create` 成功后自动打一次，便于识别崩溃残留） |
| `timeoutMs` | `10000` | 单次 CLI / socket 请求上限（启动探活另按 3s 封顶） |
| `renderLimit` | `{lines: 200, chars: 16000}` | 回执渲染上限（可只给一项） |

非法 / 缺失值一律回退缺省，不抛错（`resolveConfig`）。

## 归属与生命周期

- **会话 ↔ workspace 绑定**：进程内只绑一个（首个使用本工具的会话决定，子会话沿用）。约定 label = `<会话 cwd 目录名>/<会话 id 末 8 位>`（如 `dsh-toolset/a1b2c3d4`）；首次需要时先 `workspace list` 按 label 精确匹配复用，没有才 `workspace create --cwd <会话 cwd> --label <label> --no-focus`，并把建出的 root pane 登记为本插件 pane。不引入持久存储，靠 label 约定跨 dsh 重启找回。**每次动作前先 `workspace list` 复核绑定**：绑定的 workspace 已被关闭（用户关掉 tab / 服务端回收）时清空绑定、按 label 重新匹配或新建，不再要求重启 dsh（2026-10-22）。
- **写边界**：`tab_create` 固定 `--workspace <绑定>`；`tab_close` 只关**本 workspace 内已登记**的 tab；`pane_create` 切本 workspace 活动 pane 的兄弟 pane。**读类**（`pane_read` / `pane_info` / `pane_list`）仍可跨 workspace 观察。
- **写类动作**（`pane_send_text` / `pane_send_keys` / `pane_run` / `pane_label` / `pane_close` / `tab_close`，以及 `stable` 模式的 `pane_wait`）缺省只作用于**本插件创建并登记**的 pane / tab；pane 面可配置 `allowForeignPanes: true` 放宽（`pane_close` 另需 `force: true`），tab 面不收例外。审批门覆盖 `pane_send_text` / `pane_send_keys` / `pane_run` / `pane_close` / `tab_close`（按 `requireApproval` 档判断），`pane_label` 与 `stable` 模式的 `pane_wait` 不触发审批；**永不使用「当前聚焦 pane」**（官方技能：不依赖别的客户端的焦点）。
- `pane_create` 成功后自动 `pane rename` 打一次标记（失败只记 `注：`，不回滚创建）；`tab_create` 在建 tab 时直接带 `--label`。
- 关非自建 pane 需**同时**满足配置 `allowForeignPanes: true` 与 `pane_close` 的 `force: true`，且仍受审批档约束（破坏性动作多一道显式信号）。
- 正常退出（含 TUI 的 `/quit` → `process.exit`）按 `closeOnExit` 用 `spawnSync` 同步尽力关闭**登记过的** pane；随后若本会话 workspace 内已无 pane（说明里面的 pane 全是本插件的、且都已关闭），由程序内部 `workspace close` 掉它（唯一一处 workspace 关闭，不出工具面）。用户后来在其中开了 pane 时这条判定不成立，故不会误伤。
- 同 pane 的操作串行化（并发调用不交叉）；workspace 类动作（`pane_create` / `tab_create` / `tab_list` / `tab_close`）另有一把共享锁，避免并发建出两个 workspace。

## 降级口径（非 herdr 环境）

注册条件 = **二进制可解析** + **服务端可达**（`herdr status --json` 报 `server.status === "running"`），二者缺一即**不注册工具**、只记一行日志。`HERDR_*` 全部可选：dsh 不一定跑在 herdr 内（tmux / 普通终端均可）；在 herdr 内时这些变量只作护栏上下文——`HERDR_PANE_ID`（不读调用者自己的 pane）、`HERDR_TAB_ID`（不关调用者所在 tab，防御性），`HERDR_SOCKET_PATH` 给出 socket 路径。二进制定位顺序为「显式配置 → `HERDR_BIN_PATH` → PATH 上的 `herdr`」。

socket 路径解析顺序：`HERDR_SOCKET_PATH` → 探活报出的 `server.socket` → `$XDG_CONFIG_HOME/herdr/herdr.sock`（未设 XDG 时 `~/.config/herdr/herdr.sock`）。

理由：注册一个必然失败的工具只会诱使模型反复试错并污染工具面（对照 `ast-tools`：二进制缺失是本机可修的，故它注册降级工具给安装指引）。

## 安全边界（四道判定）

命令跑在 herdr 服务端的 pane 里、**在 dsh 进程之外，不受 dsh 文件沙箱约束**，因此不能指望沙箱兜底：

1. **guard 复查**（本包本地加固）：执行前 `ctx.get("guard")?.inspectCommand(text, "herdr-use:<action>")` —— 返回 `null` 放行，非空字符串即命中（按 deny 回执、不执行）；服务缺失 / 调用抛错 → 告警一次后**照常执行**（fail-open，与 TUI `$` 模式同口径）。待检文本 = `pane_run` 的 `command` / `pane_send_text` 的 `text` / `pane_send_keys` 的 `keys`。
2. **`security-guard` 登记**（跨包）：`PLUGIN_COMMAND_TOOLS.herdr_use = { commandKeys: ["command", "text"], commandPaths: ["keys[]"] }`。命令跑在沙箱之外，这一层是硬拒的落点；**该登记由条目「登记两个新插件工具的命令参数面（`script_run` / `herdr_use`）」在 `security-guard` 侧落地**，本包只保证参数面与登记形态一致（数组参数必须走 `commandPaths`，`commandKeys` 会静默忽略数组值）。
3. **沙箱模式联动**（闸④，先于审批）：`tools/pre-execute` 里问宿主 `ctx.sandboxPolicy.resolve({ session })` —— 会话处于 `read-only` 时对 `pane_send_text` / `pane_send_keys` / `pane_run` / `pane_close` / `tab_close` 与 stable 模式的 `pane_wait` 返回 `{kind: "deny", reason}`（不弹面板，文案含模式、动作、目标 pane / tab 与 `/permission` 切换方式）；`pane_label`（只改归属标记）、`pane_create` / `tab_create`（只建对象、不提交命令）与读类动作放行。模式是宿主按会话从 `sandbox/mode` 事件回放出来的，重启 / resume 后仍正确；服务缺失 / 解析抛错 → 告警一次后**放行**（fail-open）。
4. **越界审批**（闸③，在沙箱门之后）：`tools/pre-execute` 监听器对「对非自建 pane 动输入 / 关闭」与「关非登记 tab」返回 `{kind: "ask", reason}`，由宿主路由到审批 UI；无审批服务时自动 fail-closed。缺省档 `foreign` —— 自有 pane / tab 上的动作与官方 bash 工具同级（命令执行不逐次审批），一旦要动用户的 pane / tab 则打断一次。**跨本会话 workspace 的 tab、以及调用者自己所在的 tab 直接 deny**（不是审批问题）。

归属拒绝与 guard 拒绝都给**结构化回执 + 放行方式**（怎么建自建 pane、怎么开 `allowForeignPanes`、回执里的 security-guard 说明）；沙箱拒绝给当前模式与切换方式；跨 workspace 拒绝不暴露 workspace id / 名字。

## 库面

```ts
import { createHerdrPlugin, dispatchAction } from "@dsh-toolset/herdr-use";

const plugin = createHerdrPlugin(ctx, { label: "dsh-pane" });
if (plugin) {
  // exec 是宿主工具上下文（含 agent.session）；库面直调要么传它，
  // 要么在 plugin.deps.resolveSession 注入固定会话
  const result = await dispatchAction(
    "pane_run",
    { pane_id: plugin.registry.panes[0].paneId, command: "just test" },
    plugin.deps,
    exec,
  );
}
```

- `createHerdrPlugin(ctx, config, deps?)` → `{ registry, config, deps, cleanup, dispose }`（二进制缺失 / 服务端不可达返回 `undefined`）。
- `dispatchAction(action, args, deps, exec?)` 是**唯一执行入口**（工具面、真机脚本、库面消费者都走它）；`pane_create` / `tab_*` 需要会话来定位本会话 workspace。
- `deps` 全部可注入（`runner` / `reader` / `connector` / `clock` / `guardCheck` / `sandboxMode` / `resolveSession` / `env` / `probe` / `readHandshake`），单测不需要真机 herdr。
- 绑定与登记面：`plugin.registry.workspaceBinding`（`sessionId` / `workspaceId` / `label` / `cwd` / `rootPaneId`）、`plugin.registry.panes`、`plugin.registry.tabs`。

## 测试与验证

- 单测（不进 CI 依赖，注入 fake runner / fake reader / 假时钟 / 假 socket 连接器 / fake herdr 服务端）：

  ```sh
  npm --prefix herdr-use run check
  npm --prefix herdr-use run test
  ```

- 九个用例文件：`cli`（可用性握手 / 二进制定位 / 探活 / 信封解析 / 退出码 / 子进程执行面）、`socket`（报文拼装 / 响应解析 / 判稳三例 / 缺省 socket 路径）、`net`（真实 unix socket：分片 framing / 超时 / 连接失败）、
  `actions`（十三动作 argv 与结果解析 / pane_create 重定向与 tab 三动作 / 归属与 `allowForeignPanes` / 串行化 / guard 拒绝）、`registry`（登记 / label / tab 与 workspace 绑定 / 退出清理与 workspace 收尾）、
  `workspace`（label 规范化 / 复用与新建 / 缓存与子会话沿用 / 活动 pane 解析）、
  `policy`（归属 / 审批三档 / 沙箱门 / 跨 workspace 文案 / fail-open）、`main`（注册条件 / 沙箱门与审批门 / tab 门禁 / exec 透传）、`tool`（定义契约 / 渲染 / 截断）。

- 真机端到端（**人工跑、不进 CI**，只需 herdr 二进制可解析 + 服务端在跑）：先 `npm --prefix herdr-use run build`，再跑 `node herdr-use/scripts/verify-herdr-use.mjs`（全自动，跑完即关 pane）。开关：`--keep`（保留 pane / tab / workspace 供人工看）、`--with-python`（额外验 `python3 -i` 的 REPL 场景）、`--with-tab`（建 tab → pane_run → pane_wait → pane_read → tab_close）、`--check-cascade`（关掉本次 pane_create 的 pane 后看 workspace 是否还在）、`--session-id <id>`（固定会话身份，重跑可验 workspace 复用）、`--cwd <dir>`（覆盖会话工作目录）。

- 覆盖链：`pane_create → pane_read → pane_send_text → pane_send_keys → pane_wait(match) → pane_run → pane_wait(stable) → pane_info → pane_label → pane_list → pane_close`（另可选 tab 链），并核对「新 pane 落在本会话 workspace」「调用者焦点未被抢走」「正常退出后无本次创建的 pane / tab，workspace 空则一并关闭」。2026-10-21 真机复跑 `--with-tab --check-cascade` 20 步全通过（含 `pane_send_text` / `pane_send_keys` / `pane_run` 的静默成功修复）。

## 与相邻能力的分工

- **TUI `$` 模式**：人用、非交互、不经模型、占不到 pane —— 与本包不重叠。
- **脚本语言解释器插件**：一次性非交互执行（收 stdout / stderr / 退出码）—— 一条命令能跑完的用它 / 宿主 bash 工具，需要看屏幕与按键时序的用本包。
- **tmux 条目**：目标同构、底床不同；只约定动作语义（本包的动作名按对象分组：pane 类带 `pane_` 前缀、tab 类带 `tab_`），不建公共层。
- **同事模型群组的编排协议**：需要可编程底床面 —— 本包的**库面**可直接 `link:` 依赖调用，不必经模型工具。

## 已知边界

- 不支持 `--machine` / `--session`（跨服务器 / 命名会话目标）；不碰布局类动作（`focus` / `resize` / `zoom` / `swap` / `move` / `scroll` / `input`）；不驱动「被 herdr 识别的 agent」面（`herdr agent prompt|wait|start`）；不订阅 socket 事件。
- **workspace 面不暴露**：没有 `workspace` 动作与参数，回执也不带 workspace id / 名字；排障用 `herdr workspace list` 与本包回执里的 label 约定。
- **tab 登记不持久**：`tab_close` 只认本进程 `tab_create` 建出的 tab；dsh 重启后登记表为空，此前建的 tab 需人工在 herdr 里关闭（pane 面同理，靠 label 识别残留）。
- **一个进程只绑一个 workspace**：子会话（各有自己的 session id）沿用首个会话的 workspace；用户手工改 workspace label 会让下次启动新建一个。
- **库面直调不受沙箱门约束**：`dispatchAction` 不经 `tools/pre-execute`，库面消费者（真机脚本 / 编排插件）需自行按会话模式决定是否调用；四道判定只盖模型工具面。
- `read-only` 会话里 `pane_close` / `tab_close` 也被拒，自建对象会留到退出清理（`closeOnExit`）或切回可写模式后手动关闭。
- 不做残留 pane / tab / workspace 的后台清理守护（属「后台常驻守护机制」条目范围）。
- `format=ansi` 的颜色语义首期不验。
