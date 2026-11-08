# sessionProjections.stateOf(session, key) 弃用迁移（接取条目：docs/BACKLOG.md「sessionProjections.stateOf(session, key) 弃用迁移」）

状态：关闭　　开启：2026-11-08　　关闭：2026-11-08
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. 消除 rc.1 对三处 `stateOf` 读法的弃用警告：`task-engine`（`tokenUsage`）、`context-report`（`sessionStats` / `sessionContext`）、`rule-engine`。
2. 能拿到领域服务的改读领域服务（如 `tokenMeter`）, 其余改用宿主公开的投影 handle 或后续替代 API。
3. 迁移后功能面零变化、无弃用警告；各包测试与全仓 check / build / test 全绿。

## 调研

- **宿主读面变更**: `SessionProjectionRegistry.stateOf(session, key)` 在 rc.1 标 `@deprecated`（`dsh-session-projection/lib/types/index.d.ts:217-227`, 首次读每个 key 打一条弃用日志）, 替代路径两种: ① 自己注册单元时 `await register()` 拿 `ProjectionHandle` 后 `handle.stateOf(session)`; ② 别的单元用 `snapshot(session, keys)`（同文件 `:246-257`）。
- **`snapshot` 的边界（关键）**: 文档原文「Only the returned units are computed: other units, including Host-only units without `wire`, are neither folded nor advanced by this read」——即 `snapshot` **不覆盖 host-only 单元**。
- **四处的键与可见性**: `tokenUsage`（`dsh-token-meter/lib/types/usage-projection.d.ts` 有 `wire`）、`inbox`（`dsh-agent-loop/lib/types/inbox.d.ts` 有 `wire`）、`sessionStats`（`dsh-session-stats/lib/types/projection.d.ts:100` 有 `wire`）→ 三者都可用 `snapshot`; `sessionContext` 是**本仓 context-report 自己注册的 host-only 单元**（`context-report/src/main.ts:331-344`, 刻意不声明 `wire`）→ `snapshot` 读不到, 只能靠 handle。
- **handle 拿不到**: 本仓 `context-report` 的 `apply` 是**同步**函数, `register()` 的返回值（`() => void` 形态的注销函数）直接塞进 `disposers` 丢弃了句柄; 改读 handle 需要 `apply` 改异步并保留句柄。
- **tokenMeter 能否替代 tokenUsage**: `TokenMeter.measure(session)` 给的是 pressure / 成本口径（`totalTokens`）, 与 `tokenUsage` 的「provider 上报累计输出 token」不是同一信号 —— 现有实现正是「拿不到 usage 才回退 pressure」, 故不能反向替代。

## 决策

1. 读法: a 三处可覆盖的键（`tokenUsage` / `inbox` / `sessionStats`）统一改 `snapshot(session, [key]).values[key]`, `sessionContext` 保留 `stateOf` 并写明原因 / b 全部改成 `apply` 异步 + 保留 handle / c 只补注释不迁移。
   选定 a（2026-11-08 用户批准「改用 snapshot」）—— b 要把 `context-report` 的 `apply` 改异步（连带其全部用例改 `await`）, 属独立改动, 且只能多解决一个键; c 不解决弃用告警。
2. 兼容旧宿主: 保留 `stateOf` 回退（`snapshot` 不存在时才走）, 回退路径不额外告警（旧宿主本来就只有这一条路）。
3. 包内实现形态: 每包一个 `readProjection(registry, session, key)` 小函数（`snapshot` 优先 → `stateOf` 回退 → `undefined`）, 三包各自持有（不新增跨包依赖, 与既有「各包自持结构面」惯例一致）。

## 规划

- 计划改动文件清单:
  - `task-engine/src/host.ts`（`ProjectionRegistryLike` 加可选 `snapshot` / 把 `stateOf` 标 deprecated, 新增 `readProjection`）
  - `task-engine/src/subagent.ts`（改调 `readProjection`; 告警文案去掉 `stateOf`）
  - `context-report/src/main.ts`（`ProjectionRegistryLike` 同上 + `readProjection`; `statsFor` 改 snapshot; `stateFor` 保留 `stateOf` 并写明 host-only 原因）
  - `rule-engine/src/index.ts`（同上, `pendingInboxMessages` 改 `readProjection`）
  - 三个包的测试（假注册表补 `snapshot`, 钉住「优先 snapshot」与「旧宿主回退」两条路径）
