# @dsh-toolset/security-guard

DSH（DeepSeek Harness）进程内安全守卫插件：危险命令黑名单拦截 + 敏感文件保护策略层。

挂在宿主 `tools/pre-execute` 水位线（命令**下发前**）：命中即返回 `{kind:"deny", reason}`，宿主把工具调用物化为带 `Error: ` 前缀的 `isError: true` 结果且不下发命令；回执含拦截原因与放行方式。默认策略**保守（宁可误拦不可漏拦）**：非法黑名单正则按命中处理，非法放行正则按不放行处理。

## 能力

### 拦截面

| 层 | 覆盖 | 默认规则 |
| --- | --- | --- |
| 命令黑名单 | `bash` / `shell` / `pwsh` 的 `command` 或 `script`；`run_code` 的 `code` 或 `program`；插件命令工具（`PLUGIN_COMMAND_TOOLS`）登记的命令参数：`metric_loop` 的 `measureCmd`、`task_decompose` 的 `children[].executor.command` 与 `children[].acceptance[].command` | 15 条：`rm -rf /` 族、`curl \| sh` 族、`chmod 777` 系统目录、`sudo`、fork 炸弹、`dd` 裸盘写入、`mkfs`、`wipefs`、分区工具、重启关机、`find -delete`、`crontab -r`、`iptables -F`、kill PID 1 |
| 敏感文件 | shell 命令文本中提取的路径（含 `workdir`）；插件命令工具命令文本中提取的路径（同口径）；文件工具 `read` / `read_image` / `write` / `edit` / `patch` / `grep` / `glob` 的 `file_path` / `path` / `target` / `file` 参数；插件工具 `hash_edit` / `md_logic` / `ast_replace`（写侧）与 `ast_query` / `hash_read` / `fs_digest` / `code_map` / `md_map`（读侧）的登记路径参数 | 26 条：`.ssh`、`.aws`、`.gnupg`、`.kube`、`gh`、`gcloud`、`docker config`、`kubeconfig` 目录；`.netrc`、`.git-credentials`、`.npmrc`、`.pypirc` 凭据文件；`.env` 族；`*.pem` / `*.key` / `*.p12` / `*.pfx` / `*.jks` / `*.keystore` / `id_rsa` 族 / GCP `credentials.json` / service-account |

