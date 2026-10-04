# md-map ref token 解析三处缺口（接取条目：`md-map/docs/BACKLOG.md`「ref token 解析层缺口（三处）」）

状态：进行中　　开启：2026-10-04　　关闭：—

## 计划改动文件清单（只改这些）

- `md-map/src/indexer.ts`（ref 分支：锚点拆分 / 目录形态磁盘兜底 / 裸名唯一命中兜底）
- `md-map/tests/refs.test.ts`（新增 2 例：三处补口 + 裸名歧义不猜）
- `md-map/README.md`（`ref` 边语义与 `callers` 行的锚点口径）
- `md-map/docs/BACKLOG.md`（条目标进行中 → 收尾移除）
- 本追踪文档

## 调研（已核）

- **① 锚点不拆**：`REF_TOKEN_RE = /^(?!https?:\/\/)(?!-)(?!#)[^\s`\]+$/``` 允许 `` ```x.md#sec``` `` 进候选，但解析层把整串当路径交给 ```wikiCandidates`——`hasExt`判为 false（结尾是`#sec`）→ 生成 `x.md#sec.md`/`x.md#sec/README.md\` 一类候选 → **永不命中**（既不产边也不落 file）。
- **② 目录形态无兜底**：扫描器已剥尾斜杠（`` `docs/archived/` `` → `docs/archived`），`wikiCandidates` 只造**文件**形态候选（`.md` / `/README.md` / `/index.md`）→ 真实存在的目录永远 0 命中；wiki 分支有 `existsOnDisk` 兜底落 `file` 边，ref 分支没有。
- **③ 跨模块裸名**：候选序只有「root 相对」与「源目录相对」两处，`` `SPEC.md` ``（真实位置 `TUI/docs/SPEC.md`）解析不到。
- 计数口径：未命中 token 计 `refUnresolved`（`.md` 结尾另计 `refUnresolvedMd`），不进断链——补口后这些计数应下降。

## 决策

1. **① 用 `splitHref` 拆锚点**（与普通链接同一工具），边落 `path` 部分、`anchor` 随边带上；纯 `#anchor` token 本就被 `REF_TOKEN_RE` 排除，不受影响。
1. **② 目录兜底：只认目录 + 出边必须是 root 内规范化路径**（两轮审阅后定稿）：判定用 `stat().isDirectory()`（名含点的目录 `docs/v1.0` 也算；初版按「无扩展名形态」判、被审阅指出误拦）；**md 文件形态不兜底**——否则「被 `exclude` 挡住的文档」会绕过滤命中，且示例路径都算边（既有用例 `indexer：被 exclude 挡住的 ref 计入未解析` 正是守卫）。候选（root 相对 `raw` / 源目录相对 `resolveDocPath`）统一过 `normalize` + 包含性检查，拒绝 `..` 开头 / 绝对路径 / 空路径；`raw === ""`（query-only）直接不兜底。旁注：目录 / 文件兜底**不受 `exclude` 约束**（与既有 `file` 边兜底一致）。
1. **③ 裸名兜底按「唯一同名」**：索引内 `doc === raw || doc.endsWith('/' + raw)` 恰好 1 个才命中；多个同名**不猜**（歧义宁缺毋滥，仍计未解析）。只对「不含 `/` 且以 `.md` 结尾」的 token 生效，避免误伤正常相对路径。
1. **不改** `wikiCandidates`（共享给 wiki 链接；改它会连带改变 wiki 解析序），三处补口都局部落在 ref 分支。

## 实现记录（2026-10-04）

- `indexer.ts` ref 分支重写（初版 + 审阅后修订）：先 `splitHref(target)` 得 `refPath` / `refAnchor`；用 `refPath` 走候选序；`hits.length === 0` 时依次尝试 ③ 裸名唯一命中、② **目录**兜底（新增 `isDirectoryOnDisk()` 助手，候选 = `raw` 与 `resolveDocPath(from, raw)`，`raw` 为空或以 `..` 开头则跳过）；命中时 `ref` 边带 `anchor`；全不中才 `return undefined`（保持「不计断链」）。
- 出边目标口径（第二轮审阅后补）：候选经 `normalize` 去尾斜杠 + 拒绝 `..` 开头 / 绝对路径 / 空路径；`raw === ""`（query-only href）直接不兜底（否则 `resolveDocPath(from, "")` = 源目录，会产出指向自身目录的假边）。
- 锚点校验复用**下游既有机制**：`edge.anchor` 不存在的 ref 边与普通链接同路（`anchorOk = false` + `missing-anchor` 破链），故 ① 不另写校验（`file` 边不参与锚点校验，`docs/archived#sec` 的锚点按既有口径不落）。
- README：`ref` 行补「三处补口（2026-10-04）」；`callers` 行的「ref 边不带锚点」改为「ref 边可带锚点」。

## 测试与证据（2026-10-04）

