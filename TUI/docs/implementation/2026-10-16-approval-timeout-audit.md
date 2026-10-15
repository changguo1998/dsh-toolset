# 审批面板超时时间核查（接取条目：TUI/docs/BACKLOG.md「检查审批面板的超时时间（应当设定为 1 min）」）

状态：规划　　开启：2026-10-16　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把「审批面板无操作超时 = 1 min」核成明确口径并落地：① 核查生效链（配置 → 插件 config → adapter → App 回落）；② 修正配置面漂移，使实际生效值就是 1 min；③ 把缺省口径写进 `SPEC.md` / `README.md` / 代码注释；④ 补单测锁定优先级链与两处缺省回落。

## 调研

（来源：本工作区代码与配置文件实读、profile 与主检出实查、既有测试清单）

### 1. 生效链（四级，逐点实读）

| 级别 | 位置 | 现值 / 口径 |
| --- | --- | --- |
| ① 配置文件（最高） | `TUI/tui.config.json:3`（**受版本控制**） | `approval.timeoutMs: 30000` |
| ② 宿主插件 config | `TUI/src/main.ts:181-182` 声明；`main.ts:661-664` 读取 | profile `fff` 的 tui 段（`~/.dsh/profiles/fff/cordis.patch.yml:7-10`）只设 `theme: dark`，**未设该值 → 本档为空** |
| ③ 代码缺省 | `TUI/src/main.ts:664` | `60_000` |
| ④ adapter / App 缺省 | `TUI/src/app/adapter/dsh.ts:2925`、`:3123-3126`；`TUI/src/app/index.ts:72-73`、`:2952-2957` | `60_000`（`APPROVAL_TIMEOUT_FALLBACK_MS`） |

`main.ts:661-664` 的实际表达式：`loadTuiConfig().approval?.timeoutMs ?? config?.approvalTimeoutMs ?? 60_000`，结果作为 `opts.approvalTimeoutMs` 传给 adapter。

**结论**：代码缺省链各点均为 `60_000`（1 min），但**当前实际生效值 = 30 s**，漂移点在①（配置文件覆盖）。这正是条目「期望 ②」要处理的情形。

### 2. 真机生效面

`ls -l ~/.dsh/profiles/fff/node_modules/@dsh-toolset/tui` → symlink 指向**主检出** `/home/guochang/Projects/dsh-toolset/TUI`（非本 worktree）。主检出 `TUI/tui.config.json` 同为 `30000` 且工作区干净（`git status --short` 无输出）→ **真机当前生效值同为 30 s**；本 worktree 的改动须经合并才作用于真机，验收阶段据此说明。

### 3. 倒计时与裁定同源（条目「期望 ③」）

- 裁定定时器：`dsh.ts:2923-2926`，`setTimeout(..., opts.approvalTimeoutMs ?? 60_000)`，到点 `settle(id, "rejected", "timeout")`。
- 倒计时基准：`index.ts:1763` `deadline: Date.now() + this.approvalTimeoutMs()`；`index.ts:2952-2957` 优先取 `adapter.approvalTimeoutMs()`（`dsh.ts:3123-3126` 返回同一个 `opts` 值），无该能力时才回落常量。
- 已有断言：`TUI/tests/app.test.ts:672`「审批倒计时取 adapter 实际超时值（同源）」→ 无漂移。

### 4. 陈旧 / 矛盾陈述（本次对齐）

| 位置 | 现状 | 应改为 |
| --- | --- | --- |
| `TUI/docs/SPEC.md:459` | 尾部「> 缺省 **30000**」 | 缺省 **60000**（1 min） |
| `TUI/README.md:251` | 同句既写「默认 **60000**」又写「> 默认 30000」 | 统一 60000（1 min） |
| `TUI/tests/config.test.ts:267` | 注释「（由 main 回落缺省 30s）」 | 缺省 60_000（1 min） |
| `TUI/src/app/adapter/types.ts:1672` | 注释「缺省 60s」 | 措辞统一「缺省 60_000 ms（1 min）」 |
| `TUI/src/main.ts:181`、`:659` | 注释「默认 60s」/「缺省 60s」 | 同上 |
| `TUI/src/app/config.ts:89` | 未写缺省值与优先级 | 补「缺省 1 min，优先级见 main.ts」 |

### 5. 既有测试覆盖与缺口

已有：`adapter.dsh.test.ts:831`（按键后停止超时）、`:901`（超时 → `rejected`）、`app.test.ts:653`（按键后隐藏倒计时）、`:672`（倒计时同源）、`config.test.ts:240`（配置段解析 6 例）、`approval-panel.test.ts:104` / `:334`（倒计时显示与每秒重绘）。

缺口：① adapter 在 `opts` 未给值时的缺省返回值无断言；② App 在 adapter 无 `approvalTimeoutMs()` 能力时的回落常量无断言；③ `main.ts:661-664` 的三档优先级链无断言（该表达式内联在 `apply()` 的配置装配里，无纯函数入口）。

### 6. 术语边界

本条的「审批超时」只指 `approval.timeoutMs`（无操作超时）。同名不同物、本次不动：`local-shell.ts:80` 的 shell 30 s 超时（`SHELL_TIMEOUT_MS`）、`index.ts:79` 的 `WIDTH_PROBE_TIMEOUT_MS`、`EXIT_CLEANUP_MS`。

## 决策

（决策项 = 数字、选项 = abcd，选定项写明字母；2026-10-16 用户在接取裁定中确认）

1. **可配性**：(a) 保留可配，1 min 仅作缺省；(b) 保留可配但下限提到 60 s；(c) 固定 1 min、降权为常量。
   **选定 (a)**（用户裁定）：配置面已存在且有文档与用例，本次只对齐缺省口径，改动面最小。