- 复合命令（`;` `|` `&` 换行）按段词法分析；`run_code` 与引号内嵌命令另有整文本兜底。路径提取是保守超集（成对引号串、裸 token、`~/` 前缀、绝对路径子串四类），归一化时去引号、展开 `~` / `$HOME` / `${HOME}`、折叠 `//`。
- 两层独立：`allowPatterns` 只放开命令层，`allowedPaths` 只放开敏感文件层；放行了黑名单命令若仍含敏感路径，依旧被拦。
- 插件工具（`src/index.ts` 的 `PLUGIN_FILE_TOOLS` 登记表，按各工具**真实参数面**登记）：`hash_edit` 的 `path`（整文件重写，写侧）；`md_logic` 的 `path`（`action=replace` 写侧，`structure` / `blocks` / `links` 按读侧，与官方 `read` / `grep` / `glob` 同口径）；`ast_replace` 的 `path`（单文件写回，写侧，该工具**没有** `paths`）；`ast_query` 的 `path`（`search` / `outline`）与 `paths`（`rules`，数组逐元素取 string，**读侧**）。路径解析与敏感文件层与官方文件工具同一口径，回执工具名带 action（如 `md_logic replace`）。
- **读面插件工具**（与官方 `read` / `grep` / `glob` 同口径）：`ast_query` 的 `path`（`search` / `outline`，见上）；`hash_read` 的 `path`（读工具，返回行内容与 LINE:HASH 锚点）；`fs_digest` 的 `path`（读文件做摘要）；`code_map` 的 `root`（`index` / `refresh` 扫目录建索引，缺省 cwd）；`md_map` 的 `root`（建索引，缺省 cwd）与 `path`（`callers` / `impact` 的目标文档）。**行为变化**：这四个工具（`hash_read` / `fs_digest` / `code_map` / `md_map`）此前未登记、读任何路径都放行，现登记后读敏感名路径（`.env` / `id_rsa` / `~/.ssh` 等）会被拦，回执为读侧措辞 + 工具名；读普通路径仍放行。四者真实参数面均无数组路径参数，故不登记 `pathArrayKeys`。
- **官方读面工具 `read_image`**（图片读取，参数 `file_path`）：与 `read` 同级过敏感文件层读侧口径——读敏感名路径（`.env` / `id_rsa` / `~/.ssh` 等）被拦，回执为读侧措辞 + 规则 id + 工具名；读普通路径放行。
- **插件命令面**（`src/index.ts` 的 `PLUGIN_COMMAND_TOOLS` 登记表，按各包**真实参数面**读码登记）：`metric_loop` 的 `measureCmd`（`action=start` 时经 `/bin/sh -c` 执行，`metric-loop/src/measure.ts`）；`task_decompose` 的 `children[].executor.command`（command 后端的执行命令）与 `children[].acceptance[].command`（mechanical 验收命令）。命令文本走与 `bash` **同一**命令黑名单层与路径抽取（`allowPatterns` 同样生效），命令层回执前置一行来源标注（工具名 + 命令参数路径），敏感层回执按 shell 同口径标「读写」。命令的**执行**在 `task_execute` / `task_stop`，但**检查点**落在声明处 `task_decompose`（前两者的入参只有 `task_id`，不含命令文本）。
- **未登记工具缺省不拦**：覆盖范围是显式白名单——官方文件工具、shell 工具与两张插件登记表（`PLUGIN_FILE_TOOLS` 路径面 / `PLUGIN_COMMAND_TOOLS` 命令面）里的插件工具；其他工具名（含本仓其它只读插件工具，如 `context_report` / `rule_list`）缺省不参与判定，可用 `unknownToolPolicy: "check"` / `"deny"` + `unknownToolAllowlist` 收紧（见「边界与限制」）。登记表只覆盖**登记的参数键**：`metric_loop` 仅 `measureCmd` 参与，`task_decompose` 仅上述两条嵌套命令路径参与（`executor.cwd` / `spec` 等参数不参与）。未识别的工具名或参数缺失一律放行（不猜测语义）。工具名按自身属性查表（`Object.hasOwn`），故 `constructor` / `toString` / `valueOf` 这类原型链属性名视同未登记 → 放行。新增插件工具需按真实参数面在对应登记表登记。
- 只读查询面 `provide('guard')`：`recent()` 返回最近拦截记录（上限 200，新在前），`policy()` 返回当前开关、**未登记工具策略快照**（`unknownToolPolicy` 的原始值 / 生效值 / 是否非法 + `unknownToolAllowlist`）、生效规则（id / reason）与放行正则源，供 TUI `/guard` 等接线方消费（TUI 尚未渲染策略字段，服务面已暴露）。（服务面另暴露 `inspectCommand(command, source?)`：命令层复查入口，供其它插件在执行前自助复查）

### 回执示例

命令层：

```
[security-guard] 已拦截：命令命中黑名单规则「sudo」。
命令：sudo ls /
原因：提权（sudo）执行，超出本会话的权限边界。
放行方式：在该 profile 的 cordis.patch.yml 的 security-guard 条目 config 下，向 commandBlacklist.allowPatterns 追加一条能匹配该命令的正则，重载/重启会话后生效；或改写为等价的安全命令。
```

插件命令工具（前置一行来源标注，其余与命令层一致）：

```
[security-guard] 拦截来源：插件命令工具「metric_loop」的命令参数（measureCmd）。
[security-guard] 已拦截：命令命中黑名单规则「sudo」。
命令：sudo ls /
原因：提权（sudo）执行，超出本会话的权限边界。
放行方式：在该 profile 的 cordis.patch.yml 的 security-guard 条目 config 下，向 commandBlacklist.allowPatterns 追加一条能匹配该命令的正则，重载/重启会话后生效；或改写为等价的安全命令。
```

敏感文件层：

```
[security-guard] 已拦截：读取敏感文件「/home/user/.ssh/id_rsa」命中规则「ssh-directory」。
工具：read
原因：OpenSSH 凭据目录（私钥、known_hosts、配置）。
放行方式：在该 profile 的 cordis.patch.yml 的 security-guard 条目 config 下，向 sensitiveFiles.allowedPaths 追加该路径（或其父目录前缀），重载/重启会话后生效。
```

插件写工具（工具名带 action，读写面按 action 判定）：

