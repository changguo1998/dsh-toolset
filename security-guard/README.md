# @dsh-toolset/security-guard

DSH（DeepSeek Harness）进程内安全守卫插件：危险命令黑名单拦截 + 敏感文件保护策略层。

挂在宿主 `tools/pre-execute` 水位线（命令**下发前**）：命中即返回 `{kind:"deny", reason}`，宿主把工具调用物化为带 `Error: ` 前缀的 `isError: true` 结果且不下发命令；回执含拦截原因与放行方式。默认策略**保守（宁可误拦不可漏拦）**：非法黑名单正则按命中处理，非法放行正则按不放行处理。

## 能力

### 拦截面

| 层 | 覆盖 | 默认规则 |
| --- | --- | --- |
| 命令黑名单 | `bash` / `shell` / `pwsh` 的 `command` 或 `script`；`run_code` 的 `code` 或 `program`；插件命令工具（`PLUGIN_COMMAND_TOOLS`）登记的命令参数：`metric_loop` 的 `measureCmd`、`task_decompose` 的 `children[].executor.command` 与 `children[].acceptance[].command` | 15 条：`rm -rf /` 族、`curl \| sh` 族、`chmod 777` 系统目录、`sudo`、fork 炸弹、`dd` 裸盘写入、`mkfs`、`wipefs`、分区工具、重启关机、`find -delete`、`crontab -r`、`iptables -F`、kill PID 1 |
| 敏感文件 | shell 命令文本中提取的路径（含 `workdir`）；插件命令工具命令文本中提取的路径（同口径）；文件工具 `read` / `write` / `edit` / `patch` / `grep` / `glob` 的 `file_path` / `path` / `target` / `file` 参数；插件工具 `hash_edit` / `md_logic` / `ast_replace`（写侧）与 `ast_query` / `hash_read` / `fs_digest` / `code_map` / `md_map`（读侧）的登记路径参数 | 26 条：`.ssh`、`.aws`、`.gnupg`、`.kube`、`gh`、`gcloud`、`docker config`、`kubeconfig` 目录；`.netrc`、`.git-credentials`、`.npmrc`、`.pypirc` 凭据文件；`.env` 族；`*.pem` / `*.key` / `*.p12` / `*.pfx` / `*.jks` / `*.keystore` / `id_rsa` 族 / GCP `credentials.json` / service-account |

- 复合命令（`;` `|` `&` 换行）按段词法分析；`run_code` 与引号内嵌命令另有整文本兜底。路径提取是保守超集（成对引号串、裸 token、`~/` 前缀、绝对路径子串四类），归一化时去引号、展开 `~` / `$HOME` / `${HOME}`、折叠 `//`。
- 两层独立：`allowPatterns` 只放开命令层，`allowedPaths` 只放开敏感文件层；放行了黑名单命令若仍含敏感路径，依旧被拦。
- 插件工具（`src/index.ts` 的 `PLUGIN_FILE_TOOLS` 登记表，按各工具**真实参数面**登记）：`hash_edit` 的 `path`（整文件重写，写侧）；`md_logic` 的 `path`（`action=replace` 写侧，`structure` / `blocks` / `links` 按读侧，与官方 `read` / `grep` / `glob` 同口径）；`ast_replace` 的 `path`（单文件写回，写侧，该工具**没有** `paths`）；`ast_query` 的 `path`（`search` / `outline`）与 `paths`（`rules`，数组逐元素取 string，**读侧**）。路径解析与敏感文件层与官方文件工具同一口径，回执工具名带 action（如 `md_logic replace`）。
- **读面插件工具**（与官方 `read` / `grep` / `glob` 同口径）：`ast_query` 的 `path`（`search` / `outline`，见上）；`hash_read` 的 `path`（读工具，返回行内容与 LINE:HASH 锚点）；`fs_digest` 的 `path`（读文件做摘要）；`code_map` 的 `root`（`index` / `refresh` 扫目录建索引，缺省 cwd）；`md_map` 的 `root`（建索引，缺省 cwd）与 `path`（`callers` / `impact` 的目标文档）。**行为变化**：这四个工具（`hash_read` / `fs_digest` / `code_map` / `md_map`）此前未登记、读任何路径都放行，现登记后读敏感名路径（`.env` / `id_rsa` / `~/.ssh` 等）会被拦，回执为读侧措辞 + 工具名；读普通路径仍放行。四者真实参数面均无数组路径参数，故不登记 `pathArrayKeys`。
- **插件命令面**（`src/index.ts` 的 `PLUGIN_COMMAND_TOOLS` 登记表，按各包**真实参数面**读码登记）：`metric_loop` 的 `measureCmd`（`action=start` 时经 `/bin/sh -c` 执行，`metric-loop/src/measure.ts`）；`task_decompose` 的 `children[].executor.command`（command 后端的执行命令）与 `children[].acceptance[].command`（mechanical 验收命令）。命令文本走与 `bash` **同一**命令黑名单层与路径抽取（`allowPatterns` 同样生效），命令层回执前置一行来源标注（工具名 + 命令参数路径），敏感层回执按 shell 同口径标「读写」。命令的**执行**在 `task_execute` / `task_stop`，但**检查点**落在声明处 `task_decompose`（前两者的入参只有 `task_id`，不含命令文本）。
- **未登记工具仍不拦**（当前已知边界）：覆盖范围是显式白名单——官方文件工具、shell 工具与两张插件登记表（`PLUGIN_FILE_TOOLS` 路径面 / `PLUGIN_COMMAND_TOOLS` 命令面）里的插件工具；其他工具名（含本仓其它只读插件工具，如 `context_report` / `rule_list`）不参与判定。登记表只覆盖**登记的参数键**：`metric_loop` 仅 `measureCmd` 参与，`task_decompose` 仅上述两条嵌套命令路径参与（`executor.cwd` / `spec` 等参数不参与）。未识别的工具名或参数缺失一律放行（不猜测语义）。工具名按自身属性查表（`Object.hasOwn`），故 `constructor` / `toString` / `valueOf` 这类原型链属性名视同未登记 → 放行。新增插件工具需按真实参数面在对应登记表登记。
- 只读查询面 `provide('guard')`：`recent()` 返回最近拦截记录（上限 200，新在前），`policy()` 返回当前开关、生效规则（id / reason）与放行正则源，供 TUI `/guard` 等接线方消费。

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
- **命令来自状态文件时不经过本层**（已知边界）：`metric_loop` 的 `tick` 执行的命令取自状态文件
  （`~/.dsh/metric-loop/metric-loop-<id>.json`），不在任何工具入参里 → 本层只在 `measureCmd` 声明处
  （`action=start`）与 `task_decompose` 的 children 契约上判定。同一命令若先经 `write` 落地状态文件再
  `tick`，本层看不到（同类固有局限：「写脚本再执行」亦如此，但那条至少经 `bash` 工具可见）。加固方向：
  执行前对 `spec.measureCmd` 复查黑名单（待办见 `docs/BACKLOG.md`）。
