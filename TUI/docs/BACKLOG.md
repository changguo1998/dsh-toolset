# TUI 待办与开放项

> 职责：TUI 包的待办、开放项与已知外部问题（TUI 的变更优先写在本目录）
> 不负责：跨包功能待办（见 `docs/BACKLOG.md`）、TUI 现状（见 `TUI/docs/STATUS.md`）
> 过期条件：无
> 分组口径（2026-09-26 定）：待办按**主要改动部位**分组，一条只归一个主组，跨组以编号指引（如「见 #4」）。

## 1. 命令扩展

- **#1 新增 `/continue` 命令（加载当前目录下最近退出的会话）+ `/session` 列表改按编辑时间降序**：① `/continue`：**无参数**的新 slash 命令，等价于「`/session` + 自动选中当前目录下最近退出的那条会话」，复用同一加载路径；无匹配会话时给 notice 提示。② `/session` 面板列表排序改为**编辑时间从晚到早**（`updatedAt` 降序；现有排序口径实现时查证并补测试）。落点：`src/app/commands*`、`src/app/adapter/dsh.ts`、`docs/COMMANDS.md` / `COMMANDS-SPEC.md`、`README.md`、`tests/`。来源：2026-09-26 用户规格。

- **#2 CLI 启动参数：`--resume <sessionId>` 与 `-c` / `--continue`**：给 `src/main.ts` 加 argv 解析（当前完全不解析 argv）。① `--resume <id>`：启动即恢复指定会话（走既有 `agents.resume({ resumeSessionId })`，与 `/session` 选择一致），id 无效时提示并回落新建；② `-c` / `--continue`：启动即加载**当前目录下最近退出的会话**（与 #1 同语义、共用选择函数），**没有可恢复会话时静默新建**。用法：`dsh --profile fff --continue` / `dsh --profile fff --resume <id>`。落点：`src/main.ts`、`adapter/dsh.ts`、`README.md`、`tests/`。来源：2026-09-26 用户规格。

- 7 项纯 TUI 命令与 A1-A5 已完成，9 项候选当前无待办。裁定理由见 `TUI/docs/COMMANDS-SPEC.md` §7（`/clear`、`/login` `/logout` 维持排除；`/review` 搁置，可随 `docs/BACKLOG.md` 的 #17 一并考虑）；命令清单与层归属见 `TUI/docs/COMMANDS.md`；实施清单（已完成）见 `archive/TUI-COMMANDS-TASKS.md`。

## 2. 已完成、不再跟踪

- 排版重构（Box 模型）与符号统一（白名单 / 归一 / 同符号冷却）均已完成，机制与配置见 `TUI/README.md`、`TUI/docs/SPEC.md`、`TUI/docs/IMPLEMENTATION.md`。

## 3. 待办（按主要改动部位分组）

> **待接取 10 条**（现行编号 `#1` … `#10`，见下）。编号口径（2026-09-26 重排）：现行条目用**扁平连续 `#n`**（与项目级 `docs/BACKLOG.md` 一致）；历史上按「章节.序号」编号的条目（`3.x.y`）已于本轮清理，其记录见 git 提交与 `TUI/docs/archived/`，故现行编号不复用旧号段。
> 已完成条目（截至 2026-09-26 共 29 条）已按用户要求清理；历史见 git 提交与 `TUI/docs/archived/` 追踪文档。
> 共同落点：`src/app/components/QuestionPrompt.ts`（问答面板渲染）、`src/app/components/ApprovalPrompt.ts`（审批面板渲染）、`src/app/index.ts` 的 `handleKey` 面板分支、`src/app/adapter/dsh.ts` 的 `approvalAnswerer`（审批应答与超时）、`src/app/state.ts`（面板状态 + reducer）。
> 组目：§1 命令扩展（#1 / #2）· §3.1 布局与渲染管线（#3）· §3.2 面板内容渲染（#4 / #5 / #6）· §3.5 文档与测试基线（#7）· §3.6 外部依赖（#8）· §3.7 其它机制类开放项（#9 / #10）。章节与分组仍按改动部位划分，分组号与条目号互不相关。

