# DSH TUI 实现计划

> 配套文档：`DESIGN.md`。本计划把设计拆成可执行任务，每项给出验收标准与依赖顺序。
> 阶段编号与设计一一对应（spike → renderer → adapter → 打包）。

## 技术决策（已定，不再重议）

- TS + Node（当前 v24），npm，ESM，仅依赖 `chalk`。
- 构建：`tsc`（无 bundler），`outDir: dist/`。
- 运行/测试：demo 走 `npm run demo`，测试用 `npm run test`（无框架）。
- 会话/输入完全由 renderer 自研，不引入 Ink / Solid-TUI / node-pty。

## 阶段 0：DSH adapter spike（丢弃式）

目标：确认 DSH 插件运行时（cordis `ctx`）的会话订阅 API，产出 state 模型形状与 adapter 接口。

依据（2026-08-23 更新）：早期社区观测 `wa_dsh_doc.md`（事件名 turn/start、assistant/chunk、tool/call、tool/result、turn/end)已由官方源码研读核实并修订（agent/status 属 agent 层事件，不在 session 词汇表；见仓库根 `DSH-CTX-API.md`）。

任务：

- [x] T0.1 `scripts/spike-dsh.ts` → 改为**官方源码研读**（`~/GithubRepos/deepseek-harness`，b150a551b8），免去一次性 spike 脚本：
  - 订阅会话事件：`ctx.on('session/event', (session, event) => …)`，事件带 `seq` 连续契约
  - 审批回调：waterfall 链 `approval/request`，应答返回 `ApprovalOutcome`
  - 会话枚举：`ctx.sessions.list()`；发消息：进程内 `agent.followup`，外部桥 `session/prompt`
- [x] T0.2 接口形状已写回 `src/app/adapter/dsh.ts` 类型骨架（`DshAdapter` + 归一化 `DshEvent` + DSH 原生类型参照）
- [x] T0.3 DESIGN.md「开发阶段」段已更新（spike 描述 → 接口确认描述）

Done when：经官方源码核实任一断言（本次以 `grep` 交叉验证 JSONRPC server / session store / user-approval）；adapter 类型骨架与真实接口一致。真机跑通推迟到 T2.1（渲染层定型后），不再单独做 T0.1 落地。

## 阶段 1：renderer 最小可用

按依赖顺序实现，每文件独立可测。

- [x] T1.1 `terminal.ts`：raw mode 开/关（`process.stdin`）、`resize` 监听、读取退出信号，并在**所有退出路径**（`close()`、SIGINT/SIGTERM、`uncaughtException`/`unhandledRejection`）恢复终端。assert: raw 状态切换正确、信号处理后终端已恢复。
- [x] T1.2 `input.ts`：stdin 字节 → `KeyEvent` 解码（方向键、Home/End、Ctrl 组合、Tab、Esc、bracketed paste）。`tests/input.test.ts` 喂字节流断言 KeyEvent（node:test）。
- [x] T1.3 `screen.ts`：帧缓冲 + 整帧重绘（全部行每次 `write`，无 diff）。含 ANSI 光标定位/清屏。
- [x] T1.4 `index.ts`：`Renderer` 公共 API（`render/onKey/onResize/getSize/close`），`render` 追写最后一行优化。
- [x] T1.5 `app/state.ts` `layout.ts` `components/`：状态模型（会话列表、流式增量、审批项、问答项、模型选择面板）+ viewport 切分（wrapping、2000 行上限、跟随底部/上滚暂停跟随）。`layout.ts` 的视口计算抽纯函数，可单测。
- [x] T1.6 `demo/`：mock adapter 喂模拟流式文本、审批与问答，`npm run demo` 完整走通 renderer→app 栈。

Done when：`npm run demo` 启动后可见流式滚动、可上滚回翻、审批与问答面板可交互；`npm run test` 全绿。

`ponytail:` screen 无 diff 整帧重绘，行数大时若有闪烁再考虑增量。

## 阶段 2：adapter 接入 DSH（已完成 2026-08-23）

- [x] T2.1 `src/app/adapter/dsh.ts`：实现 `createRealDshAdapter`——`ctx.on('session/event')` 归一化（assistant/chunk、turn/start|turn/end、agent/status）→ `DshEvent` 写 state；注册 `approval/request` waterfall 应答者（approve→'allowed-once'/'rejected'，signal 中断/超时→'cancelled'，无订阅者→next() fail-closed 'unavailable'）。
- [x] T2.2 `main.ts`：双角色——导出 cordis 插件入口 `{ name, inject, apply }`（apply 内解析模型 route→`agents.create`→组装 renderer+app+real adapter，**无顶层副作用**）；`main()` 供 bin 显式调用。
- [x] T2.3 mock/真实切换：`createMockDshAdapter` 仅 demo/`bin` 使用（构造注入），app 层零改动。

真机结论（2026-08-23，profile `dsh-toolset-tui` + DEEPSEEK_API_KEY）：

- 「实测载荷」：deepseek adapter 的 `assistant/chunk` 以 `block-start`/`block-end`（`block-end` 携带完整 `text`：含 reasoning 块与 text 块）送达，而非 T0.2 假设的 `text-delta`/`reasoning-delta`——adapter 已兼容两种形态（两种不会在同一 provider 并存）。
- 链路：`user/message`（followup 送达）→ `request/header`（route deepseek-official/deepseek-v4-flash 生效）→ `assistant/chunk`×N（真实 token）→ `turn/end completed`；状态栏 `>`→`?`→`>`（idle/thinking 提示符）；Ctrl+C 退出码 0。
- 插件 `Config` 需为 schemastery Schema 才导出（cordis `resolveConfig` 要求 `Config['~standard'].validate`）；本项目零依赖故不导出，loader 透传 config。
- 未注入服务（如 `agentDefaultModel`）只能经 `ctx.get()` 访问，不能直接属性读取（cordis 严格模式）。

Done when：真实 DSH profile 内运行，TUI 显示真实会话流式输出，审批流转回 DSH。——✅ 已达成（流式落屏 + turn 完成；审批交互走同一条 waterfall 链，真机未人为触发审批弹窗）。

