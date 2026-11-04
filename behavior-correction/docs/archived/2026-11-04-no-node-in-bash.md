# bash 直跑 node 补拦截规则, 改用 script_run（接取条目：behavior-correction/docs/BACKLOG.md「bash 直跑 node 补拦截规则, 改用 script_run」）

状态：关闭　　开启：2026-11-04　　关闭：2026-11-04
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

在 `behavior-correction` 的内置规则表里新增一条与 `no-python-in-bash` 同构的规则
`no-node-in-bash`: bash 命令位直接跑 `node` 时拒绝, 并在理由里指向 `script_run`
（script-interpreter 插件）, 与既有 python 规则的拦截语义与文案风格保持一致。

## 调研

（来源：既有文档 / 本仓源码）

- `behavior-correction/src/index.ts` 内置规则形态: `RuleSpec` 带 `id` / `tool` /
  `match.regex` / `reason` / `description`; python 规则正则认命令位（行首 / `;` `&` `|`
  之后 / `$(` 之后, 允许前置 `VAR=值` 与路径前缀）, `echo python` / `.py` 扩展名 /
  `pip` 不拦（`src/index.ts:115-130`）。
- 判决文本 = bash 取 `arguments.command` 原文, 正则默认 flags `i`（`toolText`,
  `src/index.ts:324-340`）。
- `script-interpreter/src/langs/node.ts` 的 Node 后端只把 `node` 列为 PATH 候选
  （`candidates: ["node"]`）, 不认 `nodejs`; 说明被拦的 `node` 调用一定可被 `script_run`
  承接, `nodejs` 在 script_run 侧也探不到。
- 内置规则 id 清单在 `tests/main.test.ts:106` 的 `resolveConfig` 断言里硬编码, 需同步。
- `README.md:26` 写「缺省规则（两条）」并带规则表, 需同步为三条。

## 决策

1. 匹配的命令名范围:
   - a. 只认 `node`
   - b. 认 `node` / `nodejs`
   - c. 认 `node` / `nodejs` / `npm` / `npx`
   - 选定 **a**: script-interpreter 的 node 后端只探测 `node`, 规则只拦能被 `script_run`
     承接的命令, 避免拦 `nodejs` 后无工具可用的空指路; `npm` / `npx` 是包管理入口不是
     解释器, 与「python 规则不拦 `pip`」的口径一致。
2. 正则形态: 整体复刻 python 规则的正则骨架, 词干换成 `node`, 且用 `(?=\s|$)` 收尾,
   天然排除 `nodemon` / `node-gyp` / `node_modules` 等前缀词。
3. 规则顺序: 插在 `no-python-in-bash` 之后（herdr → python → node → view-text）,
   与「脚本解释器类规则相邻」的自然顺序一致。
4. 文案: reason 与 description 仿照 python 规则, 指路 `script_run`（script-interpreter
   插件）执行 Node 脚本或语句。
5. 途中发现: `README.md` 内置规则表缺 `no-view-text-in-bash` 一行, 且标题写「两条」
   （实际已三条）——既有缺陷。用户 2026-11-04 决定: **本次一并补全**（表格列全四条,
   标题改「四条」）。

## 规划

任务拆分:

1. `src/index.ts`: 文件头「内置缺省规则」注释与 `DEFAULT_RULES` 各加一条
   `no-node-in-bash`; 文件头第 10-12 行「缺省规则只有一条」的过时描述已含 python /
   view-text 两条, 本次顺带改写为列出全部内置规则（属本次改动的文档同步）。
2. `tests/main.test.ts`: 同步 `resolveConfig` 的 id 断言; 新增「命令位跑 node → 拒绝并
   指向 script_run」与「正文提到 node / npm / npx 不拦」两组用例。
3. `README.md`: 「缺省规则（两条）」改四条, 规则表追加 node 行并补全缺失的
   view-text 行（用户批准的既有缺陷一并修复）。

计划改动文件清单:

- `behavior-correction/docs/BACKLOG.md`（新建条目, 本次接取已标进行中）
- `behavior-correction/docs/implementation/2026-11-04-no-node-in-bash.md`（本文件）
- `behavior-correction/src/index.ts`
- `behavior-correction/tests/main.test.ts`
- `behavior-correction/tests/index.test.ts`（**中途补入清单**：内置规则数断言 3 → 4,
  新增规则的机械必要配套, 不改不通过）
- `behavior-correction/README.md`

明确不做:

- 不改 `script-interpreter`（node 后端已存在, 无需新增能力）。
- 不改根 `README.md` / `AGENTS.md` 的 behavior-correction 概览描述——根级概览只点
  herdr 一条是既有简略口径, 不属本次「新增一条规则」的范围, 如需让根概览列出全部
  内置规则另开条目。
- 不改 profile 配置（缺省规则表自动随构建生效, `rules` 覆盖是用户方配置）。

## 实现记录

- 2026-11-04 `src/index.ts`: 新增 `no-node-in-bash` 规则（`id` / `tool: "bash"` /
  `match.regex` 命令位 `node` / `reason` / `description`）, 插在 `no-python-in-bash` 之后;
  文件头「缺省规则」注释改写为列全四条（原「只有一条」描述早已过时, 本任务同步）。
- 2026-11-04 `tests/main.test.ts`: `resolveConfig` 规则 id 断言加入 `no-node-in-bash`;
  新增两组用例「bash 命令位跑 node → 拒绝并指向 script_run」（7 条命令）与「正文提到
  node / npm / npx 或可执行名带 node 前缀不拦」（8 条命令, 含 nodemon / node-gyp /
  cd node_modules）。
- 2026-11-04 `README.md`: 「缺省规则（两条）」改「四条」, 规则表追加 node 行, 并补全
  既缺的 view-text 行（用户批准）。

## 偏差

- **无**实质偏差。计划清单中途补入 `tests/index.test.ts`（内置规则数断言 3 → 4,
  新增规则的机械必要配套, 已在「规划」标注并按用户「继续」的指示直接修改）。

## 测试与证据

- `behavior-correction` `pnpm run check` / `pnpm run build`: 退出 0（tsc 无告警）。
- `pnpm run test`: 48/48 通过; `pnpm run test:integration`: 13/13 通过。
- 新增用例行为（`tests/main.test.ts`）: 命令位 `node` / `node -e` / `node --version` /
  `node scripts/gen.js` / `ls && node …` / `FOO=1 /usr/bin/node -v` / `x=$(node -p …)`
  均拒绝且理由含 `script_run`; `echo node` / `grep -rn node` / `npm install` /
  `npx tsc` / `nodemon` / `node-gyp` / `cd node_modules` 均放行。
- 根级 `pnpm run check:docs`: 通过, 错误 0 / 警告 0（112 篇文档 / 901 个 .ts）。
- **未做真机确认**：规则改动需重建 profile 后由人工实测（bash 跑 `node -v` 应被拒并
  指路 `script_run`, `npm install` 等应放行）; 本机 profile 未重装, 留待用户择时验证。

## 收尾

- 回写文档: `behavior-correction/README.md`（缺省规则四条 + 表格补全 node / view-text 行,
  view-text 缺行是既有缺陷, 用户批准本次一并补全）。
- BACKLOG: 条目 #1 已完成, 从清单清理移除, 关闭记录以归档注释留在 BACKLOG。
- 追踪文档移入 `behavior-correction/docs/archived/2026-11-04-no-node-in-bash.md`。
- 遗留: 真机确认（见「测试与证据」末条）; 需要时在另一台机器重跑
  `scripts/install.sh --profile fff --sync` 使主 profile 生效。
