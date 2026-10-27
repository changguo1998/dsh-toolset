# 启动参数指定 provider / model / effort（接取条目：TUI/docs/BACKLOG.md「启动参数指定 provider / model / effort」）

状态：调研　　开启：2026-10-27　　关闭：—

本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

新增 TUI 启动参数 `--provider <name>`、`--model <provider>/<model>`（也接受裸 `<model>`）、`--effort <level>`，均支持 `--flag value` 与 `--flag=value`；优先级 命令行 > profile patch config > 宿主默认；一个都不给时行为完全不变；与 `--resume` / `-c` 正交。

## 调研

- 现有启动参数：`TuiStartupArgs`（`TUI/src/main.ts:429-437`）只有 `resume` / `continueLatest`；解析 `parseTuiStartupArgs`（`:444-463`）；使用见启动流程 `:662-720`（`--resume` 优先于 `-c`，无效回落新建）。
- 初始路由：profile patch config 的 `provider` / `model` / `reasoningEffort`，其次宿主 `agentDefaultModel.currentSelection()`（`:576-604`）；`route` 作为 `agentOptions` 传给 `agents.create` / `agents.resume`（`:636-660`），`sessionModel.current` 供会话内选择（`:606-617`）。
- 参数来源：宿主 `dsh --help` 无 `--provider` / `--model` / `--effort`，启动器 flag 之后的参数原样进 `ctx.cmdlineArgs`（`main.ts:481-491` 读取），可新增且暂无冲突。
- 文档与测试：`TUI/README.md:23`「TUI 自有启动参数」；`tests/main.config.test.ts:66` 覆盖现有解析（含未知参数忽略）。

## 决策

用户 2026-10-27 逐项确认（第 2、3 项按本回复修订）：

1. `--provider` 单给：保留 config / 默认的 model 与 effort，校验叠加后的组合；不存在则警告并保持原路由。
2. `--effort`：adapter 就绪后校验；失败（名字不在该模型 `efforts` 内 / 模型无等级）→ 警告并回退到该模型的最低等级（取 `efforts` 列表首项；列表为空则不带 effort），不阻止启动。
3. 裸 `--model <model>`：用默认 provider（config / 宿主 `agentDefaultModel` 的 provider）解析；组合存在则切换，不存在 → 警告并回退到默认模型（config / 宿主默认整条路由）。
4. 显式 provider / model 在目录查无：警告 + 保持原路由，不列候选；不再做跨 provider 的裸 model 唯一匹配（裸 model 按第 3 条用默认 provider）。

## 规划

- 任务拆分：① 决策定稿；② 启动参数解析扩展；③ 路由叠加与校验接线；④ 启动提示；⑤ 文档与测试。
- 计划改动文件清单：
  - `TUI/src/main.ts`（`TuiStartupArgs` / `parseTuiStartupArgs` / route 与 `sessionModel` 组装 / create、resume 传参 / 启动提示）
  - `TUI/tests/main.config.test.ts`（解析与路由叠加用例）
  - `TUI/README.md:23`（启动参数说明）
  - 校验 helper 复用「/{provider,model,effort} name 不在目录内时警告并保持原设置」条目的实现
- 明确不做：不改 profile config 键；不与 coagent 联动（另立项目级条目）。

## 实现记录

未开始（等用户放行后按规划实现）。

## 偏差

无。

## 测试与证据

未开始。

## 收尾

未开始。
