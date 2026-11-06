# behavior-correction 命令分段解析后的解释器识别（接取条目：docs/BACKLOG.md「命令分段解析后的解释器识别」）

状态：关闭　　开启：2026-11-06　　关闭：2026-11-06
**并行任务**：本条在独立 worktree / 独立分支实施（见「并行约定」）；本文件是本任务唯一的追踪文档与文档改动位置，计划外的文件不改。
前置调研见 `behavior-correction/docs/archived/2026-11-06-interpreter-guard.md`（名单边界与漏口清单）。

## 目标

把「bash 里跑解释器」的判定从单条命令位正则换成**解析层命令位识别**：用
`@dsh-toolset/shell-parse` 的 `commandPositions()`（已剥离 `sudo` / `env` / `timeout` / `xargs`
/ `uv run` / `npx` / `pnpm exec` / `bundle exec` 等包装器，并递归 shell `-c`、`eval`、`$()`、
反引号）取真正被跑的命令名，命中解释器集合即拒绝。同时按用户指示把
`no-python-in-bash` 与 `no-node-in-bash` **合并为一条** `no-interpreter-in-bash`。

## 调研

（来源：本仓源码）

- 现行规则：`src/index.ts:120`–`152` 两条独立规则（python 家族 / node），`match.regex` 只认命令位，
  故 `uv run python`、`npx tsx`、`xargs ruby`、`bash -c 'python …'` 全放行。
- `RuleSpec` 现有匹配面：`match.keywords`（子串）、`match.regex`、`exclude`、`tool`、`reason`；
  `matchRule`（`src/index.ts:377`）对 `toolText()` 的文本判定。
- `shell-parse` 面：`commandPositions(command, { maxDepth })` 返回
  `{ word, segment, depth, wrappers, source, dynamic }[]`；`commandWords()` 只要词；
  `isShellName()` / `WRAPPERS` 可用。
- `script_run` 只承接 python / node / sh（`script-interpreter/src/index.ts:101`），其它语言没有受控出口。

## 决策

1. **合并为一条规则**（用户 2026-11-06 指示）：`no-interpreter-in-bash` 取代 python / node 两条，
   reason 只写一份。
2. **机制**：`RuleSpec.match` 增加可选 `commandNames?: readonly string[]` —— 命中条件为
   「`commandPositions()` 里任一 `word` 在该列表里」。它与 `keywords` / `regex` 是**并集**语义
   （任一命中即算命中），`exclude` 照旧优先弃权。
3. **名单**（中杯口径）：python 家族 `python` / `python2` / `python3` / `python3.12`（正则或前缀匹配
   由实现决定，须覆盖 `python2`）、`node`、`ruby`、`irb`、`perl`、`raku`、`php`、`lua`、`luajit`、
   `deno`、`bun`、`tsx`、`ts-node`、`Rscript`、`julia`、`osascript`、`tclsh`。
   **不收**：`awk` / `sed`（文本工具）、`npm` / `npx` / `pip` / `gem` / `bundle` / `cargo`（包管理入口）、
   `nodejs` / `nodemon` / `node-gyp`（前缀词）、裸 `R`（与 `r` 冲突）。
4. **reason 文案**（一份）：
   `bash 里不要直接跑解释器（python / node / ruby / perl / php / lua / deno / bun 等）: 计算与脚本改用 script_run 工具（已启用 python / node / sh）, 其它语言改写为 sh 或用现有工具组合`
5. **降级**：`shell-parse` 解析不可用（服务 / 依赖缺失、`commandPositions()` 抛错）时，
   `commandNames` 规则**不命中**（fail-open，与既有「宁可漏拦不误伤」一致）；`herdr` 与
   `view-text` 两条规则保持原样，不受影响。
6. **依赖形态**：`package.json` 加
   `"dependencies": { "@dsh-toolset/shell-parse": "link:../shell-parse" }`。

## 规划

计划改动文件清单：

- `behavior-correction/package.json`（加 `link:` 依赖）
- `behavior-correction/src/index.ts`（`RuleSpec.match.commandNames` + 编译 + `matchRule` 适配；
  `DEFAULT_RULES` 两条并一条；文件头注释同步）
- `behavior-correction/tests/main.test.ts`（规则 id 清单、正例扩包装器与嵌套、反例扩包管理入口与文本工具）
- `behavior-correction/tests/index.test.ts`（规则条数 4 → 3 等机械配套）
- `behavior-correction/README.md`（规则表两行合一行、标题「四条」→「三条」、解析层来源与降级口径）
- `README.md` / `README.zh.md` / `AGENTS.md` 里 behavior-correction 缺省规则的一句话描述
  （若原文仍写「bash 里跑 herdr」而没提解释器，可顺带补一句；只改这一句，不重构文档）
