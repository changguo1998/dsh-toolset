# TUI 待办与开放项

> 职责：TUI 包的待办、开放项与已知外部问题（TUI 的变更优先写在本目录）
> 不负责：跨包功能待办（见 `docs/BACKLOG.md`）、TUI 现状（见 `TUI/docs/STATUS.md`）
> 过期条件：无
> 编号口径（2026-09-26 重排）：现行条目用**扁平连续 `#n`**（与项目级 `docs/BACKLOG.md` 一致）；历史上按「章节.序号」编号的条目（`3.x.y`）已于同日清理，记录见 git 提交与 `TUI/docs/archived/`，故现行编号不复用旧号段。本文件的 `#n` 与项目级 `docs/BACKLOG.md` 的 `#N` **互不关联**、各自文件内唯一，跨层引用须写明文件路径。
> 分组口径（2026-09-26 修订，按用户要求）：按**验收方式**分两类——**需要交互**指验证时必须动手操作（敲命令、按键、输入文字、带参数启动、等超时）；**不需要交互**指看一眼结果或跑自动化即可（渲染、排版、显示、内部机制、外部依赖）。判断标准是「验证时是否需要操作」，不是「改动是否可见」。

## 待办（共 18 条，其中 15 条已完成待清理；另 #8 仅提醒，不做实现）

> 2026-09-27 批次（#1 / #2 / #5 / #7 / #10 / #12 / #14 / #17）过程记录与复核清单见 `TUI/docs/archived/2026-09-27-tui-remaining-batch.md`；#19 为该批次 #2 的回归修复，记录见 `TUI/docs/archived/2026-09-27-sessionquery-read-timing.md`。

> 共同落点：`src/app/components/QuestionPrompt.ts`（问答面板渲染）、`src/app/components/ApprovalPrompt.ts`（审批面板渲染）、`src/app/index.ts` 的 `handleKey` 面板分支、`src/app/adapter/dsh.ts`（审批应答与超时）、`src/app/state.ts`（面板状态 + reducer）。

### 需要交互（11 条：#1 / #2 / #5 / #7 / #10 / #12 / #16 / #18 / #19 / #20 / #23；其中 #1 / #2 / #5 / #7 / #10 / #12 / #16 / #19 / #23 已完成）

> 验收时要动手：敲命令、按参数启动、在面板里输入或按键。

- **完成（2026-09-27）** **#1 新增 `/continue` 命令（加载当前目录下最近退出的会话）+ `/session` 列表改按编辑时间降序**：① `/continue`：**无参数**的新 slash 命令，等价于「`/session` + 自动选中当前目录下最近退出的那条会话」，复用同一加载路径；无匹配会话时给 notice 提示。② `/session` 面板列表排序改为**编辑时间从晚到早**（`updatedAt` 降序；现有排序口径实现时查证并补测试）。落点：`src/app/commands*`、`src/app/adapter/dsh.ts`、`docs/COMMANDS.md` / `COMMANDS-SPEC.md`、`README.md`、`tests/`。来源：2026-09-26 用户规格。

- **完成（2026-09-27）** **#2 CLI 启动参数：`--resume <sessionId>` 与 `-c` / `--continue`**：给 `src/main.ts` 加 argv 解析（当前完全不解析 argv）。① `--resume <id>`：启动即恢复指定会话（走既有 `agents.resume({ resumeSessionId })`，与 `/session` 选择一致），id 无效时提示并回落新建；② `-c` / `--continue`：启动即加载**当前目录下最近退出的会话**（与 #1 同语义、共用选择函数），**没有可恢复会话时静默新建**。用法：`dsh --profile fff --continue` / `dsh --profile fff --resume <id>`。落点：`src/main.ts`、`adapter/dsh.ts`、`README.md`、`tests/`。来源：2026-09-26 用户规格。

- **完成（2026-09-27）** **#19 #2 回归：重启后历史会话不可用（宿主未挂载 sessionQuery）+ `-c` 静默新建**：`apply()` 把 `ctx.get('sessionQuery')` 提前到 `agents.create()` 之前读并把早读值复用给 adapter；宿主服务随插件树**并发装载**（`session-query-sqlite` 的 provider 需 `sessions` 先就绪），早读为 undefined → `/session`、`/continue` 提示「历史会话服务不可用」、`--resume` 后历史面全缺席；`-c` 决策同源读空被当「无匹配」→ 静默新建而非恢复。修法：adapter 读点回到 handle 就绪后（与其它服务同批）；`-c` 决策改 `waitForHostService` 有界等待（3s，超时按未挂载）。落点：`src/main.ts`、`tests/main.config.test.ts`、`docs/IMPLEMENTATION.md`。来源：2026-09-27 用户真机报告（批次 #2 引入）。过程记录见 `TUI/docs/archived/2026-09-27-sessionquery-read-timing.md`。

