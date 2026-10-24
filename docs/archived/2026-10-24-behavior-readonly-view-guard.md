# behavior-correction 拦截纯只读查看文本的 `sed` / `head` / `tail` 等 bash 命令（接取条目：`docs/BACKLOG.md`「behavior-correction 拦截纯只读查看文本的 sed / head / tail 等 bash 命令并指路」）

状态：已关闭　　开启：2026-10-24　　关闭：2026-10-25
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
本轮范围只到**调研与决策**（实现待用户批准后另接），除本文件外任何文件都不改。

## 目标

给 behavior-correction 增加一条内置规则（`tool: bash`）：命令位出现**纯只读查看用途**的 `sed` / `head` / `tail`（及同类只读查看命令）时拦截，理由指向应改用的专用工具（读文件 `read` / 搜索 `grep` / 摘要 `fs_digest` 等）；界定「纯只读」判定（`sed -i` 等写参数不拦），沿用文本判定、不解析 shell 语义，宁漏不误伤；补 `tests/main.test.ts` 命中与放行用例。

## 调研

### 1. 现有两条规则怎么判（判定链路）

- 入口：`apply` 把本包注册成 rule-engine 的 `tools/pre-execute` guard 消费者（`behavior-correction/src/main.ts:312-357`，注册闭包 `:334-339`）；命中返回 `{kind:"deny", reason}`，未命中返回 `undefined` 弃权。
- 判定文本：`toolText` 对 `bash` / `pwsh` 直接取 `arguments.command` 原文，不加工具名前缀（`src/main.ts:249-261`）；其余工具取「工具名 + JSON 序列化参数」。本包拿到的是**命令原文**，没有 argv 视图。
- 规则形态：`RuleSpec` = `id` / `tool` / `match{keywords,regex,flags}` / `reason` / `description`（`src/main.ts:53-71`）。`match` 内部是**或**语义：关键词（子串、编译时转小写，`:218`）或任一正则命中即算命中（`src/main.ts:283-288`）；**没有**「命中 A 且不命中 B」的表达能力。
- 命令位判定（前缀词表）：两条规则共用同一前缀 `(?:^|[;&|]\s*|\$\(\s*)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*/)?`（herdr 在 `src/main.ts:95`，python 在 `:110`），含义 = 行首、`;` `&` 或竖线之后、`$(` 之后，允许前置 `变量=值` 与绝对路径；命令名后用 `(?=\s|$)` 收边界；flags 固定 `"im"`，`g` / `y` 在编译时被剥掉（`:203`）。
- 取第一条命中：规则按声明顺序串行（`src/main.ts:283-288`）；两条缺省规则都限定 `tool: "bash"`（`:90`、`:105`），`pwsh` 不覆盖。
- 拒绝文案：`reason` 是一句中文、写明该改用哪些工具（`:99-101`、`:114-115`），随工具回执回给模型；rule-engine 另打一行告警。两次都靠「一句话列全所有落点」表达，没有分命令映射。
- 边界与约定：README 明写不解释 shell 语义（管道 / 别名 / 变量展开 / 引号 / heredoc），宁可漏拦也不误伤（`behavior-correction/README.md:87-88`）；缺省开启（`cordis.patch.yml:9-13`）；`rules` 给即整体替换（`src/main.ts:128-133`）。

结论：新规则可完全复用命令位前缀与 `reason` 机制，缺的只有**排除项**（`-i` / `-f` / 重定向 / 管道下游等），而 `match` 的或语义表达不了。

### 2. 候选命令与等价专用工具