## 阶段 3：集成与打包（已完成 2026-08-23）

- [x] T3.1 `package.json`（type: module、bin: dsh-tui.js、dsh.bundle.patch→./cordis.patch.yml、files 覆盖 dist/bin/cordis.patch.yml）、`tsconfig.json`（ESM、NodeNext、outDir dist）。此前阶段已就绪，本阶段复核。
- [x] T3.2 `bin/dsh-tui.js`：双态 delegating launcher（shebang 可执行 755）——目标 profile（默认 dsh-toolset-tui，DSH_TUI_PROFILE 可覆盖）已装本 bundle → spawn `dsh --profile <p>` 透传 argv/退出码/信号；无 DSH/`--demo` → 退化 mock demo；`--help`。零第三方依赖（仅 node 内建模块）。
- [x] T3.3 `cordis.patch.yml`（insert dsh-tui 行）+ `dsh.profile.bundles` 注册（见 `~/.dsh/profiles/dsh-toolset-tui` 示例）+ `README.md`（包定位、双态用法、挂载步骤、demo 与真实链路、构建/测试命令）。
- [x] T3.4 全新环境验证（历史验证使用 pnpm）：`pnpm pack` 产物 `dsh-toolset-dsh-tui-0.1.0.tgz`，tarball 成员含 `dist/`（34 文件，src/demo/tests）、`bin/dsh-tui.js`、`cordis.patch.yml`、`README.md`；临时空目录 `pnpm add <tarball>` 后 `node_modules/@dsh-toolset/dsh-tui` 内 bin、cordis.patch.yml、dist（含 `apply` 导出）齐全，`--help` 正常。当前开发脚本使用 `npm run`。

真机结论（2026-08-23，阶段 3 回归）：双态 bin 委托路径经伪 TTY 拉起真实链路（`dsh --profile dsh-toolset-tui`），进程无崩溃；无 DSH 空 `$DSH_HOME` 走 demo 分支存活；冒烟捕获 thinking 推理与真实作答（"7\*8 = 56"），turn 正常回 idle。

Done when：`dsh plugin --profile <p> add dsh-tui` 安装后，`dsh-tui.js` 可独立启动并与 profile 内会话交互；无 DSH 环境退化为 demo 模式。——✅ 已达成（挂载→委托→真实链路已验证；`dsh plugin add` 的发布分发形态见 README，本地开发经 `link:` 依赖同路径验证）。

## Slash 命令（2026-08-23）

设计裁定（用户）：以官方 DSH 为准——涉及其他功能的命令走注册-调用方式（`dsh-commands` 注册表），只与渲染相关的命令作为本地小命令表。行为要点：

- **路由**：`App.submit()` 对以 `/` 开头的输入走 `handleSlash()`，不进 `agent.followup`、不占模型 token/历史：
  - 本地小命令表（app 层）：`/help`（帮助）、`/clearscreen`（`/cls`，清空显示缓冲）、`/quit`（关闭 renderer）。
  - 其他 `/name` → `adapter.runCommand(line)` → `ctx.commands.execute(agent, line, [], signal)`（官方注册表）。
  - 未命中注册表（execute 返回 `undefined`）→ `notice` 提示未知命令（**官方 fail-close**：绝不 sendMessage 给模型）。
- **事件面**：`DshEvent` 新增 `{ type: "notice"; text }`——命令结果/错误/提示只进 UI 缓冲（`appendNotice`，独立成行，不入流式末行），经 `notice` reducer 落地。
- **思考打字机（配置化）**：真实链路由 `main()` 传 `slowStream: streamTypewriter`（默认 true）。打字机只作用于 thinking（reasoning）——它是输出结束会被隐藏的瞬态内容；初始流速 `streamCharsPerSecond`（默认 120，分数累计配额、按码点切分）随 tick（50ms）逐段 append；收到正文 `stream` 事件后 `slowCps` 自动切到 `SLOW_STREAM_ARRIVED_CPS`（200，固定）加速放完剩余思考。`turn-end` 置 `slowNewTurn`，下一条 thinking 把 `slowCps` 回落到 `slowCpsBase`（配置值或默认）——**每个 turn 的思考都从初始速度重新开始**。正文 `stream` 为最终保留的回复，**即时显示**：思考队列运行期间到达的正文段按序缓冲（`pendingStream`），`turn-end` 记 `pendingTurnEnd`，思考放完后一次性铺出正文、再执行 turn-end（仅清思考，不画分隔线；分隔线改由下个回合 `turn-begin` 时画；dispose 才丢弃缓冲与队列）。`thinkingMaxLines`（默认 4）经 `initialState` 落到 `AppState`，`buildTopRegion` 按其折叠思考区。以上均由 `normalizeTuiDisplayConfig` 在 `apply()` 归一化。
- **非流式回复补发（assistant/message）**：`assistant/message` 是每个 step 结束必发的完整正文 surface 事件（官方 agent-loop 在 stream 结束后 append）。adapter 按 (session:turn:step) 累计已流式输出的正文（reasoning 不计），`assistant/message` 只补发缺失后缀；非流式/无思考 provider（无任何 chunk）累计为空 → 直接输出完整正文，保证不支持流式输出的模型回复也可见。`surfaceOp: replace` 的影子覆盖事件跳过（append-only 无法安全重写）；`turn/end` 与 dispose 清空累计。效用：既有块级去重 + step 级去重，流式模型不重复输出、非流式模型不丢回复。
- **命令名语法**：`parseSlashCommand` 与官方 client 一致——`/^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/`。
- **服务解析**：`main.ts` 经 `ctx.get("commands")` 取注册表（cordis 严格模式不允许未注入服务直接属性访问），`commandAgent` 传真实 Agent（注册表作用域查找需要完整 agent，而非 app 的瘦 `DshAgentLike`）。
- **dispose 修复**：原 `const disposed = false` 致 dispose 永不生效——改为 `let`，并实现：中止在途命令的 AbortController、解绑 runtime 监听（`collectUnbind`）、清空监听集。`App.dispose()` 透传 `adapter.dispose?.()`。
- **mock/demo**：`MockDshAdapter.runCommand` 回 `notice` 提示 demo 模式无注册表；`App` 层本地表在 demo 同样生效。
- **测试**：`tests/adapter.dsh.test.ts` 新增 parseSlashCommand、runCommand（命中/未命中/错误/无注册表/非法行/同步返回/sessionId 过滤）、notice、dispose（abort + 解绑 + 幂等）用例；新增 `tests/app.test.ts` 覆盖 submit 路由（普通消息→sendMessage、/help /clearscreen /cls /quit→本地表、未知 /xxx→runCommand、notice 渲染、dispose 透传）。`package.json` test 脚本加 `--experimental-transform-types`（app 层参数属性需 transform 模式）。

