# 工具说明注册表与按需投递（接取条目：docs/BACKLOG.md「工具说明注册表与按需投递」）

状态：规划　　开启：2026-11-11
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

把「注册定义」与「模型侧呈现」分开: 注册处 `description` 只留短说明（用途一句 + 指向 `tool_consult`）、`parameters` 只留宽松占位; 完整说明与完整参数 schema 由包装层保存, 用于派发前校验与揭示后投递; 模型侧不静态携带完整说明与 schema, 由 `tool-consult` 按会话投递; tools 槽位与前缀缓存保持稳定。1109 审计指定的 7 项文案内容不变, 按本任务的新格式承载。

## 调研

- 完整说明已有唯一来源: 各工具注册处 `description` 即「用途 / 用法 / 顺序 / 效果 / 边界 / 相关」全文（例 `flow-track/src/tools.ts:87` 起）, 无第二份副本。
- 按需可见已在运行: `tool-consult` 缺省只留 9 个核心工具（`tool-consult/src/config.ts:61`）, 其余经 `tools.restrict({ allow })` 遮罩（`tool-consult/src/index.ts:250`）; 揭示把整份声明（含完整 `description` 与 `input_schema`）放回 tools 数组。
- 揭示会改 tools 数组: 槽位位于 messages 之前, 任何改动都让该次请求的前缀失效。
- 动态保持通道已在用: `summarizeRevealed`（`tool-consult/src/index.ts:478`）按已揭示集合只投 1 行首句（`oneLine`, `matcher.ts:105`）, 与揭示后工具面里的完整说明重复; 该通道本身可承载全文。
- 宿主约束（2026-11-11 只读复核 `@deepseek-ai/dsh-tools`）: 模型可见 schema 就是注册定义, `projectToolSchema` 取 `name` / `description` / `parameters` / `deferLoading`（`lib/index.js:366-375`）, `schemas(scope)` 逐条投影（`:590`）, 参数校验同样用这份 `parameters`（`:300-302` / `:322`）, 没有按会话切换模型侧 schema 的钩子。
- 可用绕法: `parameters` 注册成宽松对象, schema 子集支持 `additionalProperties` 取布尔（`lib/shared-DTdn5dXO.js:27` / `:220`）, 宿主导出 `validateJsonSchemaValue` / `validateArgs` / `ToolArgsError`（`lib/index.js:665`）, 包装层可自行严格校验。
- 结论: 「宿主用完整 `parameters` 校验」与「模型侧不出现静态 schema」在同一份注册定义上不可兼得, 必须取舍（见「决策」）; `deferLoading` 需路由 `toolUpdate`, 本机路由无此能力（`docs/archived/2026-11-09-tool-description-audit.md:121`）, 不走该路线。
- 工具总则 section（`tool-consult/tool-index`, order 4300）已登记未实现: 仓库内无对应代码, `tool-consult` 的 inject 只有 tools 与 agents（`tool-consult/src/index.ts:39`）, 归「各插件注入方式整理」任务。

## 决策