- `behavior-correction/docs/implementation/2026-11-06-interpreter-recognition.md`（本文件，收尾归档）

明确不做：

- 不改 `script-interpreter`（不给新语言开后端）、不加模型工具。
- 不改 `herdr` / `view-text` 两条规则的判定与文案。
- 不动 `security-guard` / `auto-approve` / `shell-parse` 任何文件。

## 验证

- `pnpm -C behavior-correction run check` / `run build` / `run test` / `run test:integration` 全绿。
- 正例（须拒绝且 reason 含 `script_run`）：`python x.py`、`python2 legacy.py`、`node -e '1'`、
  `ruby -e 'puts 1'`、`perl -pi -e 's/a/b/' f`、`php -r 'echo 1;'`、`lua x.lua`、`deno eval '1'`、
  `bun x.ts`、`tsx gen.ts`、`ts-node main.ts`、`Rscript p.R`、`julia c.jl`、`osascript -e 'beep'`、
  `tclsh x.tcl`、`uv run python x.py`、`npx tsx gen.ts`、`xargs -n1 ruby`、
  `bash -c 'python x.py'`、`eval 'ruby x.rb'`、`sudo -u root uv run python x.py`。
- 反例（须放行）：`echo python`、`grep -rn ruby src/`、`npm install`、`npx tsc`、`rake db:migrate`、
  `bundle exec rspec`、`awk '{print $1}' f`、`gcc a.c -o a`、`nodejs -v`、`cd node_modules`、
  `git commit -m 'docs: python -> script_run'`。
- `format` + `pnpm run check:docs`（若改了根 README）。

## 并行约定

- 工作目录：独立 worktree（`/home/guochang/Projects/dsh-toolset-wt/behavior-correction`），分支
  `task/behavior-correction-interpreter`；主仓目录不动。
- 只改「计划改动文件清单」里的文件；其余包一律不碰。
- 完成后：`format` 改动文件 → `pnpm -C behavior-correction run check && build && test && test:integration` → 回填本文件「实施记录 / 验证」→ 状态改「关闭」→ 移入
  `behavior-correction/docs/archived/` → 在本分支 `git commit`（不 push、不合 main）。

## 实施记录

2026-11-06，worktree `/home/guochang/Projects/dsh-toolset-wt/behavior-correction`，分支
`task/behavior-correction-interpreter`。

实际改动文件：

- `behavior-correction/package.json`：加 `"dependencies": { "@dsh-toolset/shell-parse": "link:../shell-parse" }`。
- `behavior-correction/pnpm-lock.yaml`：`pnpm install` 生成的锁文件更新（新增上方依赖）。
- `behavior-correction/src/index.ts`：`RuleSpec.match.commandNames`、`CompiledRule.commandNames`、
  编译校验、`matchRule` 并集判定、`DEFAULT_RULES` 两条并一条（新增导出常量
  `INTERPRETER_COMMAND_NAMES`）、`toolText` 抽出 `shellCommand` 复用、文件头注释同步。
- `behavior-correction/tests/main.test.ts`：规则 id 清单改为三条；python / node 两组用例合并为解释器
  用例（正例扩包装器与嵌套、反例扩包管理入口与文本工具）；新增 `commandNames` 作用面用例。
- `behavior-correction/tests/index.test.ts`：规则条数 4 → 3；新增 `commandNames` 非法形态告警用例与
  「并集 + exclude 弃权 + 版本后缀」用例。
- `behavior-correction/README.md`：规则表两行合一行、标题「四条」→「三条」、解析层来源与名单、
  `match.commandNames` 配置行、边界与插件关系段落。
- `README.md` / `README.zh.md` / `AGENTS.md`：behavior-correction 缺省规则那句话各补一句解释器识别。
- 本文件（回填实施记录与验证、状态改关闭、移入 `docs/archived/`）。

实现取舍：

- 命令位来源：`commandPositions(command)` 的 `word`（已取 basename、已剥包装器、已递归
  `-c` / `eval` / `$()` / 反引号）；命中 = 任一 `word` 等于名单项，**大小写敏感**（`Rscript` 与
  `rscript` 不是一回事）。
- 版本后缀：名单项后跟 `.数字(.数字)*` 也算同一命令（`python3` 认 `python3.12`、`python2` 认
  `python2.7`），因此名单里同时列 `python3.12` 只是显式冗余。没有做通用前缀匹配 —— 否则 `node`
  会把 `nodejs` 也吃掉（决策第 3 条明确不收 `nodejs`）。
