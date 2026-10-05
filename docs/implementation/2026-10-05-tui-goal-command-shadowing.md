# TUI `/goal` 与官方命令双注册（接取条目：`docs/BACKLOG.md`「TUI `/goal` 与官方命令双注册」）

状态：决策　　开启：2026-10-05　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把「TUI 本地 `/goal` 覆盖宿主同名命令」这件事从**隐式行为**变成**显式契约**，并确认宿主命令缺失 / 改名时的降级路径可见。

## 调研

来源：本仓源码实测（`grep` + 逐文件阅读）与官方包 lib 阅读，无真机运行。

### 覆盖机制

`routeSlashCommand`（`TUI/src/app/commands.ts:349-350`）实现为：

```ts
export function routeSlashCommand(name: string): SlashRoute {
  return LOCAL_ROUTES.get(name) ?? "registry";
}
```

`LOCAL_ROUTES` 由 `LOCAL_COMMANDS` 在模块加载时构建（`commands.ts:344-347`）。因此**本地表命中即走本地分支，宿主注册表里是否有同名命令不被查询** —— 覆盖是隐式的，代码里没有任何声明。

### `/goal` 的两个分支

`TUI/src/app/index.ts:2781-2789`：

- **无参**（`line.slice("/goal".length).trim() === ""`）→ 发 notice「goal/todo 详情见左侧信息栏」，直接 return —— **完全不走宿主**；
- **带参** → `this.deps.adapter.runCommand(line)`，整行原样转交宿主。

### 官方侧

`dsh-command-goal` 注册名确为 `goal`（lib 中 `name: "goal"`），package 描述「Human-facing slash command for persisted same-session goals」，内含 `clear` / `resume` 子命令。

### 缺失命令的降级路径（关键结论）

转发链路：`runCommand`（`TUI/src/app/adapter/dsh.ts:2574`）→ `dispatchCommand`（`:3795`）→ `commands.execute(...)`（`:3820`）→ `finish`（`:3846`）。

`finish` 在 `exec === undefined` 时：

```ts
emit({ type: "notice", text: "未知命令，输入 /help 查看可用命令。", error: true, tone: "error" });
```

即**宿主命令缺失时已有可见降级**（error notice + 失败色），另有 `commands` 服务未就绪的前置告警（`dsh.ts:3806-3814`）。条目验收里的「不可静默失配」**当前已经成立**。

### 已有测试

- `TUI/tests/app.test.ts:3867` —— `/goal` 无参只提示、不开面板；
- `TUI/tests/app.test.ts:3879` —— `/goal <objective>` 带参转交宿主，断言转发内容为 `["/goal 打磨状态列"]`。

### 残余风险

1. **语义分叉**：宿主 `/goal` 无参时的行为被 TUI 遮蔽（宿主可能也展示状态），两处文案会随各自演进而分叉；
1. **无契约记录**：本地覆盖宿主同名命令这件事没有写进注释、README 或 DESIGN，下一个人改命令表时不会知道存在这个约束；
1. **改名/改参不可测**：官方若把 `goal` 改名或改参数形态，TUI 转发会落到「未知命令」（可见），但**没有测试**守住这个边界。

## 决策

2026-10-05 用户裁定：**保留官方插件（A = `@deepseek-ai/dsh-command-goal`），删除 TUI 本地的覆盖定义**。

选项对照：

1. 原规划——保留本地无参分支，只补注释 / 转发断言 / 降级测试 / 文档口径：双注册仍在，只是把隐式变显式；
1. 无参也转发宿主但保留本地条目：本地条目退化成纯转交空壳，等于同一件事两处实现，未采纳；
1. **（选定）** 删除 `LOCAL_COMMANDS` 的 `goal` 条目与 `case "goal"` 分支，`goal` 回到 `registry` 路由、由官方独占。

理由：验收要求的「可见降级」当前已由注册表 fail-close 满足（`dsh.ts:3856` 未知命令 notice + 失败色），无需新增；本地条目的**唯一自有行为**是无参提示，而该信息已由左侧状态列常驻展示——保留它换来一句与官方重复的提示加一条永久契约债。删除后**行为面变化仅一处**：无参 `/goal` 从「一行 notice」变为官方多行状态块（Status / Objective / Rounds / Activation / Commands）；带参路径本就转发，行为不变。

插件关系（临时指代）：A 官方 slash 命令（保留）／B TUI（本次唯一改动方）／C `dsh-goal` 域服务／D `goal-round-driver`／E `tool-goal` 模型工具／F `goal-contract`／G `knowledge-base`。C / D / E / F / G 与命令面无耦合，本次不动。

**2026-10-06 用户细化（方案甲，覆盖上面选项 2 的判定）**：本地条目**保留**，但降级为「只为帮助与补全面板提供中文描述」——`route` 改 `"registry"`、`desc` 改为现在行为的描述，`case "goal"` 分支与 `SlashRoute` 的 `"goal"` 成员照删。即：不再有任何本地**行为**，但保留本地**描述行**（`/help` 与 `/` 补全面板仍显示中文；用户：帮助内容修改，其他内容不变，测试相应更新）。选项 2 原先被否的理由是「纯转交空壳」——按甲，该条目不再承担路由职责（路由即通用 registry 分支），只承担文案，故不构成双重实现。

## 规划

**计划改动文件清单（未列出的文件一律不改）**

代码（全在 TUI 包内，3 个文件）：