01. 注册方式: 仍用宿主 `ctx.tools.register`, 注册前由本仓包装层把每个工具定义包一层; 不替换宿主 `register`, 不另建注册面。`execute` / `output` 原样透传。
02. 注册定义: `description` 收为短说明（用途一句 + 指向 `tool_consult`）; `parameters` 换成宽松占位（`type: "object"`, `additionalProperties: true`）; 完整说明与完整 `parameters` 留在包装层。不采用同名桩或空参桩（揭示与撤桩会改 tools 数组, 空参让模型猜参数）。
03. 严格校验落在包装层: 派发前用 `validateJsonSchemaValue` 按完整 `parameters` 校验, 违规抛 `ToolArgsError`（与宿主同款错误形态）; 宿主对宽松占位的校验必然放行, 严格校验只此一处。取舍: 优先「模型侧按需 + 槽位稳定」, 接受宿主校验降级到包装层。
04. 模型侧呈现归 `tool-consult`: 槽位里只有短说明与宽松占位; 模型看到哪份说明与 schema 由揭示集合决定, 不静态携带。
05. 未揭示工具在 `tools/pre-execute` 拦截: 声明常驻、派发拒绝。宿主没有「声明常驻、派发拒绝」的原生档位（`core/tools/src/events.ts:18`; `docs/archived/2026-11-09-tool-description-audit.md:119`）。
06. 揭示 = 放开拦截名单 + 更新动态保持内容: 两件事在同一揭示动作内完成, 投递完整说明与 `input_schema`; tools 数组不动, 前缀缓存不破。
07. 投递通道: 沿用 `pinNotes.hold("revealed-tools")`（1110 T9 动态保持）, 内容由 1 行摘要改为完整说明 + `input_schema`; 按 key 比对, 内容不变不重投; 不常驻工具槽位。
08. 官方 `when` 工具除 `tool-web` 外显式禁用: 包装会丢 `when`, 条件无法复现。本机 `exit_plan_mode` 已随 plan-mode 禁用, `propose_action` 未挂载, 4 个 `team_task_*` 挂载但 Team 条件未开（`docs/archived/2026-11-09-tool-description-audit.md:148`）。
09. 说明格式迁移: 1109 审计按旧格式（全文写在注册处 `description`）完成 7 项审查并指定文案; 新格式（注册处只留短说明、全文随揭示投递）在本任务统一实施, 文案内容不改。
10. 包装层落在新轻量包 `tool-surface`: 导出 `wrapToolDefinition` 包装函数, 并提供 `toolSurface` 只读服务（`lookup(name)` / `list()`）; 各工具包在 `ctx.tools.register` 前调用包装函数, `tool-consult` 经服务取全文与完整 schema。不放进 `tool-consult`: 它可被禁用, 且各注册工具包会反向依赖它。
11. 校验落点: 严格校验在包装的 `execute` 入口做 - 调用 `validateJsonSchemaValue` 按完整 `parameters` 校验, 违规抛 `ToolArgsError`; `tools/pre-execute` 只承担未揭示拦截, 不做参数校验。
12. 校验器来源: `tool-surface` 直接依赖 `@deepseek-ai/dsh-tools`（对齐宿主 0.2.2-rc.1）, 引入 `validateJsonSchemaValue` / `ToolArgsError`, 错误形态与宿主一致。不采用仓内子集校验器或运行时动态 import（前者重复维护, 后者依赖 `process.argv[1]` 布局, 脆弱）。
13. 宽松占位形态: `{ type: "object", additionalProperties: true, properties: {} }`, 占位 `description` 给一句「完整参数 schema 经 tool_consult 查询」, 避免模型猜参数; 提示随注册定义投影, 槽位稳定。
14. 迁移策略: 先接 1-2 个工具包试点, 验证后再全量接入其余注册工具包; 各工具包短说明由包作者按决策 02 口径撰写; 过渡期 `tool-consult` 对未接入包装层的工具仍走旧揭示逻辑（整份定义放回）, 接入后经 `toolSurface` 服务投递。
15. 未揭示拒绝: `pre-execute` deny 文案「tool <name> 未在当前会话揭示, 请先经 tool_consult 查询后再调用」, 附自定错误码 `TOOL_NOT_REVEALED`（经 `error.info` 携带）, 与宿主的 `UNKNOWN_TOOL` 区分。
16. 包装函数签名: `wrapToolDefinition(def)` 返回同名注册定义; `description` / `parameters` 换位（决策 02 / 13）, `execute` 包装为「先按完整 `parameters` 校验, 违规抛 `ToolArgsError`, 再调原文」, `output` / `timeoutMs` / `deferLoading` 透传; 完整 `description` / `parameters` 深拷贝入 catalog。
17. `toolSurface` 服务面: catalog 以工具 `name` 为键; `lookup(name)` 返回 `{ name, description, parameters }` 或 undefined; `list()` 返回同形态数组; 只读无副作用。
18. 名单同步: 揭示集合（grants）是唯一状态源, `pre-execute` deny 名单与 pinNotes 投递内容都从它派生; 撤回即从集合移除; `pinNotes.hold("revealed-tools")` 内容由「已揭示集合 + 全文源」渲染, 集合不变不重投（决策 07）。
19. 揭示原子性: reveal / revoke 只改内存集合与派生名单, 无宿主外部调用点, 无中间态; grant 幂等; 顺序为「先更新集合, 再派生名单」。
20. 官方 `when` 工具禁用: 清单 = 决策 08 所列, 配置项 `disabledWhenTools` 放 tool-consult config, 建 matcher 时过滤; `tool-web` 保留。
21. 试点包: 选 flow-track（4 个工具, 含枚举复杂参数, 校验验证最充分）; pin-note 为备选。
22. `restrict` 退役节奏: 跟随全量接入 — 过渡期 `tool-consult` 双轨并存（未接入工具走旧 restrict 遮罩 + 揭示放回整份定义, 接入工具走新机制: 常驻 + deny + pinNotes 全文投递）; 全量接入完成后 `applyMask` 的 restrict 逻辑退役。
23. 初始核心集: 默认揭示清单 = 原有 9 个核心工具 + tool-web 的 `web_search` / `web_fetch`（共 11 个, 用户追加裁定 2026-11-11）; 进 grants 初始集, pre-execute 不拦, 不投全文。
24. 过渡期未接入工具: 维持旧揭示逻辑（揭示即放回整份定义）, 接受短暂 tools 数组改动与前缀失效, 该工具接入包装层后自动消失。
25. 投递格式: JSON 文本 — pinNotes 内容由「已揭示集合 + 全文源」渲染为「标题行 + 每条 `name:` + 紧凑 JSON（含 `description` 全文与 `input_schema`）」, 与宿主 input_schema 同构; 接入工具经 `toolSurface.lookup` 取全文, 过渡期未接入工具用 `tools.schemas()` 里的注册定义渲染。

