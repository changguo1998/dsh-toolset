# TUI 渲染管线重构任务（Tasks）

> **已归档**：本文是渲染管线重构的实施期任务清单（主线 A/B 均已完成）。当前口径见 `TUI/docs/SPEC.md`（规格）、`TUI/docs/DESIGN.md`（设计）、`TUI/docs/IMPLEMENTATION.md`（实现要点）；实施过程记录见 `TUI-RENDER-REFACTOR-RECORD.md`。文内「待实施 / 拆分中」等表述均为当时状态，不再维护。
> 注：文中 `COMMANDS-SPEC.md` 章节号按当时版本（§0.x/§3），现已重编号为 §1..§8。

> 状态：**设计草案，待实施**（2026-09）。
> 类型：**[task]**——实施与验收清单；涵盖**主线 A（契约迁移：`RenderLine[]` → `FrameRow[]`）**与**主线 B（Box 排版模型重构）**。
> 配套：`SPEC.md`（规格）、`TUI/docs/DESIGN.md`（设计）、`IMPLEMENTATION.md`（实现要点）。

## 0. 重构全景（两条主线）

- **主线 A · 契约迁移（样式链路归位）**：渲染层/排版层/测试同步迁移到 `FrameRow[]`（见 §1），消灭 app 侧手拼 ANSI。
- **主线 B · Box 排版模型重构**：`buildFrame` 换为 Box 树 + measure/allocate/fill（见 §2）。
- 关系：A 先冻结 `FrameRow[]` 契约（接口），B 在其上建 Box——两线可并行推进。
- 两线均拆为**多个可独立回归的提交**（§5）。

## 1. 主线 A · 契约迁移（RenderLine → FrameRow）

> **状态：已完成**（3 提交：98e9efd 契约类型 / d0d28d6 markdown 收敛 / b35826d 原子翻转；
> 回归标准：570 单测（当时值；现 844）+ 36 smoke 帧断言全绿）。以下条目为实施清单留档。

**A1 渲染层**

- `screen.ts`：`render/renderDelta` 接受 `FrameRow[]`，新增段级序列化 `segStyle(seg, theme)`（名→hex→SGR、相邻同 style 合并、未知名回退；规格见 `SPEC.md` §14）；delta 比较改按序列化文本（内部实现，不对外）。
- `theme.ts`：`ColorName` 增加 `"code"` 槽位（dark 现值 `#434343` / light `#E8E8E8`，从 `markdown.ts CODE_BG` 迁入）；序列化函数内部化（`colorFor`/`ansiNameToHex`/`hexSgr` 收口）。
- `index.ts`：`Renderer.render/refresh` 签名 `RenderLine[] → FrameRow[]`；删除 `RenderLine` 类型（由 `FrameRow` 替代）。

**A2 排版层**

- `layout/markdown.ts`：`InlineSegment`/`InlineStyle` 收敛为 `FrameSegment`/`FrameStyle`（字段已对齐）；删除 `renderSeg`（序列化移交渲染层）；删除 `CODE_BG`（改 `style.bg: "code"`）；`wrapSegments`/`wrapInlineMarkdown` 改产出 `FrameSegment[]`（跨行段每行重声明 — `SPEC.md` 不变量 #4）。
- `layout.ts`：54 处 ANSI 直写 / `colorFor(...)` 直包改 `style` 字段（如 `makeSep` → `{ fg: "border" }`）；`renderStatusLine` 等纯函数改返回 `FrameRow[]`。
- `components/*`：8 处同理；`TextInput` 保持 `caret` 语义。
- `app/index.ts`（控制层）：仅随 `buildFrame` 返回类型顺延，不涉行为。

**A3 测试**

- 新增：渲染层序列化单测（名→SGR / 相邻合并 / 未知名回退 / 主题切换 / caret 定位）。
- 新增：排版层产出断言（纯文本无 ANSI、宽度合计 = 行宽）。
- 现有 560 测试：断言从「带 ANSI 文本」改为 `segments` 结构；导入面小改（不涉及行为）。
- `demo` 帧断言与 `smoke:pty` 不变（行为不变即回归标准）。

