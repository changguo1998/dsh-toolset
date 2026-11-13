# 文档现状同步（接取条目：docs/BACKLOG.md「文档现状同步（STATUS 计数 / BACKLOG 基线 / flow-track README）」）

状态：完成　　开启：2026-11-13　　关闭：2026-11-13
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

只改文档, 不动代码与配置: 按 2026-11-13 实测刷新 `docs/STATUS.md` 的总览与状态表, 校正 `docs/BACKLOG.md` 的宿主基线与第 2 节 flow-track 红诊断, 给 `flow-track/README.md` 的 `flow_record` 参数表标出 `slug` 可选。

`docs/STATUS.md` 按仓库规则由用户择时更新; 本次为用户 2026-11-13 指令明确要求更新, 属例外。

## 实测依据（2026-11-13, 仓库根）

- `pnpm run test`: 39/39 包全绿（退出 0）, 各包用例数见当次输出。
- `pnpm run test:e2e`: 41 例, 39 通过, 2 失败（`e2e/flow-track.test.ts:46`、`e2e/ponytail.test.ts:25`）。
- `e2e/flow-track.test.ts` 现象: `flow_record` 返回成功（`isError === false`）, 但 `<home>/.dsh/project.db` 未生成——与 BACKLOG 原记「`ctx.memory` 不可用」不符。
- `scripts/test-install.sh:590`: 根 `check` / `build` 已改为委托 `scripts/test-parallel.sh`, 第 11 步提取包清单为空, 断言恒失败（静态复核成立）。
- profile `~/.dsh/profiles/fff/package.json`: 38 个 `@dsh-toolset/*` bundle（TUI + 37 插件）, 无 `tool-surface`; 快照停在 2026-11-07。

## 计划改动文件清单

| 文件 | 改动内容 |
| --- | --- |
| `docs/STATUS.md` | 单测数口径日期 / 插件与包数 / profile 挂载 / 待办引用; 状态表补 5 行并刷新全部单测数 |
| `docs/BACKLOG.md` | 头部宿主基线改 `0.2.2-rc.1`; 第 2 节 e2e 红条目的 flow-track 诊断按 2026-11-13 复跑校正 |
| `flow-track/README.md` | `flow_record` 参数表把 `slug` 标为可选（缺省回退会话 id） |
| `docs/implementation/2026-11-13-docs-state-sync.md` | 本追踪文档, 关闭后移入 `docs/archived/` |

## 实现记录

- 2026-11-13: 建追踪文档并接取条目; 计划只改上表三个正文文档。
- 2026-11-13: 改 `docs/STATUS.md`——总览三处计数（38 插件 / 1879 例 / 38 个挂载包与 39 bundle, 并注明主 profile 未同步 `tool-surface`）、待办引用改为按标题（5 条未接取 + 1 条暂停）、单测数口径日期改 2026-11-13; 状态表补 `shell-parse` / `tool-surface` / `flow-track` / `pin-note` / `term-check` 五行, 其余 33 行单测数按当次运行刷新, `tool-consult` 说明改双轨。
- 2026-11-13: 改 `docs/BACKLOG.md`——头部基线 `0.2.1-rc.2` → `0.2.2-rc.1`（对照文档 `docs/host/HOST-UPGRADE-0.2.2-rc.1.md`）; e2e 红条目把「`ctx.memory` 不可用」改为「记录成功但 P 层库文件未生成」, 并补 2026-11-13 复跑与待查项。
- 2026-11-13: 改 `flow-track/README.md`——`flow_record` 的参数表把 `slug` 写成 `slug?`, 注明缺省回退会话 id。

## 测试与证据

- `pnpm run check:docs`: 通过（120 篇现行 Markdown / 970 个 `.ts`, 错误 0 / 警告 0）; `format` 对四个改动文件退出 0。
- 计数与口径核对: STATUS 状态表 38 行（38 插件, TUI 单列）; 用脚本比对 STATUS 每行单测数与 2026-11-13 `pnpm run test` 输出, 38/38 一致、无失败包; TUI 1879 例写入总览。

## 收尾

已关闭（2026-11-13）: 三份正文文档按实测更新完毕, `docs/STATUS.md` 状态表补 5 行并刷新全部单测数, `docs/BACKLOG.md` 基线与 e2e 红诊断校正, `flow-track/README.md` 的 `slug` 标为可选。未做: 主 profile（`~/.dsh/profiles/fff`）仍停在 2026-11-07 快照, 未同步 `tool-surface`（需 `scripts/install.sh --profile fff --sync`, 属部署动作, 不在本条目范围）。追踪文档归档于 `docs/archived/`。
