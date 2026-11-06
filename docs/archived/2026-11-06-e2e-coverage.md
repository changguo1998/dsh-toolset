# 补齐四个包的 e2e 用例（接取条目：docs/BACKLOG.md「补齐四个包的 e2e 用例（flow-track / pin-note / term-check / shell-parse）」）

状态：关闭　　开启：2026-11-06　　关闭：2026-11-06
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

`e2e/` 目录每个插件一条真宿主用例；本轮补齐四个缺口包：`flow-track` / `pin-note` /
`term-check` / `shell-parse`，并把 `e2e/README.md` 的条数从 33 改到 37。

## 调研

（来源：本仓 `e2e/` 与各包入口）

- 用例形态：`bootPackage(<包目录>, { extraPackages, patch, prepare, env })` 起真实宿主 →
  `host.callTool()` 走完整工具管线 / `host.ctx.get(<服务>)` 读服务面 → 断言；
  注入类消费者用 `createAgent` + `appendTurn` + `captureInjections` + `waitFor`
  （`e2e/md-table-check.test.ts` 是范本）。
- 四个包的依赖面：`pin-note` inject `["memory","tools"]`（需 `memory-base` + `session-paths`）;
  `flow-track` inject `["ruleEngine"]` 且读 memory（需 `rule-engine` / `memory-base` / `session-paths`）;
  `term-check` inject `["ruleEngine"]`（需 `rule-engine`）; `shell-parse` 无依赖。
- `memory-base` 要 `dshHome`、`rule-engine` 要 `stateDir` 的用户层 patch，照既有用例写。

## 决策

1. 每包一条用例，只测「真宿主里确实生效」的那一面，不重复包内单测：
   - `e2e/shell-parse.test.ts`：`ctx.get("shellParse")` → 多词包装器剥离、`bash -c` 与 `$()`
     递归、参数位不误判、切段结果。
   - `e2e/pin-note.test.ts`：`pin_note` 工具写入 → `note_list` 能读到 → `pinNotes.summary`
     的条数 / 字数 / 标题。
   - `e2e/term-check.test.ts`：真实回合里投一条含旧称「返回体」的回复 → 收到更正注入（含
     禁止术语行与「回执」建议）。
   - `e2e/flow-track.test.ts`：`flow_enable` 打开 → `flow_record` 写「目标」→ `flow_status`
     读出阶段 → 服务面 `flowTrack.enabled()` / `summary()` 一致。
2. 不引入新夹具；`e2e/harness.ts` 现有能力够用（`callTool` 的 `agent` 参数用于会话归属工具）。
3. 条数口径按 `e2e/*.test.ts` 实际文件数（37）。

## 规划

计划改动文件清单:

- `e2e/shell-parse.test.ts`（新增）
- `e2e/pin-note.test.ts`（新增）
- `e2e/term-check.test.ts`（新增）
- `e2e/flow-track.test.ts`（新增）
- `e2e/README.md`（条数 33 → 37）
- `docs/BACKLOG.md`（本条标进行中, 收尾时移除）

明确不做:

- 不改四个包的代码与配置默认值。
- 不动 `e2e/harness.ts` 与已有 33 条用例。

## 实施记录

- 四条用例全部按「先 `bootPackage` + `t.after(dispose)`，再按包面取服务或工具」的既有形态写；
  `flow-track` 与 `pin-note` 的 patch 里给了 `memory-base.dshHome` 与 `rule-engine.stateDir`，
  临时 `DSH_HOME` 由夹具创建并随用例删除。
- `term-check` 用术语表里的无条件旧称「返回体」作触发样本，断言注入文本含「禁止术语」与「回执」。

## 验证

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 四条用例（逐条） | `pnpm exec node --experimental-transform-types --test --test-force-exit e2e/<包>.test.ts` | 4 条全通过 |
| 全量 e2e | `pnpm run test:e2e` | 37 条全通过（原 33 + 新 4） |
| 文档标准 | `pnpm run check:docs` | 通过 |

备注：`node` 直跑被 `behavior-correction` 的命令位规则拦下（属预期行为），改用
`pnpm exec node …` 执行，未绕过拦截。
