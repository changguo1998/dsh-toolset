# herdr-pane 插件与工具改名（接取条目：`docs/BACKLOG.md`「herdr-pane 插件与工具改名（`herdr-pane` / `herdr_pane` → `herdr-use` / `herdr_use`）」）

状态：规划　　开启：2026-10-22　　关闭：-
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把已扩展到 tab 与会话 workspace 绑定的 `herdr-pane` 包整体改名, 使包名 / 插件 id / 工具名 / 目录 / 导出符号与能力面一致: `herdr-pane` → `herdr-use`、`herdr_pane` → `herdr_use`、`HerdrPane*` → `HerdrUse*`.

同时把动作名按对象分组: pane 类一律 `pane_` 前缀 (10 个), tab 类一律 `tab_` 前缀 (3 个, 已经是). 动作集合、参数面、闸门顺序、归属口径均不变, 只改名字.

## 调研

- 现状 (读码与 grep): 包名 `@dsh-toolset/herdr-pane`, 插件 `name = "herdr-pane"` (`herdr-pane/src/main.ts:60`), 工具 `TOOL_NAME = "herdr_pane"` (`herdr-pane/src/tools.ts:262`), 目录 `herdr-pane/`, 导出符号 20 余个 `HerdrPane*`。
- 能力面: 13 个动作 (pane 读写 + `tab_create` / `tab_list` / `tab_close`) + 会话 ↔ workspace 内部绑定, 名称已不覆盖 tab / workspace 两层 (`herdr-pane/docs/archived/2026-10-21-herdr-pane-tab-workspace.md`)。
- 动作名现状: 10 个 pane 类动作用裸动词 (`create` / `list` / `read` / `wait` / `send_text` / `send_keys` / `run` / `label` / `info` / `close`), 3 个 tab 类已带 `tab_` 前缀; 工具 schema 的 `action` 枚举 (`src/tools.ts`)、`PANE_ACTIONS` 常量 (`src/types.ts:30`)、分派表 (`src/actions.ts:1122`) 三处需同步。
- 引用面 (排除 `node_modules` / `dist` / 归档): 现行文件中 22 个文件在包外引用旧名, 另包内 9 个源文件 / 10 个测试文件 / 1 个真机脚本。
- 跨包消费点三处: `security-guard/src/index.ts` 的 `PLUGIN_COMMAND_TOOLS.herdr_pane` 登记、`behavior-correction/src/main.ts` 缺省规则回执文案、`rule-engine/README.md` 示例回执。
- 接线面: 根 `package.json` check/build 链、`scripts/install.sh` 与 `scripts/test-parallel.sh` 的包清单、`AGENTS.md` 包清单、根 `README.md` / `README.zh.md` 插件表、profile (`~/.dsh/profiles/fff`) 的 `link:` 依赖与 patch 行。

## 决策

1. **新名字**: a `herdr-terminal` / b `herdr-pty` / c `herdr-console` / d `herdr-tabs` → **候选均未选, 用户自定 `herdr-use`（工具 `herdr_use`）**; 理由: 用户指定, 不再评估候选语义贴合度。
2. **改名深度**: a 全量 (目录 / 包名 / 插件 id / 工具名 / 导出符号) / b 只改对外名 / c 只改插件 id 与工具名 → **选定 a**; 理由: 目录与符号仍叫 pane 会在包内外留下两套说法, 后续读码与检索成本高于一次性改完。
3. **落点范围**: a 只改现行文件, 归档文档保留旧名 / b 连归档一起改 → **选定 a**; 理由: `docs/archived/` 与根 `archive/` 是历史记录, 改名会让当时的证据与现状混淆。
4. **实施路径**: a worktree + herdr 另起 agent 实现与自测 / b 当前会话直接改 main → **选定 a**; 理由: 跨 8 个包、约 40 个现行文件, 与真机验收分离。
5. **工具名**: 随包名同源 → `herdr_use` (用户 2026-10-22 明确要求工具名一起改)。
6. **动作名分组**: a 保持旧名 (`create` / `list` / `read` …) / b pane 类加 `pane_` 前缀、tab 类保持 `tab_` 前缀 → **选定 b**; 理由: 用户要求按对象分组, 回执与错误文案里的动作名一眼可辨归属; tab 三项原已带前缀, 无需改动。
7. **自有对象范围**: a 指向既有对象的动作全部限自有 (含 `pane_read` / `pane_info`) / b 只限写类与关闭 (保持现状) → **选定 b**; 理由: 用户选择保持观察能力 —— `pane_read` / `pane_info` 仍可读任意 pane, 写类 (`pane_send_text` / `pane_send_keys` / `pane_run` / `pane_label` / `pane_close` / `tab_close`) 与 `pane_wait` 的 `stable` 模式仍要求自有对象; `pane_list` / `tab_list` 不指向具体对象, 不在这条约束内。

