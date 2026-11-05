# TUI 待办与开放项

> 职责：TUI 包的**未完成**待办（TUI 的变更优先写在本目录）；跨包待办见 `docs/BACKLOG.md`，TUI 现状见 `TUI/docs/STATUS.md`
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用（追踪文档按条目标题引用，见 `docs/WORKFLOW-STANDARD.md` §6/§7）；**每次整理时按当前顺序从 1 起重新编号**（故 `TUI/src`、`TUI/tests` 注释中的 `TUI#n` 仅作历史线索）；本文件的 `#n` 与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 本文件只列未完成项；已完成项见 git 历史与 `TUI/docs/archived/`，不在此重复。
> 组织（2026-10-13 整理起）：**用户手动指定的顺序优先**；否则〔进行中〕条目置顶 → 其余按依赖 → 工作量升序（无前置项在前、同层按工作量升序、同工时缺陷优先于行为改动；有前置项排在各自前置之后；〔暂停〕项沉到表尾）。条目统一结构——现象 / 现状 → 期望 →（可选）复现 / 疑似范围 / 接取时裁定 → 改动位置 → 验收 → 来源·状态·优先级。
> 顺序与并行分组见项目级 `docs/BACKLOG.md` §2「实现顺序与并行分组」（按组串行、组间并行，组内按工作量升序）。
> 写入范围（2026-10-23）：并行任务只写自己的代码 / 测试与**自己的追踪文档**；本文件的状态与关闭注记、`SPEC.md`、`README.md`、`COMMANDS*.md` 由主分支代理统一回写。

## 待办

> 2026-11-04 关闭: 「拆分 `TUI/src/app/index.ts` 的 `App` 类体」完成并移出清单（追踪文档 `TUI/docs/archived/2026-11-04-split-app-class.md`): 59 个显式字段 + `deps` 与构造器收进 `app/runtime/context.ts`（`AppContext` + `ctx.self` 扁平成员面), 174 个方法按职责拆成 11 个模块（`frame` / `interaction` / `session` / `panels` / `commands` + `commands-{model,config,memory,host}` / `wiring` / `lifecycle`), `index.ts` 6497 → 151 行且只剩壳与装配; `App` 公开面 8 个方法、导出集合 15 个符号与帧内容不变（测试零改动, 壳上仅加 6 个私有兼容成员); TUI 1829 例全过、帧基线 1/1、`SMOKE_OK`、全仓 `check` / `test` 退出 0.

> 2026-11-04 关闭：「拆 `TUI/src/app/adapter/dsh.ts` 的 `DshAdapter`」完成并移出清单（追踪文档 `TUI/docs/archived/2026-11-04-split-dsh-adapter.md`）：状态收进 `adapter/context.ts`（`AdapterState` + `emit` / `deliver` 出口），职责拆成 `dsh-events.ts` / `dsh-session.ts` / `dsh-approval.ts` / `dsh-panels.ts`，`dsh.ts` 3633 → 577 行且只剩装配与接线（getter 用 `defineProperties` 保留）；对外导出集合、`runtime.on` 注册顺序与帧内容不变；TUI 1829 例全过、`demo -- --smoke` 输出 `SMOKE_OK`、帧基线 1/1、全仓 `check` / `test` 退出 0。

> 2026-11-03 关闭：`拆 TUI/src/app/state/reducer.ts 的 reduceState 状态机` 完成并移出清单（追踪文档 `TUI/docs/archived/2026-11-03-split-reducer.md`）：`switch` 的 133 个 `case` 块按 action 前缀搬到 9 个 `state/reducer-*.ts`（块文本逐字节一致），入口只留子 reducer 链与焦点复位；TUI 1829 例全过、`demo -- --smoke` 输出 `SMOKE_OK`、全仓 `check` / `test` 退出 0。

> 2026-11-04 接取〔进行中: 2026-11-04〕：`!` 打断并直发后用户块终态符号错位（用户报告）。现象：`!` 模式打断当前回合并发送新输入后，原来的输入（被打断回合）状态符号变 `?`，正在处理的新输入变 `□`/`■`；期望：原输入被中断显示 `■`（方灰块），新输入保持运行中 `●`/`○` 闪烁。疑似范围：`layout/pipeline/sections.ts` 的 `applyTurnEnd` 按**回合世代**取「最后一条未定态用户块」落终态，打断直发的新块与被打断块同世代（同一次 `turn-end` 之前交付），`aborted` 错误落给新块；且 `runtime/session.ts` 的 `sendUserText` 把打断直发块归入被打断回合的回合号（`sameTurn` 判定）。复现：同世代两用户块 + `turn-end reason="aborted"`（已用临时脚本复现：A 留 `?`、B 得 `■`）。验收：打断并直发后原输入 `■`、正在处理的新输入 `●/○` 闪烁；正常回合终态、恢复会话回合号漂移（`pipeline-sections.test.ts` 既有用例）不退化（守成）。来源：用户报告·优先级：高。