- **待办** **#20 CLI `--resume` / `-c` 启动恢复后历史区为空（不渲染既有消息）**：`main.ts` 在 App 创建前走 `agents.resume`；历史行折叠只在 `/session` 切换路径（`resumeToSession` → `history-resume-ok`）发生，CLI 启动恢复只经 `restoreSessionState` 回填 model/mode/goal/todo → 活动区空，需手动 `/session` 再切一次才可见会话内容（agent 侧上下文已恢复）。落点：`src/app/index.ts`（启动后补一次 surface 折叠）/ `adapter/dsh.ts`（暴露「本次启动为恢复」或启动即 emit 历史行）/ `tests/`。来源：2026-09-27 修复 TUI#19 时隔离环境 PTY 实测（见其追踪文档「测试与证据」）。优先级 P2。

- 7 项纯 TUI 命令与 A1-A5 已完成，9 项候选当前无待办。裁定理由见 `TUI/docs/COMMANDS-SPEC.md` §7（`/clear`、`/login` `/logout` 维持排除；`/review` 搁置，可随 `docs/BACKLOG.md` 的 #17 一并考虑）；命令清单与层归属见 `TUI/docs/COMMANDS.md`；实施清单（已完成）见 `archive/TUI-COMMANDS-TASKS.md`。

- **完成（2026-09-27）** **#5 兜底项合并（「其它」类预设并入自定义回答）**：面板最后一项预设常被当作「例外情况」说明、实际不被选中；当**自定义回答的范围可覆盖该条**时（语义包含）将其并入自定义项——合并后**只保留「自定义回答」一项**、不可直接选中（须输入文字才算作答），该项带解释文字，内容取自被合并的选项。判据落到可判定规则：该选项文案含「自定义 / 其它 / 其他 / 例外 / 以上都不是 / 都不对」等语义标记时合并（TUI 不调模型，无法真做语义判断），并在 SPEC 给提问方一条约定。落点：`components/QuestionPrompt.ts`、`state.ts`（选项归一）、`docs/SPEC.md`、`tests/`。来源：2026-09-26 用户规格。

- **完成（2026-09-27）** **#7 `/help` 持续增长**：命令加行后 help 超过一屏，且既有测试存在依赖 help 行数的脆弱断言；改 help 前先检查相关断言（改动后需重跑 `scripts/freeze-focus-frame.mts` 并审查冻结基线）。（其余条目的文档、测试与 demo 收尾随各自条目进行，不在此单列。）

- **完成（2026-09-27）** **#10 `/agents` 刷新方式**：宿主无 subagent 状态事件面，现为打开期间每 2s 定时刷新 + `r` 手动；宿主补事件面后可改为事件驱动。

- **完成（2026-09-27）** **#12 会话切换后 `state.usage`（最近一次调用）未清零**：`history-resume-ok` / `session-switch` 现在只清零本会话累计（TUI#9 新增的 `usageTotals`），`state.usage` 仍保留**上一会话**的数值 → 切换后、下次模型调用前，状态栏 `ctx` / `cache` 段与 `/stats`「最近一次调用」行显示的是旧会话数据（恢复历史会话时该值本就不可知，显示 `—` 占位更诚实）。落点：`src/app/state.ts`（两处 reducer 与 `usage` 注释）、`tests/stats-rename.test.ts`。来源：2026-09-27 实现 TUI#9 时发现。

- **完成（2026-09-27）** **#16 批次遗留的真机复核项（#3 缩进 / #9 `/stats` 双口径 / #4 审批面板标题 / #11 模型门控表现）**：四项此前只记在归档追踪文档、未单列条目，本次补齐登记（均需重启 `dsh --profile fff` 后人工目视）：① **#11**：实际可用的 `deepseek-*` 模型（flash 已有日志证据）会话走两阶段锁定-释放的实际表现（首请求目录 2-3 工具 + persona-only、首个 `tool/call` 后解锁全量；对照既有基线）；② **#9**：`/stats` 双口径四行（最近一次调用 / 本会话累计 / 上下文 / 缓存命中率）的文案与数值；③ **#4**：审批面板标题 ` △ 等待审批`（工具审批触发时目视；问答面板已通过）；④ **#3**：历史区交错缩进（`messageGutter` 4）的左右留白观感。来源：2026-09-27 批次收尾后补登记（见 `TUI/docs/archived/2026-09-27-backlog-cleanup-and-residuals.md`）。**2026-09-27 批次**：复核清单（四步操作与观察点）已写入 `TUI/docs/archived/2026-09-27-tui-remaining-batch.md`。**复核结果（2026-09-27，全部通过）**：① #11 由真实会话日志复核（`initial tools=2` → `change tools=36` + tool-addition，409→2886）；② #9 用户确认；③ #4 用户目视审批标题 ` △ 等待审批`（提权请求触发、命令被拒未执行）；④ #3 用户确认观感无问题。记录见 `TUI/docs/archived/2026-09-27-manual-verification-closeout.md`。

