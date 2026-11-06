# 公共 shell 命令解析包 shell-parse（接取条目：docs/BACKLOG.md「公共 shell 命令解析包（服务面）」）

状态：关闭　　开启：2026-11-06　　关闭：2026-11-06
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

范围修订（2026-11-06 用户指示「先做命令解析包, 但不要改其他包」）：**本轮只建包与接线**，
`security-guard` / `auto-approve` / `behavior-correction` 的迁移另立条目
（docs/BACKLOG.md「security-guard / auto-approve 改用 shell-parse」与「命令分段解析后的解释器识别」）。

## 目标

1. 把仓内已有的 shell 词法实现抽成一个包：切段（引号内不切）、分词、剥离包装器、命令位解析
   （含 shell `-c` / `eval` / `$(...)` / 反引号递归）。
2. 形态对齐 `clock-base`：纯函数从包入口 export，同时 `provide` 服务面 `shellParse`。
3. 解析层登记**多词包装器**（`uv run` / `poetry run` / `npx` / `pnpm exec` / `bundle exec` 等），
   解决既有两份实现只认单词包装器的问题。
4. 不改其他包的代码；只做新包与根清单接线（包数 37 → 38）。

## 调研

（来源：本仓源码）

- `security-guard/src/blacklist.ts:37`（`splitCommandSegments`）/ `:223`（`tokensOf`）/ `:252`
  （`commandName`）/ `:189`（`PREFIX_WORDS`，只有 `sudo` / `env` / `xargs` / `timeout` 这类单词）/ `:271`
  （`commandWords`，对 shell 族 `-c`、`eval`、`$()` 与反引号递归，深度上限 2）/ `:358`
  （`heredocFedShellHit`）/ `:312`（`dynamicCommandHit`）。
- `auto-approve/src/learn-rules.ts:50`（带 `balanced` 的同名切段）/ `:83`（`tokenizeSegment`，粘引号先断开）
  / `:137`（`segmentForm`，抹值形态）；`:46` 注明「本包复制 25 行实现，不引入跨包依赖 —— 抽公共模块属
  跨包改动，另立条目」。
- `clock-base` 是「包入口导出纯函数 + `provide` 服务 + 消费方 `link:` 依赖或 `ctx.get`」的既有范式
  （11 个包 `link:` 依赖它，TUI 也复用其时钟探测）。
- `scripts/test-install.sh:568`–`:600` 断言 `canonical_pkgs` = 根 check/build 链 = `default_pkgs`，
  且每个目录都存在 —— 新增包必须三处同序补齐。

## 决策

1. **包名与服务名**：包 `shell-parse`，服务 `shellParse`；不暴露模型侧工具（用户 2026-11-06 选定）。
2. **包装器模型**：`WrapperSpec = { words, skipArgs?, valueOptions? }` —— 多词序列 + 固定位置参数
   （`timeout 30`）+ 带值选项（`sudo -u root`）；选项不在表内时按无值处理（宁可多看一眼）。
   收录提权 / 环境 / 计时 / 批量 / shell 关键字 / 包管理入口六类，共 32 条。
3. **刻意不收录**：`command`（`command -v python` 只是查路径，收进来会把查询当执行）、
   `sh` / `bash`（由命令位解析按 `-c` 单独递归）、`docker` / `ssh` / `make` / `find -exec`
   （隔一层执行，文本层无法判定，写进 README「已知边界」）。
4. **切段返回对象**：`{ segments, balanced }`（`auto-approve` 已有此需求），消费方可据此放弃猜；
   本层仍照常解析，不抛错。
5. **命令位返回结构**：`CommandPosition { word, segment, depth, wrappers, source, dynamic }`，
   `source` 区分 `top` / `shell` / `eval` / `substitution`；`dynamic` 标记 `$cmd` 一类词面不可信的命令位
   （迁移 `security-guard` 的 `dynamicCommandHit`）。
6. **递归深度**：缺省 3（`security-guard` 原为 2），可用 `maxDepth` 收紧；深度到顶即停。
7. **范围**：本轮只建包 + 接线；三个消费方不动（用户指示），迁移条目见文首。

## 规划

计划改动文件清单:

