# DSH TUI 实现计划

> 配套文档：`DESIGN.md`。本计划把设计拆成可执行任务，每项给出验收标准与依赖顺序。
> 阶段编号与设计一一对应（spike → renderer → adapter → 打包）。

## 技术决策（已定，不再重议）

- TS + Node（当前 v24），pnpm，ESM，仅依赖 `chalk`。
- 构建：`tsc`（无 bundler），`outDir: dist/`。
- 运行/测试：demo 走 `pnpm demo`，测试用 `node --test`（无框架）。
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

- [ ] T1.1 `terminal.ts`：raw mode 开/关（`process.stdin`）、`resize` 监听、读取退出信号，并在**所有退出路径**（`close()`、SIGINT/SIGTERM、`uncaughtException`/`unhandledRejection`）恢复终端。assert: raw 状态切换正确、信号处理后终端已恢复。
- [ ] T1.2 `input.ts`：stdin 字节 → `KeyEvent` 解码（方向键、Home/End、Ctrl 组合、Tab、Esc、bracketed paste）。`tests/input.test.ts` 喂字节流断言 KeyEvent（node:test）。
- [ ] T1.3 `screen.ts`：帧缓冲 + 整帧重绘（全部行每次 `write`，无 diff）。含 ANSI 光标定位/清屏。
- [ ] T1.4 `index.ts`：`Renderer` 公共 API（`render/onKey/onResize/getSize/close`），`render` 追写最后一行优化。
- [ ] T1.5 `app/state.ts` `layout.ts` `components/`：状态模型（会话列表、流式增量、审批项）+ viewport 切分（wrapping、2000 行上限、跟随底部/上滚暂停跟随）。`layout.ts` 的视口计算抽纯函数，可单测。
- [ ] T1.6 `demo/`：mock adapter 喂模拟流式文本与审批，`pnpm demo` 完整走通 renderer→app 栈。

Done when：`pnpm demo` 启动后可见流式滚动、可上滚回翻、审批弹窗可确认/拒绝；`node --test tests/` 全绿。

`ponytail:` screen 无 diff 整帧重绘，行数大时若有闪烁再考虑增量。

## 阶段 2：adapter 接入 DSH（已完成 2026-08-23）

- [x] T2.1 `src/app/adapter/dsh.ts`：实现 `createRealDshAdapter`——`ctx.on('session/event')` 归一化（assistant/chunk、turn/start|turn/end、agent/status）→ `DshEvent` 写 state；注册 `approval/request` waterfall 应答者（approve→'allowed-once'/'rejected'，signal 中断/超时→'cancelled'，无订阅者→next() fail-closed 'unavailable'）。
- [x] T2.2 `main.ts`：双角色——导出 cordis 插件入口 `{ name, inject, apply }`（apply 内解析模型 route→`agents.create`→组装 renderer+app+real adapter，**无顶层副作用**）；`main()` 供 bin 显式调用。
- [x] T2.3 mock/真实切换：`createMockDshAdapter` 仅 demo/`bin` 使用（构造注入），app 层零改动。

真机结论（2026-08-23，profile `dsh-toolset-tui` + DEEPSEEK_API_KEY）：

- 「实测载荷」：deepseek adapter 的 `assistant/chunk` 以 `block-start`/`block-end`（`block-end` 携带完整 `text`：含 reasoning 块与 text 块）送达，而非 T0.2 假设的 `text-delta`/`reasoning-delta`——adapter 已兼容两种形态（两种不会在同一 provider 并存）。
- 链路：`user/message`（followup 送达）→ `request/header`（route deepseek-official/deepseek-v4-flash 生效）→ `assistant/chunk`×N（真实 token）→ `turn/end completed`；状态栏 idle→thinking→idle；Ctrl+C 退出码 0。
- 插件 `Config` 需为 schemastery Schema 才导出（cordis `resolveConfig` 要求 `Config['~standard'].validate`）；本项目零依赖故不导出，loader 透传 config。
- 未注入服务（如 `agentDefaultModel`）只能经 `ctx.get()` 访问，不能直接属性读取（cordis 严格模式）。

Done when：真实 DSH profile 内运行，TUI 显示真实会话流式输出，审批流转回 DSH。——✅ 已达成（流式落屏 + turn 完成；审批交互走同一条 waterfall 链，真机未人为触发审批弹窗）。

## 阶段 3：集成与打包（已完成 2026-08-23）

- [x] T3.1 `package.json`（type: module、bin: dsh-tui.js、dsh.bundle.patch→./cordis.patch.yml、files 覆盖 dist/bin/cordis.patch.yml）、`tsconfig.json`（ESM、NodeNext、outDir dist）。此前阶段已就绪，本阶段复核。
- [x] T3.2 `bin/dsh-tui.js`：双态 delegating launcher（shebang 可执行 755）——目标 profile（默认 dsh-toolset-tui，DSH_TUI_PROFILE 可覆盖）已装本 bundle → spawn `dsh --profile <p>` 透传 argv/退出码/信号；无 DSH/`--demo` → 退化 mock demo；`--help`。零第三方依赖（仅 node 内建模块）。
- [x] T3.3 `cordis.patch.yml`（insert dsh-tui 行）+ `dsh.profile.bundles` 注册（见 `~/.dsh/profiles/dsh-toolset-tui` 示例）+ `README.md`（包定位、双态用法、挂载步骤、demo 与真实链路、构建/测试命令）。
- [x] T3.4 全新环境验证：`pnpm pack` 产物 `dsh-toolset-dsh-tui-0.1.0.tgz`，tarball 成员含 `dist/`（34 文件，src/demo/tests）、`bin/dsh-tui.js`、`cordis.patch.yml`、`README.md`；临时空目录 `pnpm add <tarball>` 后 `node_modules/@dsh-toolset/dsh-tui` 内 bin、cordis.patch.yml、dist（含 `apply` 导出）齐全，`--help` 正常。