## 2. 主线 B · Box 排版模型重构

推进分三波（顺序推进为主，勾选并行仅在文件边界清晰的任务间开 worktree——一任务一 worktree，且「内容映射替换 `wrapBufferLines`」与「`layout.ts` 拆文件」绝不同时开）：

1. **接口冻结（已完成 cc743d7）**：定义 `Box`/`Paragraph`/`NodeBase` 类型 + `measure/allocate` 签名（纯函数）；同步修订 `SPEC.md` §6 契约歧义（SizeTable.root / separator 仅纵向 Box / Paragraph 总宽含 indent+prefix）。
1. **接口冻结后的有限并行**：① 契约迁移（已并入主线 A）；② measure/allocate 实现 + 单测（宽度规则/保底/比例/悬挂缩进）——**已完成 eea8196**（`layout/measure.ts` + `tests/measure.test.ts` 完整 measure/allocate 契约测试；advisor 两轮复核修复：spacer 轴显式互斥、多 ratio 归一、min>max、fill max 截断回流、v 过度约束压缩顺序）；③ 内容映射（`state.buffer` → 内容 Box 树，替换 `wrapBufferLines` 的分类处理）——**已完成**（`layout/build-box.ts`+`layout/fill.ts`+`layout/content-rules.ts`；双轨对照冻结 fixture + cutover 提交 b84d4b5，`wrapBufferLines` 已删、两处调用点走 `buildContentRows`）；④ 测试序列化辅助（`FrameRow[]` ↔ 字符串，复用旧断言）；⑤ 随子系统实现**逐步抽文件**（不再单设大规模拆文件并行道：`layout.ts` 按 DESIGN Part II §6 目标结构边做边拆，行为不变）。
1. **接线汇合**：各区域改造为 `fill(ctx, rect)`；`FocusFrame` 实现与测试（对照现有焦点框线各焦点态的帧断言）；面板改造为 Box 生成器（`TUI/docs/DESIGN.md` Part II §7；场景原语 `SPEC.md` §7）。——**已完成**（`layout/focus-frame.ts` 焦点框全局覆写 + `layout/panel.ts` 场景原语 + 7 面板组件改 Box 生成器 `buildXxxBox`；buildFrame 末尾单次 `focusFrame` 覆写；冻结 fixture 对照 `focus-frame-legacy.json` 16 场景逐行等价）。
1. **依赖基元迁移（防循环依赖，接线前必做）**：`measure.ts` 目前从 `layout.ts` import `wrapLine/truncateToWidth`、从 `layout/markdown.ts` import `displayWidth`。接线里程碑必须先把这些共享宽/折行原语迁到中立模块（如 `layout/width.ts`），再让 `layout.ts` import `measure.ts`，避免双向依赖。——**已完成 fd96d27**（抽取 `layout/primitives.ts`：seg/rowWidth2/truncateSegs/truncateToWidth/wrapLine/wrapLines；measure 改 import primitives.ts，layout.ts 改 import+re-export）。
1. 全量回归：`npm run check/test/build` + `demo -- --smoke` + `smoke:pty`。——**已完成**（tsc 0；TUI 686/686；根级 11 包 0 fail；demo 冒烟 SMOKE_PASS 36；`smoke:pty` 真机冒烟 SMOKE OK）。
1. 文档同步：`SPEC.md` 引用、`TUI/docs/DESIGN.md`「四区域布局」改为「由 Box 树声明」、`TUI/docs/design/REFACTOR.md` 归属登记。——**已完成**（SPEC 保留既有设计引述；DESIGN 标题注明由 Box 树声明 + 术语节「已收敛」；REFACTOR 已登记 layout/box|focus-frame|panel 等归属）。

## 3. 验收