| 命令 | 典型只读用法 | 等价专用工具 | 建议 |
| --- | --- | --- | --- |
| `sed -n 'a,bp'` | 取行段 | `read`（`offset` + `limit`） | 拦 |
| `sed 's/a/b/'` | 文本变换 | 无（改写走 `edit` / `hash_edit` / `ast_replace`） | 放：不是查看 |
| `head` | 前 N 行 | `read`（`limit`） | 拦 |
| `tail` | 后 N 行 | `fs_digest pruned`（头尾各裁一段）；`read`（`offset`，需先知道总行数） | 拦，弱等价，文案写「读行段」 |
| `cat` | 全文 | `read` | 拦 |
| `less` / `more` | 分页 | `read` / `fs_digest`（非交互 bash 下分页无意义） | 拦 |
| `nl` | 带行号 | `read`（回执本身带行号） | 拦 |
| `tac` | 逆序 | 无（`read` 不能逆序） | 放 |
| `wc` | 计数 | 无（`read` 回执给总行数，但 `-c` / `-w` 无对应） | 放，且常在管道里计数 |
| `cut` | 取列 | 无 | 放 |
| `awk` | 取列 / 计算 | 无（是程序，任意计算；脚本类归 `script_run` 那条规则） | 放 |
| `grep` | 搜索 | 主机 `grep` 工具（ripgrep 后端） | 有等价但本轮放，见下 |

`grep` 单列说明：主机 `grep` 工具的参数面只有 `pattern` / `path` / `include`，没有上下文行（`-A` / `-B` / `-C`）、`-o`、`-v`、`-c`、`-l`、`-q`；而 `if grep -q ...; then` 属控制流、`命令输出 | grep` 属管道过滤，两类用法占比高。拦 `grep` 的收益（省一次 fork）远小于误伤面，本轮放行、另立条目评估；`rg` 同理。

### 3. 「纯只读」逐形态判定

| 形态 | 示例 | 该拦还是放 | 依据 |
| --- | --- | --- | --- |
| `sed -i` 就地写 | `sed -i 's/a/b/g' f`、`-i.bak`、`--in-place`、`-ni` | 放 | 写文件，不是查看 |
| `tail -f` 跟随 | `tail -f log`、`-F`、`--follow=name`、`less +F` | 放 | 不结束，`read` 无法替代 |
| `sed -n` 取行 | `sed -n '1,80p' f` | 拦 | 与 `read` 的 `offset` / `limit` 一一对应 |
| `sed -n '/pat/p'` 找行 | `sed -n '/ruleEngine/p' f` | 拦 | 与 `grep` 等价 |
| 重定向写 | `head -5 f > out`、`cat f >> out` | 放 | 结果落文件，属生成 |
| heredoc | `cat <<'EOF' > notes.md` | 放 | 写文件；正文常含命令文本 |
| 管道下游 | `npm test 2>&1 \| tail -40`、`grep -n x f \| head -20` | 放 | 裁剪命令输出，专用工具无等价面 |
| 跨行管道 | `npm run build 2>&1 \|` 换行后接 `  tail -5` | 放 | 同上，补「管道上游」排除项 |
| 命令替换 | `x=$(cat msg.txt)`、`git commit -m "$(cat msg.txt)"` | 放 | 组合而非查看 |
| 字节模式 | `head -c 100 f` | 放 | `read` 不能按字节 |
| 负计数 | `head -n -5 f` | 放 | `read` 不能表达「除末尾 N 行」 |
| 不可见字符 | `cat -A f`、`-v`、`-T`、`-E`、`-s` | 放 | `read` 不显示不可见字符 |
| 批处理 | `for f in *.md; do head -2 "$f"; done`、`ls \| while read f; do head -1 "$f"; done`、`xargs head -3`、`find -exec` | 放 | 单工具接口无批量等价 |
| 脚本 | `bash x.sh`、`sh -c "sed -n '1,5p' f"` | 不命中 | 命令位不在前缀集合内（引号内 `sed` 前一字符是双引号） |

### 4. 误伤风险与必放行清单

