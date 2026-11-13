# 工具说明注册表收尾（coagent 接入 / flow-track e2e / test-install 断言）

状态：规划（未接取; 2026-11-13 用户裁定「先更新文档, 不要执行」）　开启：2026-11-13
本文件是本任务的追踪文档与文档改动位置; 代码改动待用户批准另起一轮后执行。

## 目标

把上一任务（工具说明注册表与按需投递）留下的三件事写成可执行计划: `coagent` 接入包装层、`flow-track` e2e 修红、`scripts/test-install.sh` 第 11 步修断言。`ponytail` 按用户裁定不再修改或测试。

## 用户裁定（2026-11-13）

- `coagent` 的「不 import 其他 `@dsh-toolset` 包」规矩取消, 必要情况下可以 import 其他包。
- `flow-track` 的测试用临时 `DSH_HOME`, 记录写入项目目录; 路径断言已确认正确。
- `ponytail` 计划废弃, 不再修改或测试。
- `scripts/test-install.sh` 的问题按修复处理。
- 先把计划写进文档, 暂不执行。

## 调查结论（2026-11-13, 只读阅读 + 临时探测脚本, 脚本已删除）

1. `flow-track` 的路径不是问题。夹具把 memory-base 的 `dshHome` / `projectRoot` 都指向临时 home（`e2e/harness.ts:109-118`）, P 层路径本来就是 `<home>/.dsh/project.db`, 与用例断言一致。
2. 真因: `flow-track/src/index.ts:185-200` 在 apply 时取一次 `ctx.memory`, 取不到就用「注册即抛错」的替身, 该实例此后永久 `unavailable`。装配顺序不保证 memory-base 先就绪时就会踩中; 探测显示同一夹具组合有时拿得到、有时拿不到, 拿得到时记录确实写进临时项目库。
3. 用例放过了失败: `flow_record` 返回的 payload 是 `{ok:false, error:"unavailable"}`, 但工具层 `isError` 仍为 `false`, 用例只断言 `isError === false` 就继续查库。
4. `coagent` 的规矩落在 5 处: `coagent/README.md:107`、`coagent/docs/DESIGN.md:31`、`coagent/src/types.ts:5`、`coagent/tests/guard.test.ts:211`、`coagent/tests/spawn.test.ts:107`; 工具注册点在 `coagent/src/main.ts:281`（单工具 `coagent`）。
5. `scripts/test-install.sh` 第 11 步前两行已从 `test-parallel.sh` 取 `default_pkgs` 比对; 后面那段仍从根 `package.json` 的 `check` / `build` 里抠 `pnpm -C <包> run`（`:576` 起, 判定在 `:590`）, 而根脚本 2026-11-08 起委托 `test-parallel.sh`, 抠不出内容, 恒报「check/build 链提取为空」。
6. `ponytail` e2e 失败为「步边界 5 s 内等不到注入」, 与挂载顺序无关; 按裁定不查不修。

## 决策（待执行）

1. `coagent`: 直接 `import { wrapToolDefinition } from "@dsh-toolset/tool-surface"`, 不新增 `toolSurface.wrap` 服务; `package.json` 加 `"@dsh-toolset/tool-surface": "link:../tool-surface"`。
2. `coagent`: 注册前套包装（`src/main.ts:281` 的 `ctx.tools.register(toToolDef(actions))` 改为先 `wrapToolDefinition`）; 删 5 处规矩文本与静态断言; 测试改断言「注册定义是短说明 + 宽松占位」。
3. `flow-track`: `memory` 改懒解析——apply 时不构造不可用替身, 每次调用时经反射面取服务; 取不到仍给现有可读错误与降级文案。补单测: memory 晚到时仍能写入。
4. `e2e/flow-track.test.ts`: 增断言 `flow_record` 的 payload `ok === true`, 避免 `isError === false` 掩盖 `ok:false`; 路径断言不动。
5. `ponytail`: e2e 用例保持现状, 不加 skip、不改; 在 `docs/BACKLOG.md` 记「计划废弃」。
6. `scripts/test-install.sh`: 删掉从根 `package.json` 抠清单的那段, 改为 `canonical_pkgs` / `default_pkgs` / 仓库包目录三方比对, 并补 39 个包的计数断言。
7. 执行顺序: `coagent` → `flow-track` + e2e → `test-install.sh`; 每项单独 `check` / `test`, 最后跑全量 `check` / `test` 与 `check:docs`。

## 计划改动文件清单

| 文件 | 改动 |
| --- | --- |
| `coagent/package.json` | 加 `@dsh-toolset/tool-surface` 依赖 |
| `coagent/src/main.ts` | 注册前套 `wrapToolDefinition` |
| `coagent/README.md` / `coagent/docs/DESIGN.md` / `coagent/src/types.ts` | 删「不 import」规矩, 改依赖姿态说明 |
| `coagent/tests/guard.test.ts` / `coagent/tests/spawn.test.ts` | 删静态断言, 补包装生效断言 |
| `flow-track/src/index.ts` | `memory` 改懒解析 |
| `flow-track/tests/` | 补「memory 晚到仍可写」用例 |
| `e2e/flow-track.test.ts` | 补 payload `ok` 断言 |
| `scripts/test-install.sh` | 第 11 步改三方比对 + 包数断言 |
| `docs/BACKLOG.md` | 三条条目更新; `ponytail` 记「计划废弃」 |
| `docs/implementation/2026-11-13-tool-followups.md` | 本文件, 关闭后移入 `docs/archived/` |

## 验证计划

- `coagent`: `pnpm -C coagent run check` / `test` / `build`。
- `flow-track`: `pnpm -C flow-track run check` / `test`。
- e2e: 只跑 `e2e/flow-track.test.ts`; `e2e/ponytail.test.ts` 不跑不改。
- `test-install.sh`: 跑到第 11 步, 断言通过。
- 全量: `pnpm run check` / `pnpm run test` / `pnpm run check:docs`。

## 状态记录

- 2026-11-13: 调查完成, 计划入档; 未接取, 未改代码。