## 规划

### 计划改动文件清单

| 文件 | 改动内容 | 对应决策 |
| --- | --- | --- |
| `tool-surface/package.json` | 新包; `dsh.bundle`; 依赖 `@deepseek-ai/dsh-tools` (0.2.2-rc.1) | 10 / 12 |
| `tool-surface/cordis.patch.yml` | 新包 bundle 契约 | 10 |
| `tool-surface/tsconfig.json` | 项目 tsconfig | 10 |
| `tool-surface/src/definition.ts` | `wrapToolDefinition` + catalog: 换短 / 换占位, 包装 execute 校验, 透传, 留存全文 | 2 / 11 / 13 / 16 |
| `tool-surface/src/index.ts` | 插件入口 + `toolSurface` 只读服务 (`lookup` / `list`) | 10 / 17 |
| `tool-surface/tests/` | 换位 / 透传 / 校验 / 服务面单测 | 2 / 11 / 17 |
| `tool-surface/README.md` | 模块契约 (中文) | 10 |
| `flow-track/src/index.ts` | 注册前套 `wrapToolDefinition` | 10 / 14 |
| `flow-track/src/tools.ts` | 显式短说明 + 保留完整全文 / 参数 | 2 / 9 / 14 |
| `flow-track/package.json` | 加 `tool-surface` workspace 依赖 | 10 |
| `tool-consult/src/config.ts` | `disabledWhenTools` 配置项; `DEFAULT_INITIAL_TOOLS` 追加 `web_search` / `web_fetch` | 20 / 23 |
| `tool-consult/src/index.ts` | deny 文案与 `TOOL_NOT_REVEALED` 码, JSON 投递, 双轨 `applyMask`, 初始核心集, 经 `toolSurface` 取全文 | 15 / 18 / 22-25 |
| `tool-consult/tests/` | 对应单测更新 | 15 / 22 / 25 |
| `scripts/test-parallel.sh` | `default_pkgs` 加 `tool-surface` | 接线 |
| `scripts/install.sh` | `canonical_pkgs` 加 `tool-surface` | 接线 |
| `AGENTS.md` | 包清单 38 → 39 包 | 接线 |
| 根 `README.md` / `README.zh.md` | 包计数与列表同步 | 接线 |