- `TUI/src/app/commands.ts` —— 删 `SlashRoute` 联合成员 `"goal"`（`:182`）；`LOCAL_COMMANDS` 的 `goal` 条目**保留**，`route` 改 `"registry"`、`desc` 改为现在行为的描述（方案甲）
- `TUI/src/app/index.ts` —— 删 `case "goal"` 分支（`:2781-2789`）；改 `/help` 硬编码文案（`:4185-4187`）
- `TUI/tests/app.test.ts` —— 改两条用例：无参 `/goal` 改为「转发宿主、不再本地拦截」（原 `:3867-3877`）；带参用例去掉「无参仍本地提示」尾断言（原 `:3879-3890`）

**计划外补入（2026-10-06，全量测试暴露，用户批准）**：

- `TUI/tests/fixtures/focus-frame-legacy.json` —— 冻结帧基线：`panel-completion@w60` 场景的补全候选里原本是旧 desc（`无参看状态列；带参转发宿主`），方案甲后该行描述文本变化。由 `scripts/freeze-focus-frame.mts` 再生成，实测**仅该行 2 行文本（text + ansi）变化**，其余 14 个场景逐字节不变。
- `TUI/demo/main.ts` —— `goal-panel` smoke 场景（`:437-445`）断言旧本地提示「详情见左侧信息栏」；`/goal` 改走 registry 后该提示不再出现（demo 的 mock 宿主无该命令 → 可见降级「未知命令」）。改写为三条断言：旧提示消失 + 「未知命令」可见降级 + 状态列 objective「P2 阶段 B1+B2」仍在。

**途中发现的新问题（按 §4 追加条目，不在本任务内修）**：

- `npm run demo -- --smoke` 的 `activity-mixed-ordered` 场景**恒失败**（HEAD 基线即 `SMOKE_FAIL n=1`）：场景按 `\r\n` 切帧，而渲染器自 2026-10-05 起改为逐行绝对定位（提交 `647761d`）→ 子串全命中第 0 行。已登记为 `TUI/docs/BACKLOG.md` #1。

文档（关闭后回写，与代码同批提交）：

- `TUI/docs/COMMANDS.md`（`:23`）、`TUI/docs/COMMANDS-SPEC.md`（`:78`）、`TUI/docs/DESIGN.md`（`:354`）、`TUI/README.md`（`:275`、`:299`）—— 把「`/goal` 无参本地提示、带参转发宿主」改为「`/goal` 无本地**行为**：条目仅提供帮助 / 补全描述（`route: "registry"`），全形态交宿主 `dsh-command-goal`」
- 本追踪文档、`docs/BACKLOG.md`（关闭时清理条目）

**明确不做**

- 不改命令名、不改动官方包、不动 profile（**不**新增 `disabled: true` 行——那是另一条路线，已被选项 3 取代）
- 不动 `layout.ts` 里的 `"goal"`（左侧状态列块 id，同名不同物）
- 不删 TUI 的 goal 展示面（状态列 goal 块 / phase 符号 / `⟳` activation）
- 不改动无参 `/goal` 的官方文案（属 A）

## 实现记录

- 2026-10-05：接取条目并标记「进行中」；完成现状调研（见上），**无代码改动**。
- 2026-10-06：决策定稿（保留 A、删除 TUI 本地覆盖定义），文档提交 `02bffeb`。
- 2026-10-06：首版实现（删条目 + 删 case + 改 `/help` + 改两条用例），`check` / `build` / `app.test.ts` 167 例全绿；全量 `npm test` 暴露冻结帧基线失败（计划外文件）。
- 2026-10-06：用户细化落法为**方案甲**并批准两个计划外文件，据此完成终版实现：
  - `TUI/src/app/commands.ts`：`SlashRoute` 删 `"goal"` 成员；`LOCAL_COMMANDS` 的 `goal` 条目保留，`route: "registry"`、`desc: "交宿主 dsh-command-goal"`（宽度按补全面板实测截断上限取值，避免截断），原位留指路注释；
  - `TUI/src/app/index.ts`：删 `case "goal"`（`registry` 分支统一处理）；`/help` 的 `/goal` 描述改为「全形态交宿主 dsh-command-goal…」；
  - `TUI/tests/app.test.ts`：无参用例断言「转交宿主（`adapter.commands === ["/goal"]`）+ 旧本地提示消失」；带参用例去掉「无参仍本地提示」尾断言；
  - `TUI/tests/fixtures/focus-frame-legacy.json`：`scripts/freeze-focus-frame.mts` 再生成（仅该行 text+ansi 变化）；
  - `TUI/demo/main.ts`：`goal-panel` 场景改为「旧提示消失 + 「未知命令」可见降级 + 状态列 objective 仍在」；
  - `TUI/docs/BACKLOG.md`：#1 登记途中发现的既有 smoke 缺陷。

## 测试与证据

- `cd TUI && npm run check` → 通过（tsc strict）
- `cd TUI && npm run build` → 通过
- `cd TUI && npm test` → **1332 / 1332 通过**（含改写后的两条 `/goal` 用例、`focus-frame` 15 场景基线对照）
- `npm run demo -- --smoke` → `SMOKE_PASS goal-panel`；仅剩 `SMOKE_FAIL activity-mixed-ordered (idx=0,0,0,0,0,-1)`，**与 HEAD 基线一致**（基线 `SMOKE_FAIL n=1`，本条已登记为 `TUI/docs/BACKLOG.md` #1，非本任务引入）
- 夹具差异自查：`git diff --numstat` 显示该 JSON 仅 2 行变化（text + ansi），未跑 `format`（脚本与 `AGENTS.md` 明令禁止对生成夹具跑 jq 类格式化）
- 反向验证（人工确认点）：`/goal` 现在不再出现本地提示「详情见左侧信息栏」；补全面板该行描述已换为新文案；左侧状态列 goal objective 与 phase 符号不受影响

## 收尾

（待关闭时补）
