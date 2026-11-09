# HOST-PACKAGES.md §3 服务字典与文末复现命令按 rc.1 复核（接取条目：docs/BACKLOG.md「HOST-PACKAGES.md 的 §3 服务字典与文末复现命令按 rc.1 复核」）

状态：关闭　　开启：2026-11-09　　关闭：2026-11-09
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. §3 服务字典按 0.2.2-rc.1 安装树主入口复算服务名, 补上 rc.1 的接口面变化（`tool-executor-*` 拆分与新增包的服务）。
2. §6 复现命令补「先把 profile 克隆到可写 `DSH_HOME`」的前置步骤, 消掉只读 home 下的 `EROFS`。

## 调研

- 本机安装树：`dsh --version` = `0.2.2-rc.1`；`$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai` 下 330 个包（319 个 `dsh-*`）, 与 `HOST-PACKAGES.md` 头部与 §0 的计数一致。
- 按 §6 第 2 条正则（`super(<ident>, "name")`）复算主入口：命中 **102** 个名字, 其中 3 个是错误码而非服务——`DECLINED`（`dsh-authorization`）、`SANDBOX_UNSUPPORTED_POLICY`（`dsh-sandbox`）、`CODE_RUN_FAILED`（`dsh-tool-executor-ptc`）→ 实际服务 **99** 个。
- 与现行 §3（92 个）比对：
  - 树里有、字典没有 9 个：`actionCards` / `forge` / `forgePanel` / `forgeSession` / `liveshareShares` / `pluginRecommendations` / `productTelemetry` / `sessionLogDeepSeek` / `sessionToolResults`。
  - 字典有、树里没有 2 个：`invariants`（包 `dsh-invariants` 不在安装树, 也不在 `dsh-base` patch 与 fff 用户 patch 里）、`webhookRuntime`（包 `dsh-webhook` 同样不在树里）。
- rc.1 的工具执行拆分不是服务面变化：`dsh-tool-executor-native` 主入口没有 `super(`；`dsh-tool-executor-ptc` 只命中错误码 `CODE_RUN_FAILED`。`dsh-tools` 的配置 schema 把 `maxParallelSubCalls` 标成「Moved to the PTC tool executor configuration.」；`dsh-base/cordis.patch.yml` 里 `tool-executor-native` 启用、`tool-executor-ptc` `disabled: true`。
- 挂载状态：9 个新服务里只有 `sessionLogDeepSeek`（`session-log-deepseek`）在 §1 已挂载名单里；其余 8 个包在 §2 都未挂载（`host-product-telemetry-otel` 的 §2 行已注明「本 profile 未挂载」）。
- 复现命令现状：`dsh --profile fff --dump-config` 会往 `$DSH_HOME` 写 `cordis.yml`, 只读 home（沙箱 / CI）报 `EROFS`；2026-11-08 的重生成任务已用「克隆 profile 到 `tmp/dsh-home`」绕过, 但命令块没写进文档。

## 决策

1. 字典更新方式：a 全量重算并重排 / b 增删差异 + 更新计数与正则说明, 不动其余行。
   选定 b：其余 90 行的包归属与中文定位本轮无变化（`dsh-*` 前缀按文档口径省略）, 全量重写只会引入新错。
2. `tool-executor-*` 的写法：a 在 §3 新增两行执行器 / b 在 §3 引言与 `tools` 行说明它们是执行器包、不注册 host 服务。
   选定 b：按 §6 核对口径（服务名只取主入口的 `super(<ctx>, "name")`）, 两个执行器都不产生服务名, 单列会破坏「服务 → 归属包」的字典语义。
3. 新行插入位置：按字母序插入（§3 既有顺序即字母序）, 不追加到末尾, 便于逐行评审。
4. §6 复现命令：a 一行 `DSH_HOME` 隔离写法 / b 显式三步（克隆 profile、带 `DSH_HOME` 跑 dump、删克隆）。
   选定 b：要能让读者看懂「为什么不能直接跑」；一行写法（`DSH_HOME=$(mktemp -d)`）缺 profile, 跑不通。
5. §6「核对口径」里直接描述服务提取与挂载解析的两条数字（85 候选 / 84 服务、91 个包、13 个 `@dsh-toolset/*`）同步改成 rc.1 实测值（102 / 99、105、39）, 其余口径不动。

## 规划

- 计划改动文件清单：
  - `docs/host/HOST-PACKAGES.md`（§3 引言 + 92 → 99 个服务行；`tools` 行补拆分说明；§6 命令块前置步骤；§6 核对口径两条数字；0.2.2-rc.1 增量段里「本机安装树仍为 rc.5」这句过期状态）