### 阶段计划（每阶段单独验证 + 单独提交）

**阶段 0 - 决策与规划入库**（含现有未提交文档）

- 内容: `docs/BACKLOG.md`（进行中条目）与追踪文档（决策 01-25 + 规划）。
- 验证: `check:docs`。
- 提交: `docs: 工具说明注册表与按需投递（决策与规划）`。

**阶段 1 - 新建 tool-surface 包**

- 内容: `package.json` / `cordis.patch.yml` / `tsconfig.json` / `src/definition.ts`（wrapToolDefinition + catalog）/ `src/index.ts`（toolSurface 只读服务）/ `tests/` / `README.md`。
- 验证: `pnpm run check` + `pnpm run build` + `pnpm run test`; `check:docs`。
- 提交: `feat(tool-surface): 工具包装层 + 严格校验 + 只读服务面`。

**阶段 2 - 仓库接线（38 → 39 包）**

- 内容: `scripts/test-parallel.sh` / `scripts/install.sh` / `AGENTS.md` / 根 `README.md` / `README.zh.md`（按 wiring 清单核对根 `package.json`）。
- 验证: `check:docs`; 脚本包清单与包目录双向核对。
- 提交: `chore: 接入 tool-surface（39 包）`。

**阶段 3 - 试点 flow-track 接入包装层**

- 内容: `src/tools.ts` 加显式短说明、`src/index.ts` 注册前套 `wrapToolDefinition`、`package.json` 加依赖。
- 验证: flow-track 现有单测 + `check` + `build`（本阶段只验静态层; 端到端行为随阶段 4 同批部署验证）。
- 提交: `feat(flow-track): 注册接入 tool-surface 包装`。

**阶段 4 - tool-consult 双轨改造**

- 内容: `config.ts`（`disabledWhenTools`, `DEFAULT_INITIAL_TOOLS` 加 `web_search` / `web_fetch`）; `index.ts`（deny 文案与 `TOOL_NOT_REVEALED`、JSON 投递、双轨 `applyMask`、初始核心集、经 `toolSurface` 取全文）; `tests/` 更新。
- 验证: tool-consult 单测 + `check` + `build`; `fff-test` 按「试点验收口径」人工验证。
- 提交: `feat(tool-consult): 按需投递双轨（deny + JSON 全文 + 初始核心集）`。

**阶段 5 - 全量迁移其余注册工具包**

- 内容: 试点通过后逐包接入（决策 14）; 短说明由各包作者按口径撰写。
- 验证: 每包 `check` + `test`; 全量后 `pnpm run build`。
- 提交: 每包 `feat(<pkg>): 接入 tool-surface 包装`。

**阶段 6 - 收尾**

- 内容: `restrict` 退役（决策 22）; 追踪文档补实测证据并移入 `docs/archived/`; BACKLOG 完成清理。
- 验证: 全量 `test` + `check:docs` + 真机回归。
- 提交: `refactor(tool-consult): restrict 退役` 与 `docs: 关闭条目`。

### 任务清单（机械可审计）

每条任务带一条审计命令; 命令从仓库根执行, 退出码 0 = 通过, 非 0 = 未完成。静态检查用 `grep` / `test` / `node -p`, 动态验证用包内 `pnpm run`。

**阶段 0 - 决策与规划入库**

- [x] T01 追踪文档状态为「规划」. 审计: `grep -q '状态：规划' docs/implementation/2026-11-11-tool-description-registry.md`
- [x] T02 决策 25 项齐全. 审计: `grep -q '^25\. 投递格式' docs/implementation/2026-11-11-tool-description-registry.md`
- [x] T03 文档检查 0 错. 审计: `pnpm run check:docs 2>&1 | grep -q '错误 0 / 警告 0'`

**阶段 1 - 新建 tool-surface 包**