> 2026-11-04 关闭：`!` 打断并直发后用户块终态符号错位完成并移出清单（追踪文档 `TUI/docs/archived/2026-11-04-interrupt-user-block-status.md`）：根因两处——① `runtime/session.ts` 打断提交不关本地回合, 直发块与被打断块同号同世代; ② `layout/pipeline/sections.ts` 的 `applyTurnEnd` 只按世代取「最后一条未定态用户块」落终态。修法：`!` 打断提交提前置 `ctx.turnOpen = false` 使直发开新回合（预测新号）; `applyTurnEnd` 落终态改为「按回合号精确匹配优先 + 世代兜底」（漂移场景不退化）。TUI 1834 例全过、`demo -- --smoke` 42 PASS + SMOKE_OK、根级 check / build / check:docs 全绿。遗留: 真机打断流程人工确认。

> 2026-11-03 关闭：`收拢布局层的 delivery.kind === "user" 判断` 完成并移出清单（追踪文档 `TUI/docs/archived/2026-11-03-is-user-delivery.md`）：类型守卫 `isUserDelivery` 与 `UserDelivery` 落在 `layout/pipeline/types.ts`，`sections.ts` 7 处比较统一改调；TUI 1829 例全过、`demo -- --smoke` 输出 `SMOKE_OK`。

> 2026-10-27 关闭：`/model`、`/provider`、`/effort` 带参切换（含 `:effort` 后缀）与目录组合校验、启动参数指定 provider / model / effort 三条完成并移出清单（`pnpm run check` 0、`pnpm test` 1821/1821、build 成功、live profile 已同步 dist；追踪文档 `TUI/docs/archived/2026-10-27-provider-effort-args.md` / `2026-10-27-model-name-validation.md` / `2026-10-27-startup-model-flags.md`）。

> 2026-10-27 关闭：`TUI 配置迁到 profile patch` 完成并移出清单（提交 `41b2d44`：`DshTuiConfig` 扁平展开 `layout` / `notify` / `session` / `approval` / `localLog`、主题段改名 `colorschema`、`mergeTuiConfig`（patch > 文件 > 默认，段内逐键）；示例 patch 与 `~/.dsh/profiles/fff`、`fff.bak` 同步写入；新增 `tests/tui-config-merge.test.ts`，全量 1809 例绿；追踪文档 `TUI/docs/archived/2026-10-27-tui-config-to-patch.md`）。

> 2026-10-27 关闭：`全屏（备用屏）模式` 完成并移出清单（提交 `89f2cf8`：启动写 `ESC[?1049h`、退出与异常恢复写 `ESC[?1049l`，幂等开关 `altOff`，按裁定不写回帧内容；新增 `tests/fullscreen-alt-screen.test.ts`；TUI 全量 1806 例全绿；追踪文档 `TUI/docs/archived/2026-10-27-fullscreen-alt-screen.md`）。

> 2026-10-27 关闭：`翻页键只在会话 / 回合区聚焦时生效，否则在输入区移动光标` 完成并移出清单（提交 `5109d34`：无焦点时 ↑/↓ 上下移一行并落同显示列、←/→ 一格、Home/End 整串首尾、PgUp/PgDn 行首/行尾；聚焦会话/回合区才翻页；新增 `tests/input-cursor-keys.test.ts` 3 例，旧滚动用例改为先 Ctrl+E 聚焦；TUI 全量 1804 例全绿；追踪文档 `TUI/docs/archived/2026-10-27-input-cursor-keys.md`）。

> 2026-10-27 关闭：`回合分隔线与 step 头的宽度收到正文右缘` 完成并移出清单（提交 `6501379`：分隔行补白改空格 + 右缘框列留空，线右端与正文右缘同列；头行并入紧随其后的段（正文/思考段塞进内容 v 与各块平级，用户段提到段盒外层同槽），不画左竖线；TUI 全量 1799 例全绿；追踪文档 `TUI/docs/archived/2026-10-27-separator-width.md`）。

> 2026-10-27 关闭：「文档回写：`DESIGN.md` / `SPEC.md` 按七段链路重写」完成并移出清单（DESIGN 的术语 / 文件树 / Box 模型 / 模块归属表 / 状态符号与排队块显示位置，SPEC 的 §2 边界注 / §3 / §3.1 / §3.2 / §6.7 / §6.8 / §9 / §9.1 / §11.3 / §15.5 / §15.6 全部改到七段链；旧符号 grep 零命中；追踪文档 `TUI/docs/archived/2026-10-27-doc-rewrite-seven-stage.md`）。

