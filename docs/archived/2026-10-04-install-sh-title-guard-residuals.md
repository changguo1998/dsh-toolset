# install.sh 标题 provider 守卫残余（接取条目：`docs/BACKLOG.md`「install.sh 标题 provider 守卫残余」）

状态：关闭　　开启：2026-10-04　　关闭：2026-10-04
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

清掉上一条（显式开关落地）留下的六点残余：① `--sync --force` 覆盖用户 patch 后接管片段丢失且判不出活跃条目；② awk 取 provider/model 不限条目边界（多条目 / 注释行时取错）；③ 单个 marker 覆盖「禁用 / 路由」两段 → 路由 warn 后永不重试；④ payload 的 `- id:` 硬编码（官方换 id 会追加未命中条目）；⑤ 文件头 marker 与 payload 不自愈；⑥ awk 起点可能落在注释行（实测 fff 侧属侥幸）。

## 调研（现状，`scripts/install.sh` 上一条落地后的形态）

- 守卫段：`--sync` 单独只提示（不改写）；带 `--take-over-title` 时以「活跃行存在」为前置，追加禁用块（`- id:` 硬编码）+ 单个文件头 marker + 路由块（awk 从\*\*首个匹配（含注释）\*\*扫到文件尾取 provider/model）。
- 资产复制（`:408-420`）先于守卫段：`--force` 会用 `profiles/example/cordis.patch.yml` 覆盖用户 patch（示例里的官方行是**注释**）→ 覆盖后「活跃行」为空、marker 也没了 → 接管与路由信息静默丢失。
- 幂等：单个 `title-takeover marker v1`（文件头）latch 两段；路由 warn 后不再重试。
- 测试：`scripts/test-install.sh` 7a-7g（65 项）；`- id:` 断言已用 `assert_active_count_eq`（示例 patch 有注释行）。

## 决策（待审阅）

1. **①：禁止 `--sync --force` 组合**（`die`，文案给出两条出路：`--force` 后重跑 `--sync --take-over-title` 重建接管，或只用 `--sync`）。理由：覆盖语义 = 回到示例 patch（官方行是注释、无冲突），「覆盖后再自动补接管」既无 latch 可依、又与「不静默改写」相冲；二选一更清晰。**不做**：覆盖后自动重放。
1. **②⑥：awk 限定条目块 + 只认活跃行**：起点 = 首个**非注释**匹配行；终点 = 该条目之后第一个 `- ` 项（或 EOF）；块内取首个 `provider:` / `model:`（两个独立取值函数，不用 TAB 分隔技巧）。另立 `title_entry_id`：取命中行所在条目内最近的 `- id:` 值（覆盖 `- name:` 形态的命中行）。
1. **③⑤：两条独立 latch marker（禁用 / 路由）+ 内容为准补齐**：文件头写 `title-takeover marker v1` 与 `title-takeover route marker v1` 两行；带 `--take-over-title` 时按内容补齐——缺禁用块补禁用块（补了才写接管 marker）、缺路由块且能取到 provider/model 才补路由（补了才写路由 marker）；取不到值只 warn、**不写路由 marker** → 下次带开关会重试。**裁定**：不自动自愈（普通 `--sync` 只提示）；「带开关 = 重放 / 自愈许可」——与「不静默改写」一致。
1. **④：payload id 从命中条目取**（`title_entry_id`，缺失回退 `session-title-all-prompts-llm`）；payload 注释同步说明。
1. **备份仍一次写入一次**（惰性 `title_backup_once`）；dry-run 只打印；marker 写入沿用就地重写（跟随软链 / 保权限）。
1. 文档：`--help` 的 `--take-over-title` 段补「可重放 / 自愈 / 撤销」口径；`--sync` 段与 `README` 中英的幂等段按需微调；`profiles/example` 注释不动。

## 规划

- 计划改动文件清单（**只改这些**）：`docs/BACKLOG.md`（状态）、本追踪文档、`scripts/install.sh`、`scripts/test-install.sh`、（必要时）`README.md` / `README.zh.md`。
- 验证：`sh -n scripts/install.sh` / `sh -n scripts/test-install.sh`；`sh scripts/test-install.sh`；撤修复必红（逐项：撤 `--sync --force` 禁止 → 用例红；撤条目块限定 → 用例红；撤路由重试 → 用例红；撤 id 提取 → 用例红）；根 `npm run check`。
- 明确不做：fff 侧清理；自动自愈（裁定不做）；`--sync` 的「移除」语义（下一条）。

