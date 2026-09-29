# 改名遗漏修复：`connectIntercom` → `connectSessionChannel`（接取条目：session-channel「改名遗漏：`connectIntercom` 等大写 `Intercom` 标识符未跟随更名」）

状态：关闭　　开启：2026-09-29　　关闭：2026-09-29
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`intercom` → `session-channel` 更名时漏掉含大写 `Intercom` 的标识符（小写替换规则未命中）：`src/client.ts` 导出的 `connectIntercom` 及其在 `src/index.ts` 与 4 个测试文件中的引用（共 17 处）。本任务只做机械改名，不改行为。

## 决策

- 新名 `connectSessionChannel`（与服务名 `sessionChannel`、包名 `session-channel` 同族，风格对齐既有 `createSessionChannelService` / `getSessionChannelService`）。
- 不引入别名再导出（无兼容包袱：该函数未对外承诺，且尚未有第三方使用者）。
- 顺带核对：`grep -rn "Intercom"` 在 `src/` 与 `tests/` 应零残留（历史提交与归档文档中的旧名保留）。

## 规划

计划改动文件清单（**只改这些**）：

- `session-channel/docs/BACKLOG.md`（D2 状态）
- `session-channel/docs/implementation/2026-09-29-rename-connect-intercom.md`（本文件）
- `session-channel/src/client.ts`（定义）
- `session-channel/src/index.ts`（导入 + `deps.connect` 类型 + 调用，共 3 处）
- `session-channel/tests/{client,broker,service,inject}.test.ts`（引用）

明确不做：不新增功能、不改键位/协议、不处理 `docs/` 中历史文档的旧名（归档记录按当时名称保留）。

## 实现记录

- `src/client.ts`：`connectIntercom` → `connectSessionChannel`（定义处）。
- `src/index.ts`：导入、`deps.connect` 类型（`typeof connectSessionChannel`）、调用点共 3 处。
- 测试：`tests/{client,broker,service,inject}.test.ts` 全部引用同步（含用例标题文案）。
- 残留核对：`grep -rn "Intercom" session-channel/src session-channel/tests` → 0 处；`docs/` 中仅历史记录（归档追踪文档、D2 条目原文）保留旧名。

## 测试与证据

- `npm --prefix session-channel run check` → 0 error；`run build` → 0 error。
- `npm --prefix session-channel run test` → 22 例全通过（纯改名，用例与断言未变）。
- 行为不变（可通过重启后 `session_channel` 工具仍可用间接确认）。

## 收尾

- D2 标记完成并从 `session-channel/docs/BACKLOG.md` 移除；本文件移入 `session-channel/docs/archived/`。
- 无 README / DESIGN 回写需求：文档中未出现 `connectIntercom`（该函数不是对外契约；对外契约是工具名 `session_channel` 与服务名 `sessionChannel`，均未变）。
