# TUI 收拢布局层的 `delivery.kind === "user"` 判断

> 接取条目: `TUI/docs/BACKLOG.md` #1（2026-11-03 开工）
> 层级: TUI

## 计划改动文件清单

| 文件 | 作用 |
| --- | --- |
| `TUI/src/app/layout/pipeline/types.ts` | 新增 `UserDelivery` 与类型守卫 `isUserDelivery`（与 `BlockDelivery` 同文件，避免层间循环） |
| `TUI/src/app/layout/pipeline/sections.ts` | 7 处 `delivery.kind === "user"` 改调守卫 |
| `TUI/docs/BACKLOG.md` | 条目标进行中、关闭移除 |

## 调研

- `sections.ts:641` 起在 `case "user" | "notice" | "shell"` 分支里用 7 处 `delivery.kind === "user"` 取 `turn` / `step` / `status` / `steerContinued` / `injected` / `generation` / `queued` 等 user 分支字段。
- `state/updates.ts` 的 `isUserMessage(value: unknown)` 只收窄字符串（`value === "user"`），不能把交付对象收窄到 user 分支，直接替换会丢 `delivery.turn` 等字段的类型。
- 层向: `state/*` 已 import `layout/pipeline/*`（`reducer.ts` / `updates.ts` / `types.ts` 均有），反向让 `layout/pipeline/sections.ts` 依赖 `state/updates.ts` 会形成运行时循环；类型守卫放在 `pipeline/types.ts`（`BlockDelivery` 定义处）最稳。

## 决策

1. 守卫与 `UserDelivery` 类型放在 `pipeline/types.ts`，`sections.ts` 从同目录 `./types.ts` 引入；不改 `state/updates.ts`，避免 `sections → updates → sections` 循环。
2. 守卫签名 `(delivery: BlockDelivery) => delivery is UserDelivery`，保持判别式与收窄能力；`UserDelivery = Extract<BlockDelivery, { kind: "user" }>`。
3. 判断结果与节缓存内容不变，纯收拢；不动 `notice` / `shell` 分支的比较。

## 实现记录

- `types.ts`: 增 `UserDelivery` 与 `isUserDelivery`，JSDoc 说明为什么不用 `isUserMessage`。
- `sections.ts`: 7 处比较改为 `isUserDelivery(delivery)`（scope / source / status / steerContinued / injected / generation / steer 留白）。
- 无新增测试: 行为不变，由 TUI 既有 1829 例与 demo 冒烟覆盖。

## 测试与证据

- `pnpm -C TUI run check` 退出 0。
- `pnpm -C TUI run test`: 1829 例全过。
- `pnpm -C TUI run demo:build -- --smoke`: `SMOKE_OK`（42 条 `SMOKE_PASS`）。
- 全仓 `pnpm run check` / `pnpm run test` / `pnpm run test:e2e` 退出 0。

## 偏差

- 条目写改动位置为 `state/updates.ts` + `layout/pipeline/sections.ts`；实际守卫放 `layout/pipeline/types.ts`（`state` 已被 `layout` 依赖，反向 import 会成环）。`state/updates.ts` 未改，`isUserMessage` 语义保持。