## 实现记录（2026-10-04）

- **决策修订（采纳审阅建议，替换决策 2/3/4 的形态）**：放弃「两条文件头 latch marker」，改为**生成区 sentinel + 内容为准**——判定全部读 patch 内容（命中条目按官方包名 token 边界匹配、禁用态按「条目 id + `disabled: true`」认、生成区按 `# install.sh generated: title-takeover-{disable,route} v1` 认）；带开关时只补缺（禁用块 / 路由块），取值失败只 warn 且**不留 latch** → 下次带开关自动重试；**删除生成区 = 放弃接管**（旧文件头 marker 在带开关时清理）。理由：内容即真相，latch 是冗余状态且与「删块即放弃」互相打架。
- ① 按审阅修正：`--sync --force` 无条件 `die`（文案给出真实出路：`--force` 不重建接管——示例 patch 里官方行是注释；恢复靠 `.bak` 或重挂官方行）——同时消掉「清单走 sync 分支、资产走 force」的语义分裂；`--force` 覆盖含生成区 / 旧 marker 的 patch 时**只读检测 + 告警**，`backup()` 打印真实备份路径。
- ②⑥ 按审阅收紧：状态解析改用 node 单次结构化扫描（约 60 行内联）：只认活跃行、条目按最内层 `- ` 项 + 缩进定边界、取值白名单清洗（剥成对引号 / 去行内注释；含空格或非法字符 = 取不到）、id 取自条目本身（不再是硬编码默认 id）；搜索串按 token 边界匹配。
- ③⑤ 状态机：首次接管补禁用 + 路由 + 两段 sentinel；半成品（有禁用无路由）带开关重试补路由；用户删块后普通 `--sync` 仍**字节不变**、带开关按内容补回；旧 marker 清理；过期生成区（id 已无活跃条目）只 warn 不自动删；生成区位置在命中条目**之后**才有效（宿主按 patch 顺序索引），位置不对时重放到文件尾 + warn 旧块位置。
- 代码：`scripts/install.sh`（`--sync --force` 校验、守卫段重写为生成区口径、`backup()` 打印路径、资产循环 `--force` 告警、`--help` 文案）、`scripts/test-install.sh`（7a-7j 重写 + `install_expect_fail` 助手）。
- 未做 / 记账：`fff` 侧死行清理（属 fff 仓库，条目原文）；路由 config 的「整键替换」只加注释说明（不做 YAML 合并）；README 的中英逐句同构。

## 测试与证据

- `sh -n` 两脚本通过；`sh scripts/test-install.sh`：**77 项通过**（原 65 项）。
- 反向验证（临时突变 → 跑全量 → 逐项必红 → 还原 `cmp` 通过 → 复绿 77）：
  - m1 撤「取值限定在条目块内」（换回旧的一次性 awk）→ 必红（落点 = 7e 的「取不到值时 warn」——旧 awk 把别处的 provider/model 取了回来）；
  - m2 撤「id 取自命中条目」（写回硬编码默认 id）→ 必红（7f：`- id: my-title-llm` 只 1 处）；
  - m3 撤「`--sync --force` 禁止」→ 必红（7g：该组合退出 0）；
  - m4 撤「路由补齐」→ 必红（7b：`provider: ustc` 只 1 处）。
- 真机（fff）未跑：fff 侧死行与 pin 属 fff 仓库；本仓只保证「不再静默改写 + 可重放 / 可撤销」。

## 收尾

- 回写：`README.md` / `README.zh.md`（幂等段：`--sync --force` 互斥、生成区重建 / 删除即放弃）、`profiles/example/cordis.patch.yml` 注释口径、`--help`（上一版「删 marker」撤销口径已过时，改为「删生成区」）。
- 新发现问题：无（审阅建议的「两 latch」方案未采纳，理由记录在决策修订）。
- 本文件移入 `docs/archived/`；`docs/BACKLOG.md` 清理所接条目并重新编号、同步 §2 顺序依据。
- 临时产物：`tmp/ti*.out` / `tmp/mutate.js` / `tmp/install.sh.pristine` / `tmp/probe/` 已删；无残留。
