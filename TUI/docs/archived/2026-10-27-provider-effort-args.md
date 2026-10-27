# `/model`、`/provider`、`/effort` 支持带参直接切换（含 `/model provider/model:effort`）（接取条目：TUI/docs/BACKLOG.md「/model、/provider、/effort 支持带参直接切换（含 /model provider/model:effort）」）

状态：关闭　　开启：2026-10-27　　关闭：2026-10-27

本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`/model <provider>/<model>:<effort>`（后缀可省）新增 `:effort` 语法；`/provider <name>`、`/effort <level>`（含别名 `/thinking`）带参时直接切换，形态对齐 `/model <spec>`；无参保持现有行为（打开 `/model` 面板并预置焦点列）。

## 调研

- `/model` 带参链路：`handleModelCommand`（`TUI/src/app/index.ts:4138`）→ `modelCommandSpec`（`src/app/commands.ts:442`）→ `resolveModelSpec`（`commands.ts:123`）→ `applyModelSelection`（`index.ts:4792`；`planModelSwitch` → `adapter.setSessionModel`），保留当前 `reasoningEffort`。
- 现有 spec 解析：`resolveModelSpec` 按第一个 `/` 切 provider / model，model 段原样使用；**没有** `:effort` 处理，故 `model:effort` 会被当成完整 model id。用户 2026-10-27 确认模型 id 本身不含冒号，后缀可按最后一个 `:` 无歧义拆分。
- `/provider`、`/effort`、`/thinking` 现走 `handleModelFocus`（`index.ts:4162`）：无参 `openModelPicker`（焦点列 0=provider、2=effort），带参只提示 `usage: /<name> (no argument; opens the picker)`；分派见 `index.ts:4020-4024`，别名见 `commands.ts:228-239`。
- 思考等级来源：`adapter.resolveModelInfo(provider, model)` 的 `ModelReasoning.efforts`（`{id, name}` 列表）与 `defaultEffort`（`src/app/adapter/types.ts:585-590`）；面板选中键为 effort id（`ModelPicker` 的 `matchAt`）。
- 相关测试：`tests/app.test.ts:1739` 现断言「带参提示 usage」；`tests/modelpicker.test.ts` 覆盖面板列与选中。

## 决策

用户 2026-10-27 裁定：三条命令都只改对应字段、其余保持现状；组合后不存在则警告且不操作；未命中不列可选值。

1. `/provider <name>`：选 a。保留当前 model 与 effort，先校验「目标 provider + 当前 model + 当前 effort」组合是否在目录内；存在则整套切换，不存在则警告、不改状态。示例：当前 `pA/m1:t1`，`/provider pB` 校验 `pB/m1:t1`。
2. `/effort <level>`：选 a（id 优先，其次显示名、不区分大小写）。按当前 provider/model 校验 `efforts` 是否含该等级；未命中警告、不改状态，不列可选档位。
3. 提示文案：只说「组合不存在，保持原设置」，notice 级别 warn；无等级模型（`efforts` 为空）同样警告并保持。
4. `/model` 语法：`<provider>/<model>:<effort>`，`provider/model` 可换成裸 model id；`provider` 与 `model` 按第一个 `/` 切，`effort` 按最后一个 `:` 切（模型 id 不含冒号，无歧义）；后缀省略 → 沿用当前 effort；后缀与组合校验同口径，未命中警告 + 不操作。

## 规划

- 任务拆分：① 决策定稿；② `resolveModelSpec` 增加 `:effort` 解析；③ 参数解析与校验 helper；④ `handleModelFocus` 改为带参直接切换、无参仍开面板；⑤ 文案与文档同步；⑥ 单测改写与新增。
- 计划改动文件清单：
  - `TUI/src/app/index.ts`（分派与 handler、`applyModelSelection` 的 effort 传递）
  - `TUI/src/app/commands.ts`（`resolveModelSpec` 的 `:effort` 解析、`LOCAL_COMMANDS` 描述、参数解析 helper）
  - `TUI/tests/app.test.ts`（改写 `:1739`，新增带参 / 后缀用例）
  - `TUI/docs/COMMANDS.md`（若命令表需同步）
  - `TUI/README.md`（若命令说明需同步）
- 明确不做：不改模型面板交互；`/provider` 单给时不做自动挑模型（已裁定：组合校验，不存在则警告 + 保持）。

## 实现记录

- `src/app/commands.ts`：新增 `parseModelSpecArg`（`[provider/]model[:effort]` 拆分）、`modelRouteError`（provider/model 组合校验）、`matchEffort`（id 优先、显示名次之）；`resolveModelSpec` 改为严格目录校验并返回 `reasoningEffort`；advisory 目录下设置到当前值按 already-on（不报未命中）。
- `src/app/index.ts`：`handleModelCommand` 支持 `:effort` 后缀（异步校验 efforts，未命中 warn + 不操作）；新增 `handleProviderSwitch` / `handleEffortSwitch`（只改对应字段，组合不存在警告 + 不操作）；`handleModelFocus` 无参仍打开面板；`LOCAL_COMMANDS` 与 `/help` 文案同步。
- 校验复用 `adapter.modelEfforts`；`matchEffort` 同时服务三条命令与启动参数。

## 偏差

无（与规划一致；提示统一为 warn、不列候选，符合 2026-10-27 裁定）。

## 测试与证据

- `npm run check` 退出 0；`npm test` 1821/1821 通过。
- 新增/改写用例：`/effort`、`/thinking` 带参；`/provider` 组合切换与未命中；`:effort` 后缀与非法后缀；显式 `provider/model` 未命中；`resolveModelSpec` 后缀拆分；advisory 目录 already-on。
- `npm run build` 成功，dist 已同步到 live profile（`~/.dsh/profiles/fff/node_modules/@dsh-toolset/tui`）；重启 dsh 后可真机验证。

## 收尾

- 追踪文档归档到 `TUI/docs/archived/2026-10-27-provider-effort-args.md`。
- BACKLOG 条目已从 `TUI/docs/BACKLOG.md` 移除；README 命令表已同步。