```
[security-guard] 已拦截：写入敏感文件「/home/user/notes/.env」命中规则「env-file」。
工具：md_logic replace
原因：env 环境变量文件（可能含密钥）。
放行方式：在该 profile 的 cordis.patch.yml 的 security-guard 条目 config 下，向 sensitiveFiles.allowedPaths 追加该路径（或其父目录前缀），重载/重启会话后生效。
```

## 配置

```yaml
- id: security-guard
  name: '@dsh-toolset/security-guard'
  config:
    enabled: true                 # 总开关（默认 true）
    homeDir: /home/user           # ~ / $HOME 展开用的家目录（默认 os.homedir()）
    commandBlacklist:
      enabled: true               # 命令层开关（默认 true）
      rules:                      # 追加黑名单正则（内置规则不可移除，只能追加）
        - '^git push --force$'
      allowPatterns:              # 放行正则：匹配则跳过命令层（非法正则忽略=不放行）
        - '^sudo ls /$'
    sensitiveFiles:
      enabled: true               # 敏感文件层开关（默认 true）
      rules:                      # 追加保护路径（字面前缀或 glob：* 单层、** 多层、? 单字符）
        - '~/.vault/**'
      allowedPaths:               # 放行路径（同一字面/glob 语义）
        - '~/.ssh'
    unknownToolPolicy: check      # 未登记工具策略：allow（缺省，一律放行）| check（按键类定向复检）| deny（整工具拦）
    unknownToolAllowlist:         # 未登记工具放行名单：精确匹配 + `*` 结尾前缀通配；三态之前判定
      - present
      - 'mcp__*'
```

追加规则不校验语义，只做编译；非法规则源按命中处理。配置改动需重载/重启会话生效。

## 使用示例

包自带 `cordis.patch.yml`（由 `package.json` 的 `dsh.bundle.patch` 声明，loader 自动合并；`tools` 服务存在时才挂载）：

```yaml
- insert:
    - id: security-guard
      name: '@dsh-toolset/security-guard'
```

profile 侧以 `link:` 依赖指向本包即可（勿用 `file:`，pnpm v11 不跟踪目录变化）。放行方式是在该 profile 的 `cordis.patch.yml` 的 `security-guard` 条目 `config` 下追加规则或放行模式（见上文配置参考），重载/重启后生效。

## 边界与限制

- **普通正则类规则对整段文本匹配**：`echo "sudo is a tool"` 会命中 `sudo` 规则；`run_code` 的 `code` 文本整体过黑名单，代码字符串里出现危险命令字样即拦。
- 路径提取是保守超集（裸 token 也参与 basename 规则匹配），故可能比真实语义多拦。
- 规则只覆盖显式列出的工具与参数键；其他工具、其他参数名不参与判定。
- `root` 类目录参数只按传入路径**本身**过敏感层，不扫描目录内容：`code_map` / `md_map` 的 `root` 指向普通目录时放行（即使该目录下含 `.env`），指向 `~/.ssh` 这类敏感目录本身则拦。
- **命令来自状态文件时：执行前复查（2026-10-02 收口）**：`metric_loop` 的 `tick` 执行的命令取自状态文件
  （不在工具入参里），现在由 `metric_loop` 在**执行之前**经可选服务 `ctx.get("guard")` 复查 —— 走
  `GuardEngine.inspectCommand(command, source)`，与 `bash` 同一套命令黑名单与命令内路径敏感层（`allowPatterns` /
  `allowedPaths` 同样生效），命中即不测量、不落盘。**未挂载 guard 时 fail-open（告警一次）**，与修复前行为一致
  （不回归）；`metric-loop` 直连 `createController()` 的路径默认不带复查器。
