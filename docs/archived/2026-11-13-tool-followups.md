# 工具说明注册表收尾（接取条目：docs/BACKLOG.md「两个 e2e 用例长期红」/「`coagent` 接入 tool-surface」/「`scripts/test-install.sh` 第 11 步接线断言失效」）

状态：完成　　开启：2026-11-13　　关闭：2026-11-13
本文件是该任务的追踪文档；三项均已完成并归档。

## 目标

把上一任务（工具说明注册表与按需投递）留下的三件事做完: `coagent` 接入包装层、`flow-track` e2e 修红、`scripts/test-install.sh` 第 11 步修断言。`ponytail` 按用户裁定不再修改或测试。

## 用户裁定（2026-11-13）

- `coagent` 的「不 import 其他 `@dsh-toolset` 包」规矩取消, 必要情况下可以 import 其他包。
- `flow-track` 的测试用临时 `DSH_HOME`, 记录写入项目目录; 路径断言已确认正确。
- `ponytail` 计划废弃, 不再修改或测试。
- `scripts/test-install.sh` 的问题按修复处理。
- 先把计划写进文档, 暂不执行; 随后用户指令「按照顺序完成规划条目的 1-3」, 三项全部执行。

## 调查结论（2026-11-13, 只读阅读 + 临时探测脚本, 脚本已删除）

1. `flow-track` 的路径不是问题。夹具把 memory-base 的 `dshHome` / `projectRoot` 都指向临时 home（`e2e/harness.ts:109-118`）, P 层路径本来就是 `<home>/.dsh/project.db`, 与用例断言一致。
2. 真因: `flow-track/src/index.ts:185-200` 在 apply 时取一次 `ctx.memory`, 取不到就用「注册即抛错」的替身, 该实例此后永久 `unavailable`。装配顺序不保证 memory-base 先就绪时就会踩中; 探测显示同一夹具组合有时拿得到、有时拿不到, 拿得到时记录确实写进临时项目库。
3. 用例放过了失败: `flow_record` 返回的 payload 是 `{ok:false, error:"unavailable"}`, 但工具层 `isError` 仍为 `false`, 用例只断言 `isError === false` 就继续查库。
4. `coagent` 的规矩落在 5 处: `coagent/README.md:107`、`coagent/docs/DESIGN.md:31`、`coagent/src/types.ts:5`、`coagent/tests/guard.test.ts:211`、`coagent/tests/spawn.test.ts:107`; 工具注册点在 `coagent/src/main.ts:281`（单工具 `coagent`）。
5. `scripts/test-install.sh` 第 11 步前两行已从 `test-parallel.sh` 取 `default_pkgs` 比对; 后面那段仍从根 `package.json` 的 `check` / `build` 里抠 `pnpm -C <包> run`（`:576` 起, 判定在 `:590`）, 而根脚本 2026-11-08 起委托 `test-parallel.sh`, 抠不出内容, 恒报「check/build 链提取为空」。
6. `ponytail` e2e 失败为「步边界 5 s 内等不到注入」, 与挂载顺序无关; 按裁定不查不修。

## 决策（已执行）

1. `coagent`: 直接 `import { wrapToolDefinition } from "@dsh-toolset/tool-surface"`, 不新增 `toolSurface.wrap` 服务; `package.json` 加 `"@dsh-toolset/tool-surface": "link:../tool-surface"`。
2. `coagent`: 注册前套包装（`src/main.ts:281` 的 `ctx.tools.register(toToolDef(actions))` 改为先 `wrapToolDefinition`）; 删 5 处规矩文本与静态断言; 测试改断言「注册定义是短说明 + 宽松占位」。
3. `flow-track`: `memory` 改懒解析——apply 时不构造不可用替身, 每次调用时经反射面取服务; 取不到仍给现有可读错误与降级文案。补单测: memory 晚到时仍能写入。
4. `e2e/flow-track.test.ts`: 增断言 `flow_record` 的 payload `ok === true`, 避免 `isError === false` 掩盖 `ok:false`; 路径断言不动。
5. `ponytail`: e2e 用例保持现状, 不加 skip、不改; 在 `docs/BACKLOG.md` 记「计划废弃」。
6. `scripts/test-install.sh`: 删掉从根 `package.json` 抠清单的那段, 改为 `canonical_pkgs` / `default_pkgs` / 仓库包目录三方比对, 并补 39 个包的计数断言。
7. 执行顺序: `coagent` → `flow-track` + e2e → `test-install.sh`; 每项单独 `check` / `test`, 最后跑全量 `check` / `test` / `build` 与 `check:docs`。

## 计划改动文件清单

