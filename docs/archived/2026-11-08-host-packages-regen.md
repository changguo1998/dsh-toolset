# HOST-PACKAGES.md 逐包行清单按 rc.1 树重生成（接取条目：docs/BACKLOG.md「HOST-PACKAGES.md 逐包行清单按 rc.1 树重生成」）

状态：关闭　　开启：2026-11-08　　关闭：2026-11-08
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. 按 rc.1 安装树核对 372 个包目录, 把 +30 / −1 项（清单见 `docs/host/HOST-UPGRADE-0.2.2-rc.1.md` §10）排进 `docs/host/HOST-PACKAGES.md` 的逐包行清单。
2. 文档头部补一行本机口径（当前为 0.2.2-rc.1 安装树）。
3. 版本 / 计数口径与仓库面核对一致, 不留下过期的行清单或计数说明。

## 调研

- **两个数不是一回事**: 源码 tag 口径 **372** 个包目录（`HOST-UPGRADE-0.2.2-rc.1.md` §10 的 +30 / −1）, 本机安装树实测 **330** 个（`dsh --version` = `0.2.2-rc.1`; `$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai` 下 330 个目录, 其中 `dsh-*` 319 个, 11 个是 vendored cordis 生态 / 预编译资产）。行清单按**安装树**核对, 故目标是 330 行而不是 372 行。
- **文档现状**: §2 共 306 行（12 个分类）, §1 名单 100 个, 头部三处写着「计数为 rc.1 安装树实测, §1 / §2 行清单仍为 rc.5 快照」。
- **差异实测（脚本比对安装树目录名 vs §2 行名）**: 树里有、文档没有 **26** 个; 文档有、树里没有 **2** 个（`client-ui-deepseek-model-label-1017`、`hook-protocol`）。306 + 26 − 2 = **330**, 闭合。
- **26 个新包的归属可核**: 按 `~/GithubRepos/deepseek-harness/packages` 源码目录归口（`experimental/*` 剥前缀后按同一规则; 11 个目录名与包名不一致的按 `package.json` 的 `name` 反查）。
- **挂载集合必须重测**: `dsh --dump-config` 会往 `$DSH_HOME` 写 `cordis.yml`, 真实 home 在沙箱里只读 —— 改为把 profile 克隆到 `tmp/dsh-home`（43 MB）后以 `DSH_HOME=tmp/dsh-home` 运行。实测: 845 行 / 147 个 `- id:` 行 / 无条件 `disabled: true` 8 条 / 条件式 `disabled: !!js` 8 条 / `@dsh-toolset/*` 39 条 → 官方活跃项 **101** 条、覆盖 **100** 个包（`tool-subagent-control` 一包两行）。
- **26 个新包只有一个已挂载**: `tool-executor-native`（rc.1 把工具执行从 `tools` 行拆出）; 其余（forge / liveshare / 客户端 UI 家族 / recommendation 家族等）本 profile 都没挂。
- **旧计数有偏差**: 按 dump 重算后, 「会话 / 上下文 / 存储」27 → 25、「工具与工具基建」10 → 12、「文件 / 进程 / 沙箱」9 → 8、「LLM 与模型」8 → 7、「权限 / 安全 / 设置」7 → 6 —— 旧表是历次增量手改的累积, 与 dump 不再自洽; 本轮全部按 dump 重算。
- **`session-title-all-prompts-llm` 已不再树外**: 安装树里有 `dsh-session-title-all-prompts-llm`, 旧文多处按「树外加装」写, 需订正（profile 里仍 `disabled: true`, 不计入已挂载）。

## 决策

1. 做法: a 增量重生成（补 26 行 + 删 2 行 + 按 dump 重算计数与 §1 名单, 不改原有 300 行的中文定位） / b 全量重写 330 行中文定位 / c 只改头部与计数, 行清单留待以后。
   选定 a（2026-11-08 用户批准）—— b 会把 300 条已核过的中文定位重写一遍, 收益只是「整齐」, 风险是引入新错; c 不能关闭条目（行清单仍过期）。
2. 新行归属: 按源码目录归口 —— `工具与工具基建` +3（action-cards / tool-executor-native / tool-executor-ptc）、`客户端 UI` +10、`其他` +6（forge / liveshare 家族）、`插件 / 启动 / 基础设施` +4、`技能 / 命令 / Web / 集成` +1、`文件 / 进程 / 沙箱` +1、`会话 / 上下文 / 存储` +1。
3. 挂载标记: 以本轮 dump 为准 —— 行名在活跃集合里写「（已挂载）」, 否则不写; 树外加装概念按实际修订。
4. 新行插入位置: 追加到所属分类末尾（不重排整节顺序）—— 保持既有行的相对顺序, 便于 diff 审查。

