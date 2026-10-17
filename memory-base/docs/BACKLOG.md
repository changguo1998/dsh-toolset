# memory-base 待办

> 职责：memory-base 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、契约与边界（见 `memory-base/README.md` 与 `memory-base/docs/DESIGN.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `memory-base/tests/`，不在此重复。
> 条目结构（2026-10-17 起）：现象 / 现状 → 期望 → 前置 → 落点 → 验收 → 估时 → 来源·状态·优先级。

## 待办

**#1 按「只提供分层记忆内容」的新定位瘦身，并补四项纯存储面（指定层写入 / 按 kind 列举 / 真删 / `registerKind` 去留）**（2026-10-17 登记，来源：`docs/implementation/2026-10-16-preference-analysis-design.md` 的 R1 与 D16-D20）：**现象 / 现状** —— 用户 2026-10-16 裁定 memory-base **只保留分级结构**，其余限制可能取消、管理逻辑（提升 / 审阅 / 生命周期）下沉到各插件；据 R1 实读，现面与新定位有四处错位：① `remember` 只在 `origin === "user" && tier !== undefined` 时写指定层，否则一律落 `session`（`src/tiers.ts:320-336`）—— 插件要写 P / U 层只能冒充用户来源；② **没有按 kind 列举的入口**，唯一「列全部行」的只读面 `targetRows({project, limit})` 只返回 `target IS NOT NULL` 的行（`src/knowledge.ts:917-943`），而 `approveCandidate` 落库不写 `target`（`src/promote.ts:686-694`），故批准后的行枚举不到，`search` 又必填 `query`；③ `forget` 在单库模式恒返回 0（`src/index.ts:846-851`），也没有 `evict` / `touch` / `setImportance` 可透出；④ 转换闸要求 LLM caller：`approveCandidate` 对 `summarized = 0` 的候选直接返回 `llm-unavailable`（`src/promote.ts:639-700`），无 caller 时任何候选都批不了（候选队列只能 reject）。**期望**（D19 四项）—— (a) `remember({tier})` 不再要求 `origin: "user"`；(b) 新增按 kind 列举面 `list({kind, project?, limit?})`（含 `target IS NULL` 的行）；(c) `forget` 在单库模式真删并返回条数，或透出 `evict`；(d) `registerKind` 的去留待定 —— 若保留，其 `preWrite` 钩子是用户层写入的硬闸（D18 希望保留）；瘦身侧：`promote` / `candidates` / `approveCandidate` / LLM caller 与 `conclusion` 标记随管理逻辑下沉或取消（D16 已改选「账簿为唯一状态源」、D17 改选「审阅自持」，均不再依赖候选队列）。**前置 / 顺序** —— D20 选「先瘦身、偏好分析随后按新面实现」（备选：先做偏好、正文自持、将来迁一次），故本条是偏好分析条目的前置；顺序待用户裁定。**落点** —— `memory-base/src/index.ts`（服务面）、`src/tiers.ts`（分层写入路由）、`src/knowledge.ts`（列举与删除面）、`src/promote.ts`（下沉 / 删除）、`src/router.ts`（kind 注册与检索并集）、`README.md` + `docs/DESIGN.md`（新定位口径）。**验收** —— `remember` 指定层写入不再要求 `origin: "user"`；`list({kind})` 能枚举出写入行（含 `target IS NULL` 的行）；单库模式下 `forget`（或 `evict`）真删并返回条数；`registerKind` 与 `preWrite` 若保留则各有一例（拒写、建议 `importance`）；现有分级 / 隐私闸 / 检索 / 上限用例回归全绿。**估时** —— 1 至 1.5 天（服务面 + 列举 + 删除 + 管理逻辑下沉 + 用例 + 文档），视是否连同删除 `promote` / `candidates` 而定。**优先级** —— P2（偏好分析的前置；若偏好条目优先，本条宜同步上调 P1）。**来源** —— 用户 2026-10-16 裁定（新定位 + 管理逻辑下沉）与偏好分析设计文档 D16-D20；原记录「该改动不新开 BACKLOG 条目」由 2026-10-17 用户指示「给需要变更的模块在 backlog 中添加条目」取代。〔待办: 2026-10-17 登记〕
