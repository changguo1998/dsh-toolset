# coagent 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

> 编号口径：扁平连续 `#n`，仅供阅读，不用于追踪文档的命名与引用；每次整理时按当前顺序从 1 起重新编号。
> 本文件只列未完成项；已完成项见 git 历史与 `coagent/docs/archived/`。

## 待办

### #1 coagent 传递启动模型参数（provider / model / effort）〔进行中: 2026-10-27〕

**现象 / 现状**：`spawn` 只提交常量 `fffdsh`（`coagent/src/launch.ts:13`），参数面仅 `cwd` / `label` / `claimTimeoutSec`（`coagent/src/launch.ts:62`）；回执与记录里的 `cmd` 也固定为 `"fffdsh"`（`coagent/src/types.ts:118`）。TUI 启动参数（`TUI/docs/BACKLOG.md`「启动参数指定 provider / model / effort」）落地后，coagent 拉起的子会话仍无法在启动时指定 provider / model / effort。

**期望**：`spawn` 新增可选参数 `provider` / `model` / `effort`，按 TUI 启动参数同形转发（`fffdsh --provider X --model Y --effort Z`；`model` 支持裸 id 与 `provider/model`，语义交给 TUI 校验）；一个都不给 → 命令保持 `fffdsh`，行为不变。命令拼装必须过 `checkForegroundText` 纵深防御，取值做字符集与长度校验（`^[A-Za-z0-9._:/-]+$`，单值 ≤ 64）防注入；`cmd` 回执与记录改存完整命令行；`README.md` 参数表与 `DESIGN.md` 同步。

**前置**：`TUI/docs/BACKLOG.md`「启动参数指定 provider / model / effort」（启动参数生效）先落地；否则 flags 会被 TUI 当未知参数忽略，子会话不报错但不生效。

**落点**：`coagent/src/launch.ts`（`LAUNCH_COMMAND` / `SPAWN_KEYS` / `parseSpawnArgs`）、`coagent/src/actions.ts`（spawn 提交命令 432 一带）、`coagent/src/types.ts:118`（`cmd` 类型放宽为 `string`）、`coagent/src/tools.ts`（spawn 参数 schema）、`coagent/README.md:15`、`coagent/docs/DESIGN.md`；测试 `coagent/tests/spawn.test.ts`（拼装 / 拒绝注入 / 未给参数回退）与 `store.test.ts:52`。

**验收**：单测覆盖有参数 / 无参数 / 非法字符 / 脱管痕迹仍被拒；`npm test` 全绿；真机 `spawn({model:"<provider>/<model>", effort:"high"})` 后子会话状态栏显示指定路由。

**来源·状态·优先级**：用户 2026-10-27 提出；〔进行中: 2026-10-27〕；P2。