- 循环体：`for f in *.md; do echo "$f"; head -2 "$f"; done` 的 `; head` 与换行缩进的 `head` 都会落在命令位，文本判定无法区分「脚本里的批处理」与「单次查看」，只能靠 `for` / `while` / `until` / `do` / `xargs` / `-exec` 这类标记整条放行，代价是同文本里真正的查看命令一起漏掉。
- heredoc 正文：`cat <<'EOF' > notes.md` 的正文里若有 `head -3 x` 这类整行文本，会被当成命令位，靠 `<<` 排除项整条放行。
- 管道：沿用现有前缀（含竖线与 `$(`）会把 `npm test 2>&1 | tail -40`、`x=$(cat msg.txt)` 全部命中，实测必须从前缀里去掉（见 6）。
- 变量值与参数位：`GIT_PAGER=cat git log`、`git -c core.pager=cat log`、`echo "cat f"`、提交信息里提到 `cat` / `head` 都不命中（`变量=值` 被前缀整体吃掉）。
- 与既有规则叠加：新规则排第三条，`herdr pane list | head` 仍先命中 herdr 规则、文案不会错指向 `read`；`python x.py | head` 同理先命中 python 规则。
- 重定向排除项是粗粒度的：`head -5 f 2>/dev/null` 也会整条放行（实测），这是刻意接受的漏。

必放行清单（实现阶段逐条落用例）：

1. 带重定向或 heredoc 的命令（`>`、`>>`、`<<`）。
2. `sed` 带 `-i` / `--in-place`（含 `-i.bak`、`-ni`）。
3. `tail` 带 `-f` / `-F` / `--follow`，`less +F`。
4. 管道下游与跨行管道。
5. 命令替换内部（`$(cat ...)`）。
6. 循环 / `xargs` / `find -exec` 批处理。
7. `head` / `tail` 的 `-c` 与 `-n -N`，`cat` 的 `-A` / `-v` / `-T` / `-E` / `-s`。
8. `sed` 不带 `-n`（纯替换）。
9. 清单外命令（`awk` / `wc` / `cut` / `tac` / `grep` / `rg`）不进入判定。

### 5. 现有测试的结构与要补的用例

- 位置与写法：`behavior-correction/tests/main.test.ts`，`node:test` + `node:assert/strict`，表驱动（`for (const command of [...])` + `assert.equal`）。helper：`captureStderr`（`:26-39`）、`makeEngine`（`:42-61`）、`onlyRegistration`（`:64-69`）、`contextWith`（`:72-80`）、`registerDefault`（`:83-87`）、`guardContext`（`:90-92`）。
- 可直接照抄的模板：命中用例 `:188-205`（5 条命令断言 `kind === "deny"`，再 `assert.match(reason, /script_run/)`）；放行用例 `:207-222`（5 条命令断言 `undefined`）。
- 会因新增规则而失败的既有断言：`resolveConfig` 的 id 列表写死两条（`:104-107`），必须加第三条。
- 需补的用例（对应「决策 6」）：命中表、放行表、排除项逐条单测、`exclude` 语义单测（前置规则排除命中则跳过、让后续规则胜出）、`tool: "bash"` 限定（`read` 参数里出现 `sed` 不命中，写法对齐 `:224-230`）、文案指向（对齐 `:139-143` 的 `doesNotMatch` 写法，确保不再指向已删除的工具）。
- `tests/contract.test.ts` 与本次改动无关，不动。

### 6. 本轮实测（只读，不落盘）

用 `node -e` 对候选正则跑了 46 例（打算拦 12 例、打算放 34 例），结果 0 例不符。三条对决策起作用的具体结论：

1. 沿用现有前缀（含竖线与 `$(`）会把 `npm test 2>&1 | tail -40` 与 `x=$(cat msg.txt)` 判为命中；去掉这两项后两者放行，其余 12 例命中不变，支撑「决策 3」。
2. 排除项若写成全局标志扫描（不按命令局部化），`-i` 会被 `--noEmit` 命中：实测 `tsc --noEmit && tail -5 build.log` 被整条放行，本该拦的 `tail` 漏掉，故排除项一律写成「命令名 + 段内标志」。
3. 文件描述符复制与真正重定向必须分开：`>` 的排除项写成 `>>?(?!&)` 后，`head -3 f 2>&1` 仍拦（正确），`head -5 f 2>/dev/null` 放行（刻意漏）。

## 决策