## /model 命令（2026-08-26）

- **能力**：查询可用模型 + 切换当前会话模型（不落盘）。命令形式：

  - `/model`（无参）→ 进入**交互选择模式**（面板渲染在 footer 区）：↑/↓ 移动高亮（选项超出可视高度时视口跟随选中项滚动），←/→ 左右切换三列焦点区（clamp 不循环），Enter 确认切换，Esc 取消不改变；普通字符键在该模式下被忽略（不进入输入框）。
  - `/model <provider>/<model>` → 显式指定切换；`/model <modelId>` → 跨全部 provider 唯一匹配（未匹配或歧义给错误提示，不落盘）。

- **交互选择面板**（2026-08-26 建立，2026-08-28 扩展思考等级与左右键）：`AppState.picker`（`PickerState`：options + index + phase + efforts + effortIndex）+ reducer action（`picker-open`/`picker-move`/`picker-tab`/`picker-phase`/`picker-efforts`/`picker-close`）。渲染为 `src/app/components/ModelPicker.ts` 纯函数（输出恰 footerHeight 行）：**provider/model/effort 三列独立列表同屏**，头部全小写；←/→ 左右切换焦点区（phase 0/1/2，clamp 不循环），Tab 仍循环切换，当前模型恒为首行标 `*` 附 `[current]`，焦点行标 `>` 并加粗。等级列表经 adapter 新增 `modelEfforts(provider, model)`（结构面调用宿主 `llm.resolveModelInfo` → `reasoning.efforts`；非思考模型返回 undefined，面板显示 `effort: (unsupported)`）异步按高亮模型加载，Enter 应用「模型 + 高亮等级」。`layout.ts` `metricsFor` 的 picker 高度预算取（模型列表、等级列表）较大者。demo mock 与测试（renderer 渲染/phase 切换/app 交互/适配层）同步覆盖。

- **交互确认**：Enter 复用 `applyModelSelection()`（与 `/model <name>` 带参共用）：保留当前 `reasoningEffort`、写入会话内模型引用（不写宿主设置）；选中当前模型时提示 `already on current model`，不重复切换。Esc 仅关闭面板。

- **切换语义**：只改会话内 `SessionModelSelectionRef.current`（经 `installSessionModelSelection` 挂到 agentCtx 的 `system-prompt/assemble` + `agent/request` 双钩子，下一 step 生效，快照保证不撕裂当步请求）；**绝不调用宿主 `agentDefaultModel.saveSelection()`**，避免覆盖配置中的默认模型。有效选择 = 会话内切换 ?? 宿主实时默认（`currentSelection()` 只读兜底：settings.yaml 热加载生效后自动跟上；启动时 TUI 不做一次性快照，避免异步 publish 时序吞掉设置）。切换时保留当前 `reasoningEffort`，不提供 effort 参数（YAGNI）。

- **接线**：`DshAdapter` 接口新增 `modelCatalog()` / `setSessionModel()`；`main.ts` apply() 在 `agents.create({ setup })` 中把 `installSessionModelSelection(agentCtx, sessionModel, () => readDefaultSelection(defaultModelSvc))` 挂上（`setup` 为官方 `AgentSetup` 结构面），并把同一 `sessionModel` 引用 + 只读 `defaultModel` 兜底传入 `createRealDshAdapter`（结构面 `LlmLike`/`AgentDefaultModelLike`，零运行时依赖）。demo 的 `MockDshAdapter` 提供同构 mock 数据。

- **显示格式**（2026-08-26 修改）：纯 ASCII，紧凑 `provider/model` 一行一个模型；当前模型前 `->`，其余模型前空格缩进对齐，无标题行。示例：

  ```
    -> deepseek/deepseek-chat
       deepseek/deepseek-reasoner
  ```

- **状态回显**：切换成功后 `systemStatus.model` 更新为 `provider/model` 并写入 notice；`/help` 命令表加入 `/model`。2026-08-28 修改：`renderStatusLine` 改为返回可多行 `RenderLine[]`，状态栏内容超出行宽时溢出到下一行（不再截断丢弃段），model 排在 time 之后的第 2 位优先显示；`metricsFor` 新增 `statusHeight` 参数按实际行数压缩顶部区域，保证帧不溢出终端。

- **启动状态回显**：`App.start()` 读取 `modelCatalog().current` 写入 `systemStatus.model`（不再用占位 `—`）。宿主 `agentDefaultModel` 需等 LLM provider 注册后才返回真实路由，早读会拿到内置兜底（如 `deepseek-official`）；故改为**常驻跟随 StatusTicker 的 5s 周期**（值变更才重绘），不再受启动窗口限制，运行中宿主默认变化也会自动跟上。实测：启动早期 `deepseek-official/...` → `ustc/deepseek-v4-flash`，与 `agent/request` 实际下发的 provider/model 一致。

