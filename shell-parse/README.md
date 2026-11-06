# @dsh-toolset/shell-parse

## 定位

DSH（DeepSeek Harness）进程内插件：本仓**唯一**的 shell 命令词法层。回答「这条 bash 命令
真正会跑哪些程序」，供 `security-guard`（命令位黑名单）、`auto-approve`（命令形态学习）、
`behavior-correction`（解释器识别）这类要判断命令内容的插件共用，避免各包各抄一份切段实现。

只做词法，不做 shell 语义：不展开别名 / 变量 / 通配符，不解释重定向与短路，不读文件、
不落盘、不注册工具。

## 能力

| 函数 | 作用 |
| --- | --- |
| `splitCommandSegments(command)` | 按 `;` `\|` `&` 与换行切段，**引号内的分隔符不切**；返回 `{ segments, balanced }`，引号不配对时 `balanced: false`，由调用方决定是否信任 |
| `tokenizeSegment(segment)` | 分词：空白分隔，引号串整体算一个词，**粘引号先断开**（`-m"b"` → `-m` + `b`），转义 `\` 保留后一字符；每个词带 `quoted` 标记 |
| `commandPositions(command, options?)` | 命令位列表：剥离包装器后取命令名，并递归 shell `-c`、`eval`、`$(...)` 与反引号；每项带 `segment` / `depth` / `wrappers` / `source` / `dynamic` |
| `commandWords(command, options?)` | 同上，只返回命令名数组（按出现顺序，保留重复） |
| `isDynamicCommand(command, options?)` | 命令位是否由展开产生（`$cmd` / `$(...)` / 反引号），此时命令名不可信 |
| `commandName(word)` / `basenameOf(path)` / `isAssignment(token)` | 词归一：去路径、去结构符与引号；`VAR=值` 判定 |
| `substitutionBodies(text)` | `$(...)`（括号配平）与反引号里的正文 |
| `stripWrappers(tokens, wrappers?)` | 逐层剥离包装器，返回命令位下标与包装器链 |
| `WRAPPERS` / `SHELL_NAMES` / `isShellName(word)` | 内置包装器表、shell 族、判定函数 |
| `DEFAULT_MAX_DEPTH` | 递归深度上限（缺省 3） |

### 包装器

包装器 = 自己不执行、只转手去跑后面那条命令的入口。内置表按「词序列 + 跳过的位置参数 +
带值选项」声明，覆盖：

- 提权 / 环境：`sudo` / `doas` / `env` / `nohup` / `exec`
- 计时与缓冲：`time` / `nice` / `stdbuf` / `timeout` / `watch`
- 批量：`xargs`
- shell 关键字：`if` / `then` / `else` / `elif` / `while` / `until` / `do` / `fi` / `done` / `esac` / `!`
- 包管理与脚本入口：`uv run` / `poetry run` / `pipenv run` / `pdm run` / `hatch run` / `npx` /
  `pnpm exec` / `pnpm dlx` / `yarn exec` / `yarn dlx` / `bunx` / `bundle exec`

于是 `sudo -u root uv run python x.py` 的命令位是 `python`（包装器链 `["sudo", "uv run"]`），
`timeout 30 node x.mjs` 是 `node`，`xargs -n1 ruby` 是 `ruby`。

调用方可用 `options.wrappers` 追加自己的包装器（排在内置表之前，优先匹配）。

## 服务面

包入口同时导出纯函数与 `provide` 声明：

```ts
export const provide = ["shellParse"];

// 不 import 本包的插件：
const parser = ctx.get("shellParse");   // 或 resolveShellParse(ctx)
parser?.commandWords("uv run python x.py"); // ["python"]
```

`ShellParseService` 与包导出的纯函数是同一实现（无状态），形状校验只看 `commandWords`
是否为函数。服务缺席时调用方自行降级（本包不因此让宿主启动失败）。

## 配置

无配置项。bundle 契约：`name` / `provide` / `apply`（`apply` 只挂服务面，可重复调用）。

## 边界

- **不解释 shell 语义**：别名、变量展开、通配符、重定向、`&&` / `||` 短路、heredoc 正文都不处理。
- 递归只走四个入口：shell 族 `-c` / `--command`、`eval` 参数、`$(...)`、反引号；深度上限
  缺省 3，到顶即停。
- 已知**不覆盖**的隔层执行：`find -exec`、`xargs` 之外的批处理、`make` 的 recipe、
  `docker run …`、`ssh host '…'`、`npx -c` / `su -c` 这类以选项传脚本的入口、
  `command -v`（只查路径，故意不把 `command` 当包装器）。
- 命令名只是**词面**：不判断它是否真是可执行文件，也不判断路径是否存在。

## 与其它插件的关系

- 纯库使用者（`security-guard` / `auto-approve` 这类要精细控制选项解析的包）可 `link:` 依赖
  后直接 import；不愿引依赖的插件走服务面 `ctx.get("shellParse")`。
- 本包不做判定、不拦任何调用：拦不拦、拦什么由消费方决定（`security-guard` 仍负责危险命令，
  `behavior-correction` 负责「该用专用工具却走 shell」）。

## 测试

```sh
pnpm run check             # 类型检查（tsc -p tsconfig.json --noEmit）
pnpm run build             # 编译到 dist/
pnpm run test              # 单元层：切段 / 分词 / 包装器 / 命令位
pnpm run test:integration  # 集成层：服务面挂载与读取
pnpm run test:coverage     # 单元 + 集成，覆盖率报告在 ../tmp/cov-shell-parse
```

| 文件 | 覆盖 |
| --- | --- |
| `tests/segments.test.ts` | 切段（含引号与不配对）、分词（粘引号 / 转义）、词归一、命令替换正文 |
| `tests/wrappers.test.ts` | 单层与多层包装器、带位置参数与带值选项、多词包装器、参数位不误判 |
| `tests/command-position.test.ts` | 逐段命令位、变量赋值、shell 关键字、`-c` / `eval` / 命令替换递归、深度上限、动态命令位 |
| `tests/integration/service.test.ts` | `apply` 挂载（`provide` 与直接属性两条路）、`resolveShellParse` 读取与降级 |