真机结论（2026-08-23，阶段 3 回归）：双态 bin 委托路径经伪 TTY 拉起真实链路（`dsh --profile dsh-toolset-tui`），进程无崩溃；无 DSH 空 `$DSH_HOME` 走 demo 分支存活；冒烟捕获 `thinking` 状态栏与真实作答（"7\*8 = 56"），turn 正常回 idle。

Done when：`dsh plugin --profile <p> add dsh-tui` 安装后，`dsh-tui.js` 可独立启动并与 profile 内会话交互；无 DSH 环境退化为 demo 模式。——✅ 已达成（挂载→委托→真实链路已验证；`dsh plugin add` 的发布分发形态见 README，本地开发经 `file:` 依赖同路径验证）。

## Slash 命令（2026-08-23）

设计裁定（用户）：以官方 DSH 为准——涉及其他功能的命令走注册-调用方式（`dsh-commands` 注册表），只与渲染相关的命令作为本地小命令表。行为要点：

- **路由**：`App.submit()` 对以 `/` 开头的输入走 `handleSlash()`，不进 `agent.followup`、不占模型 token/历史：
  - 本地小命令表（app 层）：`/help`（帮助）、`/clear`（清空缓冲）、`/quit`（关闭 renderer）。
  - 其他 `/name` → `adapter.runCommand(line)` → `ctx.commands.execute(agent, line, [], signal)`（官方注册表）。
  - 未命中注册表（execute 返回 `undefined`）→ `notice` 提示未知命令（**官方 fail-close**：绝不 sendMessage 给模型）。
- **事件面**：`DshEvent` 新增 `{ type: "notice"; text }`——命令结果/错误/提示只进 UI 缓冲（`appendNotice`，独立成行，不入流式末行），经 `notice` reducer 落地。
- **命令名语法**：`parseSlashCommand` 与官方 client 一致——`/^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/`。
- **服务解析**：`main.ts` 经 `ctx.get("commands")` 取注册表（cordis 严格模式不允许未注入服务直接属性访问），`commandAgent` 传真实 Agent（注册表作用域查找需要完整 agent，而非 app 的瘦 `DshAgentLike`）。
- **dispose 修复**：原 `const disposed = false` 致 dispose 永不生效——改为 `let`，并实现：中止在途命令的 AbortController、解绑 runtime 监听（`collectUnbind`）、清空监听集。`App.dispose()` 透传 `adapter.dispose?.()`。
- **mock/demo**：`MockDshAdapter.runCommand` 回 `notice` 提示 demo 模式无注册表；`App` 层本地表在 demo 同样生效。
- **测试**：`tests/adapter.dsh.test.ts` 新增 parseSlashCommand、runCommand（命中/未命中/错误/无注册表/非法行/同步返回/sessionId 过滤）、notice、dispose（abort + 解绑 + 幂等）用例；新增 `tests/app.test.ts` 覆盖 submit 路由（普通消息→sendMessage、/help /clear /quit→本地表、未知 /xxx→runCommand、notice 渲染、dispose 透传）。`package.json` test 脚本加 `--experimental-transform-types`（app 层参数属性需 transform 模式）。

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
| ----------------------------------------------------------------------- | ---- | ---------------------------------------------------------------- |
| DSH ctx API（已研读确认并沉淀 DSH-CTX-API.md，且 T2.1 已真机实证） | 低 | 真机验证事件名/载荷已完成；adapter 接口化，mock/真实可置换 |
| ANSI 输入解码漏组合键 | 中 | T1.2 用字节流单测覆盖所有设计到的手/终端场景 |
| 整帧重绘在大滚动下闪烁/卡顿 | 低 | T1.4 末行追写优化；`ponytail:` 留了增量渲染升级位 |
| profile 打包（bundle patch / files 字段）细节未知 | 中 | T3.3 参照社区包（`dsh-working-activity`）结构；T3.4 全新安装验证 |
| node-pty 未引入，DSH 若要求 TUI 自开 shell 则缺能力 | 低 | 设计已定会话由 DSH 管理；出现需求再加可选依赖 |

## 验证方式汇总

- 单元：`node --test`（input 解码、layout 视口）
- 集成：`pnpm demo`（mock 全栈）
- 真机：真实 DSH profile 跑通（T2.1；阶段 0 spike 改为源码研读，无真机脚本）
- 打包：`pnpm pack` + 全新空目录 `pnpm add <tarball>` 验证 files/bundle patch（T3.4，已通过）
