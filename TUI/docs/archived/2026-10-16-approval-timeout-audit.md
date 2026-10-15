# 审批面板超时时间核查（接取条目：TUI/docs/BACKLOG.md「检查审批面板的超时时间（应当设定为 1 min）」）

状态：关闭　　开启：2026-10-16　　关闭：2026-10-16
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

（时间倒序无关，按计划的任务拆分顺序记录；命令输出见「测试与证据」）

1. **配置面对齐**（2026-10-16）：`TUI/tui.config.json` 的 `approval.timeoutMs` 由 `30000` 改 `60000`；单一行的 diff，未触发整体重排。
2. **取用链可测化**（2026-10-16）：`src/main.ts` 新增并导出 `APPROVAL_TIMEOUT_DEFAULT_MS = 60_000` 与纯函数 `resolveApprovalTimeoutMs(configFileMs, pluginConfigMs)`（语义 `configFileMs ?? pluginConfigMs ?? 60_000`）；`apply()` 里原先内联的三元链改为调用该函数，注释口径改「> 缺省 1 min」。位置在 `parseTuiStartupArgs` 之后、`readCmdlineArgs` 之前，与既有导出纯函数同级。
3. **注释口径统一**（2026-10-16，只改注释、无行为变更）：`src/main.ts:181`「默认 60s」→「默认 1 min」；`src/app/config.ts:89` 补「缺省 1 min（取用链见 main.ts 的 `resolveApprovalTimeoutMs`：本文件 > 宿主插件 config > `60_000`）」；`src/app/adapter/types.ts:1672`「缺省 60s」→「缺省 60_000 ms（1 min）」；`src/app/index.ts:72` 回落常量注释补「= 1 min」。
4. **单测补齐**（2026-10-16，3 例新增 + 1 处注释修正）：`tests/main.config.test.ts` 新增「审批超时取用链」1 例 4 断言（配置文件值优先 / 配置文件缺失取插件 config / 两级缺失落 `APPROVAL_TIMEOUT_DEFAULT_MS` / 缺省常量 = 60_000）；`tests/app.test.ts` 新增「审批倒计时回落」（实例属性遮蔽 fake adapter 的 `approvalTimeoutMs` → 倒计时显示 `(60s)`）；`tests/adapter.dsh.test.ts` 新增「审批超时缺省 = 60_000」（直接以 `createRealDshAdapter` 构造、不给 `approvalTimeoutMs`）；`tests/config.test.ts:264` 陈旧注释「由 main 回落缺省 30s」改 1 min 口径。
5. **文档回写**（2026-10-16）：`docs/SPEC.md:459` 缺省 `30000` → `60000`（1 min，并注明取用链与仓库自带 config 亦为 60000）；`README.md:251` 消除同句「默认 60000 / 默认 30000」矛盾，统一为「默认 60000（1 min，取用链 `src/main.ts` 的 `resolveApprovalTimeoutMs`）」。
6. **验证**（2026-10-16）：`format` 全部 11 个改动文件 → TUI `npm run check` exit 0 → TUI `npm run build` exit 0 → TUI `npm test` 1609 例全过（原 1606 + 新增 3）→ 配置 dump 与根级 `npm run check`（22 包）见「测试与证据」。

## 偏差

- **真机核对未做（可选项）**：条目验收 ② 允许「真机 / 配置 dump」二选一，本次以配置 dump 取证（见「测试与证据」）；真机目视（合并后审批面板倒计时从 `(60s)` 起）未执行 —— profile `fff` 的 symlink 指向主检出 `~/Projects/dsh-toolset/TUI`，本 worktree 的 config 改动未合并前不影响真机（时点 2026-10-16）。
- **同文件内的注释一并统一**：`src/main.ts:181`（配置项注释）与装配处注释两处「60s」一并改「1 min」，仍在计划清单的同一文件内，未新增文件。
- 其余与计划一致：13 个文件全部改到，无计划外文件；决策 1 至 4 按用户裁定执行，决策 5（抽纯函数）按复述内容执行。

## 测试与证据

（本工作区 `/home/guochang/Projects/dsh-toolset/.worktree/tui`，2026-10-16）

### 机械验证

| 命令 | 结果 |
| --- | --- |
| `format`（11 个改动文件） | exit 0；TS / MD / JSON 各按扩展名走对应格式化器，diff 无整体重排 |
| `npm run check`（TUI） | exit 0（无错误输出） |
| `npm run check`（仓库根，22 包） | exit 0（每包 `tsc --noEmit`，见 job 输出） |
| `npm run build`（TUI） | exit 0，产物写入 `TUI/dist/` |
| `npm test`（TUI） | **1609 例全过 / fail 0**（改动前 1606，本次新增 3 例） |
| 新增 3 例定向运行 | 均 `✔`：`审批超时取用链…`（0.5ms）、`审批超时缺省 = 60_000…`（2.7ms）、`审批倒计时回落…`（18.5ms） |
| `npm run demo -- --smoke`（mock demo 帧断言） | exit 0：42 个 `SMOKE_PASS` / 0 个 `SMOKE_FAIL`，末行 `SMOKE_OK sent=[…] interrupts=1`（人工确认材料；临时输出文件已删） |