- **进行中（2026-09-27）** **#18 TUI 符号纠正改为 rule-engine 消费者**：`src/app/symbols.ts` 的「规则表 + 判定 + turn-end 后 followup」泛化为调用 `rule-engine`（插件已合并入 main，见项目级 `docs/BACKLOG.md` #42）；符号纠正**不迁移**，仅做消费者改造。待定：plugin 未挂载时的降级（保留内置符号表 / 直连判定，实现时定）。落点：`src/app/symbols.ts`、`src/app/adapter/*`、`docs/DESIGN.md`、`tests/`、冻结基线（如涉及）。来源：项目级 `docs/BACKLOG.md` #43（2026-09-27，跨模块，交其他 agent 接取）。**2026-09-27 批次裁定降级**：rule-engine provide 面只有 `list()` / `status()`，无消费者判定 / 注册 API，且未挂载进 `fff` profile → 本批不改 TUI 代码；依赖登记为项目级 `docs/BACKLOG.md` #47，待其落地后另起任务接取。

- **完成（2026-09-27）** **#23 `/continue` 改「最新会话」语义（当前会话已是最新时不切换）**：原规则「同目录 + persisted + 非 live + 编辑时间最大」把当前活跃会话天然排除 → 连按 `/continue` 会依次往前回退（用户 2026-09-27 真机反馈「本会话已经是最新时还是会切到其他会话」）。按用户裁定方案 C 改：候选并入**当前会话**（仅当它已有用户消息——刚起的新会话不算），最新者即当前会话 → info 提示「当前会话已是最新」、不切换；CLI `-c` 语义不变（启动时无当前会话）。落点：`src/app/adapter/dsh.ts`（新增 `pickContinueTarget`；探针覆盖活跃会话 + `SessionInfo.hasPrompt`）、`src/app/adapter/types.ts`、`src/app/index.ts`（`continueRecentSession`）、`tests/adapter.dsh.test.ts`、`tests/app.test.ts`、`README.md`、`docs/IMPLEMENTATION.md`。来源：2026-09-27 用户真机确认批次行为时发现。

### 不需要交互（7 条：#14 / #17 / #21 / #22 / #24 / #25 / #26；其中 #14 / #17 / #21 / #22 / #24 / #26 已完成）

> 验收时看结果或跑自动化即可：面板显示形态、历史区排版、状态栏显示、内部机制、外部依赖（#8 待外部修复后回归）。

- **完成（2026-09-27）** **#24 文档过时检查与回写（批次收尾）**：逐份核对活文档与当前实现，修 4 处过时点——① `IMPLEMENTATION.md` 本地命令计数（36 项 = 32 命令 + 4 别名 → 39 项 = 34 命令 + 5 别名）；② `README.md` 已知限制补 TUI#20（CLI 启动恢复只回填 agent 侧，历史行需再切一次 `/session` 才渲染）；③ `DESIGN.md` 会话生命周期补 TUI#22/#23 口径（行首时间 = 编辑时间；`/continue`「最新会话」语义 + `hasPrompt` 探针）；④ `AGENTS.md` 去掉「`IMPLEMENTATION.md` 待按 BACKLOG #40 拆分」的失效引用（TUI BACKLOG 已扁平重编号、无该条目）。落点：`TUI/docs/IMPLEMENTATION.md`、`TUI/README.md`、`TUI/docs/DESIGN.md`、`AGENTS.md`。来源：用户 2026-09-27 指令。**说明**：两份 `STATUS.md` 属用户择时更新，本次只报告不修改。

- **完成（2026-09-27）** **#26 按当前代码复核并更新剩余过时文档（含 `STATUS.md`）**：延续 #24（用户指令「以当前的代码为准，更新过时内容」）——① `TUI/docs/STATUS.md` 现状段滞后：命令面缺 `/continue`、CLI 启动参数（`--resume` / `-c`）、notice 渲染、`/stats` 双口径、`/agents` 事件驱动保鲜，且「见 `TUI/docs/BACKLOG.md` §3」引用随扁平编号失效（改 `#8`）；② 根 `README.md` TUI 行「运行时唯一依赖 `chalk`」与源码不符（全仓零 import，见 #25）→ 改零依赖口径并注记待清理的声明；③ `TUI/docs/COMMANDS.md` §2.2 等效清单漏 `/stats`（含别名 `/usage` `/context`）。落点：`TUI/docs/STATUS.md`、`README.md`、`TUI/docs/COMMANDS.md`。来源：用户 2026-09-27 指令。

