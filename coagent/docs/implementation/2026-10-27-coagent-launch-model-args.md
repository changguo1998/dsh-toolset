# coagent 传递启动模型参数（provider / model / effort）（接取条目：coagent/docs/BACKLOG.md「coagent 传递启动模型参数（provider / model / effort）」）

状态：调研　　开启：2026-10-27　　关闭：—

本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`spawn` 新增可选参数 `provider` / `model` / `effort`，以 `fffdsh --provider X --model Y --effort Z` 同形转发（`model` 支持裸 id 与 `provider/model`，语义交给 TUI 校验）；一个都不给时命令保持 `fffdsh`、行为不变；`cmd` 回执与记录存完整命令行。

## 调研

- 拉起命令是常量 `LAUNCH_COMMAND = "fffdsh"`（`coagent/src/launch.ts:13`）；`spawn` 参数面 `SPAWN_KEYS = ["cwd", "label", "claimTimeoutSec"]`（`:62`），解析 `parseSpawnArgs`（`:140-165`），未知键提示见 `rejectUnknownKeys`（`:120-137`）。
- 提交路径：`actions.ts:432` 的 `herdr.run(terminalId, LAUNCH_COMMAND, context)`；失败回滚一次 `close`。
- 记录与回执：`types.ts:118` 的 `cmd: "fffdsh"` 是字面量类型；`tests/store.test.ts:52` 已有 `cmd: "fffdsh"` 断言。
- 守卫：`checkForegroundText`（`launch.ts:30-40`）拒脱管痕迹；`tests/spawn.test.ts:146-148` 断言 `LAUNCH_COMMAND === "fffdsh"`。
- 工具面与文档：`coagent/src/tools.ts:62-100` 的 spawn 参数描述；`coagent/README.md:15` 参数表。
- `fffdsh` 包装器把其余参数原样转给 `dsh`（`dsh "${pfx[@]}" "${base[@]}" ...`），重启轮亦保留原参数。
- 前置：`TUI/docs/BACKLOG.md` 的「启动参数指定 provider / model / effort」条目先落地；否则 flags 被 TUI 当未知参数忽略，子会话不报错但不生效。

## 决策

1. 参数面：`provider` / `model` / `effort` → 转发为 `--provider` / `--model` / `--effort`；`model` 允许裸 id 与 `provider/model`，原样透传（用户 2026-10-27 确认）。
2. 校验深度：coagent 只做语法校验（键名、字符串类型、字符集、长度），不查模型目录；组合存在性由被拉起的 TUI 校验（用户 2026-10-27 确认）。已知限制（同日接受）：组合不存在时警告只出现在子 TUI，spawn 回执仍为成功。
3. `cmd` 类型放宽为 `string`，旧记录值 `"fffdsh"` 仍合法，无需迁移。
4. 语法限制（2026-10-27 用户确认）：参数值字符集 `^[A-Za-z0-9._:/-]+$`，单值长度 ≤ 64；不满足 → spawn 前拒绝（`invalid_params`）。这是值校验，与参数命名无关。

## 规划

- 任务拆分：① 决策定稿；② `parseSpawnArgs` 扩展与校验；③ 命令拼装 + 守卫；④ 回执 / 记录字段；⑤ 工具 schema、README、DESIGN、测试。
- 计划改动文件清单：
  - `coagent/src/launch.ts`（命令拼装 / `SPAWN_KEYS` / `SpawnArgs` / 校验）
  - `coagent/src/actions.ts`（spawn 提交命令与回执）
  - `coagent/src/types.ts`（`cmd` 类型）
  - `coagent/src/tools.ts`（spawn 参数 schema）
  - `coagent/README.md`、`coagent/docs/DESIGN.md`
  - `coagent/tests/spawn.test.ts`、`coagent/tests/store.test.ts`
- 明确不做：不做任意 dsh 参数透传；不在 coagent 侧查模型目录；不改 `spawn` 的 cwd / label / claimTimeoutSec 语义。

## 实现记录

未开始（等用户放行后按规划实现）。

## 偏差

无。

## 测试与证据

未开始。

## 收尾

未开始。