- [x] T11 包名 `@dsh-toolset/tool-surface`. 审计: `node -p "require('./tool-surface/package.json').name" | grep -q '^@dsh-toolset/tool-surface$'`
- [x] T12 依赖 `@deepseek-ai/dsh-tools` 钉 0.2.2-rc.1. 审计: `node -p "require('./tool-surface/package.json').dependencies['@deepseek-ai/dsh-tools']" | grep -q '^0\.2\.2-rc\.1$'`
- [x] T13 `dsh.bundle` 契约指向 `cordis.patch.yml`. 审计: `node -p "require('./tool-surface/package.json').dsh.bundle.patch" | grep -q '^\./cordis\.patch\.yml$'`
- [x] T14 `cordis.patch.yml` 就位. 审计: `test -f tool-surface/cordis.patch.yml`
- [x] T15 `tsconfig.json` 就位. 审计: `test -f tool-surface/tsconfig.json`
- [x] T16 导出 `wrapToolDefinition`. 审计: `grep -q 'wrapToolDefinition' tool-surface/src/definition.ts && grep -q 'wrapToolDefinition' tool-surface/src/index.ts`
- [x] T17 入口含 `toolSurface` 服务面. 审计: `grep -q 'toolSurface' tool-surface/src/index.ts`
- [x] T18 测试文件就位. 审计: `test -f tool-surface/tests/definition.test.ts`
- [x] T19 单测通过. 审计: `pnpm -C tool-surface run test`
- [x] T1A 类型检查通过. 审计: `pnpm -C tool-surface run check`
- [x] T1B 构建产出 dist. 审计: `pnpm -C tool-surface run build && test -f tool-surface/dist/src/definition.js`

**阶段 2 - 仓库接线（38 → 39 包）**

- [x] T21 `scripts/test-parallel.sh` 含 tool-surface. 审计: `grep -q 'tool-surface' scripts/test-parallel.sh`
- [x] T22 `scripts/install.sh` 含 tool-surface. 审计: `grep -q 'tool-surface' scripts/install.sh`
- [x] T23 `AGENTS.md` 含 tool-surface. 审计: `grep -q 'tool-surface' AGENTS.md`
- [x] T24 双语根 README 含 tool-surface. 审计: `grep -q 'tool-surface' README.md && grep -q 'tool-surface' README.zh.md`
- [x] T25 文档检查仍 0 错. 审计: `pnpm run check:docs 2>&1 | grep -q '错误 0 / 警告 0'`

**阶段 3 - 试点 flow-track**

- [x] T31 声明对 `@dsh-toolset/tool-surface` 依赖. 审计: `node -p "require('./flow-track/package.json').dependencies?.['@dsh-toolset/tool-surface']" | grep -q '.'`
- [x] T32 注册前调用 `wrapToolDefinition`. 审计: `grep -q 'wrapToolDefinition' flow-track/src/index.ts`
- [x] T33 工具定义含指向 tool_consult 的短说明. 审计: `grep -q 'tool_consult' flow-track/src/tools.ts`
- [x] T34 包检查与构建通过. 审计: `pnpm -C flow-track run check && pnpm -C flow-track run build`

**阶段 4 - tool-consult 双轨**

- [ ] T41 config 含 `disabledWhenTools`. 审计: `grep -q 'disabledWhenTools' tool-consult/src/config.ts`
- [ ] T42 默认核心集含 `web_search` / `web_fetch`. 审计: `grep -q 'web_search' tool-consult/src/config.ts && grep -q 'web_fetch' tool-consult/src/config.ts`
- [ ] T43 含 `TOOL_NOT_REVEALED`. 审计: `grep -q 'TOOL_NOT_REVEALED' tool-consult/src/index.ts`
- [ ] T44 含 deny 文案. 审计: `grep -q '未在当前会话揭示' tool-consult/src/index.ts`
- [ ] T45 投递为 JSON（含 `input_schema`）. 审计: `grep -q 'input_schema' tool-consult/src/index.ts`
- [ ] T46 经 `toolSurface` 取全文. 审计: `grep -q 'toolSurface' tool-consult/src/index.ts`
- [ ] T47 单测 + 检查 + 构建通过. 审计: `pnpm -C tool-consult run test && pnpm -C tool-consult run check && pnpm -C tool-consult run build`

