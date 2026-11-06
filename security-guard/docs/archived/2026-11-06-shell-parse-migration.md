# security-guard 改用 shell-parse（接取条目：docs/BACKLOG.md「security-guard 改用 shell-parse（删掉命令解析副本）」）

状态：关闭　　开启：2026-11-06　　关闭：2026-11-06
**并行任务**：本条在独立 worktree / 独立分支实施（见「并行约定」）；本文件是本任务唯一的追踪文档与文档改动位置，计划外的文件不改。

## 目标

删掉 `security-guard/src/blacklist.ts` 里的命令解析副本，改用 `@dsh-toolset/shell-parse`
（切段 / 分词 / 包装器剥离 / 命令位解析），使 `scope: "command"` 的黑名单规则在
`uv run …` / `npx …` / `pnpm exec …` / `bundle exec …` 这类多词包装器下也能看到真正被跑的
命令。规则集、回执文案、告警口径不变。

## 调研

（来源：本仓源码）

- 本地副本位置：`src/blacklist.ts:37`（`splitCommandSegments`，返回 `string[]`）/ `:223`
  （`tokensOf`，剥引号并丢 `(){}!;`）/ `:252`（`commandName`）/ `:189`（`PREFIX_WORDS`，只有单词
  包装器）/ `:271`（`commandWords`，深度上限 2）/ `:312`（`dynamicCommandHit`）/ `:358`
  （`heredocFedShellHit`）。
- 消费点：`rmRecursiveRootHit:96`、`chmod777RootHit:157`、`dynamicCommandHit` 规则、
  `heredocFedShellHit` 规则、`matchCommand:489` 的 `scope: "command"` 分支（`pattern` 对
  `commandWords()` 逐个 `test`）。
- `security-guard` 有意把**前缀词本身**也当命令位候选（`commandWords:283` 注释「前缀词本身也可能是被禁的对象（如 sudo）」），
  所以 `sudo` 规则（`pattern: "\\bsudo\\b"`, `scope: "command"`）依赖这一点。
- `shell-parse` 的对等 API：`splitCommandSegments`（返回 `{ segments, balanced }`）、
  `tokenizeSegment`（`{ value, quoted }[]`，支持转义与双引号内转义）、`commandName`、
  `WRAPPERS`（32 条，含多词）、`stripWrappers`、`commandPositions`（含 `wrappers` 链、`source`、
  `dynamic`）、`commandWords`、`isDynamicCommand`、`isShellName`。

## 决策

1. **依赖形态**：`package.json` 加 `"dependencies": { "@dsh-toolset/shell-parse": "link:../shell-parse" }`，
   包内直接 import（与 `clock-base` 消费方同形态），不引入服务面间接层。
2. **前缀词语义要保持**：`scope: "command"` 的规则仍要能命中 `sudo` 这类包装器本身 —— 用
   `commandPositions()` 重建词表：`positions.map(p => p.word)` 加上每条 position 的
   `wrappers` 链（按出现顺序去重即可），再交给现有 `pattern.test`。
3. **切段适配**：`splitCommandSegments` 返回对象，写一个 5 行的本地适配（`segmentsOf`）即可，
   不要保留旧的字符串返回签名。
4. **分词适配**：`tokensOf` 换成 `tokenizeSegment(...).map(t => t.value)`；`rm` / `chmod` 规则里
   用 `commandName()` 对齐词形，保持「取命令词、剥路径与结构符」的原语义。
5. **递归深度**：调 `commandWords(command, { maxDepth: 2 })`，与迁移前深度一致，先保守成；
   要放宽另开条目。
6. `heredocFedShellHit` 属本包规则逻辑（heredoc 正文要按命令再扫），**保留在本地**，
   内部 shell 族判定改用 `isShellName()`；`dynamicCommandHit` 用包 `isDynamicCommand()`
   （包口径略宽：任一处动态命令位即为真，差异写进 README「边界」）。
7. 不改 `DEFAULT_COMMAND_RULES` 的规则 id / 文案 / `reason`；不改 `matchCommand` 的对外语义。

## 规划

计划改动文件清单：

- `security-guard/package.json`（加 `link:` 依赖）
- `security-guard/src/blacklist.ts`（删本地解析实现，改 import + 适配）
- `security-guard/src/index.ts`（若导出清单需跟着调整）
- `security-guard/tests/blacklist.test.ts`（迁移后仍须覆盖切段 / 命令位断言；补多词包装器用例）
- `security-guard/README.md`（解析层来源与「动态命令位」口径变化）
- `security-guard/docs/implementation/2026-11-06-shell-parse-migration.md`（本文件，收尾归档）

明确不做：

- 不改规则集、阈值、拒绝文案与告警格式。
- 不动 `auto-approve` / `behavior-correction` / `shell-parse` 任何文件。
- 不加新工具、不改 `cordis.patch.yml`。

## 验收

- `pnpm -C security-guard run check` / `run build` / `run test` / `run test:integration` 全绿。
- 新增用例：`uv run rm -rf /`、`sudo timeout 5 rm -rf /`、`pnpm exec rm -rf /` 仍命中
  `rm-recursive-root`；`echo rm -rf /`、`grep "rm -rf /" notes.md` 仍放行。
- `git diff` 自查：`blacklist.ts` 内不再有本地 `splitCommandSegments` / `tokensOf` /
  `commandWords` / `PREFIX_WORDS` 实现。

## 实施记录

（实施：2026-11-06，分支 `task/security-guard-shell-parse`）

