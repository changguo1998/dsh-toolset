# bash 直跑解释器合并为一条规则并扩到其它语言（接取条目：behavior-correction/docs/BACKLOG.md「bash 直跑解释器合并为一条规则并扩到其它语言」）

状态：关闭（方向调整）　　开启：2026-11-06　　关闭：2026-11-06
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。
关闭原因：2026-11-06 用户改定方向 —— 先把命令解析抽成服务面（项目级条目「公共 shell 命令解析包（服务面）」）, 再在其上做解释器识别（项目级条目「命令分段解析后的解释器识别」）; 本文件的名单调研与漏口清单作为后续依据保留。

## 目标

1. 把内置规则表里的 `no-python-in-bash` 与 `no-node-in-bash` **合并为一条** `no-interpreter-in-bash`, reason 只写一份, 仍指向 `script_run`。
2. 同一条规则的正则扩到其它常见解释器（ruby / perl / php / lua / deno / bun / tsx / ts-node / Rscript / julia 等）, 拦下「python / node 被拦后改跑别的语言」的逃逸。

## 调研

（来源：本仓源码 / 本机实测）

- 现行两条规则只认命令位（行首 / `;` `&` `|` 之后 / `$(` 之后, 允许前置 `VAR=值` 与路径前缀）, 正则见 `src/index.ts:127` 与 `:144`; 判定文本 = bash 的 `arguments.command` 原文（`toolText`, `src/index.ts:350`）。
- `script-interpreter` 只自动探测 python / node / sh（`script-interpreter/src/index.ts:101`）, bash 后端需显式配置; 故其它语言**没有受控出口**, 拒绝理由必须写明「改写为 sh 或用现有工具组合」, 不能假装指路。
- 旧 python 规则正则 `python(?:3(?:\.\d+)?)?` 不认 `python2`, 属未被发现的缺口。
- 规则 id 断言有三处硬编码: `tests/main.test.ts:106`（id 清单）、`tests/index.test.ts:100`–`105`（规则条数 4）。
- `README.md:26` 写「缺省规则（四条）」并带规则表; `src/index.ts:10`–`15` 文件头同样列了四条。

## 决策（未定稿, 待用户逐条确认）

2026-11-06 用户裁定「还没定稿, 回退到决策步骤」, 已实现的一版全部撤销。下列为候选方案, 确认后才动手:

1. **合并维度**（待确认）: `no-python-in-bash` + `no-node-in-bash` → 一条 `no-interpreter-in-bash`（草稿口径, 一份 reason）, 或保留两条另加第三条。
2. **语言名单范围**（待确认）:
   - 窄: `ruby` / `perl` / `php` / `lua` / `deno` / `bun`（模型最常见逃逸）
   - 中: 窄 + `irb` / `raku` / `luajit` / `tsx` / `ts-node` / `Rscript` / `julia` / `osascript` / `tclsh`
   - 宽: 中 + `swift` / `scala` / `groovy` / `erl` / `sbcl` / `racket` / `guile` / `runghc` / `dotnet-script`
   - 一律不收: `awk` / `sed`（文本工具, 拦了误伤）、`npm` / `npx` / `pip` / `gem` / `bundle` / `cargo`（包管理入口）、`nodejs` / `nodemon` / `node-gyp`（前缀词, script_run 侧只探 `node`）、裸 `R`（与 `r` 冲突）。
3. **包装前缀是否纳入**（待确认）: 现行只认命令位, `uv run python` / `npx tsx` / `xargs ruby` / `bundle exec ruby` / `bash -c '…'` 全放行。
   - 不纳入: 与既有规则一致, 漏口写进 README 边界。
   - 纳入: 正则在命令位后允许 `(?:sudo|env|uv run|poetry run|pipenv run|xargs|timeout \S+|npx|pnpm exec|bundle exec)\s+`; 误伤面变大, 需逐项列排除（例如 `npx tsc` 现已放行）。
4. **python 家族**（待确认）: 是否顺带认 `python2` / `python2.7`（旧正则 `python(?:3(?:\.\d+)?)?` 不认）。
5. **拒绝还是提示**（待确认）: 其它语言在 `script_run` 里没有后端, deny 后模型无受控出口。
   - deny + 文案写明「改写为 sh 或用现有工具组合」（草稿口径）
   - 只提示不拒（需走 rule-engine 注入面, 改动更大）
6. **规则位置**: 替代原两条, 留在 herdr 之后、view-text 之前。

## 规划

（决策确认后回填: 计划文件清单）

## 回退记录

- 2026-11-06: 已实现一版（合并 + 15 个其它语言 + `python2` 补齐, 单元 46 / 集成 13 全通过）, 用户裁定未定稿; `git restore --source=HEAD --worktree` 撤销 `src/index.ts` / `tests/main.test.ts` / `tests/index.test.ts` / `README.md`, 树回到 `d0bc384e`。
- 可复用的结论只有两条: 名单边界（哪些收、哪些不收的理由）与「reason 必须写明其它语言在 script_run 里没有后端」。
