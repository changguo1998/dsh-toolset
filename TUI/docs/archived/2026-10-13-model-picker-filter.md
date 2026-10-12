# 2026-10-13 `/model` 面板 provider / model 两列输入筛选（按匹配度排序）

- 层：TUI
- 接取条目（按标题引用）：〈`/model` 面板 provider / model 两列支持输入筛选并按匹配度排序〉
- 开始：2026-10-13　状态：完成

## 目标

`/model` 交互面板里可直接键入筛选词, 只作用于**当前焦点列**:

- provider 列 / model 列各记各的筛选词, Tab / ←→ 切列后各自保留（不互相污染）;
- effort 列不筛（选项仅 3 个上下, 无筛选价值）;
- 命中项按匹配程度排序（全等 → 前缀 → 段首前缀 → 子串 → 子序列）; 输入为空回落默认序（当前生效值恒首位）;
- 筛选词显示在**用户输入区**（面板下方那行输入行, 带光标 —— 用户裁定）;
- Backspace 删尾字符; Esc 先清空本列筛选词, 再按一次才关面板; 底部键位提示补 `[输入]筛选`。

非目标（明确不做, 见「决策」）: 不自动改写星号选中（Enter 仍提交星号, 需空格预选）; 不做子串高亮; 不支持粘贴进筛选词; effort 列不筛。

## 调研

- 面板现状: `components/ModelPicker.ts` 三列独立列表同屏（`pickerColumnWidths` 分宽、列内 `scrollStart` 滚动）, 数据来自 `PickerState` 的 `providers` / `models`（`models` = 星号 provider 的模型列表拷贝）/ `efforts`; 焦点 `providerIndex` / `modelIndex` / `effortIndex` 都是**列表下标**。
- 键路由: `index.ts` 的 picker 分支（`state.picker` 早于主输入栏处理）只认 ↑/↓ · 空格 · Tab · ←/→ · Enter · Esc, 其余 `return` 吞掉 —— 可打印字符目前无处可去, 因此「键入即筛选」不与既有键位冲突（唯一的冲突面是空格: 已由预选占用, 沿用）。
- 下标语义: 三处按「下标取焦点行值」——`state.ts` 的 `picker-select`（`providers[providerIndex]` / `models[modelIndex]`）、`model-transition.ts` 的 `resolvePickerSelection`（星号缺失时回退焦点行）、`index.ts` 的 `reloadPickerEfforts`。筛选后「显示序 ≠ 原列表序」, 这三处必须与渲染同源, 否则空格选中 / Enter 提交 / 思考等级加载会取到别的行。
- 用户输入区现状: 面板态 footer 全是空白占位（`layout.ts` 的 `modalOpen` 分支; 仅 approval / question 借它显示 notice）; 输入区渲染器 `components/TextInput.ts` 的 `renderTextInput(text, cursor, placeholder, width, prompt, rows)` 现成可用（自带 placeholder 与 caret 列, 复用即可拿到硬件光标）。
- 冻结基线: `tests/fixtures/focus-frame-legacy.json` 的 `panel-picker@w60` 记录了「输入区 3 行空白 + 提示行旧文案」; 本任务的输入区筛选行与提示行文案是**有意偏离**, 按仓库既有「已偏离」范式改写该场景断言（`content-mapping.test.ts` 已有先例）, 不盲刷夹具。
- 无既有模糊匹配实现（全仓 `fuzzy` / `subsequence` / `score` 无命中）, 需新增; 但打分是纯函数, 放独立小模块, 不进 `state.ts`（3000+ 行）也不进 `model-transition.ts`（该模块只做状态转换、且被 `state.ts` 反向引用会成环）。

## 决策

