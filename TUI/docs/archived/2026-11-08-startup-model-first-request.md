# 启动参数模型对首个请求生效（接取条目：TUI/docs/BACKLOG.md「启动参数 `--model` 对首个请求不生效」）

状态：关闭　　开启：2026-11-08　　关闭：2026-11-09

本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

`--provider` / `--model` / `--effort` 启动参数在**首个请求**即生效（新建与会话恢复两条启动路径都是）；目录校验失败时只告警，不再悄悄回退默认路由；一个参数都不给时行为不变。

## 调研

- 现象：`fffdsh --model tg/ds4f`（= `dsh --profile fff --model tg/ds4f`；启动器 flag 之后的参数原样进 `ctx.cmdlineArgs`）启动后，首个请求仍走 profile 默认 `tg/ds41f`，第二个请求起才用 `tg/ds4f`。
- 现有实现：`parseTuiStartupArgs`（`TUI/src/main.ts`）解析三项；`main()` 在 `app.start()` **之后**才 `void app.applyStartupModel()`（`TUI/src/main.ts:238-242`）。该方法先 `await adapter.modelCatalog()` 与 `modelEfforts()`，再经 `agent.model.select()` 写 `model/selection`（`TUI/src/app/runtime/commands-model.ts:175-230`、`TUI/src/app/adapter/dsh-session.ts:747-778`），对下一步生效。
- 首个请求不是用户输入触发的：rule-engine 的 `session-start` 注入（本 profile 有 symbol-normalizer 开局指南，`delivery: "steer"`）会立刻起回合并发请求（`rule-engine/src/inject.ts:19`、`symbol-normalizer/src/index.ts:151`）。本会话日志（`~/.dsh/sessions/--home-guochang-Projects-dsh-toolset--/tui-fab4b8ae-0e77-492b-b9f5-f4a847e27c2e/session.v4.jsonl.zstd`）实测：创建后 +0.48 s 注入、+0.60 s 首个 `request/header`（tg/ds41f/low），此前没有任何 `model/selection`。
- 恢复会话还有一层限制：`AgentOptions` 只是路由回落，Session 有记录后不再生效（`docs/host/HOST-UPGRADE-0.2.2-rc.1.md` §4），只把模型并入 `agentOptions` 覆盖不到恢复路径，故还需要句柄就绪后的显式 `select`。

## 决策

1. 修复方案（用户 2026-11-08 选定 a）：
   - a（选定）：把启动参数并入初始路由（`agentOptions`），并在会话句柄就绪后**同步**调用 `agent.model.select()` 一次（恢复会话的记录选择会压过 `agentOptions`）。代价：无效组合可能让首条请求先失败一次。
   - b：只做句柄就绪后的 `model.select()`（改动更小；恢复会话仍可能被注入回合抢先）。
   - c：先复现核对再定。
   - 理由：a 同时消除新建与恢复两条路径的竞态；c 会拖到下一轮，且代码层时序已能解释现象。
2. 缺字段补齐口径：未显式给出的字段按宿主 `agent.model.current()` 补齐（恢复会话 = 记录选择；新建会话 = 刚传入的 AgentOptions），保持原 `applyStartupModel` 的「只改命令行指定字段」语义。不能一律按 profile 默认路由补齐，否则恢复会话上 `--provider` / `--effort` 会把 model 也改成默认值。
3. 目录校验失败：启动后的校验只告警，**保留命令行路由**（命令行优先）；effort 未命中的「回退该模型最低等级」仍留在启动后的校验里。

## 规划

- 任务拆分：① 条目与追踪文档；② 路由合并与同步预置；③ 启动后校验提示口径；④ 单测；⑤ 文档回写；⑥ 验证。
- 计划改动文件清单：
  - `TUI/src/main.ts`
  - `TUI/src/app/runtime/commands-model.ts`
  - `TUI/src/app/index.ts`（`pinned` 透传；实现中补入，见「偏差」）
  - `TUI/tests/main.config.test.ts`
  - `TUI/tests/app.test.ts`（`pinned` 用例；实现中补入，见「偏差」）
  - `TUI/README.md`
  - `TUI/docs/DESIGN.md`
  - `TUI/docs/BACKLOG.md`（条目状态）
  - `TUI/docs/implementation/2026-11-08-startup-model-first-request.md`（本文件）
- 明确不做：不改 `agent-default-model` 与 profile patch；不改 `/model`、`/provider`、`/effort` 命令路径；不为「无效组合」加二次回切逻辑。

## 实现记录