```sh
npm run check          # 类型通过
npm run test           # 全量测试通过（含新增序列化/排版产出断言）
npm run build
npm run demo -- --smoke   # 帧断言 SMOKE_PASS 不变
npm run smoke:pty      # 真机冒烟（工具行/状态栏 usage）
```

实施完成后文档同步：`TUI/docs/DESIGN.md` 术语节「现状偏差」→「样式链路已收敛」、「核心接口契约」更新为 `FrameRow`；`IMPLEMENTATION.md` 增补「段序列化」要点。

## 4. 不在范围（明确不做）

- 不换 TUI 框架、不加事件总线/中间件、不引入样式规则引擎/布局引擎（保留「排版后扁平快照」模型）。
- 不为 Approval/Question/ModelPicker 建共享 Panel 基类；不把控制逻辑装进 `components/` 渲染文件（TUI/docs/design/REFACTOR.md 约定）。
- 渲染层继续不量宽、不感知内容。
- 不启用 bracketed paste / 鼠标 / 滚动区域（单独条目，另行评估）。

## 5. 提交拆分（C5）

拆成多个可独立回归的提交：契约层 / Box 类型+单测 / 测量算法 / 内容映射 / 接线+FocusFrame+面板 / 测试迁移——每批独立可验证，天然支持并行。

## 5b. 命令扩展（A 组接线，独立于渲染主线）

> **进度**：批次 0 合同门 + 批次 1-4（`/stats` `/rename` `/skills` `/agents` `/tools` `/settings` `/fork`）完成并审计通过；A 组 A1（`/task`）A2（`/guard`）A3（`/memory`）A4（`/loop`）A5（`/contract`）、C1（`/jobs` PgUp/PgDn 回补）、C2（`/agents` 事件驱动刷新）、P2#16（`/workflows` 面板）、P2#18（`/council` 二次意见）、P2#24（`/search` 网页搜索）、P2#33（声音提醒事件钩子）已实现并提交，B1（`/clear`）、B2（`/login`/`/logout`）、B3（`/review`）设计裁定均已产出（均维持排除，见 `COMMANDS-SPEC.md` §3）（详见 `README.md` 命令清单与 `COMMANDS-SPEC.md` §3、`IMPLEMENTATION.md`）。
> 命令扩展属独立演进面，与本节渲染管线无耦合；实施记录见 `COMMANDS-TASKS.md`。

## 6. 待决清单

