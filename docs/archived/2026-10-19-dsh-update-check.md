# 检查官方 deepseek-harness 更新（接取条目：docs/BACKLOG.md「检查官方 deepseek-harness 更新（新 rc 版本与接口约定变动）」）

状态：关闭　　开启：2026-10-19　　关闭：2026-10-20
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

查官方 deepseek-harness 发布渠道（npm `@deepseek-ai/*`、GitHub releases 等）确认最新版本 vs 当前基线 `dsh-v0.2.0-rc.2`；若存在新版本，对照工具 / 事件 / 服务面接口约定（尤其本仓实际消费的 `ctx` 面与 `tools/pre-execute` 的 `ToolExecution` 载荷形状）列增删改清单，产出 `docs/host/HOST-UPGRADE-<版本>.md` 对照记录；与用户裁定是否升级基线（升级则按 `scripts/install.sh` 流程同步默认版本与主要版本引用，并按 HOST-UPGRADE 流程复核 `HOST-PACKAGES.md` 与既有消费方）。验收：给出「官方最新版本 vs `0.2.0-rc.2`」结论；接口有变动则给逐项增删改清单与本仓影响判定；结论落盘（无变动也留注记）。

## 调研

（2026-10-20 主会话承接后开工；已预置的查证渠道：npm `@deepseek-ai/dsh` 等发布版本 / GitHub `deepseek-ai` 仓库 releases / 已装宿主包 `@deepseek-ai/dsh` 与 `docs/host/HOST-UPGRADE-0.2.0-rc.2.md` 既定对照口径。查证过程按时间追加到「实现记录」。）

## 决策

- ① 官方是否有新 rc / 正式版：**有** —— `0.2.1-rc.2`（npm latest 与 GitHub release 双渠道确认，2026-10-17 发布）。
- ② 接口变动是否波及本仓消费的官方面：**有变动但直接消费面无破坏** —— 26 个消费包导出类型名集合只增无删；`ToolExecution` 载荷、`sessions`、`sandboxPolicy.resolve`、`llm`/`model-selection` 定点零 diff；release notes 破坏项（`./invariant` / stats 扩展位 / both 模式等）本仓不消费。装载面（`engines.dsh` / `script-interpreter` PTC 组合 / 自动化内置叠加）若升级时复核。
- ③ 是否升级基线：**用户延迟裁定** —— 本条目以「调研 + 对照记录产出」验收关闭；升级与否移交与条目 2「重新审计」绑定的任务（BACKLOG 接取绑定）：升级则按 HOST-UPGRADE 流程刷 `HOST-PACKAGES.md` / `scripts/install.sh` 再重跑复用审计，不升级则审计维持 `0.2.0-rc.2` 基线。

## 规划

任务拆分：

- 查证：确认官方最新版本号与发布时间（npm 与 GitHub 双渠道交叉）。
- 对照：若无新版本 → 直接落结论注记；若有 → 逐项列工具 / 事件 / 服务面增删改（读新版本源码与 0.2.0-rc.2 比对）。
- 裁定与产出：写 `docs/host/HOST-UPGRADE-<版本>.md`；升级与否由用户裁定，升级则同步 `scripts/install.sh` 默认版本 / 版本引用 / smoke 门槛，并复核 `HOST-PACKAGES.md` 与既有消费方（`HOST-PACKAGES` 只按升级流程刷）。

计划改动文件清单（预估；无变动则只留注记与清单外零改动）：

- `docs/host/HOST-UPGRADE-<版本>.md`（有变动时新增）
- `docs/host/HOST-PACKAGES.md`（仅升级基线时按其自身流程刷）
- `scripts/install.sh`（若升级：默认版本 + 主要版本引用 + smoke 门槛）
- 本追踪文档

明确不做：不自动升级基线（升级须用户裁定）；不改各包代码；

## 实现记录

