# 自动别名：词表纳入自然科学类词 + 后缀改为纯词名占满才兜底（接取条目：session-channel/docs/BACKLOG.md「自动别名：词表纳入自然科学类词, 后缀改为纯词名占满才兜底」）

状态：关闭　　开启：2026-10-27　　关闭：2026-10-27
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

按 2026-10-27 用户裁定落地两件事：

1. 自动别名词表可纳入**自然科学类**词（新增类别），约束维持 ≤8 字符、`[A-Za-z]`、非保留字、无重复；音节数不设限。
2. 自动别名默认只拼 `<前缀><词>`；**仅当该前缀的纯词名全部被占用时**才拼 `-<4 位 hex>` 兜底。

## 调研

- 现状命名：`src/alias-words.ts` 的 `autoAliasCandidate` 恒拼 `<前缀><词>-<hex4>`（`DESIGN.md` §3.1、`README.md` 别名条）；`src/index.ts` 的 `#autoAlias` 用 `AUTO_ALIAS_TRIES = 8` 次候选重试，耗尽即失败（计数 + 日志）。
- 词表规模（实测）：`AUTO_ALIAS_WORDS` 433 词 + `AUTO_ALIAS_WORDS_EXTRA` 331 词，去重后 `AUTO_ALIAS_POOL` 578 词；两类合计重复 186 条。
- 候选序列：词索引 = `sha256(sessionId)` 前 2 字节 + attempt 对词表规模取模（确定性、同会话恒同名）；后缀 = `sha256(sessionId)` 前 4 位 hex（确定性）。
- 约束守卫：`tests/alias.test.ts` 断言词长 `^[A-Za-z]{2,8}$`、无重复、不与保留字冲突；另有命名 / 候选 / 首见生成 / 碰撞重试 / 失败可见用例。
- 容量：纯词名每前缀 = 词表规模（现 818，含自然科学类 240 词）；会话跟踪上限 32、别名键无 TTL，长期累积才会接近占满。
- 旁证：`src/index.ts` 里 `pickAutoAlias` / `autoAliasFor` 未被生产路径使用（仅测试）；生产只用 `aliasPrefixFor`、`AUTO_ALIAS_TRIES`、`autoAliasCandidate`。

## 决策

- 决策项 1　纯词名阶段的重试边界
  - a) 维持 8 次，撞名 8 次即拼后缀。
  - b) 走完整词表（`AUTO_ALIAS_POOL.length` 次），全部被占才进兜底。
  - **选定 b**：用户裁定「该前缀纯词名全占满才启用后缀」；只有走完整表才能判定「全占满」，8 次不足以区分「运气差」与「已占满」。
- 决策项 2　兜底阶段的重试次数
  - a) 复用 `AUTO_ALIAS_TRIES = 8`。
  - b) 只试 1 个确定性后缀候选。
  - **选定 a**：后缀把容量扩到「词表规模 × 65536」，8 次重试基本必成；保留既有常量与语义（仅 `alias_taken` 重试）。
- 决策项 3　导出函数拆分方式
  - a) 把 `autoAliasCandidate` 改为纯词名，新增 `autoAliasFallbackCandidate` 出兜底名。
  - b) 新增 `autoAliasWordCandidate`，`autoAliasCandidate` 保持带后缀。
  - **选定 a**：对调用方（`index.ts` / 测试）语义最直观——「候选」即默认名；旧带后缀逻辑收进兜底函数，改动面最小。
- 决策项 4　`pickAutoAlias` / `autoAliasFor` 口径
  - a) 跟随新规则改为纯词名形态。
  - b) 保留带后缀形态并标注仅供旧测试。
  - **选定 a**：两者都表达「自动别名的形态」，保留旧形态会与命名规则自相矛盾。
- 决策项 5　自然科学类词的落点
  - a) 新增独立常量 `AUTO_ALIAS_WORDS_SCIENCE`，并入 `AUTO_ALIAS_POOL`。
  - b) 追加到 `AUTO_ALIAS_WORDS_EXTRA`。
  - **选定 a**：与既有「每类别一段」的阅读惯例一致，且便于守卫断言该类别已纳入。

