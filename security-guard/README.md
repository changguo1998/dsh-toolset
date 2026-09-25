# @dsh-toolset/security-guard

DSH（DeepSeek Harness）进程内安全守卫插件：危险命令黑名单拦截 + 敏感文件保护策略层。

挂在宿主 `tools/pre-execute` 水位线（命令**下发前**）：命中即返回 `{kind:"deny", reason}`，宿主把工具调用物化为带 `Error: ` 前缀的 `isError: true` 结果且不下发命令；回执含拦截原因与放行方式。默认策略**保守（宁可误拦不可漏拦）**：非法黑名单正则按命中处理，非法放行正则按不放行处理。

## 能力

### 拦截面

| 层 | 覆盖 | 默认规则 |
| --- | --- | --- |
| 命令黑名单 | `bash` / `shell` / `pwsh` 的 `command` 或 `script`；`run_code` 的 `code` 或 `program` | 15 条：`rm -rf /` 族、`curl \| sh` 族、`chmod 777` 系统目录、`sudo`、fork 炸弹、`dd` 裸盘写入、`mkfs`、`wipefs`、分区工具、重启关机、`find -delete`、`crontab -r`、`iptables -F`、kill PID 1 |
| 敏感文件 | shell 命令文本中提取的路径（含 `workdir`）；文件工具 `read` / `write` / `edit` / `patch` / `grep` / `glob` 的 `file_path` / `path` / `target` / `file` 参数 | 26 条：`.ssh`、`.aws`、`.gnupg`、`.kube`、`gh`、`gcloud`、`docker config`、`kubeconfig` 目录；`.netrc`、`.git-credentials`、`.npmrc`、`.pypirc` 凭据文件；`.env` 族；`*.pem` / `*.key` / `*.p12` / `*.pfx` / `*.jks` / `*.keystore` / `id_rsa` 族 / GCP `credentials.json` / service-account |

- 复合命令（`;` `|` `&` 换行）按段词法分析；`run_code` 与引号内嵌命令另有整文本兜底。路径提取是保守超集（成对引号串、裸 token、`~/` 前缀、绝对路径子串四类），归一化时去引号、展开 `~` / `$HOME` / `${HOME}`、折叠 `//`。
- 两层独立：`allowPatterns` 只放开命令层，`allowedPaths` 只放开敏感文件层；放行了黑名单命令若仍含敏感路径，依旧被拦。
- 未识别的工具名或参数缺失一律放行（不猜测语义）。
- 只读查询面 `provide('guard')`：`recent()` 返回最近拦截记录（上限 200，新在前），`policy()` 返回当前开关、生效规则（id / reason）与放行正则源，供 TUI `/guard` 等接线方消费。

### 回执示例

命令层：

```
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
- `run_code` 只过命令层，不做路径层检查；文件工具的路径参数只过敏感层，不做命令层检查。
- 拦截是**策略层**，不是沙箱：放行后命令以宿主既有权限执行，进程级隔离由宿主策略承载。

## 测试

```sh
npm run check   # tsc -p tsconfig.json --noEmit
npm run test    # node --experimental-transform-types --test 'tests/*.test.ts'（37 例）
npm run build   # tsc -p tsconfig.json → dist/
npm run smoke   # node smoke/smoke.mjs（真实 dsh headless 会话拦截验证）
```

37 例单测（blacklist 9 + guard 21 + sensitive 7）。

`smoke` 需要本机 dsh 0.1.7-rc.2、可用的模型 API 与 `zstd` CLI：建/复用 profile `dsh-toolset-security-guard`（`link:` 指向本包），在 `DSH_PERMISSION_MODE=danger-full-access` 下让权限层放行、由本插件独立拦截；headless 会话依次执行 `echo sg-smoke-ok` 与 `sudo ls /`，再解压 `session*.jsonl.zstd` 断言：`sudo ls /` 的结果 `isError` 且回执含 `[security-guard]` / `sudo ls /` / `放行方式`，`echo` 的结果 `isError: false`。模型自行改写或拒绝执行时，兜底为对 `dist/src/index.js` 的引擎直调断言。