> 2026-10-24 用户确认: 以下 6 项决策按推荐选项定稿 (b / b / b / b / a / b), 实现阶段照此执行, 不再变更; 计划改动文件清单在开工时定稿。

### 决策项 1：拦截命令清单

- (a) 只拦 `sed -n` / `head` / `tail`（最小集）。
- (b) 拦 `sed -n` / `head` / `tail` / `cat` / `nl` / `less` / `more`；不拦 `awk` / `wc` / `cut` / `tac` / `grep`。
- (c) 12 个候选全拦。
- (d) 只拦 `cat` / `head` / `tail`，`sed` 全放。

选定 **(b)**。理由：七个命令都有可直接替换的落点（`read` 为主，`fs_digest` 补长文件与 `tail`），拦了模型有确定的下一步；`awk` 是程序（任意计算，无等价，脚本类归 `script_run` 规则）、`wc` / `cut` 无等价且 `wc -l` 常在管道里计数、`tac` 无等价（`read` 不能逆序）；`grep` 虽有等价工具但缺上下文行 / 取反 / 计数 / 静默选项，且 `if grep -q` 与管道过滤两类用法占比高，本轮放行、另立条目。

### 决策项 2：只读判定规则（排除项 + 必放行形态）

- (a) 只排除 `-i`（sed 写）与 `-f`（tail 跟随）。
- (b) 8 类排除项：sed 就地写、tail 跟随、重定向与 heredoc、字节模式、`cat` 不可见字符、负计数、批处理、管道上游。
- (c) 不设排除项，全拦。

选定 **(b)**。理由：一条排除项对应一个具体失败模式（见「调研 3」「调研 4」）；代价是同文本出现任一排除特征就整条弃权（漏），与本包「宁可漏拦也不误伤」的既有取舍一致。排除项必须**按命令局部化**，全局标志扫描会被 `--noEmit` 里的 `i` 命中而误放行（「调研 6」第 2 条）。

正向判定（`match.regex` 草案，`flags: "im"`）：

```text
前缀    (?:^|[;&]\s*)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*/)?
查看类  {前缀}(?:head|tail|cat|less|more|nl)(?=[\s;|&]|$)
sed 取行 {前缀}sed(?=[\s;|&]|$)(?=[^;&|\n]*(?<!\S)(?:-{1,2}[\w.=/-]*n[\w.=/-]*|--quiet|--silent)(?=\s|$))
```

排除项（`exclude.regex` 草案，命中即整条规则弃权，`flags: "m"`）：

```text
sed 就地写      \bsed\b[^;&|\n]*(?<!\S)-{1,2}[\w.=/-]*i[\w.=/-]*(?=\s|$)
tail 跟随       \btail\b[^;&|\n]*(?<!\S)-{1,2}[\w.=/-]*[fF][\w.=/-]*(?=\s|$)|\+F\b
重定向 / heredoc >>?(?!&)|<<-?
字节模式        \b(?:head|tail)\b[^;&|\n]*(?<!\S)-{1,2}[\w.=/-]*c[\w.=/-]*(?=\s|$)
cat 不可见字符  \bcat\b[^;&|\n]*(?<!\S)-{1,2}[\w.=/-]*[AEvTs][\w.=/-]*(?=\s|$)
负计数          \s-n\s*-\d
批处理          \bxargs\b|\s-exec\s|(?:^|[;&\n])\s*(?:for|while|until|do)\s
管道上游        (?:^|[;&])\s*[^;&|\n]*\|
```

### 决策项 3：判定范围（命令位还是整段文本）

- (a) 整段文本关键词匹配。
- (b) 命令位正则：前缀 = 行首、`;`、`&` 之后，**不含竖线与 `$(`**，工具限定 `bash`。
- (c) 沿用现有两条规则的前缀（含竖线与 `$(`）。

选定 **(b)**。理由：竖线之后是合法输出裁剪（没有专用工具等价），`$(...)` 是组合而非查看（`git commit -m "$(cat msg.txt)"`）；(c) 实测把这两类全部误拦，(a) 会把 `echo cat`、提交信息、参数位误拦。工具限定沿用 `tool: "bash"`（与既有两条一致；`pwsh` 下这些是 Unix 命令名）。

