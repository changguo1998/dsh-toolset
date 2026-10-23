# @dsh-toolset/herdr-use

DSH（DeepSeek Harness）进程内集成插件：把 **herdr 的终端**（一个 tab + 它自带的 root pane）当作可控伪终端层 —— 建终端、注入文本 / 按键、取屏、等输出、进程探活、关闭，让需要「屏幕状态 + 按键时序」的交互式命令（TUI 程序、REPL、安装器、需要应答的命令）可被程序化驱动。

模型侧工具：**十个具名工具**（`herdr_list` / `herdr_read` / `herdr_info` / `herdr_wait` / `herdr_create` / `herdr_close` / `herdr_label` / `herdr_text` / `herdr_key` / `herdr_run`），工具即动作、无 `action` 参数。同时导出 `ctx.provide("herdrUse", …)` 服务面与库面，供编排类插件与真机验证脚本直接调用，不必经模型工具链。

契约与取舍见 `docs/implementation/2026-10-23-herdr-use-terminal-surface.md`（2026-10-23 终端面重构）；历史设计见 `herdr-use/docs/archived/2026-10-21-herdr-pane-tab-workspace.md`。本包按**轻量包**口径只留 `README.md` + `docs/BACKLOG.md`。

## 终端模型

- **一个终端 = 一个 tab + 它自带的 root pane**：`herdr_create` 内部调 `tab create --workspace <绑定> --cwd … --label … --no-focus`，取回执的 `.result.root_pane.pane_id` 作 `terminal_id`；`herdr_close` 关整个 tab 并注销登记。
- **工具面只露 `terminal_id`**：没有 pane / tab / workspace 概念，也没有 `tab_id`；登记表在进程内，dsh 重启后清空（残留终端靠 label 识别，需人工在 herdr 里关闭）。
- **lane**：`herdr_create` 的 `foreground` 缺省 `true`，终端落在父会话所在 herdr session；设 `false` 时落在名为 `dshbg` 的 herdr session，之后该终端的所有命令自动带 `--session dshbg`。
- **会话 ↔ workspace**：严格按 `(dsh session, lane)` 绑定，每个组合一个 workspace；label = `<会话 cwd 目录名>/<会话 id 末 8 位>`。workspace 的创建 / 查找 / 收尾都由程序完成，**不出工具面**。

### 后台 lane 前置（`dshbg`）

`--session dshbg` 只在 `dshbg` 的 herdr server 已运行时才可用（真机结论：herdr 的 `--session` 不是「使用或创建」）。因此后台 lane 的每条命令前，插件先 `herdr session list --json` 探测；缺会话时 detached 拉起 headless server（`herdr --session dshbg server`，stdio ignore + unref），轮询到 running（缺省 10s 上限）；成功后进程内缓存「已就绪」，后续后台命令不再探测。若某次后台命令报 server 不可达，清缓存，下一次后台操作重新探测并再拉起一次。

- **只拉起，不关闭**：不记「谁起的」、不 stop，退出清理也不碰它；要停用 `herdr session stop dshbg`，要手动起用 `herdr --session dshbg server`。
- 拉起超时 / 起不来时返回 `background-session-unavailable`（附 herdr 原文与下一步），**不会**静默退化到前台 lane。
- 探测与 spawn 可注入（`createBackgroundSession`）；并发后台命令共享同一次拉起（单飞）。

## 能力（10 个工具）

| 工具 | 作用 | 通道 | 必填 | 参数 |
| --- | --- | --- | --- | --- |
| `herdr_list` | 列两个 lane 的终端，逐条标 `foreground` / `registered` / `focused` / `pane_count` | CLI `tab list` + `pane list` | — | 无 |
| `herdr_read` | 取屏，回执带 `revision` / `truncated` | **socket** `pane.read` | `terminal_id` | `source?`（缺省 `recent-unwrapped`）· `lines?`（缺省 120）· `format?`（缺省 `text`） |
| `herdr_info` | 进程探活（`foreground_processes` / `shell_pid` / `running`） | CLI `pane process-info` | `terminal_id` | — |
| `herdr_wait` | 等输出：`match` 字面量 / `regex` 正则 / `stable` 静默判稳（三选一） | CLI `wait-output`（前两者）/ **socket**（`stable`） | `terminal_id` + 三者之一 | `match?` / `regex?` / `stable?`（互斥）· `settle_ms?`（缺省 400）· `timeout_ms?`（缺省 30000）· `source?` / `lines?` |
| `herdr_create` | 建终端（新 tab，`--no-focus`，自动打 label） | CLI `tab create` | — | `foreground?`（缺省 `true`）· `cwd?`（缺省会话工作目录）· `label?`（缺省配置 `label`） |
| `herdr_close` | 关整个终端（关 tab，注销登记） | CLI `tab close` | `terminal_id` | — |
| `herdr_label` | 同时改 tab 标题与 root pane label（非空） | CLI `tab rename` + `pane rename` | `terminal_id`、`label` | — |
| `herdr_text` | 注入字面量文本（**不回车**） | CLI `pane send-text` | `terminal_id`、`text` | — |
| `herdr_key` | 发按键（如 `["ctrl+c"]` / `["esc"]` / `["up"]`） | CLI `pane send-keys` | `terminal_id`、`keys`（非空字符串数组） | — |
| `herdr_run` | 文本 + 回车一次提交 | CLI `pane run` | `terminal_id`、`command` | — |