- **测试**：`tests/app.test.ts` 覆盖 formatModelCatalog/resolveModelSpec 纯函数与 `/model` 路由（带参切换、未知模型、当前模型不重复切换）及交互选择（面板打开后普通字符忽略、↑/↓ + Enter 会话内切换并保留 reasoningEffort、Esc 取消后输入恢复、当前模型不在候选时补行不重复切换）；`tests/modelpicker.test.ts` 覆盖 ModelPicker 渲染（`*`/`>` 标记、current 后缀、加粗、视口跟随、纯 ASCII）与 picker reducer（open/move clamp/close）；`tests/adapter.dsh.test.ts` 覆盖 modelCatalog 聚合/空目录容错、setSessionModel 只改 ref 不落盘/无引用抛错、installSessionModelSelection 的 agent/request 覆盖与 effort 移除；`tests/renderer.test.ts` 覆盖 Renderer `emitKey` 合成按键注入。

- **demo 冒烟**（2026-08-26）：`demo/main.ts` 在无 TTY（管道/CI）或带 `--smoke` 时自动用 `renderer.emitKey()`（Renderer 合成按键注入）驱动 `/model`（进入交互选择）→ `down` → `enter` 确认切换 → `/quit`，以退出码 0 收尾，便于无头演示与机械验证。`createRenderer` 的 `close()` 同步 `pause()` stdin（与启动时 `resume()` 对称），保证嵌入/无头场景下事件循环可退出。根目录 `package.json` 委托 `TUI/` 的 check/build/test/demo，仓库根可直接 `npm run demo`。

## 会话流对话式窗口（2026-08-27）

- `AppState.buffer` 使用结构化 `BufferLine`（`user` / `assistant` / `thinking` / `notice` / `separator`），避免靠字符串前缀猜测角色。

- 普通消息由 App 发送前本地回显为用户行；历史区内模型正文靠左、右缘按 `assistantMaxBodyWidth`（= 宽度 - `messageGutter`）保留与用户块左缘对称的空位，与右对齐的用户输入形成左右交错；`messageGutter`（默认 4，域 0..20）经 `normalizeTuiDisplayConfig` → `initialState` 落到 `AppState`，`buildFrame` 从 state 读取并传给 `userMaxBodyWidth`/`assistantMaxBodyWidth`（布局层不再硬编码 USER_MIN_LEFT_GUTTER=4 常量）。用户块按内容收缩：`wrapBufferLines` 先按 `userMaxBodyWidth`（= 宽度 - `messageGutter`）换行（含显式换行），取最大行宽作块宽，整块统一 `leftPad`、右缘贴历史区右缘，块内左对齐；续行共享同一左边界。`wrapBufferLines` 输出扩展为 `{text, kind, indent}`，`buildTopRegion` 直接按 `indent` 渲染（thinking 用固定缩进，assistant/plain/separator 为 0）。用户块与随后回答/思考之间插入一行空行（后处理，纯布局不改 state）。模型正文按终端 markdown 子集渲染（只作用于最终回答，thinking 不经 markdown）：行内 `INLINE_RE` 按优先级扫描——转义 → `` `code` `` → `***粗斜***` → `**bold**` → `~~strike~~` → `__underline__` → `*italic*` → `![alt](url)` 图片 → `[text](url)` 链接 → `<https://…>` 自动链接；转义命中后标点作为普通文本输出（反斜杠不显示、不触发样式），图片/链接/自动链接只渲染可见文本（图片额外追加 URL）。`InlineStyle` 语义化字段（bold/italic/underline/strike/fg/bg），fg/bg 可为主题色名或 `#hex`（`hexOf` 解析）；`mergeStyle` 叠加块级与行内样式。`wrapSegments` 先解析为纯文本段、按显示宽度逐字符软换行（每行独立开/闭样式、相邻同样式合并），再序列化 manual ANSI（`1m`/`3m`/`4m`/`9m`+`22m`/`23m`/`24m`/`29m`，fg/bg 用主题色并以基底前景/背景收尾，不用 `39m`/`0m` 以兼容浅色主题）。行内代码与代码块共用 `CODE_BG[themeId]`（dark `#434343` / light `#E8E8E8`，保证与基底色对比足够）。块级由 `wrapAssistantLine` 分类：`FENCE_RE`（fenced 代码块）→`RULE_RE` 分隔线→`TASK_RE` 任务列表→`HEADING_RE` 标题→`QUOTE_RE` 引用→`LIST_RE` 列表→行内；`wrapBufferLines` 维护 `inFence` 跨行状态，代码块 `wrapCodeLine` 整行灰底并补齐到内容区宽、语言标签灰斜体、块内不解析；已完成任务 `[x]` 勾选灰色 + 正文灰删除线；引用单层灰竖线 + 正文灰（不加斜体）、正文开头残留 `>` 用 `replace(/^[>\s]+/, )` 隐藏；无序列表前缀统一 `•`。未闭合/嵌套/歧义标记按普通文本保留不丢字；上标（`^`）/下标（`~`）/单下划线 `_斜体_` 不解析。`displayWidth`/`truncateToWidth` 对 ANSI SGR 转义免计宽且截断时透传转义序列（不切断样式）。state.buffer 与 screen 渲染层零改动。

- 输入栏「两字符提示符」：提示符 = 左字符（上次提交模式符号 `MODE_SYMBOL[lastSubmitMode]`，颜色 `STATUS_PROMPT_COLOR[inputStatus]` 绿/黄/红）+ 右字符（当前输入模式 `MODE_SYMBOL[inputMode]`：normal `>` / shell `$` / slash `/`，默认前景色）。`inputMode`（normal/shell/slash，默认 normal、提交后自动回退；picker-open 保留、Picker Esc 关闭面板时重置 normal）不再含 interrupt；`lastSubmitMode` 在 `submit()` 开头按当前 inputMode 记录（`last-submit-mode` 动作），随后模式回退不影响左字符符号；`buildFrame` 组装 `colorFor(theme, STATUS_PROMPT_COLOR[inputStatus])(MODE_SYMBOL[lastSubmitMode] ?? ">") + (MODE_SYMBOL[inputMode] ?? ">") + " "` 作预着色 prompt 传 `renderTextInput(text, cursor, placeholder, width, promptText, promptColor?)`（promptColor 省略；宽度按未着色文本经 `displayWidth` 计算）。模式键处理：输入框为空时按 `$`/`/` 切模式并吞键（同符号幂等），`!` 为普通字符、不再是模式键，非空时也都当普通字符。提交：`Enter` 排队/发送，`Alt+Enter`（`submit(interrupt=true)`）先 `adapter.interrupt()` 再发送；`/` 自动补 `/` 前缀走 `handleSlash`（不经 sendMessage）；`$` 仅符号展示（原样 sendMessage）；**任何提交后 input-mode 重置 normal（提示符回 `>`）**。状态转移：正常提交置 running；`agent-status` 的 thinking/tool 兜底置 running；`turn-end` 置 success；本地可检测的无效 slash 命令置 failure；adapter 对未命中注册表/执行失败的命令回带 `error` 标记的 notice → 也置 failure（fail-close 落地为红）。**活跃守卫**：`agentStatus !== "idle"` 时绿/红一律压回黄（reducer `statusFor`），绿/红仅在空闲后可见。