## 规划

任务拆分：

1. `src/alias-words.ts`：新增 `AUTO_ALIAS_WORDS_SCIENCE`（240 词，已脚本去重 / 校验）；pool 并入；`autoAliasCandidate` 改纯词名、`pickAutoAlias` 改纯词名、`autoAliasFor` 语义不变；新增 `autoAliasFallbackCandidate`（带 `-hex4`）；更新顶部与 `AUTO_ALIAS_TRIES` 注释。
2. `src/index.ts`：`SessionChannelDeps` 增 `aliasFallbackCandidate`；`#autoAlias` 两阶段（纯词名走完整表 → 兜底 8 次）；失败日志不再写死「8 次」。
3. `tests/alias.test.ts`：更新词表 / 取词 / 确定性 / 候选 / 首见生成断言为纯词名形态；新增「纯词名全占满 → 兜底带后缀成功」用例；失败用例注入两路候选恒被占。
4. `tests/apply.test.ts` / `tests/service.test.ts`：来源标签断言由「ui-…-hex4」改为纯词名形态（实跑暴露的必改项，见「偏差」）。
5. 文档：`DESIGN.md` §3.1、`README.md` 别名条回写。

计划改动文件清单：

- `session-channel/src/alias-words.ts`
- `session-channel/src/index.ts`
- `session-channel/tests/alias.test.ts`
- `session-channel/tests/apply.test.ts`
- `session-channel/tests/service.test.ts`
- `session-channel/docs/DESIGN.md`
- `session-channel/README.md`
- `session-channel/docs/BACKLOG.md`（条目标记 / 收尾清理）
- `session-channel/docs/implementation/2026-10-27-auto-alias-word-only-naming.md`（本文件）

明确不做：不改键位与「无 TTL」语义；不改 `setAlias` 唯一性 / `force` 覆盖；不重命名既有旧别名；不改 `peer` / 寻址逻辑；不加音节校验；不动 TUI 与 `agent-group`。

## 实现记录

- （待补）

## 偏差

- 无

## 测试与证据

- `npm run check`（session-channel）：通过（`tsc -p tsconfig.json --noEmit`，退出码 0）。
- `npm run build`（session-channel）：通过，`dist/` 重建。
- `npm test`（session-channel）：**74 例全绿**（`pass 74 / fail 0 / cancelled 0 / skipped 0`）。首轮 2 例失败，均为旧后缀断言（`tests/apply.test.ts` / `tests/service.test.ts` 的来源标签），同步后全绿。
- 根 `npm run check`：30 包全通过（无报错输出）。
- 根 `npm test`：全部子包通过，退出码 0（尾段摘录：`session-channel pass 74 fail 0`，其余包均 `fail 0`）。
- 产物实测（`dist/src/alias-words.js`）：`AUTO_ALIAS_POOL.length === 818`；`autoAliasFor("ui-","sess-a") === "ui-cetus"`（纯词名）；`autoAliasFallbackCandidate("ui-","sess-a",0) === "ui-cetus-e808"`（兜底带后缀）。
- 未验证：真机 `dsh --profile fff` 状态栏 `@别名` 目视（本次别名去掉了 4 位后缀，显示风险低于上次；待人工确认）。

## 收尾

- 2026-10-27：条目「自动别名：词表纳入自然科学类词, 后缀改为纯词名占满才兜底」标「完成」并从 `session-channel/docs/BACKLOG.md` 移除（功能两区回到「暂无」）；本文件移入 `session-channel/docs/archived/`。
- 回写：`docs/DESIGN.md` §3.1、`README.md` 别名条（已在本任务内完成）。
- 人工确认：用户在收尾前选择「确认通过, 收尾并提交」；真机 `dsh --profile fff` 的 `@别名` 目视未单独执行（本次别名变短，风险低于上次）。
- 遗留：无。