- 每个工具独立 schema（`additionalProperties: false`），模型看不到无关参数。
- 除 `herdr_list` 外都只接受**已登记**终端；未登记返回 `terminal-not-registered`。`herdr_list` 里 `registered: false` 的残留终端仅供识别。
- 内部仍由统一的 `dispatchAction` 实现，十个工具是十个薄壳：工具面与服务面同源。

### 通道划分（为什么只有读走 socket）

CLI 与 socket 两面都可用；socket 相对 CLI 的**硬优势只有一处** —— `pane.read` 返回 `revision` / `truncated`，而 CLI 的 `pane read` 只输出纯文本。因此：

- `herdr_read` 走 socket（拿 `revision` / `truncated`）；
- `herdr_wait` 的 `stable` 走 socket（相邻两次 `revision` 相同即判稳；服务端未给 `revision` 时回退文本比对）；
- 其余动作走 CLI（参数校验失败更早、漂移面更浅、退出清理天然同步、代码与测试面更薄）。

CLI 调用一律 `spawn(bin, args)` **参数数组、不过 shell**：模型给的文本是 argv 元素，不做字符串拼接，避免二次解释。background lane 的每条命令前置 `--session dshbg`（herdr 的语义是「使用或创建」）。

## 参数

取屏口径：缺省 `recent-unwrapped`（官方技能给日志与转录的首选，软换行已拼接）、120 行、剥 ANSI；**TUI / alternate-screen 程序改用 `visible`**；`format=ansi` 仅在需要颜色证据时用。

等待与超时：`match` / `regex` 由**服务端**完成（先搜既有输出再轮询，无需自建轮询循环）；`stable` 以 `revision` 判稳（`settle_ms` 间隔 + `timeout_ms` 兜底）。**超时返回结构化结果（`ok: false` + `code: "timeout"`），不抛错**。

输出截断：回执按 `renderLimit`（缺省 200 行 / 16000 字符）截断并提示用 `lines` / `source` 收窄；截断只影响显示，不改库面数据。

## 配置（`cordis.patch.yml` 的 `config`）

| 键 | 缺省 | 说明 |
| --- | --- | --- |
| `closeOnExit` | `true` | dsh 退出时关闭本次创建的终端（要保留现场供退出后查看的部署置 `false`，残留靠 label 清理） |
| `label` | `"dsh-pane"` | 归属标记（`herdr_create` 时写入新 tab 标题；`herdr_label` 会把 tab 标题与 pane label 一起改，便于识别崩溃残留） |
| `timeoutMs` | `10000` | 单次 CLI / socket 请求上限（启动探活另按 3s 封顶） |
| `renderLimit` | `{lines: 200, chars: 16000}` | 回执渲染上限（可只给一项） |

非法 / 缺失值一律回退缺省，不抛错（`resolveConfig`）。旧的 `requireApproval` / `allowForeignPanes` 已随终端抽象删除；旧 profile 里的残留键被静默忽略。

## 归属与生命周期

- **会话 ↔ workspace 绑定**：严格按 `(dsh session, lane)` 建绑定，不再进程内单例、子会话沿用。每次 `create` / `list` 前先 `workspace list` 复核绑定：workspace 已被关闭时清空绑定、按 label 重新匹配或新建。不引入持久存储。
- **写边界**：`herdr_create` 固定 `--workspace <绑定>`；`herdr_close` 只关**本插件登记**的终端；所有驱动动作只作用于登记终端，**永不使用「当前聚焦 pane」**。
- **调用者护栏**：继承 lane 下，`herdr_close` 拒绝关闭调用者自己所在的 tab（`HERDR_TAB_ID`）；`herdr_read` 拒绝读调用者自己的 pane。
- 正常退出（含 TUI 的 `/quit` → `process.exit`）按 `closeOnExit` 用 `spawnSync` 同步尽力关闭**登记过的**终端（`tab close`，background 带 `--session dshbg`）；随后若某绑定 workspace 内已无 pane，由程序内部 `workspace close` 掉它（唯一一处 workspace 关闭，不出工具面）。
- 同终端操作串行化（并发调用不交叉）；workspace 类动作（`herdr_create` / `herdr_list`）另有一把共享锁，避免并发建出两个 workspace。

