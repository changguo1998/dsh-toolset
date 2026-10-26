# TUI 待办与开放项

> 职责：TUI 包的**未完成**待办（TUI 的变更优先写在本目录）；跨包待办见 `docs/BACKLOG.md`，TUI 现状见 `TUI/docs/STATUS.md`
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用（追踪文档按条目标题引用，见 `docs/WORKFLOW-STANDARD.md` §6/§7）；**每次整理时按当前顺序从 1 起重新编号**（故 `TUI/src`、`TUI/tests` 注释中的 `TUI#n` 仅作历史线索）；本文件的 `#n` 与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 本文件只列未完成项；已完成项见 git 历史与 `TUI/docs/archived/`，不在此重复。
> 组织（2026-10-13 整理起）：**用户手动指定的顺序优先**；否则〔进行中〕条目置顶 → 其余按依赖 → 工作量升序（无前置项在前、同层按工作量升序、同工时缺陷优先于行为改动；有前置项排在各自前置之后；〔暂停〕项沉到表尾）。条目统一结构——现象 / 现状 → 期望 →（可选）复现 / 疑似范围 / 接取时裁定 → 落点 → 验收 → 来源·状态·优先级。
> 顺序与并行分组见项目级 `docs/BACKLOG.md` §2「实现顺序与并行分组」（按组串行、组间并行，组内按工作量升序）。
> 写入范围（2026-10-23）：并行任务只写自己的代码 / 测试与**自己的追踪文档**；本文件的状态与关闭注记、`SPEC.md`、`README.md`、`COMMANDS*.md` 由主分支代理统一回写。

## 待办

（当前无未完成项）

> 2026-10-27 关闭：`TUI 配置迁到 profile patch` 完成并移出清单（提交 `41b2d44`：`DshTuiConfig` 扁平展开 `layout` / `notify` / `session` / `approval` / `localLog`、主题段改名 `colorschema`、`mergeTuiConfig`（patch > 文件 > 默认，段内逐键）；示例 patch 与 `~/.dsh/profiles/fff`、`fff.bak` 同步写入；新增 `tests/tui-config-merge.test.ts`，全量 1809 例绿；追踪文档 `TUI/docs/archived/2026-10-27-tui-config-to-patch.md`）。

> 2026-10-27 关闭：`全屏（备用屏）模式` 完成并移出清单（提交 `89f2cf8`：启动写 `ESC[?1049h`、退出与异常恢复写 `ESC[?1049l`，幂等开关 `altOff`，按裁定不写回帧内容；新增 `tests/fullscreen-alt-screen.test.ts`；TUI 全量 1806 例全绿；追踪文档 `TUI/docs/archived/2026-10-27-fullscreen-alt-screen.md`）。

> 2026-10-27 关闭：`翻页键只在会话 / 回合区聚焦时生效，否则在输入区移动光标` 完成并移出清单（提交 `5109d34`：无焦点时 ↑/↓ 上下移一行并落同显示列、←/→ 一格、Home/End 整串首尾、PgUp/PgDn 行首/行尾；聚焦会话/回合区才翻页；新增 `tests/input-cursor-keys.test.ts` 3 例，旧滚动用例改为先 Ctrl+E 聚焦；TUI 全量 1804 例全绿；追踪文档 `TUI/docs/archived/2026-10-27-input-cursor-keys.md`）。

> 2026-10-27 关闭：`回合分隔线与 step 头的宽度收到正文右缘` 完成并移出清单（提交 `6501379`：分隔行补白改空格 + 右缘框列留空，线右端与正文右缘同列；头行并入紧随其后的段（正文/思考段塞进内容 v 与各块平级，用户段提到段盒外层同槽），不画左竖线；TUI 全量 1799 例全绿；追踪文档 `TUI/docs/archived/2026-10-27-separator-width.md`）。

> 2026-10-27 关闭：「文档回写：`DESIGN.md` / `SPEC.md` 按七段链路重写」完成并移出清单（DESIGN 的术语 / 文件树 / Box 模型 / 模块归属表 / 状态符号与排队块落点，SPEC 的 §2 边界注 / §3 / §3.1 / §3.2 / §6.7 / §6.8 / §9 / §9.1 / §11.3 / §15.5 / §15.6 全部改到七段链；旧符号 grep 零命中；追踪文档 `TUI/docs/archived/2026-10-27-doc-rewrite-seven-stage.md`）。

> 2026-10-27 关闭（不立项）：「表格单元格内 `<br>` 换行未支持」不做并移出清单 —— 用户裁定表格不做单元格换行。
> 2026-10-27 关闭：「新会话跑一会儿后整机卡死」真机复验通过（用户确认目前无问题）并移出清单 —— 根因 = 列表起始判定与解析口径分叉（`LIST_RE` 认裸标记、`listItemMark` 不认）导致的解析死循环；修法 = 删除 `LIST_RE`、统一 `isListItemStart` + 空产出必推进兜底，提交 `5070fe4`，回归 `tests/pipeline-parse.test.ts` 六形态与 `tests/layout-hang-guard.test.ts`。
> 2026-10-27 关闭：`嵌套列表按缩进产真子列表` 完成并移出清单（§2 parse 按前导缩进每 2 列一层产层级、§4 structure 按条目缩进列数排版；四条 `test.todo` 全部转正；`npm run test:tui` 1798 例全绿 / 0 todo；追踪文档 `TUI/docs/archived/2026-10-27-nested-list.md`）。