## 规划

- 计划改动文件清单:
  - `docs/host/HOST-PACKAGES.md`（标题行、头部版本口径 / rc.1 挂载复测 / §0 树外加装与 vendor 口径 / §0 小计自洽性 / §1 名单与段落 / §2 分类小计与 330 行）
- 明确不做: 不改 `docs/host/DSH-CTX-API.md`、不改 `HOST-UPGRADE-0.2.2-rc.1.md`、不重排 §2 既有行顺序、不动 §3 服务字典（接口面改动归 `DSH-CTX-API.md`）。
- 验证: 脚本比对「安装树目录名集合 = §2 行名集合」、各分类小计之和 = 330、已挂载之和 = 100、§1 名单 = dump 活跃集合; `pnpm run check:docs`。

## 实现记录

- 2026-11-08: 克隆 profile 到 `tmp/dsh-home`（43 MB）后 `DSH_HOME=tmp/dsh-home dsh --profile fff --dump-config` 取挂载集合; 解析 `- id:` / `name:` / `disabled: true` 三列, 得到活跃包集合（100 个）; 用后即删克隆与中间文件。
- 2026-11-08: 按源码目录归口把 26 个新行写进 7 个分类末尾, 删除 2 个过期行; 行名 + 中文定位一句（取自各包 `package.json` 的 description, 改写为中文）。
- 2026-11-08: 全部 12 个分类标题的小计按「行数 / 行名 ∈ dump 活跃集合」重算; §1 名单按 dump 活跃集合重排（每行 10 个）; 头部三处（标题行 / 版本口径 / rc.1 挂载复测）、§0 三处（树外加装定义 / vendor 计数 / 小计自洽性）、§1 段落与 §2 标题同步。

## 偏差

- 条目与目标写的是「核对 372 个包目录」: 实际核对的是**安装树 330 个**。372 是源码 tag 口径（+30 / −1 是源码目录的增删）, 而本文件通篇以安装树为准; 已在目标 1 与「调研」里写明两个口径的区别, 文档头部也保留了 372 这个源码口径数字。
- 计划里没写要订正 `session-title-all-prompts-llm` 的「树外加装」表述, 实现时发现该包已随 rc.1 分发, 一并订正（头部 rc.1 行、§0 树外加装定义、§1 段落、§2 该行标记）。
- 计划里「新行追加到分类末尾」已执行, 故 §2 内同一分类不再严格按字母 / 旧版顺序排列（既有行顺序未变）。

## 测试与证据

- 集合比对（脚本）: 安装树 330 个目录 vs §2 330 行 → `tree-only: []`、`doc-only: []`、行名唯一 330。
- 计数自洽（脚本）: 12 个分类小计之和 = **330**; 「已挂载」之和 = **100**; §1 名单 100 个与 dump 活跃集合**逐名相等**（`equal: True`）。
- dump 复测原始数字: 845 行、147 个 `- id:`、无条件 `disabled: true` 8 条、条件式 `disabled: !!js` 8 条、`@dsh-toolset/*` 39 条。
- `pnpm run check:docs`: 通过（119 篇现行 Markdown / 959 个 .ts, 错误 0 / 警告 0）。
- 本任务只改文档, 不跑代码门禁。

## 途中发现

- §3「服务字典」仍是旧口径: rc.1 把工具执行从 `tools` 行拆成 `tool-executor-native` / `tool-executor-ptc`（`tools` 行删除 `mode` / `maxParallelSubCalls`）, 且新增包的若干服务（如 forge 登记表、action-cards 的提议工具）未进字典。这属接口面, 归 `docs/host/DSH-CTX-API.md` 的职责, 本任务不动 —— 已在 `docs/BACKLOG.md` 登记新条目。
- `dsh --dump-config` 会往 `$DSH_HOME` 写 `cordis.yml`, 在只读 home 的沙箱里直接失败（`EROFS`）。复现命令需要先克隆 profile 到可写 `DSH_HOME`; 文末「复现命令」一节仍是旧写法, 属同类问题, 一并登记在同一个新条目里。

## 收尾

- BACKLOG 条目已移除, 本文件移入 `docs/archived/`。
- 回写: 仅 `docs/host/HOST-PACKAGES.md`（`docs/host/` 不参与变更流程, 无 README / DESIGN 需回写）。
- 遗留: §3 服务字典与文末复现命令的 `DSH_HOME` 写法（见「途中发现」, 已登记 BACKLOG）。