- adapter 将 `reasoning-delta` 与 reasoning `block-end` 映射为 `thinking` 事件。思考区只以 2 空格缩进展示（无 `[思考]` 前缀文字），只显示最新 `thinkingMaxLines`（默认 4，可配置）行，超出显示折叠提示，不提供展开/收起；首条正文或 turn-end 到达时清除思考行。

- mock demo 同样发送思考分片，用于无 DSH 环境验证对话流与思考限高。

## /theme 命令（2026-08-28）

- **配色方案**：内嵌 `~/fff/config/terminal-colortheme/` 的两份 JSON（`fffdark` = dark、`ffflight` = light）作默认浅深模式，定义 16 个 ANSI 槽位 + 基底前景/背景，全部换成 truecolor ANSI。来源为副本——`src/renderer/theme.ts` 的 `THEMES`，改动需手动同步 fff 配置（运行时读取留作后续 YAGNI）。

- **槽位映射**：`black..white` → `ansi[]`，`brightBlack..brightWhite` → `bright[]`，`gray` = `brightBlack`。`ansiNameToHex(theme, name)` 解析（颜色名转小写后查表）。`colorFor(themeId, name)` 手工拼接 truecolor ANSI 前景并**以主题基底前景收尾**（不用 chalk：chalk 以 `39m`/`49m` 收尾会复位到终端默认，浅色主题下不可读），`layout.ts` 状态区改用（边框灰/路径蓝/模型区绿+紫+灰均按当前 `state.themeId` 取色，不再直接 `chalk.*`）。`RenderLine.style` 由 `styleLine` 按 Manual-ANSI 处理（fg/bg 分别 `38;2`/`48;2`，bold 用 `1m`/`22m`，各自恢复主题基底）。

- **基底色**：`Screen` 持有当前主题（`setTheme(id)`），整帧渲染在 `ESC[2J` 清屏**之前**写出基底前景/背景（truecolor 背景 → 清屏即填充主题色）；每个 delta 行也带基底，保证 `ESC[K` 擦除以主题背景填充。`setTheme` 同时清掉渲染器 delta 缓存（`prevLines = null`），切换后必然全帧重绘。`close()` 前 `Screen.reset()` 输出 `ESC[0m` 恢复终端默认。

## 输入栏改造（2026-08-29）

- **移除 `!` 打断模式**：`InputMode` 仅保留 normal/shell/slash；`!` 键不再作模式键，始终按普通字符输入。原 `!` 打断并发送语义迁移到 **Alt+Enter**（解码层 ESC CR / ESC LF → `meta+enter`，提交前先 `adapter.interrupt()`）。
- **Esc 语义变更**：由「退回 `>` 不打断」改为「打断运行」（agent 非 idle 时 `adapter.interrupt()`；idle 无操作）。
- **提交后自动回退**：任何提交（普通/slash/shell）完成后 `inputMode` 重置 normal（提示符回 `>`），不再记忆上次模式。
- **Backspace 空输入回退**：非 normal 模式下若输入框为空，Backspace 直接回退 `inputMode` 至 normal（切了模式不输入可反悔），不做删除动作（有输入时仍正常删除）。
- **两字符提示符**：左字符 = 上次提交模式符号 + 状态色（绿/黄/红，符号不随状态变），右字符 = 当前模式符号（`>`/`$`/`/`，默认前景色）；`layout.ts` 以 `STATUS_PROMPT_COLOR`（状态色）+ `MODE_SYMBOL`（左右两字符符号）映射，state 新增 `lastSubmitMode`（提交时记录），prompt 预着色传给 `renderTextInput`（宽度按未着色文本计）。
- **测试**：`tests/app.test.ts` 更新 Esc（idle 无操作 / 非 idle 打断）、模式键（`$/` 切模式 + `!` 普通字符）、Alt+Enter（先 interrupt 再 send、空输入无操作）、提交回退（slash/shell 提交后普通发送）、/model 面板确认后回退 normal、**审批弹窗打开时 Esc 不打断不关闭（仅 y/n 应答）**；`tests/input.test.ts` 新增 ESC CR/LF → meta+enter 解码用例。`npm run check && npm test` 全绿（218 例）。
- **审批弹窗守卫**：`handleKey` 中审批打开时仅 y/n 应答，其余按键（含 Esc、Ctrl+D、Ctrl+L）一律吞掉——不打断运行、不关闭弹窗、不改输入模式（“审批模式不变”契约；修复原 Esc 落入全局打断分支的回归）。
- **demo 冒烟自断言**：`demo/main.ts` 无 TTY/`--smoke` 时合成按键驱动并自断言——`!` 普通字符发送、`$` 切模式 shell 提交（左提示符 `$`）、空输入 Backspace 回退、Alt+Enter 先打断再发送（interrupts==1）、Esc idle 无操作、审批弹窗 Esc 不打断不关闭；mock 以 `autoApproval:false` 关闭自动审批避免 timing 干扰，冒烟逐项输出 `SMOKE_PASS/SMOKE_FAIL`，失败置非零退出码。

## 用户提问面板（2026-08-30）