| 文件 | 改动 |
| --- | --- |
| `coagent/package.json` / `coagent/pnpm-lock.yaml` | 加 `@dsh-toolset/tool-surface` 依赖与 lock 条目 |
| `coagent/src/main.ts` | 注册前套 `wrapToolDefinition` |
| `coagent/README.md` / `coagent/docs/DESIGN.md` / `coagent/src/types.ts` | 删「不 import」规矩, 改依赖姿态说明, 补包装层口径 |
| `coagent/tests/guard.test.ts` / `coagent/tests/spawn.test.ts` / `coagent/tests/integration/plugin.test.ts` | 删静态断言, 补包装生效断言, 参数越界改断言 `ToolArgsError` |
| `flow-track/src/index.ts` / `flow-track/src/store.ts` | `memory` 改懒解析（构造参数改为取服务的函数） |
| `flow-track/tests/main.test.ts` / `flow-track/tests/store.test.ts` | 补「memory 晚到仍可写」用例; 告警文案断言与懒注册断言随之更新 |
| `flow-track/README.md` | 降级说明补「服务晚到能自愈」; 测试计数刷新 |
| `e2e/flow-track.test.ts` | 补 payload `ok` 断言 |
| `scripts/test-install.sh` | 第 11 步改三方比对 + 39 包计数 |
| `docs/BACKLOG.md` | 三条条目关闭并移入 §1 索引; `ponytail` 记「计划废弃」 |
| `docs/archived/2026-11-13-tool-followups.md` | 本文件, 关闭后归档 |

## 实现记录

- `coagent`: `main.ts` 注册前 `wrapToolDefinition(toToolDef(actions))`; 新增库依赖并删「不 import 其他包」规矩（README / DESIGN / types 三处文本, guard / spawn 两处静态断言与标题）; guard 的 T2 与集成注册面改断言「短说明 + 宽松占位 + catalog 全文」; `assemble.ts` 仍用未包装工具驱动动作层, 故参数越界用例分两层: 派发前由包装层拒（`ToolArgsError`）, 动作层二次校验仍由 guard 用例覆盖。
- `flow-track`: `FlowStore` 构造参数支持实例或 `MemoryProvider`; 句柄与 `#memory` 懒解析、解析成功才缓存（失败不缓存, 下次重试）; `record` / `removeMany` / `remove` / `list` 全走懒解析; `index.ts` 传入 `() => readService(c, "memory")`, apply 期告警文案改「流程记录暂不可写入（memory 服务尚未就绪）」。新增两条用例: store 层「服务晚到仍能写入, 失败不缓存」与 apply 层「apply 后挂上 memory, `flow_record` 仍能写入」。
- `e2e/flow-track.test.ts`: `flow_record` 后补 `recorded.value.ok === true` 断言, 失败时把 `textOf` 作为消息带出。
- `scripts/test-install.sh`: 第 11 步第二段重写为 Node 三方比对: 从根目录枚举 `package.json` name 以 `@dsh-toolset/` 开头的子目录, 与 `canonical_pkgs` 排序后比集合, 并断言两侧各 39 个包; 保留原有「每个 canonical 目录都存在」断言。
- `docs/BACKLOG.md`: 三条未完成项删除, §1 索引加一条关闭记录（含 `ponytail` 计划废弃口径）。

## 测试与证据

- `coagent`: `pnpm run check` 通过; `pnpm test` 77 例全绿; `pnpm run test:integration` 18 例全绿。
- `flow-track`: `pnpm run check` 通过; `pnpm test` 82 例全绿; `pnpm run build` 通过（e2e 跑 `dist`, 构建后才生效）。
- e2e: `pnpm run test:e2e` 41 例, 40 通过; 唯一失败为 `e2e/ponytail.test.ts`（按用户裁定「ponytail 计划废弃」保留现状, 不改不测）。
- `scripts/test-install.sh`: 全部 124 项通过（含新加的三方比对与 39 包计数）。
- 全量: `pnpm run check` 39/39 包通过; `pnpm run build` 39/39 包通过; `pnpm run test` 39/39 包全绿（coagent 77 / flow-track 82 等见当次输出）。

## 偏差

1. `coagent` 集成层两处「参数越界 → action 层 `invalid_params` / `invalid_action`」的断言改为 `ToolArgsError`: 注册定义套包装后, schema 越界在派发前被拒; 动作层二次校验仍由 `guard.test.ts` 的未包装 harness 覆盖。
2. `coagent` 的 `pnpm install` 在 pnpm 11 下对新增 `link:` 依赖报「Already up to date」且不写 lock; `pnpm-lock.yaml` 的 importers 条目按 `flow-track` 同格式手工补入。
3. `flow-track` 的 `FlowStore.available` / `unavailableReason` 现在会触发一次懒解析; 原「构造即注册 kind」的用例改为先读 `available` 再断言注册。
4. 执行中发现 e2e 走包 `dist`, 故 `flow-track` 先 `pnpm run build` 再复跑 e2e; 这一步写进验证顺序。
5. `test-install.sh` 第 11 步在文件中的位置仍排在 12f 之后（原编号顺序如此）, 本次不改编号。

## 收尾

已关闭（2026-11-13）: 三项均完成, `docs/BACKLOG.md` 三条未完成项删除并记入 §1 索引; `ponytail` 按用户裁定保持现状并标「计划废弃」。未做: 主 profile（`~/.dsh/profiles/fff`）同步 `tool-surface`（需 `scripts/install.sh --profile fff --sync`, 属部署动作）; 真机验收（TUI 红 ✗ 行与 `pinNotes` 全文投递）仍待人工确认。