2. **3.3.5 两条超时语义**（面板内按过任意键后不再超时；超时裁定默认拒绝）：(a) 两条都保留；(b) 保留默认拒绝、取消「按键后不再超时」；(c) 两条都改（先讨论）。
   **选定 (a)**（用户裁定）：现状即此，`SPEC.md:459` 已成文，adapter 与 app 两侧各有断言。
3. **生效值自检**：(a) 不加启动 notice，改用单测锁定优先级链；(b) 加启动 notice 打出实际值；(c) 两者都加；(d) 都不加、只改文档。
   **选定 (a)**（用户裁定）：启动提示会成噪声，真正的缺口是优先级链无回归保护。
4. **漂移处理**（`tui.config.json` 的 `30000`）：(a) 改为 `60000` 对齐 1 min；(b) 删除该配置项、走代码缺省；(c) 保持 `30000`、只改文档口径。
   **选定 (a)**（用户裁定）：与「应当 1 min」一致，同时保留配置项作为可调旋钮的示例。
5. **优先级链的可测化路径**（本任务自主决策，随复述提交用户确认）：(a) 抽纯函数 `resolveApprovalTimeoutMs(配置文件值, 插件 config 值)` 并导出，配单测；(b) 不抽函数，只在追踪文档记录 dump 结论；(c) 端到端驱动 `apply()` 断言。
   **选定 (a)**：决策 3 要求单测锁定，而现有表达式内联在 `apply()` 里无入口；`tests/main.config.test.ts` 已有从 `main.ts` 导入纯函数（`normalizeTuiDisplayConfig` / `parseTuiStartupArgs` / `waitForHostService`）的先例，抽同级纯函数是最小改动。

### 确认后的口径（本次要写进文档的一句话）

> 审批面板无操作超时缺省 = **60_000 ms（1 min）**；优先级 `tui.config.json` 的 `approval.timeoutMs`（≥ 1000）> 宿主插件 config 的 `approvalTimeoutMs` > `60_000`；倒计时与宿主侧裁定同源（同一 `opts` 值）。

## 规划

### 任务拆分

1. 配置面对齐：`tui.config.json` 的 `30000` → `60000`。
2. 代码注释口径：`config.ts:89`、`main.ts:181` / `:659`、`adapter/types.ts:1672`、`index.ts:72`。
3. 优先级链可测化：`main.ts` 抽 `resolveApprovalTimeoutMs` 纯函数并在配置装配处改用。
4. 单测补齐：优先级链 3 例、adapter 缺省值、App 回落常量、陈旧注释。
5. 文档回写：`SPEC.md:459`、`README.md:251`。
6. 验证：`npm run check` + `npm run test:tui`（相关用例）+ `npm run build`；配置 dump 作为「生效值核查」证据。
7. 关闭：BACKLOG 条目标完成并移除、排序注记追加、追踪文档移入 `TUI/docs/archived/`。

### 计划改动文件清单

代码（4）：

- `TUI/src/main.ts` —— 抽并导出 `resolveApprovalTimeoutMs`，配置装配处改用，注释口径改 1 min。
- `TUI/src/app/config.ts:89` —— 注释补缺省 1 min 与优先级。
- `TUI/src/app/adapter/types.ts:1672` —— 注释口径统一。
- `TUI/src/app/index.ts:72` —— 回落常量注释口径（补「= 1 min」）。

配置（1）：

- `TUI/tui.config.json` —— `approval.timeoutMs` 由 `30000` 改 `60000`。

测试（4）：

- `TUI/tests/main.config.test.ts` —— 新增优先级链 3 例（配置值优先 / 插件 config 次之 / 双双缺失回落 60_000）。
- `TUI/tests/app.test.ts` —— 新增「adapter 无 `approvalTimeoutMs()` 能力时倒计时 = 60 s」。
- `TUI/tests/adapter.dsh.test.ts` —— 新增「`opts` 未给值时 `approvalTimeoutMs()` 返回 60_000」。
- `TUI/tests/config.test.ts:267` —— 陈旧注释改为 1 min 口径。

文档（2）：

- `TUI/docs/SPEC.md:459` —— 缺省改 `60000`（1 min）并保留可配口径。
- `TUI/README.md:251` —— 消除同句 60000 / 30000 矛盾，统一 1 min。

流程文档（2）：

- `TUI/docs/BACKLOG.md` —— 条目标〔进行中: 2026-10-16〕（已完成）→〔完成〕并移除、排序注记追加。
- `TUI/docs/implementation/2026-10-16-approval-timeout-audit.md` —— 本追踪文档（关闭时移入 `TUI/docs/archived/`）。

### 明确不做

- 不动 `adapter/dsh.ts:2925` / `:3123-3126` 的 `?? 60_000`（已是 1 min）。
- 不加启动 notice、不在 `/help` 或其他命令面暴露生效值（决策 3a）。
- 不改 `stopApprovalTimeout` 与「超时裁定默认拒绝」语义（决策 2a）。
- 不删除 `approval.timeoutMs` 配置面、不改 `config.ts` 的 `≥ 1000` 下限（决策 1a）。
- 不改 profile `fff` 的 `cordis.patch.yml`（第二档本就为空，属真机侧配置）。
- 不改 `local-shell.ts` 的 30 s shell 超时与其余同名超时（术语边界，见调研 6）。
- 不改 `STATUS.md`（用户择时更新）；不做顺手的格式化或重命名。

## 实现记录

（待实现）

## 偏差

（待补）

## 测试与证据

（待补）

## 收尾

（待补）
