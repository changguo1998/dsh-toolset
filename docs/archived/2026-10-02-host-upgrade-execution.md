# 宿主升级到 0.2.0-rc.2 的执行与验证（接取条目：`docs/BACKLOG.md`「宿主升级到 0.2.0-rc.2 的执行与验证」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

按 `docs/host/HOST-UPGRADE-0.2.0-rc.2.md` 的对照结论，在本机执行宿主升级（0.1.7-rc.2 → 0.2.0-rc.2）并完成部署面同步与真机验证；验证通过后关闭条目。

## 决策

- **D1（目标版本）**：`0.2.0-rc.2`。2026-10-02 实测 npm dist-tags：`latest` = `next` = `0.2.0-rc.2`，`alpha` = `0.1.7-alpha.2`；0.2 线只发布过 `0.2.0-rc.1` / `0.2.0-rc.2`。查询用 `npm view --cache /tmp/<dir>`（沙箱内 `~/.npm` 只读）。
- **D2（备份与回滚）**：升级前把仓库外配置备份到 `~/.dsh-upgrade-backup-2026-10-02/`（`profiles/fff/package.json`、`profiles/fff/cordis.patch.yml`，`cp -L` 解引用软链）；回滚 = `npm i -g @deepseek-ai/dsh@0.1.7-rc.2` + 还原两个文件 + profile `pnpm install`。**不用 `npm update -g`**（会把 CLI 拉到 npm `latest` 之外的旧线）。
- **D3（树外加装包同步）**：profile 的 `@deepseek-ai/dsh-session-title-all-prompts-llm` 硬钉 `0.1.7-rc.2`，升级 CLI 不会自动跟随；按其所在 profile 目录 `npm pkg set` + `pnpm install`（这是它是 `ctx.sessionTitle` 唯一 provider 的前提）。
- **D4（验证分层）**：能自动化做的先做（版本 / 组合 dump / 启动激活 / 仓库自带 PTY 冒烟），需要重启会话才能验的（会话内工具行为）在重启后由本会话继续做——不把「已执行」当「已验证」。
- **D5（本条目范围）**：只做升级与验证；`HOST-PACKAGES.md` 的逐行挂载标记复核归条目 #2（步骤①），本条目只回写实测计数（包数 / 挂载数）。

## 计划改动文件清单

- `scripts/install.sh`（默认 dsh 版本 → `0.2.0-rc.2`）
- 版本引用同步（升级后发现的全仓陈旧引用）：`docs/BACKLOG.md` 基线行、`docs/host/HOST-PACKAGES.md` §5「升级方式」、根 `README.md` / `README.zh.md`（宿主复核声明 + 升级对照文档索引）、`TUI/docs/DESIGN.md` 接口基线行、`security-guard` / `goal-contract` / `knowledge-base` 三个 README 的 smoke 前置条件
- `docs/host/HOST-UPGRADE-0.2.0-rc.2.md`（版本事实 / 实施状态 / 未确认项回写）
- `docs/host/HOST-PACKAGES.md`（包数与挂载数按实测回写）
- `docs/BACKLOG.md`（本条目开工标「进行中」→ 关闭时清理）
- 本追踪文档（唯一过程记录）

审阅后追加（子代理审阅意见带入，属本条目同类清理）：

- `hash-edit/docs/BACKLOG.md`（新建：途中发现的 render 缺陷条目）
- 5 个包的 smoke 脚本宿主门槛：`security-guard` / `output-compress` / `goal-contract` / `knowledge-base` / `metric-loop` 的 `smoke/smoke.mjs`（`REQUIRED_VERSION` 与文件头注释）
- `metric-loop/README.md`、`knowledge-base/IMPLEMENTATION.md`（同上口径）
- `README.md` / `README.zh.md` / `TUI/docs/DESIGN.md`（错改回退与口径修正）

仓库外（已征得用户同意，见「执行记录」）：全局 npm 安装、`~/.dsh/profiles/fff` 与 `~/fff/config/dsh/profiles/fff`。

## 执行记录（2026-10-02）