## 服务面（`herdrUse`）

```ts
interface HerdrUseService {
  dispatch(action, args, context?): Promise<ActionResult>;
  list(context?); read(id, opts?, context?); info(id, context?); wait(id, opts?, context?);
  create(opts?, context?); close(id, context?); label(id, label, context?);
  text(id, text, context?); key(id, keys, context?); run(id, command, context?);
  isRegistered(id): boolean;
  readonly config: ResolvedConfig;
}
```

- 与十个工具**同源**：每个方法直接调 `dispatchAction(action, args, deps, context)`，共用同一份 registry 与写锁。
- 末参 `context` 可为宿主工具 `exec`、`{ session: { id, cwd } }` 或 `{ id, cwd }`（`readSessionContext` 三种形态都支持）；不传则返回 `session-unavailable`。
- 不暴露 registry，只给 `isRegistered` 与 `config`；**不经 `tools/pre-execute`**（进程内可信 API），但动作层仍校验归属、guard 复查仍生效。

## 降级口径（非 herdr 环境）

注册条件 = **二进制可解析** + **服务端可达**（`herdr status --json` 报 `server.status === "running"`），二者缺一即**不注册工具**、只记一行日志。`HERDR_*` 全部可选：dsh 不一定跑在 herdr 内（tmux / 普通终端均可）；在 herdr 内时这些变量只作上下文——`HERDR_PANE_ID`（不读调用者自己的 pane）、`HERDR_TAB_ID`（不关调用者所在 tab）、`HERDR_SOCKET_PATH`（foreground socket）、`HERDR_SESSION`（父会话所在 session，仅记录）。二进制定位顺序为「显式配置 → `HERDR_BIN_PATH` → PATH 上的 `herdr`」。

socket 路径解析顺序：foreground 用 `HERDR_SOCKET_PATH` → 探活报出的 `server.socket` → `$XDG_CONFIG_HOME/herdr/herdr.sock`；background 用 `--session dshbg status --json` 报出的 socket（首次用到才探活）。

## 安全边界（两道判定）

命令跑在 herdr 服务端的终端里、**在 dsh 进程之外，不受 dsh 文件沙箱约束**，因此不能指望沙箱兜底：

1. **guard 复查**（本包本地加固）：执行前 `ctx.get("guard")?.inspectCommand(text, "herdr-use:<action>")` —— 返回 `null` 放行，非空字符串即命中（按 deny 回执、不执行）；服务缺失 / 调用抛错 → 告警一次后**照常执行**（fail-open，与 TUI `$` 模式同口径）。待检文本 = `herdr_run` 的 `command` / `herdr_text` 的 `text` / `herdr_key` 的 `keys`。
2. **沙箱模式联动**：`tools/pre-execute` 里问宿主 `ctx.sandboxPolicy.resolve({ session })` —— 会话处于 `read-only` 时对 `herdr_create` / `herdr_label` / `herdr_text` / `herdr_key` / `herdr_run` / `herdr_close` 返回 `{kind: "deny", reason}`（文案含模式、工具、目标终端与 `/permission` 切换方式）；`herdr_list` / `herdr_read` / `herdr_info` / `herdr_wait` 放行。模式是宿主按会话从 `sandbox/mode` 事件回放出来的，重启 / resume 后仍正确；服务缺失 / 解析抛错 → 告警一次后**放行**（fail-open）。

外来 pane 审批门与 `allowForeignPanes` / `force` / `requireApproval` 已随终端抽象删除：工具面只有本插件登记的终端，没有「对别人对象动输入」这回事。归属拒绝与 guard 拒绝都给**结构化回执 + 放行方式**；错误码统一为 terminal 口径（`terminal-required` / `terminal-not-registered` / `ambiguous-terminal` 等）。

## 库面

```ts
import { createHerdrPlugin, dispatchAction } from "@dsh-toolset/herdr-use";

const plugin = createHerdrPlugin(ctx, { label: "dsh-pane" });
if (plugin) {
  // context 可为工具 exec / { session } / { id, cwd }
  const created = await plugin.service.create({ foreground: true }, { id, cwd });
  const id2 = created.ok ? created.payload.terminal_id : undefined;
  if (id2) await dispatchAction("run", { terminal_id: id2, command: "just test" }, plugin.deps, { id, cwd });
}
```

