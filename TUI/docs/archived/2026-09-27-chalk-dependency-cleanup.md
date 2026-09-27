# TUI 未使用的 `chalk` 依赖与「零运行时依赖」口径统一（接取条目：`TUI/docs/BACKLOG.md`「TUI 声明了未使用的 `chalk` 依赖（与「零运行时依赖」口径冲突）」）

状态：关闭（真机确认通过）　　开启：2026-09-27　　关闭：2026-09-27
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`TUI/package.json`、`TUI/src/main.ts` 注释、根 `README.md` 三处口径统一为「零运行时依赖」：删除未使用的 `chalk` 依赖，并同步注释 / 文档。

## 调研

来源：仓库自查（本次核对）。

- `TUI/package.json:21`：`"dependencies": { "chalk": "^5.6.2" }`——**唯一**运行时依赖声明。
- 代码侧：`grep -rn "chalk" TUI/src TUI/demo TUI/tests TUI/bench TUI/scripts` 无 import（renderer 有意走 manual ANSI；`theme.ts` 为内置 truecolor + ANSI 槽位映射）。
- 文档侧三处口径：
  1. 根 `README.md:13`（TUI 行）：「运行时不 import 第三方依赖（`package.json` 中遗留的 `chalk` 声明待清理，见 `TUI/docs/BACKLOG.md` #42）」——已如实记为**待清理**；
  1. `TUI/README.md:3`：句末同样带「`package.json` 中遗留的 `chalk` 声明待清理」；
  1. `TUI/docs/DESIGN.md:16`（技术选型）：「源码零第三方 import（颜色走 manual ANSI；`package.json` 中遗留的 `chalk` 声明待清理，见 `BACKLOG.md` #42）」。
- 结论：依赖确系遗留（迁移期未清理），删除不影响构建 / 运行；三处文档的「待清理」说明随删除一并去掉，回到干净的「零运行时依赖」表述。

## 决策

选项 → 选定（本次实现自定，**待用户审阅**）：

1. **删除** `chalk`（`TUI/package.json` 的 `dependencies` 整个字段可去掉，因已无其它运行时依赖）——不保留、不改注释口径。
1. 同步三处文档：去掉「待清理」括号说明，保留「源码零第三方 import / 零运行时依赖」的正面表述。
1. 检查 `TUI/package-lock.json`（若 TUI 有独立 lock）：删除后重新生成 / 同步，避免 lock 与 package.json 不一致；若仓库根 lock 统一管理则只改 `package.json`（实现时以实际文件为准）。
1. **验收**：`npm run check` / `npm run build` / `npm run test:tui` 全绿；`node -e \"import('chalk')\"` 之类不再被任何 TUI 产物引用（源码零 import 已由 grep 证明）。

## 规划

任务拆分：

1. `TUI/package.json`：删 `chalk` 依赖（及空的 `dependencies` 字段）。
1. `TUI/package-lock.json`（如有）：同步依赖树。
1. 三处文档措辞更新：根 `README.md`、`TUI/README.md`、`TUI/docs/DESIGN.md`。
1. 验证：`check` / `build` / `test:tui` 三跑；确认 `dist/` 产物无 chalk 引用（`grep -r chalk TUI/dist` 空）。
1. 若 profile 以 `link:` 挂载 TUI：删除依赖后无需 `pnpm install`（`AGENTS.md` 已述 build→link 生效），真机启动一次确认无 `ERR_MODULE_NOT_FOUND`。

计划改动文件清单（**只改这些**）：

- `TUI/package.json`
- `TUI/package-lock.json`（存在且需要时）
- `README.md`（根，TUI 行）
- `TUI/README.md`
- `TUI/docs/DESIGN.md`
- 本追踪文档

明确不做：不改 renderer / 主题实现（manual ANSI 现状即目标态）；不引入替代依赖；不动其它包（其 `dependencies` 均非空且在用）。

## 实现记录

**实现（2026-09-27）**

1. `TUI/package.json`：删除 `dependencies` 整个字段（`chalk` 是唯一运行时依赖）——TUI 自此 **零运行时依赖**。
1. `README.md`（根，TUI 行）：改为「**零运行时依赖**（源码零第三方 import，颜色走 manual ANSI）」。
1. `TUI/README.md`（首段）：同上口径，去掉「遗留 `chalk` 声明待清理」过渡措辞。
1. `TUI/docs/DESIGN.md`（技术选型）：改为「**零运行时依赖**（源码零第三方 import；颜色走 manual ANSI，`dependencies` 为空）」。

**未改动的相关文字（有意保留）**：`src/renderer/theme.ts` / `src/renderer/screen.ts` 的注释仍说明「不用 chalk」及其原因（`39m`/`49m` 复位在浅色主题不可读）——这是**设计依据**，不是遗留口径；`src/main.ts` 的「本项目零运行时依赖」注释现与事实一致。

**无 lockfile 需同步**：`TUI/` 与仓库根都没有 `package-lock.json` / `pnpm-lock.yaml`（profile 以 `link:` 挂载），故只改 `package.json`。

## 测试与证据

| 命令 / 检查 | 结果 |
| --- | --- |
| `npm run check`（tsc --noEmit） | 通过 |
| `npm run build` | 通过（编译到 `dist/`） |
| `npm test`（TUI 全量） | **1179 例全通过** |
| `grep -rn 'from "chalk\|require("chalk' dist src` | 无输出（**无任何 chalk import**，含编译产物） |
| `grep -rn chalk TUI/{src,demo,scripts,tests,bench}` | 仅剩 3 处**注释**（theme.ts ×2 / screen.ts ×1，均为「为什么不用 chalk」的设计依据） |

备注（计划里写「`grep -r chalk TUI/dist` 为空」的口径修正）：编译产物会保留源码注释中的 chalk 字样，故验收改为「无 chalk **import**」+「残留仅注释」两条，语义等价且可机械校验（已如上执行）。

真机确认：profile 以 `link:` 指向本包，删依赖后无需 `pnpm install`，`dsh --profile fff` 启动应无 `ERR_MODULE_NOT_FOUND`（构建→link 生效，见 `AGENTS.md`）。

## 收尾

- 三处文档口径已回写（根 `README.md` / `TUI/README.md` / `TUI/docs/DESIGN.md`）；
- 无计划外文件；无可清理临时产物（构建产物 `dist/` 属既有流程常态）；
- 真机确认（2026-09-27）：用户重启 `dsh --profile fff` 正常进入并完成后续操作，无 `ERR_MODULE_NOT_FOUND`（删依赖后 profile 的 link 挂载无需重装即生效）。
- 原待办：用户人工确认（真机启动一次 TUI 无模块缺失）（已完成，本文档归档于 `TUI/docs/archived/`）。