### 3.1 布局与渲染管线

- **#3 历史区交错缩进减少 2 列（`messageGutter` 默认 6 → 4）**：回复右缘留白与用户块左缘缩进同步收窄；同步 `README.md` 里「与回复正文第 5 个字符同列」的示例描述（改为第 3 个）及相关断言、冻结基线。落点：`src/app/state.ts`（默认值）、`README.md`、`docs/SPEC.md`、`tests/`。来源：2026-09-26 用户规格。

### 3.2 面板内容渲染

- **#4 面板类型标识符号化（○ / □ / △）与标记统一为对勾**：问答面板不再显示 `[单选]` / `[多选]`、审批面板不再显示 `[审批]`，改用空心几何符号——单选 `○`、多选 `□`、审批 `△`，颜色均黄。**单题**时符号并入标题行；**多题**时在活动面板**最顶行单独一行**按题序列出全部问题符号，**当前题黄、其余灰**。选项标记 `*` / `+` 统一改为 **`✓`**（类型已由符号表达，标记不再区分单/多选）。待确认：符号间距、多题时标题行的题号导航是否保留。落点：`components/QuestionPrompt.ts`、`components/ApprovalPrompt.ts`、`docs/SPEC.md` §7.1、`tests/`、冻结基线。来源：2026-09-26 用户规格。
- **#5 兜底项合并（「其它」类预设并入自定义回答）**：面板最后一项预设常被当作「例外情况」说明、实际不被选中；当**自定义回答的范围可覆盖该条**时（语义包含）将其并入自定义项——合并后**只保留「自定义回答」一项**、不可直接选中（须输入文字才算作答），该项带解释文字，内容取自被合并的选项。判据落到可判定规则：该选项文案含「自定义 / 其它 / 其他 / 例外 / 以上都不是 / 都不对」等语义标记时合并（TUI 不调模型，无法真做语义判断），并在 SPEC 给提问方一条约定。落点：`components/QuestionPrompt.ts`、`state.ts`（选项归一）、`docs/SPEC.md`、`tests/`。来源：2026-09-26 用户规格。
- **#6 面板题干与审批草稿渲染 markdown**：问答面板题干、审批面板描述改用既有 `layout/markdown.ts` 渲染（与历史区同口径：标题 / 列表 / 引用 / 代码 / 行内样式）；描述窗由「纯文本行 + 单一颜色」改为承载样式段行，折行 / 滚动 / 滚动条 / 焦点条逻辑不变。待确认：`detail`（计划卡片）是否一并渲染。落点：`components/QuestionPrompt.ts`、`components/ApprovalPrompt.ts`、`layout.ts`、`docs/SPEC.md`、`tests/`、冻结基线。来源：2026-09-26 用户规格。

### 3.5 文档与测试基线

- **#7 `/help` 持续增长**：命令加行后 help 超过一屏，且既有测试存在依赖 help 行数的脆弱断言；改 help 前先检查相关断言（改动后需重跑 `scripts/freeze-focus-frame.mts` 并审查冻结基线）。（其余条目的文档、测试与 demo 收尾随各自条目进行，不在此单列。）

### 3.6 外部依赖（TUI 侧无法自修）

- **#8 herdr pane 尺寸与其渲染区域不一致（外部问题，TUI 侧无法自行校正）**：在 herdr pane 里运行时，全宽横线（状态栏下边框等）右端比 pane 渲染区少 1~2 列、需 `Ctrl+L` 或拖动 pane 才恢复；同一构建在独立终端里正常（2026-09-24 实测确认）。取证与排查结论：
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

### 3.7 其它机制类开放项

- **#9 `state.usage` 语义**：`/stats` 展示「最近一次模型调用」，不是会话累计；要累计值需另行采集（`tokenMeter.measure` 接入成本高）。
- **#10 `/agents` 刷新方式**：宿主无 subagent 状态事件面，现为打开期间每 2s 定时刷新 + `r` 手动；宿主补事件面后可改为事件驱动。