- `createHerdrPlugin(ctx, config, deps?)` → `{ registry, config, deps, service, cleanup, dispose }`（二进制缺失 / 服务端不可达返回 `undefined`）。
- `dispatchAction(action, args, deps, context?)` 是**唯一执行入口**（工具面、服务面、真机脚本都走它）；`list` / `create` 需要会话来定位本会话 workspace。
- `deps` 全部可注入（`runner` / `readerFor` / `connector` / `clock` / `guardCheck` / `sandboxMode` / `resolveSession` / `env` / `probe` / `readHandshake`），单测不需要真机 herdr。
- 绑定与登记面：`plugin.registry.getBinding(sessionId, lane)`、`plugin.registry.terminals`；服务面只给 `isRegistered`。

## 测试与验证

- 单测（注入 fake runner / fake reader / 假时钟 / 假 socket 连接器 / fake herdr 服务端）：

  ```sh
  npm --prefix herdr-use run check
  npm --prefix herdr-use run test
  ```

- 用例文件：`cli`（可用性握手 / 二进制定位 / 探活 / 信封解析 / 退出码）、`socket`（报文拼装 / 响应解析 / 判稳 / 缺省 socket 路径）、`net`（真实 unix socket：分片 framing / 超时 / 连接失败）、
  `actions`（十个动作 argv 与结果解析 / lane 前缀 / 归属拒绝 / list 聚合 / close 关 tab / 串行化 / guard 拒绝 / 后台会话就绪）、`registry`（登记 / 跨 lane 歧义 / 会话 × lane 绑定 / 退出清理）、
  `workspace`（label / 会话隔离 / 复用与重建 / 后台 lane）、`policy`（沙箱写类集合 / guard 与沙箱 fail-open）、`background`（探测 / 拉起 / 单飞 / 超时 / 缓存失效）、`main`（注册条件 / 十工具注册 / 服务面 / 沙箱门）、`tool`（十个 schema / 渲染 / 截断）、`service`（方法映射 / 同源 registry / 串行化 / context 三形态）。

- 真机端到端（**人工跑、不进 CI**，只需 herdr 二进制可解析 + 服务端在跑）：先 `npm --prefix herdr-use run build`，再跑 `node herdr-use/scripts/verify-herdr-use.mjs`（全自动，跑完即关终端）。开关：`--keep`（保留终端 / workspace 供人工看）、`--with-python`（额外验 `python3 -i` 的 REPL 场景）、`--background`（额外验 `foreground: false` 的 dshbg lane）、`--check-cascade`、`--session-id <id>`、`--cwd <dir>`。

- 覆盖链：`herdr_create → herdr_read → herdr_text + herdr_key(enter) → herdr_wait(match) → herdr_run → herdr_wait(stable) → herdr_info → herdr_label → herdr_list → herdr_close`（可选后台 lane），并核对「新终端落在本会话 workspace」「调用者焦点未被抢走」「正常退出后无本次创建的终端」。

## 与相邻能力的分工

- **TUI `$` 模式**：人用、非交互、不经模型、占不到终端 —— 与本包不重叠。
- **脚本语言解释器插件**：一次性非交互执行（收 stdout / stderr / 退出码）—— 一条命令能跑完的用它 / 宿主 bash 工具，需要看屏幕与按键时序的用本包。
- **tmux 条目**：目标同构、底床不同；只约定语义，不建公共层。
- **同事模型群组的编排协议**：需要可编程底床面 —— 本包的**服务面 / 库面**可直接依赖调用，不必经模型工具。

## 已知边界

- 不支持 `--machine`；background lane 固定 `dshbg`，不开放自定义 session 名。不碰布局类动作（`focus` / `resize` / `zoom` / `swap` / `move` / `scroll` / `input`）；不驱动「被 herdr 识别的 agent」面；不订阅 socket 事件。
- **workspace 面不暴露**：没有 workspace 工具与参数，回执也不带 workspace id / 名字；排障用 `herdr workspace list` 与本包回执里的 label 约定。
- **登记不持久**：`herdr_close` 只认本进程 `herdr_create` 建出的终端；dsh 重启后登记表为空，此前建的终端需人工在 herdr 里关闭（靠 label 识别残留）。
- **workspace 的 root pane 不登记为终端**：`workspace create` 自带的 root tab 会出现在 `herdr_list` 里且 `registered: false`；关掉本插件全部终端后该 workspace 仍有 pane，故退出清理不会关它（避免误伤用户后续打开的 pane）。
- **库面 / 服务面直调不受沙箱门约束**：`dispatchAction` 与服务面不经 `tools/pre-execute`，消费者需自行按会话模式决定是否调用。
- `tab rename` 只接受非空 label，故 `herdr_label` 不提供清空语义。
- 跨 lane 的 pane id 若碰撞，按 `terminal_id` 查找返回 `ambiguous-terminal`，需用 `herdr_list` 的 `foreground` 标记区分后重取。
- 不做残留终端 / workspace 的后台清理守护；`format=ansi` 的颜色语义首期不验。
