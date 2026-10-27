# `/{provider,model,effort} name` 不在目录内时警告并保持原设置（接取条目：TUI/docs/BACKLOG.md「/{provider,model,effort} name 不在目录内时警告并保持原设置」）

状态：关闭　　开启：2026-10-27　　关闭：2026-10-27

本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`/model`、`/provider`、`/effort`（含 `/thinking`）带参设置时，名字必须命中对应列表；未命中 → 警告并保持原设置（provider / model / effort 均不变），不隐式猜测、不回落默认。

## 调研

- `resolveModelSpec`（`TUI/src/app/commands.ts:123-157`）：裸 model id 查 `catalog.models`（无命中 → error，多 provider 同名 → 歧义提示）；`provider/model` 显式形态直接返回，不校验（`:131-139`）。
- 显式直通被 `tests/app.test.ts:2031` 锁定（「显式直通，无需目录命中」）；`:1498` 覆盖裸 id 的三种结果。
- 目录结构：`ModelCatalog { providers, models, current }`（`src/app/adapter/types.ts:598-602`）；effort 无目录缓存，需 `adapter.resolveModelInfo` 现取（`types.ts:585-590`）。
- 目录为 advisory：当前默认模型 / 自建 endpoint 可能不在 `listModels` 里（`commands.ts:106` 注释），严格校验有误拒风险。

## 决策

用户 2026-10-27 裁定：一律严格校验「改动后的完整组合」是否存在；未命中只警告并保持原设置，不列可选值。

1. 校验范围：provider 在 `catalog.providers`、`(provider, model)` 在 `catalog.models`、effort 在该 model 的 `efforts`；不保留显式 `provider/model` 的目录外直通。
2. 未命中文案：只说未找到并保持原设置，不列候选、不指路；notice 级别 warn。
3. 边界：advisory 目录下若当前路由本身不在目录，设置到当前值仍按「already on」提示、不报未命中；改到目录外的新值一律警告 + 保持。

## 规划

- 任务拆分：① 决策定稿（含与「/model、/provider、/effort 支持带参直接切换（含 /model provider/model:effort）」条目共用校验 helper）；② 实现 provider / model / effort 三条校验；③ 未命中文案；④ 测试改写与新增。
- 计划改动文件清单：
  - `TUI/src/app/commands.ts`（`resolveModelSpec` + provider / effort 校验 helper）
  - `TUI/src/app/index.ts`（`handleModelCommand` 与新增的 provider / effort 带参分支、notice 文案）
  - `TUI/tests/app.test.ts`（改写 `:2031`、`:1498` 一带，新增三命令未命中用例）
- 明确不做：不做目录缓存；不做模糊匹配 / 自动纠正；不改面板。

## 实现记录

- `src/app/commands.ts`：`modelRouteError` 严格校验 provider 与 `(provider, model)`；`resolveModelSpec` 对裸 model 保持跨 provider 唯一匹配、显式 `provider/model` 必须命中；`matchEffort` 供 effort 校验；advisory 目录下设置到当前值按 already-on。
- `src/app/index.ts`：三条命令未命中统一 warn（不列候选）；`/effort` / `/thinking` 未命中保持原设置；`/provider` 保留 model / effort 并校验组合。

## 偏差

无。

## 测试与证据

- `npm run check` 退出 0；`npm test` 1821/1821 通过。
- 覆盖：裸 id 未命中 / 多 provider 歧义、显式 `provider/model` 未命中、effort 未命中、advisory 当前路由 already-on。

## 收尾

- 追踪文档归档到 `TUI/docs/archived/2026-10-27-model-name-validation.md`。
- BACKLOG 条目已从 `TUI/docs/BACKLOG.md` 移除。
