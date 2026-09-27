# 按当前代码复核并更新剩余过时文档（BACKLOG: TUI#26）

状态：规划　　开启：2026-09-27
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

用户 2026-09-27 指令「以当前的代码为准，更新过时内容」：延续 #24，把上一轮只报告未改的过时点改掉，并补查一处漏项。

## 调研

| 过时点 | 现状（代码为准） |
| --- | --- |
| `TUI/docs/STATUS.md` 现状段 | 缺 2026-09-27 批次成果（`/continue`、CLI 启动参数、notice 渲染、`/agents` 事件驱动保鲜、`/stats` 双口径、`/session` 排序与行首时间、冒烟失败信号）；「见 `TUI/docs/BACKLOG.md` §3」引用随编号扁平化失效（现为 `#8`） |
| 根 `README.md` TUI 行 | 称「运行时唯一依赖 `chalk`」；实际全仓（`src/`、`demo/`、`scripts/`、`bin/`）零 import（`chalk` 仅声明在 `package.json`，见 #25） |
| `TUI/docs/COMMANDS.md` §2.2 | 「本项目已有等效」清单漏 `/stats`（含别名 `/usage` `/context`；其余 38 项均已在列） |

复核方法：`LOCAL_COMMANDS`（39 条）与 README 命令表 / COMMANDS.md 清单逐项比对；chalk 全仓 import 检索；两份 STATUS 与最近批次追踪文档对照。

## 规划

计划改动文件清单（= 落点；计划外文件不改）：

- `TUI/docs/STATUS.md`（现状段回写 + 失效引用改 `#8`）
- `README.md`（TUI 行依赖口径）
- `TUI/docs/COMMANDS.md`（§2.2 补 `/stats`）
- `TUI/docs/BACKLOG.md`（#26 状态）
- 本追踪文档（关闭时移入 `TUI/docs/archived/`）

明确不做：不改代码 / `package.json`（chalk 走 #25）、不改 `docs/STATUS.md`（项目级，其内容为插件表与宿主基线，无 TUI 冲突表述）、不做顺手优化。

## 实现记录

1. `TUI/docs/STATUS.md`：现状段回写——命令面补 2026-09-27 批次成果（`/continue`、CLI `--resume` / `-c`、notice 渲染、`/agents` 事件驱动保鲜、`/stats` 双口径、`/session` 排序与行首时间、冒烟失败信号）；宿主升级适配段补 `sessionQuery` 读点约束；「`BACKLOG.md` §3」失效引用改 **#8**。
1. 根 `README.md`：TUI 行「运行时唯一依赖 `chalk`」→「运行时不 import 第三方依赖（`package.json` 中遗留的 `chalk` 声明待清理，见 #25）」。
1. `TUI/docs/COMMANDS.md`：§2.2 等效清单补 `/stats`（`/usage` `/context`）。
1. `TUI/README.md` 首段与 `TUI/docs/DESIGN.md` 技术选型行：同源 chalk 口径一并修正（源码零第三方 import；声明待清理见 #25）。
1. 命令清单复核：`LOCAL_COMMANDS` 39 条与 README 命令表逐项比对，0 缺失。

## 测试与证据

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 旧口径复核 | `grep -rn "运行时唯一依赖\|BACKLOG.md\` §3"`| 0 命中 | | 新口径复核 | 三处`grep -c`| 均 1 命中 | | 命令清单 |`LOCAL_COMMANDS`（39）vs README 逐项 | 0 缺失 | | 依赖口径 | `grep`全仓`chalk`import（src/demo/scripts/bin） | 0 import（唯有`package.json` 声明 → #25） | | 自动化 | 仅文档改动，未跑代码测试；`format\` 已对改动文件执行 | — |

## 收尾

- `TUI/docs/BACKLOG.md` #26 标「完成」；本追踪文档移入 `TUI/docs/archived/`。
- #25（chalk 声明清理）留待其他 agent 接取。
- 提交：按流程询问用户（本次为文档改动，可与 #24 一并成 `docs(tui)` 一笔）。
