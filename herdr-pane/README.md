# @dsh-toolset/herdr-pane

DSH（DeepSeek Harness）进程内集成插件：把 **herdr 的 pane 当作可控伪终端层** —— 建 pane、注入文本 / 按键、取屏、等输出、进程探活、关闭，让需要「屏幕状态 + 按键时序」的交互式命令（TUI 程序、REPL、安装器、需要应答的命令）可被程序化驱动。

模型侧工具：**`herdr_pane`**（单工具 + `action` 分派十个动作）；同时导出库面，供编排类插件与真机验证脚本直接调用，不必经模型工具链。

设计依据与取舍见 `docs/implementation/2026-10-16-herdr-pane-design.md`（项目级追踪文档；本包按**轻量包**口径只留 `README.md` + `docs/BACKLOG.md`）。

## 能力

| 动作 | 作用 | 通道 | 必填参数 |
| --- | --- | --- | --- |
| `create` | 建兄弟 pane（缺省按调用者 pane 宽高选 `right` / `down`，`--no-focus` 不抢焦点，成功自动打 label） | CLI `pane split` | 无 |
| `list` | 列 pane 摘要 + 本插件登记标记 | CLI `pane list` | 无 |
| `read` | 取屏，回执带 `revision` / `truncated` | **socket** `pane.read` | `pane_id` |
| `wait` | 等输出：`match` 字面量 / `regex` 正则 / `stable` 静默判稳（三选一） | CLI `wait-output`（前两者）/ **socket**（`stable`） | `pane_id` + 三者之一 |
| `send_text` | 注入字面量文本（**不回车**） | CLI `pane send-text` | `pane_id`、`text` |
| `send_keys` | 发按键（如 `["ctrl+c"]` / `["esc"]` / `["up"]`） | CLI `pane send-keys` | `pane_id`、`keys` |
| `run` | 文本 + 回车一次提交 | CLI `pane run` | `pane_id`、`command` |
| `label` | 打 / 清归属标记（显式空串 = 清除） | CLI `pane rename` | `pane_id` |
| `info` | 进程探活（`foreground_processes` / `shell_pid` / `running`） | CLI `pane process-info` | `pane_id` |
| `close` | 关闭 pane（`force` 需配置 `allowForeignPanes: true`） | CLI `pane close` | `pane_id` |

### 通道划分（为什么只有读走 socket）

CLI 与 socket 两面都可用；socket 相对 CLI 的**硬优势只有一处** —— `pane.read` 返回 `revision` / `truncated`，而 CLI 的 `pane read` 只输出纯文本。因此：

- `read` 走 socket（拿 `revision` / `truncated`）；
- `wait` 的 `stable` 走 socket（相邻两次 `revision` 相同即判稳；服务端未给 `revision` 时回退文本比对）；
- 其余动作走 CLI（参数校验失败更早、漂移面更浅、退出清理天然同步、代码与测试面更薄）。

CLI 调用一律 `spawn(bin, args)` **参数数组、不过 shell**：模型给的文本是 argv 元素，不做字符串拼接，避免二次解释。

## 参数

| 动作 | 参数 |
| --- | --- |
| `create` | `direction?`（`right` / `down`；缺省按 `pane layout` 宽高自动选）· `cwd?`（缺省继承 dsh 进程 cwd）· `label?`（缺省配置 `label`） |
| `list` | `workspace?` |
| `read` | `pane_id` · `source?`（缺省 `recent-unwrapped`）· `lines?`（缺省 120）· `format?`（缺省 `text`） |
| `wait` | `pane_id` · `match?` / `regex?` / `stable?`（三选一，互斥）· `settle_ms?`（缺省 400）· `source?` / `lines?` · `timeout_ms?`（缺省 30000） |
| `send_text` | `pane_id` · `text` |
| `send_keys` | `pane_id` · `keys`（非空字符串数组） |
| `run` | `pane_id` · `command` |
| `label` | `pane_id` · `label?`（缺省写配置值；显式空串清除） |
| `info` | `pane_id` |
| `close` | `pane_id` · `force?` |

取屏口径：缺省 `recent-unwrapped`（官方技能给日志与转录的首选，软换行已拼接）、120 行、剥 ANSI；**TUI / alternate-screen 程序改用 `visible`**（alternate-screen 的行不进普通 scrollback）；`format=ansi` 仅在需要颜色证据时用。