- **未登记工具：三态策略 + 放行名单**（2026-10-02）：覆盖是**显式白名单**（官方 shell / run_code / 文件工具 + 两张插件登记表）。
  - `unknownToolPolicy: "allow"`（缺省）= 与历史行为逐字一致（未登记工具一律放行）。
  - `unknownToolPolicy: "check"`：**不整工具硬拦**，把 watched 键下的字符串值（含数组元素）**按键类定向**送既有两层，命中才拦：
    路径键（`file_path` / `path` / `target` / `file` / `paths` / `dir` / `directory` / `root` / `workdir` / `cwd` / `filePath`，键名按小写归一）
    → 敏感文件层，回执前置一行「路径复查来源：未登记工具「X」的 \<键名>」；
    命令键（`command` / `measureCmd` / `cmd`，值是 shell 命令串）→ 命令黑名单层，前置「命令复查来源」行；
    代码键（`script` / `code` / `program`，值是 JS/Python 代码）→ **只做路径提取**后过敏感文件层、**不整段送命令层**
    （代码里的危险词字面不算执行该命令，避免把 `workflow.script` / `run_code.code` 这类正常代码误拦）；
    另有**值面**兜底：非 watched 键下以 `cwd:` 前缀或 `/`、`~/`、`$HOME` 开头的字符串值也按路径判定（覆盖 `session_channel.to = "cwd:…"` 这类）。
    两层放行面（`commandBlacklist.allowPatterns` / `sensitiveFiles.allowedPaths`）在 check 下与已登记工具同口径生效。
  - `unknownToolPolicy: "deny"`：整工具拦，且**只拦「携带潜在路径/命令/代码参数」的未登记工具**（键名启发，键集同上；**键深上限 3 层**：顶层键 → 数组元素键 → 其对象成员键 → 再一层数组元素键，**数组层不计数**、数组透明不消费键深 —— 详见下方「键发现深度与遍历上限」），
    其余未登记工具仍放行（防误伤）；回执给三条**可行动作**（改 `"check"` / 加 `unknownToolAllowlist` / 按参数面登记进代码），不再只说「改源码」。
  - `unknownToolAllowlist: string[]`：工具名**精确匹配** + `*` 结尾**前缀通配**（如 `mcp__*`），在**三态策略之前**判定，命中即无条件放行
    （`deny` 下的显式例外 / MCP 工具名）；只作用于未登记工具，已登记工具的敏感参数照拦。
  - 非法 `unknownToolPolicy` 值（如 `"Deny"` / `true`）→ `console.warn` 一次 + 按 `"allow"` 生效（fail-open 语义不变），
    `policy()` 快照标 `invalid: true`（TUI 侧尚未渲染该字段，服务面已暴露供后续消费）。
  - **键发现深度与遍历上限**：键深上限 **3 层**（顶层键 → 数组元素键 → 其对象成员键 → 再一层数组元素键；**数组层不计数** —— 数组透明、不消费键深；`WeakSet` 跳过环引用）：`children[].executor.command` 与 `children[].acceptance[].command` 都在覆盖内，第 4 层起的同形嵌套不纳入（锁上限语义，避免深层误伤）。键发现递归与 `check` 模式的值面扫描共用同一遍历器（深度口径不分叉），并另设**资源上限**（与键深是两个维度）：**容器节点 ≤ 4096**（对象 / 数组各算 1 个节点，**标量不计**）+ **嵌套层数 ≤ 64**（数组透明不消费键深，但深数组照样加深递归栈，实测本遍历器 ~3500 层即 `RangeError`）。`TOOL_SURFACE.keyDepth` 暴露键深上限，脚本与引擎同源。
  - **上限耗尽时保守（不是放行）**：遍历被截断时**绝不**当成「没查到 = 放行」—— `deny` 直接拦、`check` **告警一次 + 按拦处理**（回执说明「参数面超出遍历上限」并给放行方式）；因此「无害填充 + 更深处危险键」的规避不成立（填充量远小于节点上限，且截断本身也拦）。仅**扫描抛异常**（畸形参数，如枚举即抛错的 `Proxy`）才 fail-open：`console.warn` 一次 + 放行，绝不让 `inspect` 把异常抛到宿主 listener（否则一个畸形参数就能把 `pre-execute` 打崩）。