**阶段 5 - 全量迁移**

- [ ] T51 每个注册工具包已套包装. 审计: `for p in <全量清单, 试点后补>; do grep -q 'wrapToolDefinition' "$p/src/index.ts" || exit 1; done`
- [ ] T52 全仓检查与构建通过. 审计: `pnpm run check && pnpm run build`

**阶段 6 - 收尾**

- [ ] T61 restrict 已退役. 审计: `! grep -q '\.restrict(' tool-consult/src/index.ts`
- [ ] T62 追踪文档已归档. 审计: `test -f docs/archived/2026-11-11-tool-description-registry.md`
- [ ] T63 BACKLOG 条目已移除. 审计: `! grep -q '工具说明注册表与按需投递' docs/BACKLOG.md`
- [ ] T64 全量测试与文档闸门. 审计: `pnpm run test && pnpm run check:docs 2>&1 | grep -q '错误 0 / 警告 0'`

### 试点验收口径

- flow-track 4 工具的 `schemas()` 投影 = 短说明 + 宽松占位（含提示）; `toolSurface.lookup` 返回完整 description 与 parameters。
- 非法参数调用 → `ToolArgsError`（`INVALID_ARGS`）, TUI 工具区红色 ✗ 行。
- 未揭示调用 → deny「tool <name> 未在当前会话揭示…」+ `TOOL_NOT_REVEALED`; 揭示后放行且 pinNotes JSON 全文投递。
- tools 数组 / 前缀缓存不因揭示而变（仅过渡期未接入工具例外）。

### 明确不做

- 不改 1109 审计已完成的 7 项文案内容; 后续文案修订归新条目。
- 不新建 `TOOL_USAGE` 类跨包说明台账与 22 包说明依赖; 包装层收在新轻量包里, 各工具包只调包装函数, 不各自维护说明副本。
- 不改宿主 `system-prompt` / `agent-loop` / `tools` 源码（只读参考）; 三类注入通道的分类不变。
- 不重新采用同名桩、空参或撤桩重建声明。
- 不改 `execute` / `output` 行为。
- 不实现工具总则 section `tool-consult/tool-index`（归「各插件注入方式整理」）。

## 实现记录

- 2026-11-11: 只读调研并定案方向（见「决策」）; 未改代码, 未改工具说明。按用户要求先把「包装层落新包」写入决策, 新包尚未创建; 同日补齐决策 11-15（校验落点 / 校验器来源 / 占位提示 / 迁移策略 / 拒绝形态）、16-20（签名 / 服务面 / 名单同步 / 原子性 / when 配置）、21-24（试点 / restrict 退役 / 初始核心集 / 过渡期行为）与 25（投递格式）; 待设计清零, 转规划。用户追加裁定: tool-web 的 `web_search` / `web_fetch` 入默认揭示（决策 23 更新）。推进: 移除待设计节, 规划补分阶段执行计划（阶段 0-6, 每阶段单独验证与提交）与机械可审计任务清单（T01-T64）, 状态改规划。
- 2026-11-11（阶段 1）: 新建 `tool-surface` 包（39 包的第一块）：`wrapToolDefinition`（短说明 + 宽松占位 + catalog 深拷贝 + 派发前 `validateJsonSchemaValue` / `ToolArgsError` 严格校验 + `output` / `timeoutMs` / `deferLoading` 透传 + 重复包装幂等）、`toolSurface` 只读服务面（`lookup` / `list`，返回深拷贝）、`cordis.patch.yml` 与 `tsconfig.json`；依赖宿主 `@deepseek-ai/dsh-tools` 精确 `0.2.2-rc.1`（本仓首个宿主运行期依赖）。单测 13 例。
- 2026-11-11（阶段 2）: 仓库接线 38 → 39 包：`scripts/test-parallel.sh` 的 `default_pkgs` 与 `scripts/install.sh` 的 `canonical_pkgs` 均加 `tool-surface`（同位: `shell-parse` 之后）、`AGENTS.md`（插件总数 / 子包清单 / 结构与约定 / 轻量包豁免）、根 `README.md` 与 `README.zh.md`（总数 / 包表 / 目录树）；`dev/standard/index.mjs` 的 `count.packages` / `count.plugins` 断言从 38/37 改为 39/38。计划外但必需: 计数规则改后 `docs/ROADMAP.md` / `docs/WORKFLOW-STANDARD.md` / `md-logic/README.md` / `security-guard/README.md` 四处旧计数一并同步（否则 `check:docs` 报错）。发现 `scripts/test-install.sh` 第 11 步接线断言自 2026-11-08 起恒失败，已入 `docs/BACKLOG.md` 交其他 agent。
- 2026-11-11（阶段 3）: 试点 `flow-track` 接入包装层：5 个工具加 `summary`（用途一句 + 指向 `tool_consult`），`src/index.ts` 在 `ctx.tools.register` 前调 `wrapToolDefinition`，`package.json` 加 `link:../tool-surface` 依赖。两处 schema 与实现对齐：`flow_record` 的 `slug` 从 `required` 里去掉（`execute` 本来就允许缺省并回退到会话 id，旧 schema 比实现严，包装层会误拦），其余 4 个工具的 schema 未改；工具自带的参数守卫全部保留。单测 80 例（新增 1 例断言「模型侧=短说明+宽松占位、服务面=全文+完整 schema」）。实测发现：宿主 schema 子集不校验 `minimum` 这类数值边界，`flow_remove` 的 `id: 0` 仍由工具守卫拦下（`invalid_id`），包装层只兜住 type / required / additionalProperties / enum / oneOf / items。