> 2026-10-27 关闭（不立项）：「表格单元格内 `<br>` 换行未支持」不做并移出清单 —— 用户裁定表格不做单元格换行。
> 2026-10-27 关闭：「新会话跑一会儿后整机卡死」真机复验通过（用户确认目前无问题）并移出清单 —— 根因 = 列表起始判定与解析口径分叉（`LIST_RE` 认裸标记、`listItemMark` 不认）导致的解析死循环；修法 = 删除 `LIST_RE`、统一 `isListItemStart` + 空产出必推进兜底，提交 `5070fe4`，守成测试 `tests/pipeline-parse.test.ts` 六形态与 `tests/layout-hang-guard.test.ts`。
> 2026-10-27 关闭：`嵌套列表按缩进产真子列表` 完成并移出清单（§2 parse 按前导缩进每 2 列一层产层级、§4 structure 按条目缩进列数排版；四条 `test.todo` 全部转正；`pnpm run test:tui` 1798 例全绿 / 0 todo；追踪文档 `TUI/docs/archived/2026-10-27-nested-list.md`）。

> 2026-10-26 关闭：`排查表格排版修复后的副作用（额外空行 / 竖线断掉）` 完成并移出清单（本任务只到决策，未单独实现修法：两个根因——表格行高二次解析、measure 与 fill 折行口径分叉——已由渲染流水线重构从结构上消除；追踪文档 `TUI/docs/archived/2026-10-24-table-layout-side-effects.md`）。

> 2026-10-26 关闭：`重构渲染流水线：结构分类在摊平阶段丢失，measure 与 fill 各自解析` 完成并移出清单（七段链路落地：`layout.ts → pipelineContent → split/parse/route/structure/measure/flatten → renderPaneNew`；旧链路 `buildBoxes`/`boxToLines`/`buildBox`/`build-box.ts` 整条删除，源码净删约 1.2k 行；复验 1783 例 + 4 todo + 冒烟 42 PASS；追踪文档 `TUI/docs/archived/2026-10-25-render-pipeline-refactor.md`；遗留转入新条目 #1 / #2 / #3）。

> 2026-10-24 关闭：`#1` notice 行统一为 `[hh:mm:ss <来源>] 正文` 完成并移出清单（实现含 deliverBufferTail 补漏, 即 compaction/retry 等直落 toast 也带前缀; 追踪文档 `TUI/docs/archived/2026-10-24-notice-line-format.md`; 复验 1760 例 + 冒烟 42 PASS; demo 脚本不再内嵌 build）。

> 2026-10-22 接取：全部 5 条标〔进行中: 2026-10-22〕，追踪文档 `TUI/docs/archived/2026-10-22-*.md`（hmr-no-exit / config-editor-surface / code-block-tab / table-content-mismatch / user-block-right-gap）；本次只建文档，调研与实现未开始。