- **差异检查（宿主升版后跑一次）**：`node security-guard/scripts/tool-surface-check.mjs --root <dsh 包目录> [--json]`
  （也认 `DSH_INSTALL=<同上>`）。**要指 dsh 包目录**（其下含 `node_modules/@deepseek-ai/dsh-tool-*`）；指到 `@deepseek-ai` scope 层
  （或其下直接是 `dsh-tool-*` 的目录）会给纠正提示并 **exit 2**（扫 scope 层会把未挂载 / 其它版本的工具包算进来）。
  脚本**逐工具**解析工具包源码 `defineTool({...})` 的 `parameters`（顶层键即参数名；数组经 `items` 透明、与数组同层；**参数发现深度取自引擎单一来源 `TOOL_SURFACE.keyDepth`**（读不到该字段即 exit 2，与键集同口径）；`properties` / `items.properties` / 直接对象字面量三类形态都递归下钻，另有分析步数上限防病态嵌套），
  输出「已覆盖 / **需关注**（未登记且带路径·命令·代码参数）/ **名称未解析**（`name:` 为计算值，单列包名与 name 表达式；其参数键命中 watched 键时同时计入门禁）
  / 未覆盖但无相关参数」。退出码：有「需关注」→ 1（可作门禁），干净 → 0，用法 / 环境错误（缺 `--root`、指到 scope 层、root 下无工具包）→ 2。
  键集与登记集来自 `src/index.ts` 的 `TOOL_SURFACE` 快照（发布形态读 `dist`，`src` 作仓库内回退；`dist` 早于 `src` 时提示并改读 `src`），
  与引擎**单一来源**、不再各自维护一份键表（旧版脚本与引擎键集互不一致）。仍按「宁可多报」口径，需人工复核。
- **命令执行侧的检查点边界**：task-engine 的命令（`children[].executor.command` 与 mechanical 验收 `children[].acceptance[].command`）在 `task_decompose` **声明处**检查，而执行工具 `task_execute` / `task_stop` 的入参只有 `task_id`、命令文本不在其中。因此**绕过声明工具**进入帧契约的命令不受本层覆盖：经导出 API `resumeFromSnapshot` 恢复的帧（本仓插件**当前未接线**：只写快照、不读回）、配置侧 `root.acceptance[].command`（引擎直接执行、不经 `task_decompose`），以及其它直接写引擎状态/旁路的路径。此外 `workflow` 后端的 `script` 是 JS 编排脚本（非 shell 命令串），不在命令黑名单层覆盖范围内——未登记工具策略取 `"check"` 时对代码键（`script` / `code` / `program`）也只做路径提取、不整段送命令层（同一口径）。
- **插件命令参数按参数键检查、不区分 action**：`metric_loop` 的 `measureCmd` 只在 `action=start` 时执行，但登记表按参数键判定——`action=status` 等调用若带上会命中黑名单的 `measureCmd` 同样被拦（宁可误拦不可漏拦；可用 `commandBlacklist.allowPatterns` 放行）。
- `run_code` 只过命令层，不做路径层检查；文件工具的路径参数只过敏感层，不做命令层检查。
- 拦截是**策略层**，不是沙箱：放行后命令以宿主既有权限执行，进程级隔离由宿主策略承载。

## 测试

```sh
npm run check   # tsc -p tsconfig.json --noEmit
npm run test    # node --experimental-transform-types --test 'tests/*.test.ts'（99 例）
npm run build   # tsc -p tsconfig.json → dist/
npm run smoke   # node smoke/smoke.mjs（真实 dsh headless 会话拦截验证）
```

99 例单测（blacklist 9 + guard 72 + script 11 + sensitive 7）。

`tests/script.test.ts` 用假宿主树（`dsh-tool-fixture-*` 包）覆盖 `scripts/tool-surface-check.mjs` 的逐工具三分类、
「名称未解析」行与退出码纪律（0 / 1 / 2，含 `--root` 指到 scope 层的纠正提示），并覆盖**发布形态**
（只有 `dist` + `scripts` → 键集来源 `dist`）与**损坏安装**（只有 `scripts` → exit 2 + 提示先 `npm run build`）；
另有**参数发现深度语义**两例（第 3 层形态计入「需关注」、第 4 层形态不计入，锁引擎 3 层上限）。
仓库内无 `dist` 时键集走 `src` 回退，故测试**不依赖**是否已构建（dist 存在时发布形态用例才运行）。

`smoke` 需要本机 dsh 0.2.0-rc.2、可用的模型 API 与 `zstd` CLI：建/复用 profile `dsh-toolset-security-guard`（`link:` 指向本包），在 `DSH_PERMISSION_MODE=danger-full-access` 下让权限层放行、由本插件独立拦截；headless 会话依次执行 `echo sg-smoke-ok` 与 `sudo ls /`，再解压 `session*.jsonl.zstd` 断言：`sudo ls /` 的结果 `isError` 且回执含 `[security-guard]` / `sudo ls /` / `放行方式`，`echo` 的结果 `isError: false`。模型自行改写或拒绝执行时，兜底为对 `dist/src/index.js` 的引擎直调断言。
