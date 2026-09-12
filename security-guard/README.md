# @dsh-toolset/security-guard

DSH（DeepSeek Harness）进程内安全守卫插件：危险命令黑名单拦截 + 敏感文件保护策略层。
挂在宿主 `tools/pre-execute` 水位线（命令**下发前**），命中即把工具调用物化为
带错误文本的 isError 结果（不下发命令），回执含拦截原因与放行方式。

默认策略**保守（宁可误拦不可漏拦）**：非法黑名单正则按命中处理，非法放行正则按不放行处理。

## 拦截面

| 层 | 覆盖 | 说明 |
| --- | --- | --- |
| 命令黑名单 | `bash` / `shell` / `pwsh` 的 `command` 文本；`run_code` 的 `code` 文本 | 15 条默认规则：`rm -rf /` 族、curl|sh 族、chmod 777 系统目录、sudo、fork 炸弹、dd/裸盘写入、mkfs/wipefs/分区工具、重启关机、find -delete、crontab -r、iptables -F、kill PID 1。复合命令（`;` `|` `&` 换行）按段词法分析，run_code/引号内嵌命令另有整文本兜底 |
| 敏感文件 | shell 命令文本中提取的路径（含 `workdir`）+ 内置文件工具 `read`/`write`/`edit`/`patch`/`grep`/`glob` 的路径参数 | 26 条默认规则：`.ssh`/`.aws`/`.gnupg`/`.kube`/`gh`/`gcloud`/`docker config` 目录、`.netrc`/`.git-credentials`/`.npmrc`/`.pypirc` 凭据文件、`.env` 族、`*.pem`/`*.key`/`*.p12`/`*.pfx`/`*.jks`/`*.keystore` 私钥、`id_rsa` 族、GCP `credentials.json`、service-account |

两层独立：`allowPatterns` 只放开命令层，`allowedPaths` 只放开敏感文件层；
放行了黑名单命令若仍含敏感路径，依旧被拦。

## 放行方式

在 profile 的 `cordis.patch.yml` 的 `security-guard` 条目 `config` 下配置
（见下文「配置参考」），重载/重启会话生效。

## 挂载

包自带 `cordis.patch.yml`（`dsh.bundle.patch` 键声明，loader 自动合并，
`tools` 服务存在时才挂载）：

```yaml
# pi-lens-ignore: yaml-schema: JSONPatch:0, yaml-schema: JSONPatch:513
- insert:
    - id: security-guard
      name: '@dsh-toolset/security-guard'
```

profile 侧以 `link:` 依赖指向本包即可（勿用 `file:`，pnpm v11 不跟踪目录变化）。

## 配置参考（profile 层 config，均可选）

```yaml
# pi-lens-ignore: yaml-schema: JSONPatch:0, yaml-schema: JSONPatch:513
- id: security-guard
  name: '@dsh-toolset/security-guard'
  config:
    enabled: true                 # 总开关（默认 true）
    homeDir: /home/user           # ~ / $HOME 展开用的家目录（默认 os.homedir()）
    commandBlacklist:
      enabled: true               # 命令层开关（默认 true）
      rules:                      # 追加黑名单正则（默认规则不可移除，只能追加）
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

## 回执示例

命令层（宿主在工具结果文本前加 `Error: ` 前缀）：

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
原因：SSH 私钥/凭据目录，泄露即失守。
放行方式：在该 profile 的 cordis.patch.yml 的 security-guard 条目 config 下，向 sensitiveFiles.allowedPaths 追加该路径（或其父目录前缀），重载/重启会话后生效。
```

## 已知保守取舍（文档化的过度拦截）

- 普通正则类规则对整段文本匹配：`echo "sudo is a tool"` 会命中 `sudo` 规则；
- `run_code` 的 `code` 文本整体过黑名单：代码字符串里出现危险命令字样即拦；
- shell 命令路径提取是保守超集（裸 token 也参与 basename 规则匹配）。

## 命令

```sh
npm run check   # tsc --noEmit
npm run test    # node --test（黑名单/敏感文件/引擎+宿主挂载 共 32 例）
npm run build   # 编译到 dist/
npm run smoke   # 真实 dsh headless 会话拦截验证（需 dsh 0.1.5-rc.2 与本包依赖已装）
```

## 验证（smoke 说明）

`npm run smoke` 建/复用 profile `dsh-security-guard`（`link:` 指向本包，
`DSH_PERMISSION_MODE=danger-full-access` 下让权限层放行、由本插件独立拦截），
headless 会话依次执行 `echo sg-smoke-ok` 与 `sudo ls /`，再解压
`session.jsonl.zstd` 断言：`sudo ls /` 的工具结果 `isError` 且回执含
`[security-guard]`/`sudo ls /`/`放行方式`，`echo` 的结果 `isError: false`。
若模型自行改写/拒绝执行，smoke 兜底为对 `dist/src/index.js` 的引擎直调断言。