| # | 问题 | 备注 |
|---|---|---|
| B3 | /review 设计裁定 | ✅ 已裁定（C8 复核 dsh-workflow 0.1.5-rc.2：workflowEngine.start 为通用脚本引擎（自备 script/meta/parent: Agent），包内无 review 资产 → 需先建 review 编排资产 → 搁置；裁定见 `COMMANDS-SPEC.md` §3） |
| B2 | /login·/logout 设计裁定 | ✅ 已裁定（C7 复核 dsh-credentials 0.1.5-rc.2：ctx.credentials 为凭据存取/管理 seam（reference 空间 resolve/describe/set/unset + record 空间 listRecords/describeRecord/modifyRecord/deleteRecord + reference-updated 事件），仍无交互登录流程；/logout 无宿主「登出」概念 → 维持排除；裁定见 `COMMANDS-SPEC.md` §3） |
| B1 | /clear 设计裁定 | ✅ 已裁定（C6 复核 dsh-session 0.1.5-rc.2：store 公开面无删除/清理 API（`detachEntered`/`store.delete` 为 private teardown）、`dsh-session-query` 仅查询、无 `session/delete` 事件 → 宿主入口仍缺；会话清理已由 `/session` 面板 `d`/`x` + `/session clean` 文件级删除覆盖 → 维持排除；裁定见 `COMMANDS-SPEC.md` §3） |
| C1 | /jobs 面板 PgUp/PgDn 回补 | ✅ 已实现（jobs-panel-page reducer + index 按键 + footer/helpText 同步，页高=activityH 与共享面板同口径） |
| P2#24 | /search 网页搜索 | ✅ 已实现（核实 dsh-web 为 provider-selecting 非聚合 → **TUI 侧并行多 provider**（web 派生 + options.searchProviders）合并/URL 去重/query-token 关联度排序；单 provider 失败降级、全败 reject(warn)；Enter 来源 URL） |
| P2#33 | 声音提醒事件钩子 | ✅ 已实现（Renderer.bell?() → Screen.beep() 写 BEL \\x07；turn-end 任务结束响 + 等待输入超 idleThresholdMs 补响；notify.enabled 开关；经 tui.config.json notify 读取，缺省即可用；不做桌面通知） |
| P2#18 | /council 二次意见 | ✅ 已实现（核实 ctx.subagents.start（dsh-subagent one-shot）可达 → adapter 并行 N 个 allSettled 汇总 + 失败降级；notice 展示；宿主缺失 warn 不假启动） |
| P2#16 | /workflows 面板（只读运行列表） | ✅ 已实现（tool-workflow 事件按 runId 维护集合 + workflowEngine 挂载探测 + 面板定时刷新；dsh-workflow 无查询面走事件面，B3 裁定衔接） |
| C2 | /agents 面板事件驱动刷新 | ✅ 已实现（评估：宿主无 subagent 状态事件面 → 打开期间每 2s 定时 + 手动 `r` 刷新，tick 自检停表；`agentsRefreshIntervalMs` 可注入） |
| C2 | markdown 解析器重构范围 | ✅ 已随 Box 重构收口（`wrapBufferLines` 已删、块解析抽出完成，见 `IMPLEMENTATION.md`「渲染管线重构」；`markdown.ts` 现 723 行，未做整体重排——当年判据保留为历史） |
| C3 | 测试迁移策略 | ✅ 已随 Box 重构收口（主线 A：断言改用 `segments` 结构 + `tests/helpers/rowText.ts` 序列化辅助；当前 TUI 844 单测） |
| — | 活动区两态触发方式 | ✅ 已裁定并实现：**用户显式命令** `/verbose on\|off`（不做按高度预算自动降级）。状态 2（紧凑）= 每条目 1 行 + 行尾 `…`，`state.activityVerbose` + `buildBox` 单行压缩；`SPEC.md` §6.8、`IMPLEMENTATION.md`「活动区详略两态」 |
| — | 表格 `minW` 取值策略 | ✅ 已定并实现：`max(3, ⌈自然宽/4⌉)`；压缩改**水位法**（窄列保自然宽、超宽列压到共同水位线），ΣminW 仍放不下才按 minW 比例 + 格内 `…` 截断（`SPEC.md` §3.2、`layout/table.ts`） |
| — | 面板选中/高亮字符 | 候选沿用现状：`>` 高亮、单选 `*`、多选 `+`；SPEC 面板原语只定结构字段，字符待定（`SPEC.md` §7） |
| — | 启动自动清理空会话 | ✅ 已实现（session.autoCleanEmpty 开关，**缺省开**，tui.config.json 显式 false 关闭；启动 + 优雅退出两个时机：start() 后台全目录扫描空会话复用 /session 判据，deleteSession 串行删除 + notice 汇报；退出时提示与结果渲染到活动区并等待完成再退出；startupCleanableIds 纯函数 + App 集成 7 例） |

## 7. 开放点

- **内容树的测量代价**：✅ 已缓解（折行/宽度纯函数有界缓存 + `charWidth` 码点表，开关 `TUI_LAYOUT_CACHE=0`，见 `IMPLEMENTATION.md`「排版缓存与绘制合帧」；`npm --prefix TUI run bench` 三档报告 off/on 中位耗时与倍数，cold 33×、warm 72×、incremental 70× 量级）。**剩余未做**（本次明确不纳入）：区域级帧输出 memo（状态列/状态栏/footer，实测仅占单帧 1-4%）与「只测量可见窗口」的懒排版（需块高度前缀和 + 折叠/滚动边界处理）。
