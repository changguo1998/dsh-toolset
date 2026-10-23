# 把 `timer` 包改名为 `clock-base`（与宿主定时器错开）

状态：已完成　　开启：2026-10-23　　关闭：2026-10-23
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

包名与条目 id 都改名为 `clock-base`，与宿主的 `cordis-plugin-timer`（包名 `timer`、条目 id `timer`、服务名 `timer`）彻底错开；
功能与服务名不变（仍提供 `clock` 服务的 `now()` 与 `scope(ctx)` 排期面）。

## 调研

- 起因：接入 profile 时宿主 base 已有 `- id: timer`，本包同名导致重复 id、其中一条未激活、HMR 一直等 `timer` 服务（详见 `docs/archived/2026-10-22-clock-unified-timers.md`「接线上发现的缺陷」）。
- 命名风格：项目内包名统一「小写、连字符、二到三词的名词短语、按角色命名」，如 `memory-base` / `session-paths` / `rule-engine` / `command-template`；单字只有 `timer` 与 `ponytail` 两个例外。
- 功能对照：`alarm` 指墙上时刻触发且通常持久化，不贴合；`timer` 最贴合排期但这正是宿主占用的名字；`clock` 覆盖 `now()` 与排期面，最终取「领域 + 底座」构词 `clock-base`。

## 决策

1. 包名 `@dsh-toolset/clock-base`、目录 `clock-base/`、条目 id `clock-base`、`export const name = "clock-base"`。
2. 服务名保持 `clock` 不变（消费方 `ctx.get("clock")` 无需改动）。
3. 一次性全量改名，不同时保留旧名别名（避免两个 id 再次撞车）。
4. profile 的 `dsh.profile.bundles` 与依赖链接同步改为新包名。

## 规划

### 计划改动文件清单

- 包目录：`timer/` → `clock-base/`（`package.json`、`package-lock.json`、`cordis.patch.yml`、`README.md`、`src/main.ts`、`tests/main.test.ts`）
- 消费包测试 import：`ast-tools`、`auto-approve`、`command-template`、`herdr-integration`、`herdr-use`、`rule-engine`、`script-interpreter`、`task-engine` 的 `tests/clock.test.ts`
- 根 `package.json` 的 `check` / `build` / `test` / `demo` 链；`scripts/test-parallel.sh`；`scripts/install.sh`
- `AGENTS.md`、根 `README.md` 与 `README.zh.md`
- 文档：`docs/BACKLOG.md` 条目 2 正文的包名、`docs/archived/2026-10-22-clock-unified-timers.md`
- 工作区外：profile `fff` 的 bundles / dependencies / 符号链接

### 验收

- `cd clock-base && npm run check && npm test` 全绿；八个消费包的 `tests/clock.test.ts` 通过。
- 根 `npm run check` 通过（改名后不再有 `timer` 目录）。
- `dsh --profile fff --dump-config` 只出现 `- id: clock-base`，无 `timer`（宿主那条除外），且不再有 `1 entry did not activate` / `hmr: pending (waiting for service: timer)` / `clock 服务不可用`。

## 关闭记录

- 提交：`2d2fbd4`（rename + 引用同步 + 文档），本提交（收尾）
- 验证：`clock-base` 24 例、八个消费包 check/test（45/157/33/13/164/173/94/44）、根 `npm run check` 全绿；`dsh --profile fff --dump-config` 只出现 `- id: clock-base`
- profile 侧（工作区外）：bundles 与依赖链接改为 `@dsh-toolset/clock-base`，符号链接重建；备份 `package.json.bak-clockbase`
- 未做：真机重启后的服务可用性确认（用户下次重启时观察日志即可）
