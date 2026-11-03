# auto-approve 可选服务缺席时降级

> 接取条目: `docs/BACKLOG.md` §2 #5（2026-11-03 开工）
> 层级: 项目级

## 计划改动文件清单

| 文件 | 作用 |
| --- | --- |
| `auto-approve/src/types.ts` | `readService` 兜底读取加保护, 不再让 cordis 的属性访问异常冒出 |
| `auto-approve/tests/config.test.ts`（或新用例文件） | 覆盖 `ctx.get` 抛错 + 直接属性读取抛错时返回 `undefined` |
| `e2e/auto-approve.test.ts` | 只挂 `dsh-base` + 本包时插件激活、审计降级原因可读; 挂齐可选面时行为不变 |
| `docs/BACKLOG.md` | 条目标进行中、关闭移除 |

## 调研

- `readService(host, key)` 先 `ctx.get(key)`（try/catch 包住），失败后回落到 `host[key]` 直接属性读取；cordis 对未注入的服务属性访问会抛 `cannot get property "..." without inject`，这次抛错没有捕获，导致 `apply` 抛出、条目记 `entry did not activate`。
- `createAudit` 已对 `sessionPaths === undefined` 调 `degrade(...)`（会话审计不可写、自动放行停用、请求退回人工面板），对 `memory === undefined` 跳过项目审计并告警；所以只要服务读取能返回 `undefined`，降级链路本身是齐全的。
- `command.ts` 的 `readService(host, "commands")` 也经同一函数，修好后命令面缺席同样安全。

## 决策

1. **只改兜底读取**: 在 `readService` 里把 `record[key]` 包进 try/catch，抛错同样视为服务不可用；不改各调用点的语义。
2. **保留 `ctx.get` 优先**: 宿主服务面存在时仍走 `ctx.get`，行为不变。
3. **e2e 断言两个场景**: 只挂本包（激活 + 审计降级原因）、挂齐 `session-paths` + `memory-base`（服务面与命令输出正常）。

## 实现记录

- `types.ts`：直接属性读取套 try/catch，异常返回 `undefined`；注释补「cordis 对未注入属性会抛，按不可用处理」。
- 单测：`tests/types.test.ts` 用抛错 Proxy 模拟 cordis 上下文，断言 `readService` 对 `sessionPaths` / `memory` 均返回 `undefined`；另断言 `ctx.get` 优先与普通属性读取不变。
- e2e：`e2e/auto-approve.test.ts` 改为只挂 `dsh-base` + 本包，断言插件激活、`status().audit.sessionWritable === false`、`degradedReason` 指明 session-paths、`/autoapprove status` 输出「审计（会话）: 不可用」。

## 测试与证据

- `pnpm -C auto-approve run check` 退出 0；`build` 成功。
- `pnpm -C auto-approve run test`：183 例全过（原 181 + 新增 2）。
- `pnpm run test:e2e` 全跑 33/33 退出 0（auto-approve 场景改为降级路径）。
- 全仓 `pnpm run check` / `pnpm run test` 退出 0。

## 偏差

- **同文件两次 `runProfile` 不可行**: 试图在一个 e2e 文件里先后装配「无可选面」与「挂齐可选面」，第二次装配仅 113 ms 且 session-paths 不可见（进程内二次起树状态不干净）。按既有「一文件一宿主」口径，e2e 只保留新的降级场景；「挂齐时行为不变」由 183 例包内测试与上一条目全跑记录覆盖。
- 未改 `README`: 可选面与降级语义原文已正确，缺的只是实现层的兜底捕获。