1. **筛选词存在 `PickerState` 上（`providerFilter?` / `modelFilter?`, 可选字段）**, 可见列表**按需派生**（不缓存派生数组）: 派生是 `items × query` 的线性扫描, provider / model 量级（几十项）下每帧重算可忽略; 缓存派生数组反而要处理「星号 provider 变更 / efforts 异步回填」时的失效面。字段设为可选, 避免改动测试里大量 `PickerState` 字面量。
2. **可见序是唯一真源**: 新增 `picker-filter.ts` 的 `pickerVisibleProviders` / `pickerVisibleModels` / `pickerFocusedValues`, 渲染、reducer（move / select）、`resolvePickerSelection`、`reloadPickerEfforts` 全部改走它 —— 一处定义, 四处消费, 避免「显示一套、取值另一套」。
3. **只筛当前焦点列, 各列独立记词**（用户裁定）: 两列共用一词会把另一列筛空（provider 名与模型名不同源, 如 provider `alibaba` / 模型 `qwen-max`）; 各列独立则切列即可换词, 语义最直白。effort 列不筛（3 项, 且用户只提 provider / model）。
4. **排序分档 + 稳定 tie-break**: 全等 0 → 前缀 1 → 段首前缀 2（词首, 前一字符是 `-` `_` `/` `.` `:` 或空格）→ 子串 3 → 子序列 4（按序命中、可跳过）; 同档依次比匹配起点、名称长度、原索引 —— 保证「输入为空 = 默认序」是同一条排序实现的退化情形（query 空 → 原序直接返回）, 而不是另一条分支。
5. **不自动改写星号选中**: 筛选只改「显示与焦点」; 星号（`selectedModel` / `selectedProvider`）语义不变 —— 打开面板后 Enter 仍不改模型（既有契约）, 键入后仍需空格预选再 Enter。理由: 键位语义不因筛选而变, 才不会出现「有没有筛选决定 Enter 含意」的两种心智模型。代价（已记入「遗留」）: 键入后直接 Enter 不改模型。
6. **筛选词显示在用户输入区**（用户裁定）: 面板内不加输入行（列表行数不变）, 复用 `renderTextInput` 渲染 `筛选 <列名>: <词>` + placeholder（空串时）+ caret; effort 列（phase 2, 不筛）该行回落空白占位 —— 提示「这一列没有筛选」。
7. **Esc 两段行为**: 本列有词 → 只清空; 无词 → 关面板（并重置输入模式, 同现状）。Backspace 在词空时吞掉（不冒泡到主输入栏 —— picker 分支本就 `return`）。
8. **不做子串高亮 / 粘贴入筛选词 / 匹配计数**: 未请求的装饰与旁路, YAGNI。

## 规划 / 计划改动文件清单

- `src/app/picker-filter.ts`（新增）：匹配分档打分 `rankPickerItems`、可见列表 `pickerVisibleProviders` / `pickerVisibleModels`、焦点值 `pickerFocusedValues`、筛选列与词 `pickerFilterColumn` / `pickerFilterText`、逐键编辑 `pickerFilterInput`。
- `src/app/state.ts`：`PickerState` 增 `providerFilter?` / `modelFilter?`；新增 action `picker-filter`；`picker-move` / `picker-select` 改走可见列表；焦点行按值保持（词变化后原焦点项仍在 → 跟随, 否则回落 0 = 最佳匹配）。
- `src/app/model-transition.ts`：`resolvePickerSelection` 的焦点回退改走 `pickerFocusedValues`。
- `src/app/index.ts`：picker 键路由增「可打印字符 / Backspace 编辑筛选词」与「Esc 先清空」；`reloadPickerEfforts` 焦点值解析复用 `pickerFocusedValues`。
- `src/app/components/ModelPicker.ts`：渲染改用可见列表（列宽 / 滚动 / 省略号口径不变）。
- `src/app/layout.ts`：面板态 footer —— picker 且焦点列为 provider / model 时改显筛选输入行（`renderTextInput`）。
- `src/app/layout/hints.ts`：`PICKER_HINT_LINE` 补筛选与 Esc 两段语义。
- `tests/picker-filter.test.ts`（新增）：分档 / 排序稳定 / 空词默认序 / 逐键编辑 / 可见列表 / reducer（焦点按值保持、move / select 走可见列表、effort 列不筛）。
- `tests/modelpicker.test.ts`：补「筛选后渲染可见列表 + 焦点行下标一致」用例。
- `tests/focus-frame.test.ts`：`panel-picker@w60` 改「已偏离」断言（输入区筛选行 + 提示行）。
- `TUI/README.md` / `TUI/docs/DESIGN.md`：面板交互（筛选词 / 排序口径 / 键位）回写。
- `TUI/docs/BACKLOG.md`：条目状态与收尾移除。

## 实现记录

- `src/app/picker-filter.ts`（新增，约 140 行）：`pickerFilterColumn` / `pickerFilterText`（只 provider / model 两列可筛）、
  `matchClass`（分档 0-4 + 匹配起点，大小写不敏感）、`rankPickerItems`（分档 → 起点 → 名称长度 → 原索引；
  空词直接原序返回）、`pickerVisibleProviders` / `pickerVisibleModels`、`pickerFocusedValues`、
  `pickerFilterInput`（追加 / 删尾 / 其余交回）。类型依赖单向：只 `import type` `PickerState`，无环。
- `src/app/state.ts`：`PickerState` 增 `providerFilter?` / `modelFilter?`（可选字段，避免改动大量测试字面量）；
  新增 action `picker-filter`；`movePicker` 的两列 clamp、`selectPicker` 的焦点行取值改走可见列表
  （`pickerVisibleProviders` / `pickerVisibleModels`）；新增 `filterPicker`（换词 → 焦点行按**值**保持，
  原项被筛掉则回落 0 = 匹配度最高项；星号不动；effort 列无操作）。
