# TUI 待办与开放项

> 职责：TUI 包的待办、开放项与已知外部问题（TUI 的变更优先写在本目录）
> 不负责：跨包功能待办（见 `docs/BACKLOG.md`）、TUI 现状（见 `TUI/docs/STATUS.md`）
> 过期条件：无
> 编号口径（2026-09-26 重排）：现行条目用**扁平连续 `#n`**（与项目级 `docs/BACKLOG.md` 一致）；历史上按「章节.序号」编号的条目（`3.x.y`）已于同日清理，记录见 git 提交与 `TUI/docs/archived/`，故现行编号不复用旧号段。本文件的 `#n` 与项目级 `docs/BACKLOG.md` 的 `#N` **互不关联**、各自文件内唯一，跨层引用须写明文件路径。
> 分组口径（2026-09-26 修订，按用户要求）：按**验收方式**分两类——**需要交互**指验证时必须动手操作（敲命令、按键、输入文字、带参数启动、等超时）；**不需要交互**指看一眼结果或跑自动化即可（渲染、排版、显示、内部机制、外部依赖）。判断标准是「验证时是否需要操作」，不是「改动是否可见」。

## 待办（共 3 条：#18 进行中，#20 / #25 待办；另 #8 仅提醒，不做实现）

### 需要交互（2 条：#18 / #20）

> 验收时要动手：敲命令、按参数启动、在面板里输入或按键。

- **进行中（2026-09-27）** **#18 TUI 符号逻辑迁出为独立插件 `symbol-normalizer`（项目级 #43 / #48）**：TUI 删除 `src/app/symbols.ts`（含默认规则与算法）、逐符号冷却表与 turn-end followup；改经 `ctx.get('symbolNormalizer')` 服务消费——流式展示归一（`normalize`）与 notice（`onReview` 回调，口径与模型反馈的冷却一致）；插件缺席 → 原文透传（无归一、无提醒）；`/symbol-unify` 开关保留（仅控制 TUI 侧归一与订阅）。落点：`src/app/index.ts`、`src/app/config.ts`、`src/app/adapter/types.ts`、`src/main.ts`、`tests/`、`docs/DESIGN.md`、`TUI/README.md`。来源：项目级 `docs/BACKLOG.md` #43（2026-09-27 用户定稿；原「不迁移、仅消费者改造」方案作废）。

- **待办** **#20 CLI `--resume` / `-c` 启动恢复后历史区为空（不渲染既有消息）**：`main.ts` 在 App 创建前走 `agents.resume`；历史行折叠只在 `/session` 切换路径（`resumeToSession` → `history-resume-ok`）发生，CLI 启动恢复只经 `restoreSessionState` 回填 model/mode/goal/todo → 活动区空，需手动 `/session` 再切一次才可见会话内容（agent 侧上下文已恢复）。落点：`src/app/index.ts`（启动后补一次 surface 折叠）/ `adapter/dsh.ts`（暴露「本次启动为恢复」或启动即 emit 历史行）/ `tests/`。来源：2026-09-27 修复 TUI#19 时隔离环境 PTY 实测（见其追踪文档「测试与证据」）。优先级 P2。

### 不需要交互（1 条：#25）

> 验收时看结果或跑自动化即可：面板显示形态、历史区排版、状态栏显示、内部机制、外部依赖（#8 待外部修复后回归）。

- **待办** **#25 TUI 声明了未使用的 `chalk` 依赖（与「零运行时依赖」口径冲突）**：`TUI/package.json` 的 `dependencies` 含 `chalk`，但 `src/`、`demo/`、`scripts/` 无任何 import（renderer 有意改 manual ANSI）；同时 `src/main.ts` 注释称「本项目零运行时依赖」、根 `README.md` TUI 行称「运行时唯一依赖 `chalk`」——三处口径需统一（建议删依赖 + 同步注释/文档；若确有用途则改注释口径）。落点：`TUI/package.json`、`TUI/src/main.ts`（注释）、`README.md`（TUI 行）。来源：2026-09-27 文档过时检查（#24）途中发现。优先级 P2。

### 仅提醒（#8，仅记录、不做实现）