- `shell-parse/package.json` / `tsconfig.json` / `cordis.patch.yml` / `LICENSE`（新包，形态照 `clock-base`）
- `shell-parse/src/segments.ts`（切段 / 分词 / 词归一 / 命令替换正文）
- `shell-parse/src/wrappers.ts`（包装器表与剥离）
- `shell-parse/src/command-position.ts`（命令位解析与递归）
- `shell-parse/src/index.ts`（导出面 + `provide` + `apply` + `resolveShellParse`）
- `shell-parse/tests/segments.test.ts` / `wrappers.test.ts` / `command-position.test.ts`
- `shell-parse/tests/integration/service.test.ts`
- `shell-parse/README.md`
- `package.json`（check / build 链）
- `scripts/install.sh`（`canonical_pkgs`）、`scripts/test-parallel.sh`（`default_pkgs`）
- `dev/standard/index.mjs`（数量断言 37 / 36 → 38 / 37）
- `README.md` / `README.zh.md`（组成表 + 目录树 + 安装行数量）
- `AGENTS.md`（包清单、数量口径、子包说明、轻量包名单）
- `docs/ROADMAP.md` / `docs/WORKFLOW-STANDARD.md` / `md-logic/README.md` / `security-guard/README.md`
  （`check:docs` 的数量断言命中，只改数字）
- `docs/BACKLOG.md`（本条标进行中并收窄范围；新增迁移条目）

明确不做:

- 不改 `security-guard` / `auto-approve` / `behavior-correction` 的代码与其行为。
- 不做 heredoc 正文解析、不做别名 / 变量展开、不做 `docker` / `ssh` / `make` 隔层解析。
- 不注册模型工具、不落盘。

## 实施记录

- 新包三个源文件按「切段 / 包装器 / 命令位」分层；`index.ts` 转出纯函数并提供 `shellParse` 服务，
  `resolveShellParse(ctx)` 依次看直接属性与 `ctx.get`（结构化形状校验只看 `commandWords`）。
- 包装器表 32 条：`sudo` / `doas` / `env` / `nohup` / `exec` / `time` / `nice` / `stdbuf` / `timeout` /
  `xargs` / `watch` / `busybox` / 8 个 shell 关键字与 `!` / `uv run` / `poetry run` / `pipenv run` /
  `pdm run` / `hatch run` / `npx` / `pnpm exec` / `pnpm dlx` / `yarn exec` / `yarn dlx` / `bunx` /
  `bundle exec`。
- 段首 `VAR=值` 与空命令位（`[` / `]` 这类结构符剥完为空）不产生命令位；`fi` / `done` / `esac` 作为
  关键字消费掉，不冒充命令。
- 根接线三处同序追加 `shell-parse`；`dev/standard` 数量断言 38 / 37；`check:docs` 顺带命中
  4 处旧数量（`docs/ROADMAP.md`、`docs/WORKFLOW-STANDARD.md`、`md-logic/README.md`、
  `security-guard/README.md`），只改数字。

## 验证

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 包类型检查 | `pnpm -C shell-parse run check` | 通过 |
| 包构建 | `pnpm -C shell-parse run build` | 通过（dist 生成 3 个模块） |
| 单元用例 | `pnpm -C shell-parse run test` | 24 例全通过 |
| 集成用例 | `pnpm -C shell-parse run test:integration` | 6 例全通过 |
| 全仓类型检查 | `pnpm run check` | 通过（38 包） |
| 全仓构建 | `pnpm run build` | 通过 |
| 接线断言 | `bash scripts/test-install.sh` | 124 项全通过（含 canonical_pkgs ↔ check/build ↔ default_pkgs 同序） |
| 文档标准 | `pnpm run check:docs` | 116 篇 / 942 个 `.ts`，错误 0、警告 0 |
| 全仓测试 | `pnpm run test` | 38 包全通过（TUI 1839 例、security-guard 160、auto-approve 183、behavior-correction 48、shell-parse 24, 其余照旧） |

行为样例（单测覆盖）：`sudo -u root uv run python x.py` → 命令位 `python`（链 `["sudo","uv run"]`）；
`timeout 30 node x.mjs` → `node`；`xargs -n1 ruby` → `ruby`；`bash -c "python x.py"` → `bash` + `python`；
`eval 'ruby x.rb'` → `eval` + `ruby`；`echo $(ruby x.rb)` → `echo` + `ruby`；`echo python` / `grep -rn ruby`
不产生解释器命令位。