等待与超时：`match` / `regex` 由**服务端**完成（先搜既有输出再轮询，无需自建轮询循环）；`stable` 以 `revision` 判稳（`settle_ms` 间隔 + `timeout_ms` 兜底）。**超时返回结构化结果（`ok: false` + `code: "timeout"`），不抛错**，回执带可操作的放宽提示。

输出截断：回执按 `renderLimit`（缺省 200 行 / 16000 字符）截断并提示用 `lines` / `source` 收窄；截断只影响显示，不改库面数据。

## 配置（`cordis.patch.yml` 的 `config`）

| 键 | 缺省 | 说明 |
| --- | --- | --- |
| `requireApproval` | `"foreign"` | `foreign` 只对**非本插件创建**的 pane 动输入 / 关闭时审批；`always` 每次输入 / 关闭都弹；`never` 从不弹（仍有 guard 硬拒层与归属限制） |
| `allowForeignPanes` | `false` | 写类动作的归属限制总开关：打开后允许对**非自建** pane 动输入 / 关闭（`close` 另需 `force: true`；审批仍按 `requireApproval` 档先打断一次） |
| `closeOnExit` | `true` | dsh 退出时关闭本次创建的 pane（要保留现场供退出后查看的部署置 `false`，残留靠 label 清理） |
| `label` | `"dsh-pane"` | 归属标记（`create` 成功后自动打一次，便于识别崩溃残留） |
| `timeoutMs` | `10000` | 单次 CLI / socket 请求上限 |
| `renderLimit` | `{lines: 200, chars: 16000}` | 回执渲染上限（可只给一项） |

非法 / 缺失值一律回退缺省，不抛错（`resolveConfig`）。

## 归属与生命周期

- **写类动作**（`send_text` / `send_keys` / `run` / `label` / `close`，以及 `stable` 模式的 `wait`）缺省只作用于**本插件创建并登记**的 pane；配置 `allowForeignPanes: true` 可放宽这条限制（此时审批门按 `requireApproval` 档先打断一次，`close` 另需 `force: true`）；**读类**（`read` / `info`）可读任意 pane；**永不使用「当前聚焦 pane」**（官方技能：不依赖别的客户端的焦点）。
- `create` 成功后自动 `pane rename` 打一次 label；打标失败只记 `注：`，不回滚创建。
- 关非自建 pane 需**同时**满足配置 `allowForeignPanes: true` 与 `close` 的 `force: true`，且仍受审批档约束（破坏性动作多一道显式信号）。
- 正常退出（含 TUI 的 `/quit` → `process.exit`）按 `closeOnExit` 用 `spawnSync` 同步尽力关闭**登记过的** pane；崩溃 / `kill -9` 残留靠 label 识别（`herdr pane list` 与本工具 `list` 都能看到），再显式 `close`。
- 同 pane 的操作串行化（并发调用不交叉）；不同 pane 互不阻塞。

## 降级口径（非 herdr 环境）

握手三变量 `HERDR_ENV=1` + `HERDR_SOCKET_PATH` + `HERDR_PANE_ID` 缺一即**不注册工具**，只记一行日志（与同族 `herdr-integration` 的空转口径一致）；二进制定位顺序为「显式配置 → `HERDR_BIN_PATH` → PATH 上的 `herdr`」，解析不到同样不注册。

理由：不在 herdr 内是**运行位置决定的**、本机不可修，注册一个必然失败的工具只会诱使模型反复试错并污染工具面（对照 `ast-tools`：二进制缺失是本机可修的，故它注册降级工具给安装指引）。

## 安全边界（三闸）

命令跑在 herdr 服务端的 pane 里、**在 dsh 进程之外，不受 dsh 文件沙箱约束**，因此不能指望沙箱兜底：

1. **guard 复查**（本包本地加固）：执行前 `ctx.get("guard")?.inspectCommand(text, "herdr-pane:<action>")` —— 返回 `null` 放行，非空字符串即命中（按 deny 回执、不执行）；服务缺失 / 调用抛错 → 告警一次后**照常执行**（fail-open，与 TUI `$` 模式同口径）。待检文本 = `run` 的 `command` / `send_text` 的 `text` / `send_keys` 的 `keys`。
2. **`security-guard` 登记**（跨包，闸②）：`PLUGIN_COMMAND_TOOLS.herdr_pane = { commandKeys: ["command", "text"], commandPaths: ["keys[]"] }`。命令跑在沙箱之外，这一层是硬拒的落点；**该登记由条目「登记两个新插件工具的命令参数面（`script_run` / `herdr_pane`）」在 `security-guard` 侧落地**，本包只保证参数面与登记形态一致（数组参数必须走 `commandPaths`，`commandKeys` 会静默忽略数组值）。
3. **越界审批**（闸③）：`tools/pre-execute` 监听器对「对非自建 pane 动输入 / 关闭」返回 `{kind: "ask", reason}`，由宿主路由到审批 UI；无审批服务时自动 fail-closed。缺省档 `foreign` —— 自有 pane 上的动作与官方 bash 工具同级（命令执行不逐次审批），一旦要动用户的 pane 则打断一次。