- `md-map`：`npm run check` ✓、`npm test` **49 例全绿**（既有 45 + 新增 4；既有 ref / wiki / exclude 用例零回归）。
- 新增用例：①「ref 三处补口」——`` `docs/a.md#sec` `` 落 `docs/a.md` 且 `anchor === "sec"`；`` `docs/archived` `` 落 `file` 边；`` `SPEC.md` `` 唯一命中 `TUI/docs/SPEC.md`；`refUnresolved === 0`。②「裸名歧义不猜」——两个 `SPEC.md` → 不产边且 `refUnresolved === 1`。③「目录兜底边界」（审阅后补）——不存在目录 / 越界（`../../outside-root`）/ 空路径形态（`?a/b#c`）**均不产边**且仍计未解析；名含点目录 `docs/v1.0` 落 `file` 边；源目录相对目录形（`deep/notes.md` 里的 `sub/dir` → `deep/sub/dir`）落 `file` 边。
- 反向验证（脚本式，未留痕）：`git stash` 撤掉 `indexer.ts` 的改动 → ①③④ 三例红（②歧义例在改动前后同为「不产边」，不红符合预期）；恢复后 49 例全绿。

## 子代理审阅

（决策后 / 收尾前各一轮，记录见下）

### 决策后（2026-10-04）

只读审阅（47 例全绿 + 临时探针实测）。结论「需改」，主诉求①②③ 判定为解决，但实现口径要收口：

1. **[重要] ② 候选未做逃逸检查**：初版把 `raw` 直接当出边目标 → `../outside-dir`（无扩展名）产出 `to: "../outside-dir"` 的 `file` 边且不计未解析。→ 现在 `raw` 为空或 `..` 开头直接跳过，源目录候选走 `resolveDocPath`（返回 `null` = 仓库外 → 丢弃），保证出边目标恒为 root 内规范化路径。
1. **[次要] `hasExt` 门误拦名含点的真目录**（`docs/v1.0`）→ 改为 `stat().isDirectory()` 判定（顺带把「不与 md 文件兜底冲突」变成结构保证，而非依赖扩展名猜测）。
1. **[次要] 决策 2 的「与 wiki 同口径」依据不成立**（wiki 兜底只覆盖带扩展名形态）→ 已在「决策」条目改为「与**文件引用**分支同口径」，并写明目录 / 文件兜底不受 `exclude` 约束的既有事实。
1. **[次要] ① 锚点不校验**（`a.md#no-such` / `a.md#b#c`）→ 实查：下游既有机制已覆盖（`anchorOk = false` + `missing-anchor` 破链，与普通链接同路），故不另写校验；`file` 边不参与锚点校验（`docs/archived#sec` 的锚点按既有口径不落），已在实现记录写明。
1. **[次要] 缺边界守卫** → 补「目录兜底边界」用例（不存在目录 / 越界 / 空路径形态 / 名含点目录 / 源目录相对目录形）。

### 决策后（第二轮，2026-10-04）

收尾前审阅又测出两处（同一成因：候选未统一规范化），已修 + 补用例：

1. **[重要] 中段 `..` 逃逸**：`docs/../../outside/dir`（root 外目录真实存在）产出 `to:"docs/../../outside/dir"` 的 `file` 边且不计未解析（`startsWith("..")` 只挡开头）。→ 候选统一 `normalize` + 包含性检查；补「越界口径」用例：中段 `..` 归一后落在 root 内（`docs/../docs/archived`）命中且 `to` 无 `..`、真越界不产边且计未解析、`sub/page.md` 的 `../docs` 命中 `docs`，并**全量断言所有出边目标不含 `..` / 不以 `/` 开头**。
1. **[次要] `../docs` 被误拦**：原实现把整块 gate 在 `!raw.startsWith("..")`，源目录相对但落在 root 内的形态被一并拒绝。→ 改为逐候选判定（`../docs` 经 `resolveDocPath` 归一为 `docs` 后命中）。
1. **[次要] 「尾斜杠已剥掉」被质疑**：实探 `scanInlineRefs(["`docs/archived/`"])` 得 token `docs/archived`——**确已剥掉**，README 该句保留；同时把「normalize 去尾斜杠」作为第二道保险写进代码（上游形态变化也不会产出带斜杠 / 越界的 `to`）。

## 收尾

- 条目从 `md-map/docs/BACKLOG.md` 移除（该表随后为空，按模块惯例置「（当前无未完成项）」）。
- 本追踪文档移入 `md-map/docs/archived/`；本次变更合并为一次提交（`indexer.ts` + 测试 + README + BACKLOG + 归档文档），提交见 git 历史。
- 复跑记录：`npm run check`（根，20 包）✓、`npm run build` ✓、`md-map` `npm test` **49 例** ✓。
- 审阅记录说明：「收尾前」审阅即上面的第二轮（测出中段 `..` 逃逸与 `../docs` 误拦，均为实现问题）；修复后以**定向用例 + 反向验证**确认（①③④ 三例在撤掉改动时必红），未再开第三轮子代理审阅。
