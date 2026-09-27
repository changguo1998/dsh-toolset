# /init 也用状态栏显示 cwd 判 AGENTS.md 是否存在（接取条目：TUI/docs/BACKLOG.md「`/init` 也用状态栏显示 cwd 判 `AGENTS.md` 是否存在」）

状态：关闭　　开启：2026-09-28　　关闭：2026-09-28
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

修 `runInit()` 用状态栏显示用缩写 cwd（`~/…`）直接 join 判断 `AGENTS.md` 的缺陷：家目录内的项目被误判「不存在」而误注入初始化指令。

## 调研

- `app/index.ts:2091-2099` `runInit()`：取 `state.systemStatus.cwd`（`status.ts:97` `shortenHome(process.cwd())`，家目录前缀缩写为 `~`），仅排除 `""` / `"—"` 后直接 `existsSync(join(dir, "AGENTS.md"))`。
- `app/local-shell.ts:59` `resolveShellCwd(cwd?)` 已有同类归一：`~` 展开 → `statSync` 验证是存在的目录 → 否则回落 `process.cwd()`；`$` shell 模式（TUI#37 真机缺陷）已复用它。
- 测试现状：`tests/app.test.ts:233` `makeAppAtCwd(cwd)` 注入 cwd；`:255` / `:271` 两个 `/init` 用例只用绝对路径，未覆盖 `~/…` 形态。

## 决策

- 选项 A（选定）：`runInit` 改 `const dir = resolveShellCwd(this.state.systemStatus.cwd) ?? process.cwd();`——复用既有已测函数，最小改动，与 `$` shell 同口径。
- 选项 B（否）：改取原始会话 cwd（新增 state 字段 / 适配层接口）——影响面大，收益与 A 相同。
- 选项 C（否）：仅手工展开 `~`——仍不校验目录存在，行为与 shell 路径不一致。
- 测试：新增一个用例，注入 `~/<家目录下临时目录名>` 且其中放 `AGENTS.md`，断言仅提示、不发送消息。

## 规划

计划改动文件清单：

- `TUI/src/app/index.ts`（`runInit` + import `resolveShellCwd`）
- `TUI/tests/app.test.ts`（新增 TUI#45 用例 + import `homedir` / `basename`）
- `TUI/docs/BACKLOG.md`（条目状态「进行中」→「完成」）
- `TUI/docs/implementation/2026-09-28-init-cwd-resolution.md`（本文件；关闭后移入 `TUI/docs/archived/`）

明确不做：不动 `local-shell.ts`（已正确）；不改 `/init` 提示文案与初始化指令；不顺手改其他命令的 cwd 用法。

## 实现记录

2026-09-28：

- `TUI/src/app/index.ts`：`runInit()` 改为 `const dir = resolveShellCwd(this.state.systemStatus.cwd) ?? process.cwd();`，并从 `./local-shell.ts` 引入 `resolveShellCwd`；原 `""` / `"—"` 排除逻辑由该函数内部候选回落覆盖。
- `TUI/tests/app.test.ts`：新增用例「/init：状态栏缩写 cwd（~/…）仍能命中已存在的 AGENTS.md（TUI#45）」——用仓库根（自带 `AGENTS.md`）构造 `~/…` 形态（仓库不在家目录时 `t.skip`），断言仅提示、不发送消息；`try/finally` 释放 App 以免断言失败时定时器挂住 `node --test`。
- `TUI/docs/BACKLOG.md`：条目状态「待接取」→「进行中」；标「完成」待真机确认后。
- 提交询问：用户答「否（先不提交）」——改动留工作区，条目保持「进行中」、本文件留在 `implementation/`，待真机确认后再关闭并提交。
- 2026-09-28 真机确认通过（见下），再次向用户发起提交询问。

## 测试与证据

- 新增用例先红后绿（回归对照）：
  - 反向验证：`git stash push -- TUI/src/app/index.ts`（临时撤掉修复）后跑 `npm run test:tui -- app.test.ts` → 该用例 ✖（`AssertionError：缩写路径展开后命中，不发送消息`，实际发送了初始化指令），证明用例真实覆盖缺陷；
  - 恢复修复后同用例 ✔。
- `npm run test:tui -- app.test.ts`：161 pass / 0 fail（含新用例，未 skip）。
- 全仓机械验证：`npm run check` exit 0；`npm run build` exit 0；`npm run test`（全包并行）15 包全部 pass / fail 0，exit 0。
- 附加验证（demo 冒烟，发现预存在缺陷）：`npm run demo -- --smoke` 在改动树与 clean tree（HEAD `8671b82`）均 `SMOKE_FAIL n=2`（`compaction-summary-toast` / `shell-submit`）→ 与本改动无关，已登记 BACKLOG #47。
- 真机确认（2026-09-28，PTY 真机跑 `dsh --profile fff`）：状态栏 cwd 显示为缩写 `~/Projects/dsh-toolset`，执行 `/init` → 提示「AGENTS.md 已存在，跳过初始化」；修复前该形态会误注入初始化指令（与单测红绿对照互为印证）。

## 收尾

- 回写：BACKLOG 条目状态「完成」；本文件移入 `TUI/docs/archived/`。
- 遗留：demo 冒烟两项失败（预存在）已登记 BACKLOG #47。