- **#8 herdr pane 尺寸与其渲染区域不一致（外部问题，TUI 侧无法自行校正；2026-09-27 用户裁定：仅作提醒、不做实现）**：在 herdr pane 里运行时，全宽横线（状态栏下边框等）右端比 pane 渲染区少 1~2 列、需 `Ctrl+L` 或拖动 pane 才恢复；同一构建在独立终端里正常（2026-09-24 实测确认）。取证与排查结论：

  - 抓帧解析（`script -qec "dsh --profile fff" <cap>`）首帧：帧在它**自己的列数**下满宽（标题下划线 / 状态栏上下边框都到最后一列），活动区行按口径不补空格，布局无缺列；
  - 真机 PTY 假应答实验：`CSI 18t`（终端自报网格）确实由 TUI 发出，但终端的应答**到不了插件**（被宿主按键解码消费）→ 无法用终端查询校正尺寸；
  - 实测 Node 的 `stdout.columns` 与 `stdout.getWindowSize()` 都是**缓存值**（改 PTY winsize 但不发 SIGWINCH 时都不更新）→ 「实时 ioctl 读尺寸」这条路无效。
  - 结论：herdr 给 pane 的 PTY winsize 与实际渲染区差 1~2 列；修复应在 herdr 侧（pane 的 PTY 尺寸与渲染区一致，并在尺寸变化时同步下发、含 SIGWINCH）。本仓库 `herdr-integration` 只做状态上报（unix socket），不持有 PTY，无可改点；待 herdr 修复后回归验证。
  - 现场取证（在那台机器上跑，只读、结束恢复终端）：
    ```sh
    python3 - <<'EOF'
    import os,select,termios,tty
    fd=0; old=termios.tcgetattr(fd)
    try:
        tty.setraw(fd); os.write(1,b"\x1b[18t")
        r=select.select([fd],[],[],0.5)[0]
        print("终端自报网格:", os.read(fd,32) if r else "无应答", "| PTY:", os.get_terminal_size(1))
    finally:
        termios.tcsetattr(fd,termios.TCSADRAIN,old)
    EOF
    ```

## 已完成、不再跟踪

- 排版重构（Box 模型）与符号统一（白名单 / 归一 / 同符号冷却）均已完成，机制与配置见 `TUI/README.md`、`TUI/docs/SPEC.md`、`TUI/docs/IMPLEMENTATION.md`。
- 本地命令面：7 项纯 TUI 命令与 A1-A5 已完成，9 项候选当前无待办（裁定理由见 `TUI/docs/COMMANDS-SPEC.md` §7：`/clear`、`/login` `/logout` 维持排除；`/review` 搁置，可随 `docs/BACKLOG.md` 的 #17 一并考虑）；命令清单与层归属见 `TUI/docs/COMMANDS.md`；实施清单（已完成）见 `archive/TUI-COMMANDS-TASKS.md`。
- 2026-09-27 批次（#1 / #2 / #5 / #7 / #10 / #12 / #14 / #17）过程记录与复核清单见 `TUI/docs/archived/2026-09-27-tui-remaining-batch.md`；#19 为该批次 #2 的回归修复，记录见 `TUI/docs/archived/2026-09-27-sessionquery-read-timing.md`。
- 2026-09-26 已清理 29 条已完成条目（历史见 git 提交与 `TUI/docs/archived/` 追踪文档）。
- 2026-09-27 已清理 7 条已完成条目（#3 / #4 / #6 / #9 / #11 / #13 / #15）：过程记录见 `TUI/docs/archived/2026-09-27-noninteractive-backlog-batch.md`、`2026-09-27-tool-bootstrap-unlock-fix.md`、`2026-09-27-multi-question-symbol-row-color.md`（本次清理与残留登记见 `2026-09-27-backlog-cleanup-and-residuals.md`）。
- 2026-09-27 已清理 15 条已完成条目（#1 / #2 / #5 / #7 / #10 / #12 / #14 / #16 / #17 / #19 / #21 / #22 / #23 / #24 / #26）：各条过程记录见 `TUI/docs/archived/` 对应追踪文档（本次清理见 `2026-09-27-backlog-cleanup.md`）。