1. **备份**：`~/.dsh-upgrade-backup-2026-10-02/{package.json,cordis.patch.yml}`（profile 配置文件；`settings.yaml` 早在 0.1.7 升级时已 `.imported`，本次无迁移面）。
1. **全局安装**：`npm i -g @deepseek-ai/dsh@0.2.0-rc.2 --cache /tmp/npm-cache-dsh` → `added 30 / removed 13 / changed 508`，48s，退出 0；`dsh --version` = `0.2.0-rc.2`。
1. **profile 依赖同步**：`~/fff/config/dsh/profiles/fff` 里 `npm pkg set 'dependencies.@deepseek-ai/dsh-session-title-all-prompts-llm=0.2.0-rc.2'` → `~/.dsh/profiles/fff` 里 `pnpm install`（`Packages: +1`，退出 0；peer 警告为「宿主包不在 profile 内」的既有预期提示）。
1. **组合与装配健康检查**：`dsh --profile fff --dump-config` 退出 0、stderr 空、850 行；`- id: otel`（`@deepseek-ai/dsh-otel`）在位，exporter 端点为 `dsh-otel-collector.deepseeksvc.com`（与 0.2.0 官方 base 一致）。
1. **实测计数**（供 `HOST-PACKAGES.md` 回写）：随包分发 288 包（`dsh-*` 277；0.1.7 时为 283 / 272）；`--dump-config` 名字项 93 = 计入 §1 的 92 + TUI 自插的 `tool-ask-user`；§2 行清单与安装树逐名对照：仅多 `otel` / `client-product-analytics` / `client-ui-settings-session-log` / `experimental-schedule-bundle` / `host-product-telemetry-otel`（后者由「源码有、不分发」转为分发），`session-title-all-prompts-llm` 仍为树外加装。
1. **启动激活检查**（PTY 真实启动一次 `dsh --profile fff`，30s 后超时终止）：日志中**无** `did not activate` / `startup failed` / `pending (waiting for services` / `ERR_MODULE_NOT_FOUND` / `cannot get property`；插件日志在位（`[metric-loop] 已注册 metric_loop 工具`、`[rule-engine] 已加载：规则 1 条`、`[session-channel] 已连接 unix:...`）；仅一条既有环境提示（`all_proxy names a SOCKS proxy`）。
1. **文档与脚本同步**：`scripts/install.sh` 默认版本 → `0.2.0-rc.2`（3 处）；`HOST-UPGRADE-0.2.0-rc.2.md` 回写版本事实（dist-tags 实测、随包分发 288/277）、实施状态、并删除已解决的未确认项；`HOST-PACKAGES.md` 回写包数 / 挂载数 / §1 列表（+`otel`）/ 新增行（`host-product-telemetry-otel`）。

## 验证

| 项 | 结果 | 证据 |
|---|---|---|
| 宿主版本 | 通过 | `dsh --version` = `0.2.0-rc.2` |
| 组合装配（含新 `otel` 行） | 通过 | `dsh --profile fff --dump-config` 退出 0、stderr 空、`- id: otel` 在位 |
| 插件激活（17 包 + 官方面） | 通过 | PTY 启动日志无 activation 失败；插件自报日志在位 |
| profile 树外加装包版本 | 通过 | `package.json` 里为 `0.2.0-rc.2`；`pnpm install` 退出 0 |
| 仓库自带真机 PTY 冒烟（`npm run smoke:pty`） | **未通过（环境凭据，非升级缺陷）** | 3 次尝试均在模型请求处失败：`MISSING_CREDENTIAL: llm-pi-ai ... route "ustc"`；该行 config 用 `apiKeyEnv: USTC_API_KEY`（`~/.dsh/profiles/fff/cordis.patch.yml:91`），而沙箱内 shell 里该变量 UNSET（`printenv` 实测），冒烟子进程拿不到凭据 → 无法发模型请求。**待用户在自己 shell 里跑一次或换用非沙箱环境复跑** |
| 重启后宿主确为 0.2.0 | 通过 | 本会话工具描述里 `bash` 已带 0.2.0 新增的「删除 / 移动前先核实解析后的绝对路径、`${VAR:?}` 防未设」文案（0.1.7 无此文案），即运行中的宿主确为 `0.2.0-rc.2` |
| `context_report`（投影面） | 通过 | summary 正常：会话 `tui-8a585495…`，66 回合 / 769 步，`sessionContext` 折叠读得 |
| `fs_digest`（结构面） | 通过 | `outline` 正常返回 `HOST-PACKAGES.md` 的 7 级标题树 |
| `code_map`（索引面） | 通过 | `index` 建 365 文件 / 6693 符号 / 1665 import，5.5s；`summary` 报 `ready: true` |
| `task_engine`（任务面） | 通过 | `task_status` 返回空树 `ok` |
| 其余插件运行痕迹 | 通过 | `~/.dsh/knowledge-base/knowledge.db-wal` 当前时刻仍在写；`~/.dsh/rule-engine/rules.json` 在位；`~/.dsh/session-channel/data` 在写；`metric_loop` / `rule_*` / `channel_*` / `goal_contract_draft` 等模型侧工具均在工具清单内 |
| `schedule_*` 在本组合仍不存在 | 通过 | 工具清单里无 `schedule_create` / `_delete` / `_list` / `_update`，与对照结论一致 |

