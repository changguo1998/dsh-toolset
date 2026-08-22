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

依据（2026-08-22 调研，`wa_dsh_doc.md`）：DSH 插件 = 带 `dsh:{bundle:{patch}}` 的 npm 包，经 `dsh plugin add` 挂进 profile；宿主用 cordis 组合树；插件导出 `apply(ctx)`。会话事件名可见：`turn/start`、`assistant/chunk`、`tool/call`、`tool/result`、`turn/end`、`agent/status`。

任务：

- [ ] T0.1 `scripts/spike-dsh.ts`（一次性脚本，不入 src）：列出可用 `ctx` 方法/事件（console 打印），确认：
  - 订阅会话事件的方式（`ctx.on(...)`？事件名与载荷形状？）
  - 发送审批 / 发消息的回调接口
  - 会话列表枚举接口
- [ ] T0.2 把确认到的接口形状写回 `src/app/adapter/dsh.ts` 的类型骨架（`DshAdapter` interface + 事件载荷 type）
- [ ] T0.3 若事件名/载荷与假设不符，更新/增补 DESIGN.md「开发阶段（含 spike）」段里的 DSH adapter 相关内容

Done when：spike 脚本在真实 DSH profile 内跑通一次，打印出流式文本事件+至少一次审批回调；adapter 类型骨架与真实接口一致。

风险：仓库无 DSH 源码，接口以 spike 实证为准；`wa_dsh_doc.md` 中的事件名为社区插件观测值，需在 T0.1 核实。

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

## 阶段 2：adapter 接入 DSH

- [ ] T2.1 `src/app/adapter/dsh.ts`：按 T0.2 骨架实现，`ctx.on` 会话事件 → 写 state（流式增量、审批项、agent 状态）。
- [ ] T2.2 `main.ts`：组装 renderer + app + real adapter；发消息/审批 → 回调 DSH。
- [ ] T2.3 mock/真实切换：demo 直接用 mock 适配器（构造注入），不改 app 层。

Done when：真实 DSH profile 内运行，TUI 显示真实会话流式输出，审批流转回 DSH。

## 阶段 3：集成与打包

- [ ] T3.1 `package.json`（type: module、bin: dsh-tui.js、dsh.bundle.patch）、`tsconfig.json`（ESM、outDir dist）。
- [ ] T3.2 `bin/dsh-tui.js`：shebang + `import('../dist/main.js')`；`chmod +x`、可执行。
- [ ] T3.3 `cordis.patch.yml`（若需以 DSH bundle 方式挂载）+ `dsh.profile.bundles` 注册说明，写 README。
- [ ] T3.4 `pnpm build` 产物在全新 `pnpm install` 下可跑（验证 `files` 字段覆盖 `dist/`, `bin/`, `cordis.patch.yml`(若有), `patches/`(若有)）。

Done when：`dsh plugin --profile <p> add dsh-tui` 安装后，`dsh-tui.js` 可独立启动并与 profile 内会话交互；无 DSH 环境退化为 demo 模式。

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
|---|---|---|
| DSH ctx API 未确认（事件名/载荷/审批回调） | 高 | T0.1 spike 实证；adapter 接口化，先 mock 后置换 |
| ANSI 输入解码漏组合键 | 中 | T1.2 用字节流单测覆盖所有设计到的手/终端场景 |
| 整帧重绘在大滚动下闪烁/卡顿 | 低 | T1.4 末行追写优化；`ponytail:` 留了增量渲染升级位 |
| profile 打包（bundle patch / files 字段）细节未知 | 中 | T3.3 参照社区包（`dsh-working-activity`）结构；T3.4 全新安装验证 |
| node-pty 未引入，DSH 若要求 TUI 自开 shell 则缺能力 | 低 | 设计已定会话由 DSH 管理；出现需求再加可选依赖 |

## 验证方式汇总

- 单元：`node --test`（input 解码、layout 视口）
- 集成：`pnpm demo`（mock 全栈）
- 真机：真实 DSH profile 跑通（T0.1 / T2.1）
- 打包：全新 `pnpm install && pnpm build && bin/dsh-tui.js`（T3.4）