归属拒绝与 guard 拒绝都给**结构化回执 + 放行方式**（怎么建自建 pane、怎么开 `allowForeignPanes`、回执里的 security-guard 说明）。

## 库面

```ts
import { createHerdrPlugin, dispatchAction } from "@dsh-toolset/herdr-pane";

const plugin = createHerdrPlugin(ctx, { label: "dsh-pane" });
if (plugin) {
  const result = await dispatchAction(
    "run",
    { pane_id: plugin.registry.panes[0].paneId, command: "just test" },
    plugin.deps,
  );
}
```

- `createHerdrPlugin(ctx, config, deps?)` → `{ registry, config, deps, cleanup, dispose }`（非 herdr 环境返回 `undefined`）。
- `dispatchAction(action, args, deps)` 是**唯一执行入口**（工具面、真机脚本、库面消费者都走它）。
- `deps` 全部可注入（`runner` / `reader` / `connector` / `clock` / `guardCheck` / `env`），单测不需要真机 herdr。

## 测试与验证

- 单测（不进 CI 依赖，注入 fake runner / fake reader / 假时钟 / 假 socket 连接器）：

  ```sh
  npm --prefix herdr-pane run check
  npm --prefix herdr-pane run test
  ```

  八个用例文件：`cli`（握手 / 二进制定位 / 信封解析 / 退出码 / 子进程执行面的参数直通与超时）、`socket`（报文拼装 / 响应解析 / 判稳三例）、`net`（真实 unix socket：分片 framing / 超时 / 连接失败）、`actions`（十动作 argv 与结果解析 / 归属与 `allowForeignPanes` / 串行化 / guard 拒绝）、`registry`（登记 / label / 退出清理 / 串行队列）、`policy`（归属 / 审批三档 / fail-open）、`main`（握手不注册 / 工具注册 / 审批门 / 通道注入）、`tool`（定义契约 / 渲染 / 截断）。

- 真机端到端（**人工跑、不进 CI**，必须在 herdr 管理的 pane 内）：

  ```sh
  npm --prefix herdr-pane run build
  node herdr-pane/scripts/verify-herdr-pane.mjs            # 全自动，跑完即关 pane
  node herdr-pane/scripts/verify-herdr-pane.mjs --keep     # 保留 pane 供人工看
  node herdr-pane/scripts/verify-herdr-pane.mjs --with-python  # 额外验 python3 -i 的 REPL 场景
  ```

  覆盖 `create → read → send_text → send_keys → wait(match) → run → wait(stable) → info → label → list → close`，并核对「调用者焦点未被抢走」与「正常退出后无本次创建的 pane」。

## 与相邻能力的分工

- **TUI `$` 模式**：人用、非交互、不经模型、占不到 pane —— 与本包不重叠。
- **脚本语言解释器插件**：一次性非交互执行（收 stdout / stderr / 退出码）—— 一条命令能跑完的用它 / 宿主 bash 工具，需要看屏幕与按键时序的用本包。
- **tmux 条目**：目标同构、底床不同；只约定动作名（`create / list / read / wait / send_text / send_keys / run / close`，本包另有 `label` / `info`），不建公共层。
- **同事模型群组的编排协议**：需要可编程底床面 —— 本包的**库面**可直接 `link:` 依赖调用，不必经模型工具。

## 已知边界

- 不支持 `--machine` / `--session`（跨服务器 / 命名会话目标）；不碰布局类动作（`focus` / `resize` / `zoom` / `swap` / `move` / `scroll` / `input`）；不驱动「被 herdr 识别的 agent」面（`herdr agent prompt|wait|start`）；不订阅 socket 事件。
- 不做沙箱模式联动（会话 `read-only` 时自动拒写类动作）：会话初始模式在无事件时无从判定，猜错就是把闸门做成误拦或空设 —— 首期用「归属 + guard + 审批」覆盖，二期另立条目。
- 不做残留 pane 的后台清理守护（属「后台常驻守护机制」条目范围）。
- `format=ansi` 的颜色语义首期不验。