- **未登记工具仍不拦**是当前已知边界：插件工具靠 `PLUGIN_FILE_TOOLS`（路径面：写面 `hash_edit` / `md_logic` / `ast_replace`，读面 `ast_query` / `hash_read` / `fs_digest` / `code_map` / `md_map`）与 `PLUGIN_COMMAND_TOOLS`（命令面：`metric_loop` / `task_decompose`）两张白名单登记，未登记的插件工具（如 `context_report` / `rule_list`）不会被拦；新增工具时需按**真实参数面**同步登记。
- **命令执行侧的检查点边界**：task-engine 的命令（`children[].executor.command` 与 mechanical 验收 `children[].acceptance[].command`）在 `task_decompose` **声明处**检查，而执行工具 `task_execute` / `task_stop` 的入参只有 `task_id`、命令文本不在其中。因此**绕过声明工具**进入帧契约的命令不受本层覆盖：从 `snapshotPath` 快照恢复的既有帧、配置侧 `root.acceptance[].command`（引擎直接执行、不经 `task_decompose`），以及其它直接写引擎状态/旁路的路径。此外 `workflow` 后端的 `script` 是 JS 编排脚本（非 shell 命令串），也不在命令黑名单层覆盖范围内。
- **插件命令参数按参数键检查、不区分 action**：`metric_loop` 的 `measureCmd` 只在 `action=start` 时执行，但登记表按参数键判定——`action=status` 等调用若带上会命中黑名单的 `measureCmd` 同样被拦（宁可误拦不可漏拦；可用 `commandBlacklist.allowPatterns` 放行）。
- `run_code` 只过命令层，不做路径层检查；文件工具的路径参数只过敏感层，不做命令层检查。
- 拦截是**策略层**，不是沙箱：放行后命令以宿主既有权限执行，进程级隔离由宿主策略承载。

## 测试

```sh
npm run check   # tsc -p tsconfig.json --noEmit
npm run test    # node --experimental-transform-types --test 'tests/*.test.ts'（57 例）
npm run build   # tsc -p tsconfig.json → dist/
npm run smoke   # node smoke/smoke.mjs（真实 dsh headless 会话拦截验证）
```

57 例单测（blacklist 9 + guard 41 + sensitive 7）。

`smoke` 需要本机 dsh 0.2.0-rc.2、可用的模型 API 与 `zstd` CLI：建/复用 profile `dsh-toolset-security-guard`（`link:` 指向本包），在 `DSH_PERMISSION_MODE=danger-full-access` 下让权限层放行、由本插件独立拦截；headless 会话依次执行 `echo sg-smoke-ok` 与 `sudo ls /`，再解压 `session*.jsonl.zstd` 断言：`sudo ls /` 的结果 `isError` 且回执含 `[security-guard]` / `sudo ls /` / `放行方式`，`echo` 的结果 `isError: false`。模型自行改写或拒绝执行时，兜底为对 `dist/src/index.js` 的引擎直调断言。