- **服务接线**：`main.ts` 经 `ctx.get("userQuestions")` 取 `user-questions` 服务（结构面判定后传入 adapter）。`adapter/dsh.ts` 注册 `registerProvider({ask})`——单活动请求守卫（并发 ask 直接 reject）、`signal` abort → reject；DSH 回调提问归一化为 `DshEvent {type:'question'; id; questions[]}`。App 应答走 `answerQuestion(id, {answers})`（整批），Esc/cancel 走 `cancelQuestion(id)`（仅 reject）。注册失败（DUPLICATE_PROVIDER）不阻塞启动：stderr 告警 + notice，构造期 notice 先进 `pendingRegNotices` 缓冲、首个 `onEvent` 订阅时补发（避开构造期无监听者丢事件）。`emit_models` 等既有逻辑不受影响。
- **状态与交互**：`AppState.question`（`QuestionPanelState`）+ 6 个 reducer action（open/move/nav/select/custom/close）。`handleQuestionKey` 路由在 approval 之后、picker 之前：Esc 仅取消；**Enter 有下一题时 `question-nav +1` 进下一题、末题 `submitQuestion()` 提交整批**（修复：原直接提交导致多问答完第一题就被收走，模型拿不到后续题目答案）。**「自定义回答」作为选项列表末位（`optionIndex === options.length`）**，与预设选项共用 `question-move`（↑/↓ 在 0..options.length 内 clamp）——不再有独立 focus 字段、**Tab 已释放**（落入默认分支吞掉）；空格/可打印字符/退格仅在自定义项高亮时编辑 custom（预设选项上键入被吞，不落入主输入栏）。单选互斥：`selectQuestionOption` 选预设清空 custom、`setQuestionCustom` 输入首字符清空 selected；多选 preset 与 custom 并存。`navQuestion` 切题重置于列表首项。
- **渲染**：`QuestionPrompt.ts` 输出恰 footer 高度；**自定义兜底项为普通列表行，高亮在其上且列表超长时强制该行可见**（修复「自由回答不显示输入文字」，输入文本就地在行尾回显 `自定义回答：文本`）；选项标记纯 ASCII：首列光标 `>`/空格、次列选中 `*`（单选）/`+`（多选）/空格（修复复杂符号，未选中以空格对齐）。**操作提示只显示实际用到的按键**：Enter 文案区分「下一题/提交」（多题首/中题=下一题、末题与单题=提交）、多题才显示「[←/→]切题」、有预设选项才显示「[空格]选择」与「[↑/↓]选项」。`plan-review` intent 以「计划卡片」呈现 detail、标题「计划审批」。`metricsFor` footer 优先级 approval > question > picker > 输入栏。
- **测试**：`tests/adapter.dsh.test.ts` 6 例（register → question 事件 → answerQuestion resolve；cancel reject；并发 ask 拒绝；DUPLICATE_PROVIDER notice 缓冲补发且 sendMessage 不受影响；abort；dispose 注销）；`tests/app.test.ts` 9 例（渲染+动态按键提示/单选替换+末题 Enter 提交/切题+多选 toggle/↓ 到自定义项键入+空格+退格修改+单选互斥/多选预设+custom 并存/预设选项键入被吞/Tab 释放被吞/Esc 取消不打断/plan-review 卡片+单题提示）；demo 冒烟 4 断言（question-rendered/submitted/cancelled/Esc 不打断）。`npm run check && npm run test && npm run build && npm run demo -- --smoke`（233 例）全绿。

## 按键扩展（2026-08-24）

- **Esc** → `App.handleKey` case `escape` → 若 `agentStatus !== "idle"` 调 `adapter.interrupt()`（打断运行）；idle 无操作；picker 面板打开时 Esc 仍由 picker 分支关闭面板。**不再回退输入模式**（提交后自动回退；`!` 打断模式已移除）。
- **Alt+Enter** → `KeyDecoder` 将 ESC CR / ESC LF 合并解码为 `{name:"enter", meta:true}`（stepEscape 在 SS3 之后、可打印字符之前处理 0x0d/0x0a）；`App.handleKey` case `enter` → `submit(k.meta)`，meta 时先 `adapter.interrupt()` 再发送（等效旧 `!` 模式语义）。
- **Tab** → 占位：notice「标签页切换待实现（当前为单会话）」。真正的标签页切换需 per-session buffer 基建（`sessions` 表已存在但渲染共享单缓冲）。
- **Ctrl+L** → `renderer.refresh()` 强制全帧重绘（`prevLines=null`，绕过 delta 优化）。
- 测试：`tests/app.test.ts` 4 例（当时 Esc 语义仍为“退回一般模式不打断 + Ctrl+L 刷新 + 普通 'l' 不吞 + Tab 占位”；该 Esc 语义已被上方「输入栏改造（2026-08-29）」取代为**打断运行**，相关用例同步改写）、`tests/adapter.dsh.test.ts` 3 例（回调/no-op/dispose 后 no-op）。`npm run check && npm test` 全绿。

## 阶段 4：四区域布局 + 系统状态区（2026-08-24）

- [x] T4.1 `layout.ts` 重构：`FrameMetrics` 改为 `topHeight/statusHeight/footerHeight/pluginWidth/historyWidth`；顶部高度 = rows - 状态(1) - 输入(1) - 分隔行(2)；顶部区域内左侧固定 `PLUGIN_WIDTH=2` 竖线窄条（无边框无标题）+ 右侧历史区（按 historyWidth 换行，沿用 scrollback 语义）；上/中/下三区之间各有一条横线分隔行（`SEPARATOR_ROWS`）。
- [x] T4.2 `state.ts`：新增 `SystemStatus` 字段与 `{type:"status"}`（合并更新）、`{type:"turn-end"}`（`appendTurnSeparator` 追加分隔线，空 buffer/重复 turn-end 不重复追加）；`appendStream` 在末行为分隔线时不再合并（硬边界）。
- [x] T4.3 `status.ts` 新增：`StatusTicker`（合并节流，queries/schedule 可注入，tickCount 可数）+ `createProcessStatusQueries`/`gitStatus` 真实实现。
- [x] T4.4 `app/index.ts`：`turn-end` → reducer；`AppDeps.status` 可选，提供后自动启停 StatusTicker；`main.ts`/demo 接入真实查询器。
- [x] T4.5 单测：`tests/layout4.test.ts`（四区顺序/尺寸、turn 分隔、truncateToWidth）、`tests/status.test.ts`（合并节流、可注入调度、占位不抛错）。`npm run check && npm test` 全绿（98/98）。