- 解析时机：`matchRule` 里只有「确实存在带 `commandNames` 的规则」且已通过 `tool` 限定时才解析一次，
  同一次判定内结果复用；没有 `commandNames` 的规则表零额外开销。
- fail-open：`commandPositions()` 抛错按空列表处理（该条件不命中）；`herdr` 与 `view-text` 两条规则
  未改动。

偏离方案（须记录的原因）：

1. **解析范围只到 shell 类工具**：`commandNames` 只对 `bash` / `pwsh` 的 `arguments.command` 原文
   解析；其余工具的判定文本是「工具名 + JSON」，不是命令行，解析它只会误判。规则把 `commandNames`
   配到别的工具上时该条件永不命中（关键词 / 正则照常）。
2. **「依赖缺失」这一档 fail-open 覆盖不完整**：`shell-parse` 是静态 import，模块装不上时插件在
   加载期就会失败，同步的 `matchRule` 无法兜住；能兜住的是「解析函数抛错」与「工具不是 shell 类」。
   依赖由 `scripts/install.sh` 的 `canonical_pkgs`（已含 shell-parse）保证，profile 侧无需额外步骤。
3. **安装命令需要两个附加参数**：本 worktree 里默认 pnpm store 在沙箱外不可写
   （`ERR_SQLITE_ERROR unable to open database file`），改用 `--store-dir ../tmp/pnpm-store`；新增依赖
   使锁文件失配，故用 `--no-frozen-lockfile`。最终命令：
   `CI=true pnpm install --ignore-workspace --store-dir ../tmp/pnpm-store --no-frozen-lockfile`。
4. **项目级 `docs/BACKLOG.md` 的条目未在本分支改**：该文件不在「计划改动文件清单」里，且与并行任务
   同文件冲突；条目状态（「进行中」）与清理留主仓收口。
5. **`cordis.patch.yml` 注释未改**：注释仍写「缺省规则 = bash 命令含 herdr」，未把解释器规则写进去；
   该文件不在计划清单内（且带注释的 YAML 不参与格式化），留作后续小改。

## 验证

- `pnpm -C behavior-correction run check`：通过（`tsc -p tsconfig.json --noEmit`，无输出）。
- `pnpm -C behavior-correction run build`：通过（`tsc -p tsconfig.json`）。
- `pnpm -C behavior-correction run test`：`tests 50 / pass 50 / fail 0`。
- `pnpm -C behavior-correction run test:integration`：`tests 13 / pass 13 / fail 0`。
- 正例（拒绝且 reason 含 `script_run`）：`python x.py`、`python2 legacy.py`、`python3 -c`、
  `python3.12 tools/gen.py`、`node` / `node -e`、`ruby -e`、`irb`、`perl -pi -e`、`raku -e`、
  `php -r`、`lua` / `luajit`、`deno eval`、`bun`、`tsx`、`ts-node`、`Rscript`、`julia`、`osascript`、
  `tclsh`、`uv run python`、`poetry run python`、`npx tsx`、`xargs -n1 ruby`、`timeout 30 node`、
  `sudo -u root uv run python`、`bash -c 'python x.py'`、`sh -c 'ruby x.rb'`、`eval 'ruby x.rb'`、
  `FRED=1 bash -lc 'node -v'`、`ls && python3 -V`、`FOO=1 /usr/bin/python3 -m http.server`、
  `x=$(node -p '1+1')`、`echo $(perl -e 'print 1')`。
- 反例（放行）：`echo python`、`grep -rn python3 src/`、`grep -rn ruby src/`、`ls scripts/run.py`、
  `pip install requests`、`npm install`、`npx tsc`、`pnpm exec tsc --noEmit`、`gem install rake`、
  `bundle exec rspec`、`cargo build`、`rake db:migrate`、`awk '{print $1}' f`、`sed 's/a/b/' f`、
  `gcc a.c -o a`、`nodejs -v`、`nodemon src/index.ts`、`node-gyp rebuild`、`cd node_modules`、
  `git commit -m 'docs: python -> script_run'`、`herdr pane list`（由 herdr 规则另行拒绝）。
- 改动文件已跑 `format`（TS / JSON / Markdown 均无重排）。
- `pnpm run check:docs`：`116 篇 Markdown / 946 个 .ts`，错误全部是 `pkg.structure` 的 36 条
  「`files` 里的 `dist` 不存在」（本 worktree 只构建了 behavior-correction 与 shell-parse，其余包未
  构建；与本次文档改动无关），文档类规则零告警。