按决策实施，落地形态与偏离如下：

01. **依赖**：`security-guard/package.json` 加 `"dependencies": { "@dsh-toolset/shell-parse": "link:../shell-parse" }`；
    包内 `pnpm-lock.yaml` 随之更新（新增 link 依赖，`CI=true` 下需 `--no-frozen-lockfile`）——计划清单没写 lockfile，
    但它是依赖安装的必然产物，一并提交。
02. **删掉的本地副本**：`splitCommandSegments` / `tokensOf` / `commandName` / `basenameOf` / `PREFIX_WORDS` /
    `SHELL_FAMILY` / `substitutionBodies` / `commandWords` / `dynamicCommandHit` 全部删除，改 import 包的对应实现。
    本地只留三个适配/规则件：`segmentsOf`（取 `.segments`）、`wordsOf`（`tokenizeSegment(...).map(value)`）、
    `commandCandidates`（`scope: "command"` 的候选词）。
03. **包装器本身仍是候选词**：`commandCandidates` = 每个命令位的 `word` + `wrappers` 链；另按段补一次
    `stripWrappers(...).wrappers` —— `sudo --version` 这类「包装器后面没有命令词」的输入解析层不落命令位，
    不补这一趟 `sudo` 规则会退化（首轮实现漏了，`tests/guard.test.ts` 的 `sudo --version` 用例抓到并已修）。
    多词包装器按整串记录（`uv run` / `pnpm exec` / `bundle exec`）。
04. **rm / chmod / systemctl 判定**：`rm` / `chmod` 保持「段内首个命令词」的迁移前语义（不剥包装器），
    只把分词与词形归一换成包实现（`tokenizeSegment` + `commandName`）；`systemctl` 保留原有「跳前导赋值 /
    选项 + 剥包装器」的取词口径（`stripWrappers`）。
05. **递归深度**：`commandPositions` / `commandWords` / `isDynamicCommand` 一律传 `{ maxDepth: 2 }`，与迁移前一致。
06. **heredoc**：规则逻辑留本地，shell 族判定改 `isShellName()`，取词改包 `commandWords()`。
07. **`dynamic-command`**：改用包 `isDynamicCommand()`（任一处命令位由展开产生即为真，比迁移前只看每段首个命令位略宽），
    差异已写进 README「边界」。
08. **对外导出**：`src/index.ts` 去掉 `splitCommandSegments` 的 re-export —— 包的切段返回 `{ segments, balanced }`，
    保留同名换签名会让调用方静默出错；仓内无其他消费方（`auto-approve` 自带自己的副本，不 import 本包）。
09. **测试**：`tests/blacklist.test.ts` 的切段 / 命令位断言改为从 `@dsh-toolset/shell-parse` 取，并按包口径改写
    （`eval 'sudo id'` 的词表变成 `["eval", "id"]`、包装器在 `wrappers` 链里）；新增「多词包装器」用例：
    `uv run rm -rf /` / `pnpm exec rm -rf /` / `bundle exec rm -rf /` / `sudo timeout 5 rm -rf /` 命中
    `rm-recursive-root`，`uv run mkfs.ext4 /dev/sdb1` 与 `pnpm exec sudo id` 命中命令位规则。
    另修 `tests/script.test.ts` 的发布形态 fixture：`dist` 现在会 import 运行时依赖，假安装包需软链
    `node_modules`，否则动态 import 解析失败被误判「口径来源缺失」（计划清单外，属迁移的连带影响）。
10. **未改**：`DEFAULT_COMMAND_RULES` 的 id / 文案 / `reason`、回执文案、敏感文件层、`cordis.patch.yml`、其他包。

**与任务要求的已知差异**：`echo rm -rf /` 并不放行 —— 它由 `rmRecursiveRootHit` 的整文本兜底正则
`EMBEDDED_RM_RE` 命中（决策 7 要求不改规则语义，故保留）；命令位层面的结论是用例里锚定的
`commandWords("echo rm -rf /") === ["echo"]`。新增用例因此不写「`echo rm -rf /` 放行」，改锚定命令位。

## 验证

（2026-11-06，本 worktree）

- `pnpm -C security-guard run check`：通过。
- `pnpm -C security-guard run build`：通过。
- `pnpm -C security-guard run test`：`tests 161 / pass 161 / fail 0 / skipped 0`。
- `pnpm -C security-guard run test:integration`：`tests 14 / pass 14 / fail 0`。
- `format` 已跑（package.json / pnpm-lock.yaml / blacklist.ts / index.ts / blacklist.test.ts / script.test.ts / README.md）。
- `git diff` 自查：`blacklist.ts` 内已无 `splitCommandSegments` / `tokensOf` / `commandWords` / `PREFIX_WORDS`
  的实现（仅 import + 适配），grep 无残留。
- 未验证：真机 profile 安装形态（`scripts/install.sh` 对嵌套 `link:` 依赖已有 overrides 处理，本任务不改；
  需要时在合并后跑一次安装验收）。

## 并行约定

- 工作目录：独立 worktree（`/home/guochang/Projects/dsh-toolset-wt/security-guard`），分支
  `task/security-guard-shell-parse`；主仓目录不动。
- 只改「计划改动文件清单」里的文件；其余包一律不碰。
- 完成后：`format` 改动文件 → `pnpm -C security-guard run check && build && test && test:integration` → 回填本文件「实施记录 / 验证」→ 状态改「关闭」→ 移入
  `security-guard/docs/archived/` → 在本分支 `git commit`（不 push、不合 main）。
