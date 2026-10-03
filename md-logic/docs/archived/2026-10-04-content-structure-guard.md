# content 结构校验（接取条目：`md-logic/docs/BACKLOG.md`「`content` 无结构校验」）

状态：关闭　　开启：2026-10-04　　关闭：2026-10-04
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`replace` 的非空 `content` 必须以**标题行**开头（ATX / setext），否则返回 `content_invalid`（防「该节被静默并入父节、节从节树消失」）；空串 = 删除该节（既有语义不变）；成功渲染追加「结构可能已变，继续改请重新 structure」提示。

## 调研

- 现状：`replaceSections`（`src/edit.ts:187`）对 `content` 只校验「是字符串」（`invalidReason`，`:177`）；替换时 `lines.splice` 直接铺入 → 首行非标题即把该节并入父节；`content` 引入新标题也会改动祖先与后续节范围（与「不做插入节」的定位不符）。
- 判据来源：解析器已能识别 ATX 与 setext 标题，且报告节起始行 —— 实测 `parseMarkdownDocument`：`"# T"` → 首节 line 1；`"Title\n====="` → line 1；纯文本 → 无节；`"\n# T"` → line 2。故判据 = 「content 非空时，其首个节必须从第 1 行开始」。
- 顺序约束：既有用例以 `content: "x"`（非标题）配合错误范围来断言 `section_drift` / `missing` / `range_out_of_bounds`（`tests/edit.test.ts:63,78,85,141,189,284,290,310`）→ 新校验必须放在**定位（①）之后**，保持这些错误的既有优先级；形状校验（`edits_invalid`）与越界（`range_out_of_bounds`）仍在最前。
- 渲染：`renderReplace`（`src/render.ts:76`）成功行 `已按节替换：<path>（N 处，整批原子写）`，无结构提示。

## 决策（待审阅）

1. `src/edit.ts`：`EditFailureCode` 增 `content_invalid`；在 ① 定位后、② 重叠前加守卫——`content === ""` 跳过（删除）；否则 `parseMarkdownDocument(normalize(content)).sections[0]` 必须存在且 `line === 1`，不满足即拒（纯空白同拒：删除请传空串）。
1. `src/render.ts`：成功分支追加一行提示「结构可能已变（新标题会改动祖先与后续节范围）；继续改请重新 action=structure 取范围」。
1. `README.md`：渲染口径行与「改写面」安全语义补 `content_invalid`；「不做」条目注明仅做首行标题守卫。
1. 测试（`tests/edit.test.ts`）：纯函数面——普通文本开头拒 / 纯空白拒 / setext 放行 / 空串删除不变；工具面——成功渲染含新提示 + `content_invalid` 透传。
1. 不动：空串删除语义、漂移/重叠/越界判据与顺序、写盘原子性。

## 规划

- 计划改动文件清单（**只改这些**）：`md-logic/docs/BACKLOG.md`（状态）、本追踪文档、`md-logic/src/edit.ts`、`md-logic/src/render.ts`、`md-logic/tests/edit.test.ts`、`md-logic/README.md`。
- 验证：`md-logic` 包 `check` / `build` / `test`；撤修复必红（去掉守卫 → 纯文本开头用例由 `content_invalid` 变成功）；根 `npm run check`。
- 明确不做：不动解析器；不引入「插入节」；不校验 heading 与 `content` 首行标题的级别/文本关系（超范围，另立条目）。

## 实现记录（2026-10-04）

- 子代理只读审阅（决策后、实现前）：通过；修订与新增——① **setext 邻接反例（P1，实测复现）**：`content` 首节为 setext 且目标节前一行非空时，替换后「上一段 + content 首行」会被解析成同一个 setext 标题（`# H`/`## A`/`body A`/`## B` 替换 B → 新结构出现 `h2 "body A\nT2"`，A 节正文丢失）→ 守卫加条件：setext 首行且目标节前一行非空 → 拒并建议 ATX；② 空标题节（`#` / `#   `）虽 `line === 1` 也拒（该节此后无法用 heading 定位）；③ 模型侧契约补 `src/tools.ts`（工具描述 / edits / content 参数说明 + `parseEdits` 的「content 直取保留删除语义」注释）——原计划清单遗漏；④ 失败渲染按 code 分派（`content_invalid` 不再提示「先 structure」，改提示补标题行）；⑤ README 增补校验优先级链与 setext / frontmatter 边界说明。
- 代码：`src/edit.ts`（`content_invalid` + ①.5 守卫；`lines` 上提共享）、`src/render.ts`（成功提示 + 按 code 分派）、`src/tools.ts`（描述与注释）。
- 未做（记录为观察 / 新条目）：`heading` 与 `content` 首行标题的文本 / 级别一致性校验（另立条目）；根 README 动作列表漏 `replace`（另立项目级条目）。

## 测试与证据

- `md-logic` 包 `npm run check` / `npm run build`：exit 0；`npm test`：50 pass / 0 fail（新增 2 条纯函数用例 + 工具面用例扩展）。
- 反向验证（撤修复必红）：临时关闭守卫（`if (true) continue`）→ 3 条用例红（「必须以标题行开头」/「setext 邻接」/「工具面 replace」——后者因非法 content 被写盘）；恢复后复绿。
- 判别式覆盖：正文开头拒 / `#foo` 拒（挡 `startsWith("#")` 实现）/ 前导空行拒 / 空标题拒 / setext（前一行空行）放行 / 坏 content + 漂移 → `section_drift` 优先。

## 收尾

- 回写：`md-logic/README.md`（渲染口径行、安全语义 + 优先级链、`content` 守卫要点、不做条目、测试计数 50）。
- 新发现问题另立条目：`md-logic/docs/BACKLOG.md`「`content` 首行标题与 `heading` 不校验一致性」（P3）；项目级 `docs/BACKLOG.md`「根 README / README.zh 的 md-logic 动作列表漏 `replace`」（P3）。
- 本文件移入 `md-logic/docs/archived/`；`md-logic/docs/BACKLOG.md` 清理所接条目（仅留未完成项）。
- 临时产物：无（探测为一次性 `node -e`，未落盘）。