### 决策项 4：排除项的实现形态

- (a) 不加字段，把 8 类排除项写成负向先行断言塞进同一条 `match.regex`。
- (b) `RuleSpec` 增可选 `exclude`（与 `match` 同形：`keywords` / `regex` / `flags`），命中即该规则弃权、继续看后续规则。
- (c) 交 rule-engine 规则侧处理。

选定 **(b)**。理由：排除项有 8 条，(a) 会变成一条三百多字符、含近十个先行断言的正则，哪条排除生效无法定位、也无法逐条落用例；(b) 只在 `compileRule`（`src/main.ts:164-221`）与 `matchRule`（`:276-289`）上加约 25 行，配置面向后兼容（省略即无排除），后续规则可复用同一组排除项。(c) 只能事后提醒、拦不住已执行的调用（`behavior-correction/README.md:11-13`），不满足需求。

### 决策项 5：规则粒度与指路文案

- (a) 一条规则 + 一条合并文案。
- (b) 每条命令一条规则（7 条 id）。
- (c) 按目标工具拆两条（`read` 家族 / `grep` 家族）。

选定 **(a)**。理由：七个命令共用同一组排除项，拆成 7 条只是把 8 条排除项抄 7 遍；文案一次列全落点即可覆盖所有命中命令。规则 id `no-view-text-in-bash`，排在 `no-python-in-bash` 之后（第三条）。

文案草案（`reason`，与既有两条同风格）：

```text
bash 里不要用 cat / head / tail / nl / less / more / sed -n 查看文本: 读行段用 read（offset + limit）, 搜内容用 grep, 长文件先 fs_digest（pruned 或 outline）
```

分命令落点（实现与 README 表格用）：

| 命中命令 | 主落点 | 次落点 |
| --- | --- | --- |
| `cat` / `head` / `nl` / `less` / `more` | `read` | 长文件 `fs_digest pruned` |
| `tail` | `fs_digest pruned`（头尾各裁一段） | `read`（`offset`，需先知道总行数） |
| `sed -n 'a,bp'` | `read`（`offset` + `limit`） | 无 |
| `sed -n '/pat/p'` | `grep` | 无 |

Markdown 结构深查（章节 / 块 / 链接）另有 `md_logic`；文案暂不写它，避免一次给四个以上落点，需要时再补进 `description`。

### 决策项 6：用例清单

- (a) 只补命中用例。
- (b) 命中 10 条 + 放行 10 条 + 排除项单测 + `exclude` 语义 / 工具限定 / 文案断言。
- (c) 3 至 5 条冒烟用例。

选定 **(b)**。

命中（断言 `kind === "deny"`，文案同时含 `read` 与 `grep`）：

01. `head -n 20 src/main.ts`
02. `sed -n '1,80p' AGENTS.md`
03. `sed -n '/ruleEngine/p' AGENTS.md`
04. `tail -20 docs/STATUS.md`
05. `cat README.md`
06. `nl -ba behavior-correction/src/main.ts`
07. `less docs/SPEC.md`
08. `ls; head -3 CHANGELOG.md`
09. 多行命令：`ls` 换行后接 `head -3 CHANGELOG.md`
10. `tsc --noEmit && tail -5 build.log`

放行（断言 `undefined`）：

01. `sed 's/a/b/' f`
02. `sed -i.bak 's/a/b/g' src/main.ts`
03. `tail -f log/app.log`
04. `less +F log`
05. `head -c 100 f`
06. `cat f >> out.txt`
07. `cat <<'EOF' > notes.md`
08. `npm test 2>&1 | tail -40`
09. `for f in *.md; do head -2 "$f"; done`
10. `x=$(cat msg.txt)`

其余放行形态（`--follow=name`、`head -n -5`、`xargs`、跨行管道、`/dev/null` 重定向、`cat -A`）落在「排除项单测」里逐条断言，不靠正反向样例表兜底。

## 规划

