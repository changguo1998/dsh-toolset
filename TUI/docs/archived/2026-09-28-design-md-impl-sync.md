# DESIGN.md 与实现不一致（6 处）审计修正（接取条目：TUI/docs/BACKLOG.md「DESIGN.md 与实现不一致（6 处，审计结论）」）

状态：关闭　　开启：2026-09-28　　关闭：2026-09-28
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

按条目「DESIGN.md 与实现不一致（6 处，审计结论）」逐处核对 `TUI/docs/DESIGN.md` 与实现，消除 6 处口径不一致；不动代码。

## 调研

逐处核对源码（2026-09-28）：

1. **① L62 `bin/tui.js`**：实为双态启动器（`TUI/bin/tui.js`）——profile bundle 就绪（`$DSH_HOME/profiles/<profile>/node_modules/@dsh-toolset/tui`，校验包名 + bin 存在）→ `spawn dsh --profile` 并透传 argv/退出码；否则或 `--demo` → mock demo；只依赖 node 内置模块。
1. **② L118/120/129 四区域 pane 树**：`layout/build-box.ts:138` 的 `buildBox(buffer, opts) -> BuildBoxResult` 只产**两 pane 内容树**（`panes.dialogue` / `panes.activity`，另有等价引用与行元数据 `meta`/`metadata`），文件头自述「buffer 内容 → Box 内容树，不依赖 layout.ts」；四区域分割与整帧拼装在 `layout.ts`（`frameGeometry` L780 / `buildTopRegion` L1509 / `buildFrame` L2632）。
1. **③ L142 caret**：`components/QuestionPrompt.ts:314-318` 仅当 `customCaret !== null && customCaret > 0` 才给 `customCaretIndex`；光标在答案串首（`customCaret === 0`）无 caret（硬件光标保持隐藏）。
1. **④ L180 theme 归一**：`main.ts:545` 的 `normalizeTuiDisplayConfig(config)` 只处理 `messageGutter`（L167）；theme 由 L548-549 单独走 `normalizeThemeId(config.theme)`；App 侧 `app/index.ts:417` 再用 `normalizeThemeId(deps.initialTheme ?? DEFAULT_THEME)` 归一一次。
1. **⑤ L250 退出路径**：`app/index.ts:1685` Ctrl+D（idle 且输入区为空）、`app/index.ts:1716` Ctrl+C 750ms 双击窗口退出（常量 `CTRL_C_DOUBLE_MS = 750`，L160）。
1. **⑥ L257/L259 `model/selection` 回放**：已实现——TUI 侧会话快照存 model（`sessionUiState()` `app/index.ts:730-743`，`adapter/session-ui-state.ts`），恢复时 `adapter/dsh.ts:1263` `restoreSessionState` 按「宿主日志末条 `model/selection` → 快照 `model` → `request/header.config`」折叠并写回 `sessionModel.current`；`state.modelBySession`（state.ts:506）供状态栏与切会话恢复。

结论：6 处均为**文档过时**（实现为准），修正 DESIGN.md 口径即可。

## 决策

- 6 处全部按实现口径修 DESIGN.md；不改任何 `src/`、`tests/` 代码。
- 修正保持句子级最小改动，不重排文档结构、不新造编号。
- 途中发现的 BACKLOG 自身问题（头部计数「共 9 条」vs 实列 12 条、已完成条目未清理）登记为新条目，不在本任务内处理。

## 规划

计划改动文件清单：

- `TUI/docs/DESIGN.md`（6 处修正）
- `TUI/docs/BACKLOG.md`（本条目标「进行中」→「完成」；追加途中发现的新条目）
- `TUI/docs/implementation/2026-09-28-design-md-impl-sync.md`（本文件；关闭后移入 `TUI/docs/archived/`）

明确不做：改动任何源码 / 测试；顺手同步 SPEC / README / IMPLEMENTATION 等其他文档。

## 实现记录

2026-09-28：

- ① L62：`bin/tui.js` 注释改为「双态启动器：profile 就绪 → 委托 dsh --profile；否则 mock demo」。
- ② L118/120/129：分区层归属改为 `layout.ts`（`frameGeometry` + `buildTopRegion` / `buildFrame`）；排版管线标注 `buildFrame` + `buildBox` 两 pane 内容树；模块表 `build-box.ts` 行改为 `buildBox(buffer, opts) -> BuildBoxResult`（两 pane 内容树 + 行元数据）。
- ③ L142：补 caret 产出条件（仅 `customCaret > 0`；串首无 caret、硬件光标隐藏）。
- ④ L180：theme 归一改注 `normalizeThemeId`（`messageGutter` 仍走 `normalizeTuiDisplayConfig`；App 侧再归一一次）。
- ⑤ L250：退出路径补 `Ctrl+D` 与 750ms 内双击 `Ctrl+C`。
- ⑥ L257/L259：删除已实现的 `model/selection` 回放待做项与 deferred 列表中的同名项。
- BACKLOG：追加新条目（计数与已完成条目残留问题）；本条目标「进行中」→「完成」。

## 测试与证据

- `format` 预检（2026-09-28）：对改动文件的临时副本跑 `/home/guochang/fff/scripts/format`（mdformat），`diff` 无输出（mdformat 对本文档为 no-op），再对 `TUI/docs/DESIGN.md`、`TUI/docs/BACKLOG.md`、本文件实际执行 `format`，`git diff --stat` 与编辑内容一致，无整段重排。
- `git diff -- TUI/docs/DESIGN.md TUI/docs/BACKLOG.md` 自查：6 处修正均在计划范围内，行级最小改动，无顺手改动。
- 文档类改动：按流程免 `check` / `build` / `test`（无代码改动）。

## 收尾

- 回写：`TUI/docs/DESIGN.md`（6 处，即本任务产出）；BACKLOG 条目状态「完成」并追加新条目。
- 本文件移入 `TUI/docs/archived/`。
- 遗留：无。
