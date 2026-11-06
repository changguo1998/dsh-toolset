# auto-approve 改用 shell-parse（接取条目：docs/BACKLOG.md「auto-approve 改用 shell-parse（删掉切段 / 分词副本）」）

状态：进行中　　开启：2026-11-06
**并行任务**：本条在独立 worktree / 独立分支实施（见「并行约定」）；本文件是本任务唯一的追踪文档与文档改动位置，计划外的文件不改。

## 目标

删掉 `auto-approve/src/learn-rules.ts` 里的切段 / 分词副本，改用 `@dsh-toolset/shell-parse`；
**抹值口径（`maskToken`）与段形态（`segmentForm` / `formOfCommand`）留在本包**，
指纹与学习规则（白名单命中、规则学习）行为不变。

## 调研

（来源：本仓源码）

- 本地副本：`src/learn-rules.ts:50`（`splitCommandSegments`，返回 `{ segments, balanced }`）/
  `:83`（`tokenizeSegment`，`{ value, quoted }[]`，粘引号先断开）/ `:125`（`maskToken`）/
  `:137`（`segmentForm`，段首词原样、其余抹值）/ `:147`（`formOfCommand`）。
  `:46` 注明「本包复制 25 行实现，不引入跨包依赖 —— 抽公共模块属跨包改动，另立条目」。
- 消费点：`src/decide.ts:165`（`formOfCommand(command)` 匹配白名单）、
  `src/learn-observe.ts:385/411/582`（学习观测）、`src/fingerprint.ts`（会话指纹）与
  `tests/learn.test.ts`（直接 import 这两个函数测切段 / 分词）。
- `shell-parse` 的分词比本地实现多支持：反斜杠转义、双引号内 `\"` 转义、`''` 空词仍然成词；
  这些差异**可能改变段形态**，必须先取基线再比对。

## 决策

1. **依赖形态**：`package.json` 加
   `"dependencies": { "@dsh-toolset/shell-parse": "link:../shell-parse" }`，直接 import 纯函数。
2. **迁移范围**：删 `splitCommandSegments` / `tokenizeSegment` 两个本地实现与其类型，
   改从包 import（`CommandToken` 也改用包导出的类型）；`maskToken` / `segmentForm` /
   `formOfCommand` 保留在 `learn-rules.ts`（属本包语义）。
3. **守成基线**：动手前先跑一个临时脚本，对 12 条样例命令（普通 / 引号内分隔符 / 粘引号 /
   多段 / `&&` / 管道 / 空引号 / 反斜杠转义 / 双引号内转义 / 单段长参数 / 变量赋值 / 命令替换）
   打印 `formOfCommand` 结果并留在追踪文档里；迁移后逐条比对，任何差异必须在文档中写明原因
   （预期差异只来自包分词对转义的处理更正确）。
4. **`balanced` 语义不变**：`formOfCommand` 仍要求引号配对，不配对返回 `undefined`（不猜）。
5. 不改指纹算法、白名单匹配、学习观测与配置项。

## 规划

计划改动文件清单：

- `auto-approve/package.json`（加 `link:` 依赖）
- `auto-approve/src/learn-rules.ts`（删本地切段 / 分词，改 import；保留抹值与段形态）
- `auto-approve/tests/learn.test.ts`（import 路径与断言随迁移调整；转义差异若改变样例，按新口径更新）
- `auto-approve/tests/fingerprint.test.ts`（若 import 了被删函数才改）
- `auto-approve/README.md`（解析层来源说明，若原文提到「本包复制 25 行」需改）
- `auto-approve/docs/implementation/2026-11-06-shell-parse-migration.md`（本文件，收尾归档）

明确不做：

- 不改指纹 / 白名单 / 学习规则 / 审计的判定逻辑。
- 不动 `security-guard` / `behavior-correction` / `shell-parse` 任何文件。
- 不加新工具、不改 `cordis.patch.yml`。

## 验证

- `pnpm -C auto-approve run check` / `run build` / `run test` / `run test:integration` 全绿。
- 段形态基线逐条比对结果写进「实施记录」；差异只允许是「转义处理更正确」这一类，且需说明。
- `git diff` 自查：`learn-rules.ts` 内不再有本地切段 / 分词实现。

## 并行约定

- 工作目录：独立 worktree（`/home/guochang/Projects/dsh-toolset-wt/auto-approve`），分支
  `task/auto-approve-shell-parse`；主仓目录不动。
- 只改「计划改动文件清单」里的文件；其余包一律不碰。
- 完成后：`format` 改动文件 → `pnpm -C auto-approve run check && build && test && test:integration` → 回填本文件「实施记录 / 验证」→ 状态改「关闭」→ 移入
  `auto-approve/docs/archived/` → 在本分支 `git commit`（不 push、不合 main）。