## 途中发现（升级后发现的全仓陈旧引用，2026-10-02）

- **已改**（上节「计划改动文件清单」）：BACKLOG 基线行、`HOST-PACKAGES.md` §5、根 README 双语、`TUI/docs/DESIGN.md`、三个包 README 的 smoke 前置条件（`0.1.7-rc.2` → `0.2.0-rc.2`）。
- **新缺陷（已登记，非升级引入）**：`hash_read` / `hash_edit` 的结果到不了模型——`hash-edit/src/main.ts:86` 的 `render` 写在第一个形参上（`render: (value)`），而宿主契约是 `render(args, value)`（本仓其余 12 处 render 均为 `(_args, value)`），于是模型每次只能读到**入参回显**（实测 `hash_read(path="tmp/hashread-probe.txt")` 返回 `{"path": …}`，对同文件直调后端却正常返回 `hashlines`）。0.1.7-rc.2 上同样复现（本会话升级前即如此）→ 已登记为本包模块条目 `hash-edit/docs/BACKLOG.md` #1（P1，0.5 h）。
- **未改，需另行处置**：
  - `docs/STATUS.md:17`「宿主基线：本地安装 dsh `0.1.7-rc.2`」——该表由用户择时更新，属条目 #11 范围；
  - `docs/host/DSH-CTX-API.md:7`（研读基线 `dsh-v0.1.7-rc.2`）——该文件标注「只读参考，勿改动」，本次对照已确认其描述的消费面在 0.2.0 无变化；
  - `docs/host/AGENT-COMPOSITION.md:8`、`docs/host/AGENT-ARCHITECTURE-ANALOGY.md:260,368`——宿主面笔记的运行基线行仍是 0.1.7（结论未被 0.2.0 推翻）；
  - `profiles/README.md:49`——「示例按宿主 0.1.7-rc.2 的条目 id 编写」仍属实（示例未逐条复核到 0.2.0，归条目 #2 挂载面工作）；
  - `TUI/docs/COMMANDS.md:20`「`ctx.commands.register` 现注册 6 条（dsh 0.1.7-rc.2 随包清单核对）」——命令面需在 0.2.0 复核一次（挂载的 command 相关包未变，预计不变）。

## 关闭记录

- 条目从 `docs/BACKLOG.md` §2 清理；其余条目按当前顺序重编（挂载面扩张 → #1，复现审计 → #2，结构能力线 → #3..#6，独立修复 → #7/#8，executor 隔离 → #9，STATUS 对齐 → #10），§2 顺序依据与 §3 里程碑同步。
- 途中发现的 `hash-edit` render 缺陷登记为模块条目 `hash-edit/docs/BACKLOG.md` #1（P1），本条目不动其代码。
- 本追踪文档移入 `docs/archived/`。
- 残余（非阻塞）：① `npm run smoke:pty` 需在带 `USTC_API_KEY` 的非沙箱 shell 里复跑（等价链路已由本会话承担）；② `agent-loop` 失败步合成 `tool/result` 未真机复现——5 处消费点（TUI 渲染 / `output-compress` / `knowledge-base` / `rule-engine` / `context-report`）的「不误分片 / 不写噪声条目」未断言，记入 `docs/host/HOST-UPGRADE-0.2.0-rc.2.md` §7。