计划改动文件清单（草案，实现阶段定稿）：

- `behavior-correction/src/main.ts`：`RuleSpec` / `CompiledRule` 增可选 `exclude`，`compileRule` 编译（`:164-221`）、`matchRule` 跳过（`:276-289`）；`DEFAULT_RULES` 追加 `no-view-text-in-bash`（`:87-119`）；文件头与规则注解释义同步。
- `behavior-correction/tests/main.test.ts`：`resolveConfig` 的 id 列表加第三条（`:104-107`）；命中 10 条 + 放行 10 条；排除项逐条单测；`exclude` 语义与 `bash` 限定；文案断言。
- `behavior-correction/README.md`：缺省规则表加一行（`:26-31`）、`RuleSpec` 表加 `exclude` 行（`:45-58`）、边界一节补「命令位前缀不含管道下游与命令替换」、开发表格的用例覆盖描述同步。
- `behavior-correction/cordis.patch.yml`：头注释补第三条缺省规则（`:1-7`）。
- `behavior-correction/package.json`：`description` 补一句「纯只读查看文本的 sed / head / tail 也拦」。
- `AGENTS.md`：第 77 行的 behavior-correction 口径补新规则。
- `README.md` / `README.zh.md`：第 34 行包表（中英同步）、第 73 行目录注释。

明确不做：本轮不实现任何改动；不解析 shell 语义、不改 `security-guard`（两包分工不同）。

## 实现记录

- 2026-10-25：`behavior-correction/src/main.ts`
  - `RuleSpec` 新增可选 `exclude`（与 `match` 同形：`keywords` / `regex` / `flags`）；`CompiledRule` 新增 `excludeKeywords` / `excludeRegexes`；`compileRule` 按与 `match` 同口径校验并编译（非法即整条跳过并告警）。
  - `matchRule` 改为「命中后先看排除，命中即弃权并继续看后续规则」。
  - 新增第三条内置规则 `no-view-text-in-bash`（排在 `no-python-in-bash` 之后）：命令位正则覆盖 `head` / `tail` / `cat` / `less` / `more` / `nl` 与「带 `-n` / `--quiet` / `--silent` 的 `sed`」；8 类排除项按决策 2 落地。
- 2026-10-25：`behavior-correction/tests/main.test.ts` 补 4 例（命中 10 条 / 放行 10 条 / 参数位与其它命令不误拦 5 条 / 自定义规则表的 exclude 语义），并把缺省规则 id 断言更新为三条。

## 偏差

- 排除项实现为单条规则内的一个 `exclude`（决策 4 选 b），不是 8 条独立规则。
- 命令位前缀只认行首与 `;` `&` 之后（不含管道与 `$(`），与决策 3 一致；因此 `cmd | head -40` 一律放行。
- 文档写「8 类排除项」中的「重定向 / heredoc」合并为一条正则 `>>?(?!&)|<<-?`。

## 测试与证据

- `cd behavior-correction && npm run check` → 通过。
- `cd behavior-correction && npm test` → `tests 33 / pass 32 / fail 0 / skipped 1`（跳过的是既有的「真实 rule-engine 契约」用例，本机不可解析 `@dsh-toolset/rule-engine`，与本次无关）。
- `cd behavior-correction && npm run build` → 通过。
- 真机验证见「收尾」。

## 收尾

已关闭（2026-10-25）。提交：`75c6efb`。

真机验证（会话已装载新构建）：

- 拒绝：`head -1 package.json`、`cat package.json`、`sed -n '1,2p' package.json` 三条均被拦，回执指向 `read` / `grep` / `fs_digest`。
- 放行：`head -c 20 package.json`（字节模式）、`timeout 1 tail -f /dev/null`（跟随）、`sed -i`（写模式，tmp 内实测改写生效）、`cat package.json > /dev/null`（重定向）、`npm run test 2>&1 | tail -40`（管道上游；全包 34 项仍全绿）。

命名：归档后本文件为 `docs/archived/2026-10-24-behavior-readonly-view-guard.md`。
