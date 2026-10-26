# tool-consult：取消会话揭示上限

状态：完成　　开启：2026-10-27
接取条目：`tool-consult/docs/BACKLOG.md`「取消会话揭示上限」。
本文件是本任务唯一的过程记录与文档变更落点。

## 现象与期望

`session` 档揭示达到 `maxRevealed`（缺省 12）后，新工具一律被拒（`state.ts` 返回
`rejected-cap`），工具面提示「已达新增揭示上限」。可揭示项在会话内只增不减，配额只会挡住
后续真正需要的工具。

用户 2026-10-27 裁定：**`session` 档不设上限**（咨询即授权），`maxRevealed` 只保留 `turn`
档容量语义。

## 计划改动文件清单

- `tool-consult/src/state.ts`（授权分支与类型）
- `tool-consult/src/tool.ts`（配额文案、`rejected-cap` 分支与上限提示）
- `tool-consult/src/config.ts`（`maxRevealed` 注释）
- `tool-consult/tests/state.test.ts` / `tests/main.test.ts`
- `tool-consult/README.md`、`tool-consult/docs/BACKLOG.md` 与本文件

## 实现

- `src/state.ts`：删掉 `grant()` 里 `session` 档的 cap 分支；`GrantResult.status` 收窄为
  `"granted" | "already"`；`GrantLimits.maxRevealed` 注释改为仅 `turn` 档口径。
- `src/tool.ts`：配额文案改为「session 档已揭示 N 项，不设上限」；移除两处 `rejected-cap`
  分支与「已达新增揭示上限」提示块。
- `src/config.ts`：`maxRevealed` 注释改为「仅 turn 档」。
- `README.md`：配置表同步。
- 测试：`state.test.ts` 把「超上限拒绝」用例改成「超 `maxRevealed` 仍继续授权」（连续 16 次
  session 揭示全部 granted）；`main.test.ts` 的集成用例改为断言超出后仍揭示、且已授权不被抽走。

## 验证

- `npm run check`（tsc --noEmit）通过。
- `npm test`：**81 例（80 通过 / 1 跳过、0 失败）**，跳过项是 `retrieval.test.ts:209` 既有的
  已知 skip（措辞归 lint 任务），与本次无关。
- 未做真机验证：需在会话里连续揭示超过 12 个工具观察行为。

## 收尾

- 提交见 git 历史；条目从 BACKLOG 移出。