## 偏差

- 阶段 2 超出「计划改动文件清单」 5 个文件: `dev/standard/index.mjs`（计数断言是 `check:docs` 的规则源, 不改则新计数必报错）与 `docs/ROADMAP.md` / `docs/WORKFLOW-STANDARD.md` / `md-logic/README.md` / `security-guard/README.md`（四处旧计数会被新规则判错）；另有 `docs/BACKLOG.md` 新增一条待办（进接线时发现的 `test-install.sh` 旧断言失效）。其余未越界。
- 阶段 3 改了 1 处工具 schema（`flow_record` 的 `required` 去 `slug`）：不改的话新旧行为不一致（`execute` 支持缺省 slug、`tests` 也这么用），包装层会把合法调用当违规拦下；`execute` / `output` 本身未改，属于「schema 与实现对表」，不是行为变更。

## 测试与证据

- 阶段 2 实测（2026-11-11，仓库根）: `pnpm run check` / `pnpm run build` / `pnpm run test` 均退出 0（39 包全部 OK, `tool-surface` 13 例在列）; `pnpm run check:docs` 报 120 篇现行 Markdown、错误 0 / 警告 0。
- 清单双向核对: `test-parallel.sh` 的 `default_pkgs` 与 `install.sh` 的 `canonical_pkgs` 字符串逐字相同（均含 `tool-surface`, 位置在 `shell-parse` 之后）, 39 项; 仓库目录与清单逐项对应（未跑 `test-install.sh` 全量, 只做了 static 核对与其第 11 步旧断言的失效判定）。
- 未验证: 包装后的行为尚未在 DSH profile 实机调用（阶段 3 / 4 部署后验证）。
- 阶段 3 实测（2026-11-11，`flow-track` 目录）: `pnpm run check` / `pnpm run build` / `pnpm test` 均退出 0（80 例全通过）；全仓 `pnpm run check` 在 39 包上通过。新增的包装断言实测：5 个工具的注册定义均为短说明 + `{ type: "object", additionalProperties: true, properties: {}, description: "完整参数 schema 经 tool_consult 查询" }`；`lookupSurface("flow_record")` 返回完整说明与 `required: ["stage", "status"]`。端到端（揭示、拒绝码、TUI 红行）尚未验证，随阶段 4 一起部署。

## 收尾

未关闭: 待规划、实现、测试。