- 明确不做：不改 `docs/host/DSH-CTX-API.md`、不改 `HOST-UPGRADE-0.2.2-rc.1.md`、不重排 §2 行清单、不重写 §3 其余 90 行的中文定位与挂载标记。
- 验证：脚本复算「安装树服务名集合 = §3 行集合」；§3 行数 = 99；按新命令块实跑一次 `--dump-config`（`tmp/` 下克隆, 用后删）；`pnpm run check:docs`。

## 实现记录

- 2026-11-09：按 §6 正则复算 rc.1 安装树（99 个服务）, 与 §3 逐名比对后删除 `invariants` / `webhookRuntime` 两行, 新增 9 行（按字母序插入）, `tools` 行补执行器拆分说明；§3 引言改为 99 个并写明 102 个候选里的 3 个错误码。
- 2026-11-09：§6 命令块插入第 0 步（克隆 profile 到 `tmp/dsh-home`、带 `DSH_HOME` 跑 dump 并在同一步 `rm -rf` 克隆）；采集段落与两条核对口径按 rc.1 实测重写；0.2.2-rc.1 增量段里「本机安装树仍为 rc.5」改为已重生成。

## 偏差

- 条目只要求「复核 §3 与 §6 复现命令」；实现时把 §6 采集段落与两条核对口径里的过期数字（0.2.0-rc.2 / 288 包 / 85 候选 / 91 个包 / 13 个 `@dsh-toolset/*` 行）一并订正——它们与 §1 的 330 / 100 / 39 直接冲突, 属同一节同一事实。计划清单已按「§6」范围列出。
- 服务数从 92 变 99 的同时删了 2 行, 净变化 +7；条目原文只写「补 tool-executor-\* 拆分与新增包的服务」, 没提删除, 实际两行对应的包已不在 rc.1 安装树（见「调研」）。
- 文档头部第 15 行「`> 采集时间：2026-10-21 …`」仍是 0.2.1-rc.2 时代的旧采集注记, 与 §1 计数冲突；它属头部历史注记, 不属 §3 / §6, 本轮未动（见「收尾·遗留」）。
- 命令块的 `DSH_HOME="$H" dsh …` 在本会话被 security-guard 的「dynamic-command」规则拦下（命令名由变量展开）, 实跑验证改用字面路径等价命令（结果见「测试与证据」）；文档本身面向人工 shell, 保持变量写法。

## 途中发现

- `hash_read` / `md_logic` / `ast_replace` 三个模型侧工具本轮全部不可用：返回 `cannot get property "workingDirectory" without inject`。根因是三包 `inject` 只有 `["tools", "fs"]` 却直接读 `host.workingDirectory`（`hash-edit/src/ctx-fs-io.ts:160`、`md-logic/src/ctx-fs-io.ts:146`、`ast-tools/src/ctx-fs-io.ts:162`）。已作为新条目（P1）登记进 `docs/BACKLOG.md`, 本批次不修；本任务的文档编辑改用 `write` + `script_run` 完成。

## 测试与证据

- 服务名集合比对（脚本）：安装树 **99** = §3 **99**, `tree-only: []` / `doc-only: []` / 包归属不一致 **0**；服务名唯一 99。
- 字母序：除原有的一处（`productAnalytics` 排在 `pluginRegistryProbe` 前, 未动）外无逆序对。
- 复现命令实跑（字面路径等价写法）：退出码 **0**、输出 **845** 行、顶层 `- id:` **147** 行、无条件 `disabled: true` **8** 条、条件式 `disabled: !!js` **8** 条、`@dsh-toolset/` 行 **39** 条；第 3 条命令归并后 **105** 个包名。克隆与 dump 文件用后已删。
- `pnpm run check:docs`：通过（119 篇现行 Markdown / 959 个 .ts, 错误 0 / 警告 0）。
- 本任务只改文档；同批次的根 `pnpm run check` / `build` / `test` 全绿（38 包）。

## 收尾

- BACKLOG 条目已移除；本文件移入 `docs/archived/`。
- 回写：仅 `docs/host/HOST-PACKAGES.md`（`docs/host/` 不参与变更流程, 无 README / DESIGN 需回写）。
- 遗留：头部「采集时间 2026-10-21」注记仍为 0.2.1-rc.2 口径（见「偏差」第 3 条）, 留待宿主文档整体复写时处理。