### 生效值核查（验收 ②：配置 dump）

命令（cwd = `TUI/`）：

```sh
node --experimental-transform-types --input-type=module -e '
import { loadTuiConfig } from "./src/app/config.ts";
import { resolveApprovalTimeoutMs, APPROVAL_TIMEOUT_DEFAULT_MS } from "./src/main.ts";
const cfg = loadTuiConfig();
console.log("配置 dump: approval.timeoutMs =", cfg.approval?.timeoutMs);
console.log("生效链结果 (配置 > 插件config > 缺省) =", resolveApprovalTimeoutMs(cfg.approval?.timeoutMs, undefined));
console.log("缺省常量 APPROVAL_TIMEOUT_DEFAULT_MS =", APPROVAL_TIMEOUT_DEFAULT_MS);
'
```

输出：

```
配置 dump: approval.timeoutMs = 60000
生效链结果 (配置 > 插件config > 缺省) = 60000
缺省常量 APPROVAL_TIMEOUT_DEFAULT_MS = 60000
```

结论：1. 仓库自带 `tui.config.json` → `60000`（改动前 `30000`）；2. 宿主插件 config 档为空（profile `fff` 的 tui 段只设 `theme`，未设 `approvalTimeoutMs`）；3. 两级都缺失时的代码缺省 = `60000`。三级一致 = **1 min**。

### 缺省路径 grep（验收 ①）

```
TUI/src/main.ts:377:export const APPROVAL_TIMEOUT_DEFAULT_MS = 60_000;
TUI/src/app/index.ts:73:const APPROVAL_TIMEOUT_FALLBACK_MS = 60_000;
TUI/src/app/adapter/dsh.ts:2925:      opts.approvalTimeoutMs ?? 60_000,
TUI/src/app/adapter/dsh.ts:3125:      return opts.approvalTimeoutMs ?? 60_000;
```

审批范围内已无 30 s 的缺省陈述（残留的 `30_000` / `30s` 命中都在别处：`local-shell.ts` 的 shell 超时、`README.md:171` 的 `$` 模式说明、以及测试里作为「覆盖值 / 解析输入 / 显示注入值」的用例数据，均非缺省口径）。

### 同源（验收 ③）

`app.test.ts` 两条断言并存：既有「取 adapter 值 30 s → 显示 `(30s)`」，本次新增「无该能力 → 显示 `(60s)`」；adapter 侧裁定定时器与 `approvalTimeoutMs()` 共用同一 `opts`（`dsh.ts:2925` 与 `:3123-3126`），无第二真源。

### 真机核对（未做，可选）

合并后重启 `dsh --profile fff`，审批面板倒计时应从 `(60s)` 起；本 worktree 未合并前不影响真机（见「偏差」）。

## 收尾

- **回写文档**：`TUI/docs/SPEC.md:459`（缺省 60000 / 1 min + 取用链）、`TUI/README.md:251`（消除「默认 60000」与「默认 30000」同句矛盾，统一 1 min）；`DESIGN.md` 与 `ROADMAP.md` 不涉（无架构或方向变化）；`STATUS.md` 按流程不改（用户择时更新）。
- **BACKLOG**：所接取条目「检查审批面板的超时时间（应当设定为 1 min）」标完成并从 `TUI/docs/BACKLOG.md` **移除**（清单只留未完成项），「排序注记」追加本次接取与关闭记录；剩余编号 `#3` 至 `#7` 未重排，留待下次整理。
- **归档**：本追踪文档由 `TUI/docs/implementation/` 移入 `TUI/docs/archived/`（路径 `TUI/docs/archived/2026-10-16-approval-timeout-audit.md`）；`implementation/` 目录随之为空并删除。
- **遗留项**：无新增 BACKLOG 条目；真机目视（合并后倒计时从 `(60s)` 起）为可选项，按本任务范围未做（见「偏差」）。
- **临时文件**：`tmp/smoke.out`（冒烟输出）已在验证后删除，无其它残留。
- **提交**：接取文档 `c406652`（BACKLOG 进行中 + 追踪文档）、实现与测试 `353a425`（12 文件 +152 / −17）、收尾提交见 git 历史（BACKLOG 关闭清理 + 归档移动）。