## 模块拆分（2026-08-31，RFC v3 已执行）

按 `REFACTOR.md` v3 渐进式拆出 6 个纯逻辑文件（6 commit：`5bb189b`→`134ff09`，233 测试零断言改动，门禁全绿）。原则：**拆文件不拆架构、只拆纯逻辑**，副作用（adapter 调用、paint、notice、异步）一律留在 `App`（`index.ts`）。

| 新文件 | 内容 | 来源 |
|---|---|---|
| `src/app/commands.ts` | `formatModelCatalog`/`resolveModelSpec` + slash 路由/决策纯函数（`routeSlashCommand`/`modelCommandSpec`/`themeCommandDecision` + `SlashRoute`/`ThemeCommandDecision`） | 原 `index.ts` 底部 2 纯函数 + Step 6 |
| `src/app/adapter/types.ts` | 29 个纯类型 | 原 `adapter/dsh.ts` |
| `src/app/adapter/normalize.ts` | `parseSlashCommand`/`buildApprovalPrompt`/`buildUserMessage`/`normalizeAgentStatus`/`readDefaultSelection` | 原 `adapter/dsh.ts` |
| `src/app/layout/markdown.ts` | 宽度原语 + markdown 行内/块级纯解析（`charWidth`/`displayWidth`/`parseInlineMarkdown`/`wrapInlineMarkdown`/`wrapAssistantLine` 等） | 原 `layout.ts` |
| `src/app/question-transition.ts` | 问答纯状态转换（`QuestionKeyDecision`/`questionKeyDecision`/`buildQuestionAnswers`） | 原 `index.ts` Step 4 |
| `src/app/model-transition.ts` | 模型选择纯状态转换（`PickerInit`/`buildPickerInit`/`pickerEffortIndex`/`resolvePickerSelection`/`ModelSwitchPlan`/`planModelSwitch`） | 原 `index.ts` Step 5 |

- 兼容策略：`index.ts` 重导 `formatModelCatalog`/`resolveModelSpec`；`layout.ts` 重导 markdown 纯函数；`adapter/dsh.ts` 显式类型/函数重导（不用 `export *`，避免 verbatimModuleSyntax 与循环依赖）。外部 import 路径全部不变。
- 明确不动：`state.ts`、`renderer/`、`DSH-CTX-API.md`。
- 遗留：`adapter/dsh.ts` 14 个未使用 `import type`（TS 6196 警告级，`noUnusedLocals` 关闭故 tsc 不报），留作后续清理。

## 输入态按键提示条（2026-08-31）

- 全部界面按键提示统一为「**[按键]文字**」格式、项间 `·` 分隔：主输入提示区（`HINT_LINE`）、审批面板 `[y]批准 · [n]拒绝 · [Esc]退出`、问答面板 `[Enter]下一题/提交 · [Esc]取消 · …`、模型选择面板 `[space]select · [left/right]col · [tab]next col · [enter]commit · [esc]cancel`（保持 ASCII 无汉字；最底行帮助改整行满宽单行——旧实现放入第一列单元被截断到列宽，实际仅前 ~16 字符可见，`modelpicker.test.ts` 加回归断言）。
- 输入态底部新增独立的**按键提示区**（1 行，`layout.ts` 导出 `HINT_LINE`）：`[Enter]发送 · [Alt+Enter]打断并发送 · [Esc]打断 · [Ctrl+L]重绘 · [/help]更多命令`，统一灰色（同边框），窄终端按显示宽度截断；**与输入区之间不画横线**；审批/问答/模型选择面板自带操作提示，不显示该区。
- `FrameMetrics` 新增 `hintHeight` 字段、`metricsFor` 新增第 6 参 `hintRows`（按键提示区独立计入，输入态 1）；顺手修复既有高度误算：picker 的「+1 最底行按键帮助」原先无面板时也按 1 计入（`Math.max(0, ...[]) + 1`），导致输入态 footer 少算 1 行、整帧比终端高 1 行，现改为仅面板打开时计入。
- 测试：`tests/layout4.test.ts`（四区索引、按键提示区内容、metricsFor hintRows/hintHeight）、`tests/app.test.ts` 输入行 SGR 断言由末行改倒数第 2 行。`npm run check && npm run test` 全绿（236/236，含下述 Screen 回归用例）。
- `Screen` 换行规则由「输入行(caret 行)不写尾部 CRLF」改为「**仅帧末行不写 CRLF**」（caret 行只记录光标停留位置）——提示区加入后输入行不再占末行，旧规则使提示文本与输入行同行；无 caret 行的面板帧满高时末行 CRLF 触底上滚 1 行的潜在问题一并修正（`screen.ts` `render`/`renderDelta`，`tests/screen.test.ts` 新增 2 个回归用例）。

## 交互区高度规则与多行输入框（2026-08-31）

