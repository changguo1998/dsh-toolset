# TUI 未使用的 `chalk` 依赖与「零运行时依赖」口径统一（接取条目：`TUI/docs/BACKLOG.md`「TUI 声明了未使用的 `chalk` 依赖（与「零运行时依赖」口径冲突）」）

状态：规划（决策已定稿，待用户审阅）　　开启：2026-09-27　　关闭：——
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

（待实现）

## 测试与证据

（待补：`npm run check` / `npm run build` / `npm run test:tui` 输出 + `grep -r chalk TUI/dist` 空）

## 收尾

（待补：三处文档回写确认、是否移入 `docs/archived/`）