- 明确不做: 不改 `context-report` 的 `apply` 同步签名、不把 `sessionContext` 单元改成 `wire`、不改 token 口径、不动其他包。
- 验证: 三包各自 `check` / `build` / `test` / `test:integration`; 根 `pnpm run check` / `build` / `test`; `pnpm run check:docs`。

## 实现记录

- 2026-11-08: `task-engine/src/host.ts` 新增 `ProjectionSnapshotLike` 与 `readProjection`（`snapshot` 优先、`stateOf` 回退）, `ProjectionRegistryLike` 的两个方法都改可选; `subagent.ts` 改调 `readProjection(projections, session, "tokenUsage")`, 告警文案改为「读 tokenUsage 投影失败」。
- 2026-11-08: `context-report/src/main.ts` 同样加 `readProjection`; `statsFor` 走它（`sessionStats` 有 `wire`）; `stateFor` **保留** 注册表级 `stateOf` 并加注释说明 host-only 单元不进 `snapshot`、非弃用替代要 handle、本包 `apply` 同步未保留句柄。
- 2026-11-08: `rule-engine/src/index.ts` 加 `readProjection`, `pendingInboxMessages` 改调它（`inbox` 有 `wire`）。
- 2026-11-08: 测试更新 —— `task-engine/tests/usage.test.ts` 假注册表改为 `snapshot` 形态并新增「旧宿主只有 stateOf → 回退可用」用例; `context-report/tests/assemble.ts` 假注册表加 `snapshot`（委托给内部 `stateOf` 折叠, 计 `snapshotCalls`）, 集成用例断言 `state`/`report` 走 snapshot; `rule-engine/tests/main.test.ts` 假宿主加 `snapshot` + `stateOf` 计数, 断言「不碰 stateOf」, 并新增「snapshot 抛错 → fail-open」用例。

## 偏差

- **`context-report` 的 `sessionContext` 未迁移**（条目原写「三处弃用警告全消除」）: 它是本包注册的 host-only 单元, `snapshot` 按宿主文档不覆盖; 非弃用读法要求保留 `await register()` 的 handle, 而本包 `apply` 是同步的。改 `apply` 为异步会连带其全部用例, 属独立改动 —— 已在 `docs/BACKLOG.md` 登记新条目。故本任务实际消除的是 `tokenUsage` / `inbox` / `sessionStats` 三处（原条目里的三项里有两项完整闭合、context-report 部分闭合）。
- 决策 3 的「三包各持一份 `readProjection`」是刻意的重复: 三包都不依赖 `session-paths` 那类共享包, 若新开一个跨包工具包只为一处 10 行函数, 反而增加接线与版本负担。

## 测试与证据

- `pnpm -C task-engine run check` / `build`: 通过; `run test`: 181 pass / 0 fail（新增「旧宿主只有 stateOf → 回退读法仍可用」1 例）。
- `pnpm -C context-report run check` / `build`: 通过; `run test`: 51 pass / 0 fail（集成用例新增 snapshot 断言）; `run test:integration`: 16 pass / 0 fail。
- `pnpm -C rule-engine run check` / `build`: 通过; `run test`: 177 pass / 0 fail（新增 snapshot 计数断言与 snapshot 抛错用例）; `run test:integration`: 13 pass / 0 fail。
- 根 `pnpm run check` / `build` / `test`: 各 38 个包全 `OK`。
- `pnpm run check:docs`: 通过（119 篇现行 Markdown / 959 个 .ts, 错误 0 / 警告 0）。
- 真机未验证「不再出现弃用警告」: 需要在挂载新代码的 dsh 会话里观察 stderr; 静态上三处已不再调用 `stateOf`（`grep` 只余 `readProjection` 内的回退分支与 `context-report` 的 `sessionContext`）。

## 途中发现

- `task-engine/tests/integration/plugin.test.ts:87` 有一条**与本次改动无关的既有红灯**: 断言工具参数 schema 的 `required` 集合应为 `[parent_id, children]`, 实际多出 `enumeration`。在 `HEAD`（`b23e3f22`）上 stash 掉本次改动后重跑同样失败 —— 属**先前遗留**（`enumeration` 进入 schema 后未同步该断言）。已按流程在 `task-engine/docs/BACKLOG.md` 登记新条目。

## 收尾

- BACKLOG 条目已移除, 本文件移入 `docs/archived/`。
- 回写: 无 README / DESIGN 变更（三包均无面向使用者的配置面变化）。
- 遗留: ① `context-report` 的 `sessionContext` 仍读注册表级 `stateOf`（见「偏差」, 已登记 BACKLOG 新条目）; ② `task-engine` 集成用例的既有红灯（见「途中发现」, 已登记）。
