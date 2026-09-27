# /continue 改「最新会话」语义（BACKLOG: TUI#23）

状态：规划　　开启：2026-09-27
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

修 `/continue` 的回退行为：原规则把当前活跃会话（live）天然排除，导致「本会话已是最新时仍切到其他会话」，连按会依次往前回退。按用户 2026-09-27 裁定**方案 C**：候选并入**当前会话**（仅当它已有用户消息——刚起的新会话不算），若最新者就是当前会话 → info 提示「当前会话已是最新」、不切换；CLI `-c` 语义不变（启动时无当前会话）。

## 调研

- 现状：`pickRecentSession(records, cwd)`（`adapter/dsh.ts:720-735`）候选 = 同目录 + `persisted` + `!live` → 当前会话恒被排除；`/continue`（`index.ts:2630-2659`）与 CLI `-c` 共用它。
- 判定「当前会话是否已有用户消息」需要数据：`SessionInfo` 目前只有 `isEmpty`（仅对 `persisted && !live` 计算），live 会话拿不到。已有 surface 探针（`readMessages`）产出 `hasPrompt`，但只对「无官方标题」的会话执行 → 需要把**当前活跃会话**也纳入探针，并把 `hasPrompt` 暴露到记录上。
- 探针失败分支已按保守处理（`hasPrompt: true`，视为有内容）；`readMessages` 缺省（CLI 路径）时不探针，但 CLI 不涉及当前会话逻辑。

## 决策

| # | 维度 | 选项 → 选定 | 理由 |
|---|------|------------|------|
| D1 | 语义 | 保持「最近退出的会话」/ **「最新会话」（含当前会话）**（用户裁定 C） | 消除连按回退；主用例（刚起新会话 → 回退到上次会话）不受影响 |
| D2 | 「当前会话已使用」判据 | 时间比较 / **`hasPrompt`（探针确认有用户消息）** | 时间比较下 live 会话恒最新，会让 `/continue` 完全失效；`hasPrompt` 能区分「刚起的新会话」与「用过的会话」 |
| D3 | 未知 `hasPrompt` | 视为「已使用」 | 探针失败（`hasPrompt: true`）与无探针（CLI）都保持保守/无影响 |
| D4 | 实现位置 | app 层拼规则 / **adapter 纯函数 `pickContinueTarget`** | 与 `pickRecentSession` 同处、便于单测；`/continue` 只做提示与切换 |

## 规划

计划改动文件清单（= 落点；计划外文件不改）：

- `TUI/src/app/adapter/dsh.ts`（`pickContinueTarget` 纯函数、排序比较器抽公共、探针覆盖活跃会话、`hasPrompt` 落记录）
- `TUI/src/app/adapter/types.ts`（`SessionInfo.hasPrompt?: boolean`）
- `TUI/src/app/index.ts`（`continueRecentSession` 改用新函数 + 「已是最新」提示）
- `TUI/tests/adapter.dsh.test.ts`（`pickContinueTarget` 用例；探针/hasPrompt 断言）
- `TUI/tests/app.test.ts`（既有 `/continue` 用例夹具补 `hasPrompt: false`；新增「已是最新 → 不切换」用例）
- `TUI/README.md`（`/continue` 行）、`TUI/docs/IMPLEMENTATION.md`（`/continue` 落点行）
- `TUI/docs/BACKLOG.md`（#23 状态）
- 本追踪文档（关闭时移入 `TUI/docs/archived/`）

明确不做：不改 CLI `-c` / `--resume` 行为、不改 `/session` 面板规则、不做顺手优化。

## 实现记录

1. `adapter/types.ts`：`SessionInfo.hasPrompt?: boolean`（`false` = 读取面可读且确无用户消息；`true`/省略 = 有内容或未判定）。
1. `adapter/dsh.ts`：探针 `probeIds` 纳入**当前活跃会话**（有官方标题也探）；记录带 `hasPrompt`；排序比较器抽 `byUpdatedDesc`（`listSessionRecords` / `pickRecentSession` / 新函数共用）；新增 `pickContinueTarget(records, cwd)`（返回 `{kind:"current"} | {kind:"session",record}` | undefined）。
1. `app/index.ts`：`continueRecentSession` 改用 `pickContinueTarget`；`kind:"current"` → info「当前会话已是最新，无需恢复」不切换；CLI 路径（`main.ts`）不变。
1. 测试：`tests/adapter.dsh.test.ts`（`pickContinueTarget` 四态 + 「活跃会话有官方标题也探针 → hasPrompt:false」；`FakeSessionQuery.emptySessions` 支持；既有归一化用例补 `hasPrompt` 断言）；`tests/app.test.ts`（既有两例夹具补 `hasPrompt`；新增「已是最新 → 不切换」「当前较旧 → 切到更新会话」）。
1. 文档：`README.md`（`/continue` 行）、`docs/IMPLEMENTATION.md`（`/continue` 落点行 + 编辑时间条目）。

## 测试与证据

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run check` | 干净（0 error） |
| 全量单测 | `npm test` | **1176 pass / 0 fail**（新增 4 条用例） |
| 构建 | `npm run build` | 通过（dist 已刷新） |

## 收尾

- `TUI/docs/BACKLOG.md` #23 标「完成」；本追踪文档移入 `TUI/docs/archived/`。
- 真机目视：待用户重启后验证——① 在已用过的会话里 `/continue` → 提示「当前会话已是最新」不切换；② 刚起的新会话 `/continue` → 仍回退到最近退出的会话。
- `STATUS.md` 不改（用户择时更新）。