- `src/app/model-transition.ts`：`resolvePickerSelection` 的焦点兜底改走 `pickerFocusedValues`。
- `src/app/index.ts`：picker 键路由 —— Esc 两段（本列有词先清空）、可打印字符 / Backspace 走
  `pickerFilterInput`（仅在可筛列生效，effort 列吞掉）；`reloadPickerEfforts` 的焦点值解析复用
  `pickerFocusedValues`（选中值判重也同源）。
- `src/app/components/ModelPicker.ts`：渲染改用可见列表（列宽 / 滚动 / 省略号 / 着色口径不变）。
- `src/app/layout.ts`：新增 `pickerFooterLines` —— 面板态输入区改显 `筛选 <焦点列>: <词>`（复用
  `renderTextInput`：空词 placeholder、caret 在词尾）；effort 列回落空白占位；`modalOpen` 分支按
  approval/question → picker → 空白 三级选型。`layout/hints.ts`：`PICKER_HINT_LINE` 补 `[输入]筛选`
  与 `[Esc]清空/取消`，并把 `[←/→/Tab]切列` 压成 `[Tab]切列`（整行显示宽 64 → 78，80 列终端不截断）。

## 测试与证据

- `tsc -p tsconfig.json --noEmit` → 通过；`npm run build` → 通过；`npm run demo -- --smoke` → 全项 SMOKE_PASS / SMOKE_OK。
- 全量 `sh scripts/test.sh` → **1514 / 1514 通过**（上一基线 1495；本任务新增 19 例：`picker-filter.test.ts` 15、
  `app.test.ts` 2、`modelpicker.test.ts` 1、`focus-frame.test.ts` 1）。
- 新增 `tests/picker-filter.test.ts`：分档顺序、同档 tie-break（起点 / 长度 / 原序）、大小写不敏感、
  空词原序、无命中空列表、返回新数组；逐键编辑（含 CJK 按 code point 删、Ctrl / 功能键 / 裸 DEL 交回）；
  reducer（两列独立、焦点按值保持、星号不动、同词幂等、effort 列无操作）；move / select / resolve 全部
  走可见列表（含「只一个可见行时 ↓ 不动」「select 取可见焦点行而非原列表同下标」）。
- `tests/app.test.ts`：App 级键路由 —— 键入筛掉不命中项且 provider 列不受影响、输入区显示 `筛选 model: <词>`、
  Backspace 删尾、Esc 两段（先清词后面板仍在 → 再按关面板）；另例覆盖「各列词独立保留 + effort 列键入被吞」。
- `tests/modelpicker.test.ts`：筛选后 `>` 焦点标记落在**可见列表**的焦点行（下标与可见序同源）。
- 冻结基线：`panel-picker@w60` 的输入区（20-22 行）与提示行（23 行）为**有意偏离**，`focus-frame.test.ts`
  加 `DEVIATED_ROWS` 唯一豁免口 + 专用「已偏离」用例（断言新行内容、断言基线侧确为旧行为、
  其余行仍逐行等价）；夹具 `fixtures/focus-frame-legacy.json` **未改**（无盲刷）。
- 真机探针（隔离 `DSH_HOME` + 真 tmux；配方见 `archived/2026-10-13-tmux-detach-and-hmr-theme-exit.md`）：
  `/model` 打开后输入区显示 `筛选 model: 输入以筛选 (匹配度排序)`、提示行显示新键位；键入 `flash` →
  输入区 `筛选 model: flash`，model 列只剩 `glm-5.3-flash` / `qwen3.8-flash-ne…` / `deepseek-flash` /
  `deepseek-flash-2` / `deepseek-v4-flash…`（段首前缀档内按匹配起点 → 名称长度排序），星号仍在
  `deepseek-flash`；`0x7f` 真退格两下 → `筛选 model: fla`；Esc 一次清词（列表回到全量）、两次关面板；
  全程 `pane_dead=0` / `cmd=node`（进程存活、会话保留）。

## 收尾

- BACKLOG：条目移除（其后条目顺延编号）；排序注记补记本次关闭。
- 追踪文档移入 `TUI/docs/archived/`。
- 文档回写：`TUI/docs/DESIGN.md`（`/model` 命令节：键位 + 「筛选与排序」+「筛选词落在用户输入区」两条机制、
  reducer action 清单）、`TUI/README.md`（命令表 `/model` 行 + 面板小节）。
- 遗留：① 键入筛选后 `Enter` 仍提交**星号**（不自动把焦点行设为星号）——按「决策 5」保持既有键位语义，
  代价是「筛完直接 Enter 不改模型，需先空格预选」；要改成自动预选是独立决策（会引入「有无筛选决定
  Enter 含意」的两种心智模型）。② 筛选词不支持粘贴（`paste` 事件在 picker 分支吞掉）与串内光标移动
  （←/→ 已用于切列），只支持追加 / 删尾。③ 子串命中不做高亮。