> 历史（2026-10-13 至 2026-10-22）：本清单关闭过的 20 余条追踪文档全在 `TUI/docs/archived/`（按日期命名，逐条对应），本文件不再保留逐条关闭注记。要点按档：`2026-10-13-*`（HMR 主题退出 / tui 配置重建 fiber）、`2026-10-14-*`（`@` 文件补全 / 焦点键与提示行）、`2026-10-15-*`（打断发送与 `!` 模式 / 焦点保持 / 相位抖动）、`2026-10-16-*`（提示键审计 / 审批超时 / 宽度探测 / 思考排版 / 干净退出 / 边界留白）、`2026-10-17-*`（字符格高宽比）、`2026-10-18-*`（回合区开关 / 用户块平衡 / 五项清单）、`2026-10-19-*`（notice 模型可见 / 列表类型）、`2026-10-21-help-align-4.md`（help 4 空格档位）。
> 2026-10-22 登记：新增两条（同一发现源——改 `output-compress` 行 config 后 dsh 直接退出；排查确认是 HMR 行级重载 + TUI `process.exit` 链路），状态均未接取。
> 2026-10-22 登记再新增一条：`#3` 代码块里 `\t` 展开为 4 空格并保证底色填满（用户登记, 未接取）。
> 2026-10-22 登记再新增一条：`#4` 排查「正文里的表格」与「排版后展示的表格」内容不一致（用户登记, 未接取）。
> 2026-10-22 登记再新增一条：`#5` 用户块折行后右侧大片留白、竖线未贴右缘（用户报告, 未接取; 细节留到开工后的调研阶段讨论）。
> 2026-10-23 关闭：`#1` 代码块 `\t` 展开完成并移出清单（实现 `637200c`、用例 `c9b2e79`；追踪文档 `TUI/docs/archived/2026-10-22-code-block-tab.md`；真机验收用户 2026-10-23 确认：缩进 / 折行 / 灰底三组测试文本均正常）。
> 2026-10-23 关闭：`#5` 非 TUI 行 HMR 重载不退出完成并移出清单（实现 `962b8f4`、用例 `c10edf0`；追踪文档 `TUI/docs/archived/2026-10-22-hmr-no-exit.md`；真机验收 2026-10-23：非 TUI 行重载会话存活，`/quit`、退出确认面板、`/restart` 三条路径全绿）。
> 2026-10-23 关闭：`#4` 接 config-editor 配置编辑面完成并移出清单（实现 `27d76a3`、值校验与归一化兜底 `ec8e7bd`；追踪文档 `TUI/docs/archived/2026-10-22-config-editor-surface.md`；真机验收两轮：首轮发现无效值未拒 / unset 删整行，修复后复验通过：非法值未写盘、patch 逐字不变）。
> 2026-10-23 关闭：`#2` 用户块折行后右侧大片留白完成并移出清单（实现 `3174373` 布局尺寸节点自持 + 多轮收敛、合并 `3f4b23d`；追踪文档 `TUI/docs/archived/2026-10-22-user-block-right-gap.md`；真机验收 2026-10-23：长中英混排消息折 4 行，四行右竖线均 82 列位置一致且贴右无空隙）。
> 2026-10-23 关闭：`#3` 正文表格与排版后展示不一致完成并移出清单（实现 `61f63af`、合并 `844ec9f`；追踪文档 `TUI/docs/archived/2026-10-22-table-content-mismatch.md`；根因 = 排版链重新拼回 markdown 行时分隔行按 `aligns` 长度生成，上游少列时旧渲染器判不成表格、整表退回原文；修法 = 分隔行按表头格数生成 + `isTableStart` 列数只许少不许多，缺列按左对齐补齐）。同日顺带交付「思考行识别 markdown 表格」（紫竖线），该子项已登记并随本条关闭。

> 2026-11-05 关闭：取消会话区 / 回合区的文字右缘留白完成并移出清单（追踪文档 `TUI/docs/archived/2026-11-05-remove-pane-text-margin.md`）：删除 `PANE_TEXT_MARGIN_COLS` 与 `paneTextWidth`，两 pane 文字排版宽 = 正文宽（`dialogueTextW` / `activityTextW` 直接取 `dialogueW` / `activityW`），排队块与回合区面板同口径；横线与外框列不动。TUI 1834 例全过（15 条帧基线重冻 + 窄屏警告断言改压平匹配）、`demo -- --smoke` 42 PASS + `SMOKE_OK`、根级 check / build / check:docs 全绿。遗留：真机目视确认行尾空白与 CJK 混排折行。

> 2026-11-04 接取〔进行中: 2026-11-04〕：运行状态符号分阶段：发送中四箭头旋转、接收中按类型着色（用户报告）。现象：目前运行中符号只有黄 `●`/`○`（runVirt 相位交替），无法区分「已发送等首字节」与「正在接收」，也没有按内容类型（思考/正文/工具…）的着色。期望：① 发送后首字节到达前，四个循环箭头依次出现（视觉旋转）；② 接收中保持闪烁，但颜色/类型对应——思考紫（magenta）、正文蓝（blue）、工具黄（yellow）、notice 灰、shell 青（cyan）；发送中保持默认黄。配套：旋转箭头符号（⟳ ⟲ ↻ ↺）加入 36 符白名单（dev/standard/rules.mjs + AGENTS.md + dev/standard/README.md），用户 2026-11-04 明确许可。来源：用户报告·优先级：中。

> 2026-11-04 关闭：运行状态符号分阶段完成并移出清单（追踪文档 `TUI/docs/archived/2026-11-04-run-symbol-phases.md`）：发送中（首字节未到, `runVirt.lastTime` undefined）用户块首行显黄旋转箭头（`SPINNER` 4 态 ⟳↻↲↺ 随 250ms tick 轮换）; 接收中保持 `●`/`○` 相位闪烁并按 `streamKind` 着色（思考紫 / 正文蓝 / 工具黄 / notice 灰 / shell 青, undefined 回退黄）。白名单 36 → 40（`⟳ ⟲ ↻ ↺` 入 dev/standard/rules.mjs + AGENTS.md + symbol-normalizer 家族 F, 旧裁定「⟳ 不进推荐集合」按用户指示推翻）。TUI 1834 例全过、smoke 42 PASS + SMOKE_OK、symbol-normalizer 46 例全过、根级 check / build / check:docs 全绿。遗留: 真机分阶段闪烁人工确认。