- **交互区 1/4 规则**：输入区+按键提示区共同构成「交互区」——总高足够时占 `floor(rows/4)`，不足时每区至少 1 行（输入 1 + 提示 1）；提示区固定 1 行，输入区取剩余：`metricsFor` 普通输入态 `footerHeight = max(1, floor(rows/4) - 1)`（替换固定 1 行）。面板态（审批/问答/选择器）高度逻辑不变。
- **多行输入框**：`renderTextInput` 新增 `height` 参数（默认 1），`buildFrame` 传 `metrics.footerHeight`。文本按 `avail = width - promptWidth` 显示列统一换行（字符不跨行、不切半个 CJK）；首行带 prompt、续行缩进 `promptWidth` 列、顶部对齐；光标行 `floor(cursorFlowCol/avail)` 超出窗口时按 `vshift` 整体滚动跟随；仅光标行带 `caret`（`promptWidth + 行内列`）。文本恰在换行边界/末尾时光标落在空行。原单行「水平滚动」被换行语义取代（高度 1 时显示光标所在换行，滚动到续行时该行无 prompt、仅缩进）。
- 测试：`tests/layout.test.ts` 水平滚动用例改为换行断言，新增多行框（顶部对齐/续行缩进/留空行/caret 仅光标行）与换行边界空行用例；`tests/layout4.test.ts` 四区用例按新高度重排（24 行终端：顶部 15 + 分隔 2 + 状态 1 + 输入 5 + 提示 1）、metricsFor 断言更新并补小终端最小值；`tests/app.test.ts` 输入行 SGR 断言改倒数第 6 行（24 行终端输入区 5 + 提示区 1）。`npm run check && npm run test` 全绿（238/238）。

## 面板态共用固定交互区高度（2026-08-31）

- 交互区（输入区+按键提示区）高度固定为 `max(2, floor(rows/4))`，不再随面板打开变化：普通输入态 = 提示区 1 行 + 输入区剩余；面板态（审批/问答/模型选择）整体占据交互区（面板自带最底行按键提示、无独立提示区）。此前审批 `max(4, rows*0.3)`、问答/选择 `min(所需, max(4, rows*0.4))` 会使面板开关时顶部区域上下跳动，现统一不调整。
- `metricsFor` 签名收敛为 `(size, hasPanel?, statusHeight?, hintRows?)`：面板「所需行数」估算（选择器列表长度、问答选项/detail 粗估）不再参与高度计算，`buildFrame` 中相应计算一并移除。
- 面板适配固定高度（此前最小高度 ≥4 的隐含前提不再成立）：问答面板可截断区（题干/detail/选项/自定义兜底项）改为按**高亮行滚动窗口**——高亮项（当前选项或自定义项）恒在可视窗口内，取代旧的「自定义行强制放底部」特例（`QuestionPrompt.ts`）；审批/问答 `maxBody = max(0, height-2)`，高度 \<3 时只渲染标题+操作提示行，输出行数恒等于高度。
- 测试：`tests/layout4.test.ts` metricsFor 断言改 4 参签名并新增面板态同高断言、审批弹窗用例改「交互区高度与输入态一致」；`tests/app.test.ts` plan-review 用例改为短 detail（固定 6 行面板下 2 行 detail + 2 选项 + 兜底项无法同屏），并新增「超长时末位选项初始不可见、↓ 滚动后可见」断言。`npm run check && npm run test` 全绿（238/238）。

## /model 面板列表跟随星号选中（2026-08-31）

- 问题：model 列与思考等级列表原先由 `>` 焦点驱动（provider 列上下移动即切换 model 列表、焦点移动即重载 efforts），与「星号 `*` = 待提交选中、`>` = 临时焦点」的语义不一致。
- 变更后：`movePicker` phase 0 仅移动 `providerIndex`；`selectPicker` 在星号移到新 provider 时才把 `models` 切到该 provider 的列表、`modelIndex=0`、旧 `selectedModel` 失效（effort 列表清空由 App 重载；思考等级星号保留，新列表中存在才显示），重选同一 provider 幂等不重置；phase 1 选中保留 `selectedEffort`（维持「保留当前 reasoningEffort」的既有行为）。
- `App.reloadPickerEfforts()` 目标由焦点改为选中（星号）的 model/provider（未选中回退焦点行）；触发时机由 `picker-move` 改为 `picker-select`（仅 provider/model 区星号移动时重载）；旧结果校验改为同时比较 provider 与 model。
- Enter 提交仍走 `resolvePickerSelection`「星号优先、焦点兜底」（打开时已用当前值预填星号，通常即星号值）。
- 测试：`tests/modelpicker.test.ts` reducer 断言改为「焦点移动不切 model 列」+ picker-select 新用例；`tests/app.test.ts` FakeAdapter 新增 `modelEffortsCalls` 记录，新增双 provider 用例验证 model 列/思考等级列表只随星号变化（240/240 绿）。

## 依赖顺序

```
T0.1 → T0.2 → T0.3
T1.1 → T1.2 → T1.3 → T1.4        (T1.4 依赖前面的渲染核心)
                 ↘ T1.5（layout 纯函数可与 T1.1-1.4 并行）
T1.6 ← 全部 T1.x
T2.1 ← T0.2；T2.2 ← T1.6 + T2.1；T2.3 ← T1.6
T3.1/3.2 ← T2.2；T3.3/3.4 ← T3.1
```

## 风险登记

| 风险 | 等级 | 缓解 |
| ------------------------------------------------------------------ | ---- | ---------------------------------------------------------------- |
| DSH ctx API（已研读确认并沉淀 DSH-CTX-API.md，且 T2.1 已真机实证） | 低 | 真机验证事件名/载荷已完成；adapter 接口化，mock/真实可置换 |
| ANSI 输入解码漏组合键 | 中 | T1.2 用字节流单测覆盖所有设计到的手/终端场景 |
| 整帧重绘在大滚动下闪烁/卡顿 | 低 | T1.4 末行追写优化；`ponytail:` 留了增量渲染升级位 |
| profile 打包（bundle patch / files 字段）细节未知 | 中 | T3.3 参照社区包（`dsh-working-activity`）结构；T3.4 全新安装验证 |
| node-pty 未引入，DSH 若要求 TUI 自开 shell 则缺能力 | 低 | 设计已定会话由 DSH 管理；出现需求再加可选依赖 |

## 验证方式汇总

- 单元：`node --test`（input 解码、layout 视口）
- 集成：`npm run demo`（mock 全栈）
- 真机：真实 DSH profile 跑通（T2.1；阶段 0 spike 改为源码研读，无真机脚本）
- 打包：历史验证使用 `pnpm pack` + 全新空目录 `pnpm add <tarball>` 验证 files/bundle patch（T3.4，已通过）；当前开发脚本使用 `npm run`