- `TUI/src/main.ts`：
  - 启动参数解析前移到路由解析之前；新增纯函数 `planStartupRoute`（命令行 > profile config > 宿主默认；返回初始 `route` 与仅含显式字段的 `override`）与 `planStartupSelection`（按宿主 `model.current()` 补齐未给出的字段）。
  - 新增宿主面 helper `readAgentModelSelection` / `setAgentModelSelection`（同步 `Agent.model.select()`，失败只告警）。
  - 会话句柄（create / resume / `-c` 回落）就绪后、本函数后续任何 `await` 之前同步预置；成功即写 `sessionModel.current`（状态行与 `/model` 面板的显示源）。
  - `main()` 的 `startupModel` 选项增加 `pinned`（预置后的最终选择），随 `applyStartupModel` 传给 App。
- `TUI/src/app/runtime/commands-model.ts`：`applyStartupModel` 以 `args.pinned ?? catalog.current` 为缺字段基线；目录校验失败文案改为「保留命令行路由」。
- `TUI/src/app/index.ts`：`applyStartupModel` 参数透传 `pinned`。
- `TUI/tests/main.config.test.ts`：`planStartupRoute` / `planStartupSelection` / `readAgentModelSelection` / `setAgentModelSelection` 用例，以及「预置早于 adapter」的源码顺序断言。
- `TUI/tests/app.test.ts`：`pinned` 作为缺字段来源的用例（恢复会话的 model 不被默认值盖掉）。
- `TUI/README.md` / `TUI/docs/DESIGN.md`：启动参数行为口径同步（首个请求即生效、命令优先、校验只告警）。

## 偏差

- 计划文件清单原未含 `TUI/src/app/index.ts` 与 `TUI/tests/app.test.ts`：`pinned` 必须在 App 公开方法上透传，否则启动后校验会拿恢复前的默认路由当基线（恢复会话的 model 会被盖掉）；对应补一条 App 层用例。两处随实现补入清单，影响面仅限 TUI 内部，无对外契约变化。
- 未在用户主 profile `fff` 上跑真机：本会话沙箱对 `~/.dsh` 只读（profile boot 要写 `cordis.yml`，实测 `EROFS`），改用临时 `DSH_HOME` + `fff-test`（`link:` 协议，直接指向本次构建）验证；`fff` 是 `file:` 快照，需 `scripts/install.sh --profile fff --sync` 后才对用户会话生效（本次未执行：沙箱只读且需用户确认）。

## 测试与证据

- `pnpm -C TUI run check`：exit 0。
- `pnpm run check`（全包）：exit 0；`pnpm run build`（全包）：exit 0。
- `pnpm run test`（全包）：exit 0。
- `pnpm run test:tui`：tests 1877 / pass 1877 / fail 0。
- `pnpm run check:docs`：119 篇现行 Markdown / 959 个 .ts，错误 0 / 警告 0。
- `format` 已跑（`TUI/src/main.ts`、`TUI/src/app/runtime/commands-model.ts`、`TUI/src/app/index.ts`、两个测试文件、README、DESIGN、BACKLOG、本文件）。
- 真机（临时 `DSH_HOME` + `fff-test`，构建产物即本次改动；会话 `tui-611e8c62-63fc-4ae0-97d2-d75ffd1b91c7`）：
  - 新建：`dsh --profile fff-test --model tg/ds4f` → seq 3 `model/selection` = tg/ds4f/low → seq 4 steer 注入（符号规范）→ seq 13 首个 `request/header` config = **tg/ds4f/low**。
  - 恢复：`-c --model tg/ds4f`（会话内上一条记录为其它模型）→ seq 31 `model/selection` = tg/ds4f/low → seq 37 首个 `request/header` = **tg/ds4f/low**。
  - 对照：修复前同场景首个 `request/header` 为 tg/ds41f（本会话起点日志）。
- 未验证：`--provider` / `--effort` 单给与无效组合的首条请求失败表现（仅单测覆盖）。

## 收尾

- BACKLOG 条目「启动参数 `--model` 对首个请求不生效」标完成并从 `TUI/docs/BACKLOG.md` 移除。
- 本文件移入 `TUI/docs/archived/`。
- 回写 `TUI/README.md`、`TUI/docs/DESIGN.md`。
- 残留：主 profile `fff` 未同步（需 `scripts/install.sh --profile fff --sync`，等用户裁定）；`STATUS.md` 由用户择时更新，本次不改。
- 临时验证目录与编辑脚本已清理（`tmp/verify-home`、`tmp/verify-tty*.log`、`tmp/*-edits.txt`）。
