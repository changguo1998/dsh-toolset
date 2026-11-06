# behavior-correction 命令分段解析后的解释器识别（接取条目：docs/BACKLOG.md「命令分段解析后的解释器识别」）

状态：进行中　　开启：2026-11-06
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