> 2026-10-26 关闭：`排查表格排版修复后的副作用（额外空行 / 竖线断掉）` 完成并移出清单（本任务只到决策，未单独实现修法：两个根因——表格行高二次解析、measure 与 fill 折行口径分叉——已由渲染流水线重构从结构上消除；追踪文档 `TUI/docs/archived/2026-10-24-table-layout-side-effects.md`）。

> 2026-10-26 关闭：`重构渲染流水线：结构分类在摊平阶段丢失，measure 与 fill 各自解析` 完成并移出清单（七段链路落地：`layout.ts → pipelineContent → split/parse/route/structure/measure/flatten → renderPaneNew`；旧链路 `buildBoxes`/`boxToLines`/`buildBox`/`build-box.ts` 整条删除，源码净删约 1.2k 行；复验 1783 例 + 4 todo + 冒烟 42 PASS；追踪文档 `TUI/docs/archived/2026-10-25-render-pipeline-refactor.md`；遗留转入新条目 #1 / #2 / #3）。

> 2026-10-24 关闭：`#1` notice 行统一为 `[hh:mm:ss <来源>] 正文` 完成并移出清单（实现含 deliverBufferTail 补漏, 即 compaction/retry 等直落 toast 也带前缀; 追踪文档 `TUI/docs/archived/2026-10-24-notice-line-format.md`; 复验 1760 例 + 冒烟 42 PASS; demo 脚本不再内嵌 build）。

> 2026-10-22 接取：全部 5 条标〔进行中: 2026-10-22〕，追踪文档 `TUI/docs/implementation/2026-10-22-*.md`（hmr-no-exit / config-editor-surface / code-block-tab / table-content-mismatch / user-block-right-gap）；本次只建文档，调研与实现未开始。

> 历史（2026-10-13 至 2026-10-22）：本清单关闭过的 20 余条过程记录全在 `TUI/docs/archived/`（按日期命名，逐条对应），本文件不再保留逐条关闭注记。要点按档：`2026-10-13-*`（HMR 主题退出 / tui 配置重建 fiber）、`2026-10-14-*`（`@` 文件补全 / 焦点键与提示行）、`2026-10-15-*`（打断发送与 `!` 模式 / 焦点保持 / 相位抖动）、`2026-10-16-*`（提示键审计 / 审批超时 / 宽度探测 / 思考排版 / 干净退出 / 边界留白）、`2026-10-17-*`（字符格高宽比）、`2026-10-18-*`（活动区开关 / 用户块平衡 / 五项清单）、`2026-10-19-*`（notice 模型可见 / 列表类型）、`2026-10-21-help-align-4.md`（help 4 空格档位）。
> 2026-10-22 登记：新增两条（同一发现源——改 `output-compress` 行 config 后 dsh 直接退出；排查确认是 HMR 行级重载 + TUI `process.exit` 链路），状态均未接取。
> 2026-10-22 登记再新增一条：`#3` 代码块里 `\t` 展开为 4 空格并保证底色填满（用户登记, 未接取）。
> 2026-10-22 登记再新增一条：`#4` 排查「正文里的表格」与「排版后展示的表格」内容不一致（用户登记, 未接取）。
> 2026-10-22 登记再新增一条：`#5` 用户块折行后右侧大片留白、竖线未贴右缘（用户报告, 未接取; 细节留到开工后的调研阶段讨论）。
> 2026-10-23 关闭：`#1` 代码块 `\t` 展开完成并移出清单（实现 `637200c`、用例 `c9b2e79`；追踪文档 `TUI/docs/archived/2026-10-22-code-block-tab.md`；真机验收用户 2026-10-23 确认：缩进 / 折行 / 灰底三组测试文本均正常）。
> 2026-10-23 关闭：`#5` 非 TUI 行 HMR 重载不退出完成并移出清单（实现 `962b8f4`、用例 `c10edf0`；追踪文档 `TUI/docs/archived/2026-10-22-hmr-no-exit.md`；真机验收 2026-10-23：非 TUI 行重载会话存活，`/quit`、退出确认面板、`/restart` 三条路径全绿）。
> 2026-10-23 关闭：`#4` 接 config-editor 配置编辑面完成并移出清单（实现 `27d76a3`、值校验与归一化兜底 `ec8e7bd`；追踪文档 `TUI/docs/archived/2026-10-22-config-editor-surface.md`；真机验收两轮：首轮发现无效值未拒 / unset 删整行，修复后复验通过：非法值未写盘、patch 逐字不变）。
> 2026-10-23 关闭：`#2` 用户块折行后右侧大片留白完成并移出清单（实现 `3174373` 布局尺寸节点自持 + 多轮收敛、合并 `3f4b23d`；追踪文档 `TUI/docs/archived/2026-10-22-user-block-right-gap.md`；真机验收 2026-10-23：长中英混排消息折 4 行，四行右竖线均 82 列位置一致且贴右无空隙）。
> 2026-10-23 关闭：`#3` 正文表格与排版后展示不一致完成并移出清单（实现 `61f63af`、合并 `844ec9f`；追踪文档 `TUI/docs/archived/2026-10-22-table-content-mismatch.md`；根因 = 排版链重新拼回 markdown 行时分隔行按 `aligns` 长度生成，上游少列时旧渲染器判不成表格、整表退回原文；修法 = 分隔行按表头格数生成 + `isTableStart` 列数只许少不许多，缺列按左对齐补齐）。同日顺带交付「思考行识别 markdown 表格」（紫竖线），该子项已登记并随本条关闭。