- 2026-10-20（主会话）：查证渠道三线并查。
  - npm：`@deepseek-ai/dsh` registry 直查 → `dist-tags.latest = 0.2.1-rc.2`（`alpha` 0.2.1-alpha.5, `next` 0.2.1-rc.2）；已装基线 `0.2.0-rc.2`。
  - GitHub：`deepseek-ai/deepseek-harness` releases → `dsh-v0.2.1-rc.2`（2026-10-17 发布, prerelease）、`dsh-v0.2.1-rc.1`（同 2026-10-17, 汇总自 v0.2.0-rc.2 的变更）、`dsh-v0.2.0-rc.2`（2026-09-29）。
  - 结论：官方最新 `0.2.1-rc.2`，比基线 `0.2.0-rc.2` 新一个 rc 系列，接口面有变动（含破坏项）。
  - 对照产出：`docs/host/HOST-UPGRADE-0.2.1-rc.2.md`（14 项变更清单 + 本仓影响初判）。本仓 29 模块对 `./invariant` / stats 扩展位 / both 展示模式等破坏面无直接消费（grep 实测），升级直接冲击面小；装载面（engines.dsh / script-interpreter PTC 组合 / 自动化内置叠加）待升级时复核。
- 2026-10-20（主会话，二次补充，按用户指示改为「详细调研接口变动并更新参考文档」）：
  - git 级核对：GitHub compare `dsh-v0.2.0-rc.2`(639ed01) → `dsh-v0.2.1-rc.2`(687f282) 共 **1925 提交**。
  - 源码/类型级调研：上游 shallow 克隆 + 26 个消费包 `lib/types` 两版本比对 —— **导出类型名集合全部只增无删**；定点核对 `ToolExecution` 载荷（仅注释口径变）、`sessions` 服务签名集、`sandboxPolicy.resolve` 面、`llm`/`model-selection` 事件面 **均零 diff**。
  - 详细结果并入 `docs/host/HOST-UPGRADE-0.2.1-rc.2.md`「详细接口调研（源码级）」节；残余与升级裁定留待用户。

## 偏差

- 未做 26 包「逐类型体」全量 diff（只做类型名集合级 + 定点载荷 diff）—— 因零删除名 + 定点点位相同，判断额外价值低；升级前如需极致保险可补。
- 模型可见工具集合（默认组合）未逐枚举增删（已知新增 `working_directory`）；`HOST-PACKAGES.md` 实挂行对照未刷（需升级时按流程执行）。
- 升级基线未执行（用户延迟裁定）—— 见「决策」③，移交条目 2 绑定任务。本条目验收（结论 + 清单 + 影响判定 + 落盘）已完成。

## 测试与证据

- npm：`https://registry.npmjs.org/@deepseek-ai/dsh` 直查（2026-10-20）→ `dist-tags.latest=0.2.1-rc.2` / `alpha=0.2.1-alpha.5` / `next=0.2.1-rc.2`；本机已装 `0.2.0-rc.2`。
- GitHub：`deepseek-ai/deepseek-harness` releases API → `dsh-v0.2.1-rc.2`（2026-10-17T08:16Z, prerelease）/ `dsh-v0.2.1-rc.1`（同 2026-10-17, 汇总区间注释）。
- git 级：compare API `dsh-v0.2.0-rc.2`(639ed01)…`dsh-v0.2.1-rc.2`(687f282) → `ahead_by=1925` 提交。
- 源码/类型级：上游 shallow 克隆（`--filter=blob:none`, 双标签）+ 26 个消费包 npm tarball `lib/types` 与已装 0.2.0-rc.2 比对 → 类型名集合全「只增无删」；定点 diff：`ToolExecution`（仅注释口径）、`sessions` 签名集、`sandboxPolicy.resolve` 面、`llm`/`model-selection` 事件面零 diff。
- 产出：`docs/host/HOST-UPGRADE-0.2.1-rc.2.md`（结论 / 14 项变更清单 / 本仓影响初判 / 详细接口调研节 / 复核与升级路径）。

## 收尾

- 产出并提交：`docs/host/HOST-UPGRADE-0.2.1-rc.2.md`（新增）、BACKLOG 条目 5/6 接取标记与条目 2/3 接取绑定、本追踪文档调研/决策/实现记录（提交 `365cdca`）。
- 升级遗留：是否升级基线至 `0.2.1-rc.2` 由用户裁定；升级则按 HOST-UPGRADE 流程刷 `HOST-PACKAGES.md` / `scripts/install.sh` 并复核既有消费方，随后与条目 2（复用审计）绑定任务在最新基线上开工（BACKLOG 接取绑定）。
- 本追踪文档归档至 `docs/archived/`，BACKLOG 条目「检查官方 deepseek-harness 更新」标记完成并从 §2 移除（升级/审计续作并入条目 2）。