## 规划

任务拆分:

1. 目录改名 `herdr-pane/` → `herdr-use/`, 包名 `@dsh-toolset/herdr-use`, `package-lock.json` 同步。
2. 源码 / 测试 / 真机脚本内的标识符与文案: `TOOL_NAME`、`name`、`HerdrPane*` 类型与函数、回执前缀 `herdr_pane ...`、错误来源标注 `herdr-pane:<action>`、socket id 前缀、临时目录前缀、`--keep` / `--with-tab` 等开关文案。
3. 动作名分组: `create` / `list` / `read` / `wait` / `send_text` / `send_keys` / `run` / `label` / `info` / `close` → `pane_*` (10 个); `tab_create` / `tab_list` / `tab_close` 不变。同步改: 动作枚举与 `PANE_ACTIONS` 常量 (13 项集合改名 `ALL_ACTIONS`, 新增 `TAB_ACTIONS` 供 workspace 锁复用)、工具 schema 的 `action` 枚举与描述、分派表 `HANDLERS`、回执 13 个分支、错误文案、`policy.ts` 的动作集合 (`OWNED_ACTIONS` / `READONLY_ACTIONS` / `SANDBOX_WRITE_ACTIONS` / 审批判断)、`actions.ts` 的 `WORKSPACE_ACTIONS` 与归属提示文案、全部测试与真机脚本。
4. 真机脚本改名 `scripts/verify-herdr-pane.mjs` → `verify-herdr-use.mjs`, `package.json` 的 `verify` 脚本同步。
5. 跨包三处: `security-guard`(`PLUGIN_COMMAND_TOOLS` 键 + 测试 + README)、`behavior-correction`(缺省规则回执 + 测试 + README + package 描述 + patch 注释)、`rule-engine`(README 示例 + 两处测试用例)。
6. 接线面: 根 `package.json`、两个脚本的包清单、`AGENTS.md`、根 `README.md` / `README.zh.md`、`docs/ARCHITECTURE-REUSE.md`、`docs/BACKLOG.md` §1 索引与候选行。
7. 收尾: 本追踪文档归档、条目从 BACKLOG 移除; profile 两文件在真机验收前由主会话改。

计划改动文件清单:

- `herdr-pane/` → `herdr-use/`（整目录改名）: `src/{index,main,types,tools,actions,policy,socket,cli,registry,workspace}.ts`、`tests/{actions,cli,main,net,policy,registry,socket,tool,workspace}.test.ts`、`tests/helpers.ts`、`scripts/verify-herdr-pane.mjs` → `verify-herdr-use.mjs`、`package.json`、`package-lock.json`、`cordis.patch.yml`、`README.md`、`docs/BACKLOG.md`
- 根: `package.json`、`scripts/install.sh`、`scripts/test-parallel.sh`、`AGENTS.md`、`README.md`、`README.zh.md`
- 文档: `docs/BACKLOG.md`、`docs/ARCHITECTURE-REUSE.md`、本追踪文档
- 跨包: `security-guard/src/index.ts`、`security-guard/tests/guard.test.ts`、`security-guard/README.md`；`behavior-correction/src/main.ts`、`behavior-correction/tests/main.test.ts`、`behavior-correction/README.md`、`behavior-correction/package.json`、`behavior-correction/cordis.patch.yml`；`rule-engine/README.md`、`rule-engine/tests/main.test.ts`、`rule-engine/tests/consumerGuard.test.ts`
- 工作区外 (真机验收前, 主会话执行): `~/.dsh/profiles/fff/package.json`、`~/.dsh/profiles/fff/cordis.patch.yml`

明确不做:

- 归档文档与根 `archive/` 一律保留旧名 (`docs/archived/**`、`*/docs/archived/**`)。
- `TUI/docs/STATUS.md` 指向归档文档的历史引用行不改。
- `rule-engine/docs/BACKLOG.md`、`docs/BACKLOG.md` §6 关闭记录等历史注记不改。
- `docs/STATUS.md` 由用户择时更新, 流程内不改。
- 无功能性改动: 动作集合 (13 个)、参数面、回执结构、错误码、闸门顺序、归属与审批口径全部保持原样 —— 本次只改名字 (含动作名)。
- 不新增动作, 不改 workspace 绑定语义, 不改 `pane_read` / `pane_info` 可读外部 pane 的观察能力。

## 实现记录

（待实现。）

## 偏差

（待填。）

## 测试与证据

（待填。）

## 收尾

（待填。）