- **待办** **#25 TUI 声明了未使用的 `chalk` 依赖（与「零运行时依赖」口径冲突）**：`TUI/package.json` 的 `dependencies` 含 `chalk`，但 `src/`、`demo/`、`scripts/` 无任何 import（renderer 有意改 manual ANSI）；同时 `src/main.ts` 注释称「本项目零运行时依赖」、根 `README.md` TUI 行称「运行时唯一依赖 `chalk`」——三处口径需统一（建议删依赖 + 同步注释/文档；若确有用途则改注释口径）。落点：`TUI/package.json`、`TUI/src/main.ts`（注释）、`README.md`（TUI 行）。来源：2026-09-27 文档过时检查（#24）途中发现。优先级 P2。

- **完成（2026-09-27）** **#14 demo 冒烟失败信号失效（`SMOKE_OK` 无条件打印、失败不落退出码）**：`demo/main.ts` 的 `ok()` 失败只打印 `SMOKE_FAIL`，结尾仍无条件打印 `SMOKE_OK`，随后 `/quit` 以退出码 0 收尾 → 帧断言失败在 `npm run demo -- --smoke` 下「看起来通过」（2026-09-27 实测：#4 改形态后 `question-rendered` 断言陈旧失败被静默吞掉，直到人工 grep 输出才发现）。修法建议：统计失败数，有失败时改打印 `SMOKE_FAIL n=...` 且不打印 `SMOKE_OK`（退出码口径按需裁定），或在 `/quit` 前 `process.exit(1)`；另建议冒烟断言与面板形态解耦（用稳定可判据，如题干文本 + 符号行）。落点：`demo/main.ts`。来源：2026-09-27 #4 目视收口时发现。

- **完成（2026-09-27）** **#17 TUI 支持 `source.form:'notice'` 渲染**：插件注入消息带 `form:'notice'` + `summary` 时渲染为**一行提示**（不展开、不占用户消息块），使 rule-engine 的「提示人」呈现方式生效；当前 TUI 未实现该分支，注入内容会渲染成普通用户消息块。落点：`src/app/adapter/normalize.ts` / `dsh.ts` 事件消费面、`docs/SPEC.md`、`tests/`。来源：项目级 `docs/BACKLOG.md` #46（2026-09-27，其来源栏要求 TUI 落地时同步登记）。

- **完成（2026-09-27）** **#21 清理已取消旧代模型名的硬编码引用（两款）**：两款已取消的旧代模型名不再出现在源码注释 / 测试夹具 / 活文档中——注释与文档改中性表述（「模型 id 含 `deepseek`」），测试夹具统一改**合成假名**（`deepseek-test-a` / `deepseek-test-b`，显示名 `Test A` / `Test B`）；归档文档保留历史原样。落点：`src/app/adapter/tool-bootstrap.ts`、`src/app/state.ts`、`tests/tool-bootstrap.test.ts`、`tests/adapter.dsh.test.ts`、`tests/app.test.ts`、`tests/session-ui-state.test.ts`、`tests/modelpicker.test.ts`、`tests/layout4.test.ts`、`docs/BACKLOG.md`（#16 表述）。来源：用户 2026-09-27 指令（字面量见本次改动 diff）。

- **完成（2026-09-27）** **#22 `/session` 行内时间改显示编辑时间（`updatedAt`）**：列表排序已按编辑时间（#1），但行首时间一直显示创建时间（`HistoryPanel.ts` 的 `fmtTime(rec.createdAt)`）→ 同一行两个时间口径不一致，活跃会话看起来「时间不对」（2026-09-27 用户真机发现）。改：行内时间显示 `updatedAt`，缺失回退 `createdAt`；落点：`src/app/components/HistoryPanel.ts`（行渲染与注释）、`tests/app.test.ts`（列表渲染用例补时间断言）、`README.md`（`/session` 行）、`docs/IMPLEMENTATION.md`（编辑时间条目）。来源：2026-09-27 用户真机确认批次行为时发现（用户裁定方案 A）。

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
- 2026-09-26 已清理 29 条已完成条目（历史见 git 提交与 `TUI/docs/archived/` 追踪文档）。
- 2026-09-27 已清理 7 条已完成条目（#3 / #4 / #6 / #9 / #11 / #13 / #15）：过程记录见 `TUI/docs/archived/2026-09-27-noninteractive-backlog-batch.md`、`2026-09-27-tool-bootstrap-unlock-fix.md`、`2026-09-27-multi-question-symbol-row-color.md`（本次清理与残留登记见 `2026-09-27-backlog-cleanup-and-residuals.md`）。
