# security-guard 黑名单匹配增加命令拆分与命令 / 参数区分（接取条目：`docs/BACKLOG.md`「security-guard 黑名单匹配增加命令拆分与命令 / 参数区分」）

状态：已关闭　　开启：2026-10-24　　关闭：2026-10-25
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
本轮范围只到**调研与决策**（实现待用户批准后另接），除本文件外任何文件都不改。

## 目标

给 `CommandRule` 增加可选 `scope: "command"`（缺省整段、完全向后兼容）：先按分隔符把复合命令拆成逐条简单命令（复用 `splitCommandSegments`），`scope: "command"` 的规则只对每条简单命令的**命令名**（段首词 basename，跳过前导 `VAR=` 赋值）匹配，参数位出现关键词不算命中；默认规则中纯命令名即可判定危险的 `sudo` / `reboot-class` / `mkfs` / `wipefs` 改为 command scope；rm / chmod 谓词与带参数约束类规则（`crontab -r` / `kill 1` / `find -delete` 等）保持整段语义，安全底线不降；补用例与 README 规则表说明。

用户已确认的口径（2026-10-24）：「先按照分隔符把复合命令拆成一条一条的简单命令，然后像 `rm -rf`、`sudo` 这些只需要匹配命令位置的字符串，不需要匹配参数位置。」

## 调研

调研方式：只读阅读 `security-guard/src/blacklist.ts`、`security-guard/src/index.ts`、`security-guard/tests/*.test.ts`、`security-guard/README.md`，并用 `node --experimental-transform-types` 在内存中直调纯函数层（未构建、未写盘、未改动任何文件）取实测结果；下文「实测」均指此方式得到的输出。

### 结论速览

- 15 条默认规则里只有 4 条（`sudo` / `mkfs` / `wipefs` / `reboot-class`）的 pattern 本身只写了命令名，命令名即危险；其余 11 条要么是谓词（rm / chmod / 远程管道），要么 pattern 里绑了参数约束（`of=/dev/sd*`、`-delete`、`-r`、`1`、`-F`、`/dev/sd*`、重定向目标），单看命令名判不出来。
- 误拦根因是「不锚定正则 + 整段文本」：关键词出现在参数位、注释、字符串里也算命中。实测被误拦：`echo sudo`、`grep sudo file.txt`、`grep shutdown file.txt`、`git commit -m reboot`、`echo mkfs.ext4`、`man wipefs`、`echo crontab -r`、`echo kill 1`。
- 本轮的现场证据：查 README 时用 `grep -n "sudo…"` 被自身 guard 拦下两次（回执「命令命中黑名单规则「sudo」」），属同一类误拦。
- 改命令位后 `systemctl reboot` 会由「命中 `reboot-class`」变成放行，必须补偿；`ssh host reboot` 这类「关键词在别的程序的实参里」的形态会一并放开，属用户口径的直接后果，需在 README 写明。
- 测试面代价集中在两处 fixture：`CHECK_BLACKLIST_COMMAND`（24 处引用）与 `riskyCommand()`（6 处引用）都以「`echo` 前缀 + 关键词」构造，改语义后前提消失。

### 15 条默认规则逐条盘点

行号均指 `security-guard/src/blacklist.ts`。

| # | 规则 id | 判定形态（行号） | 能拦什么 | 仅凭命令名可判定 | 建议 |
| --- | --- | --- | --- | --- | --- |
| 1 | `rm-recursive-root` | 谓词 `rmRecursiveRootHit`（91-118）：整文本兜底正则 + 逐段词法 | `rm` 带递归标志删 `/` `~` `$HOME` `.` 及 `--no-preserve-root`；代码 / 引号文本内嵌的 rm | 否 | 保持整段 |
| 2 | `remote-pipe-shell` | 谓词（121-137），四个正则 | `curl\|sh` 管道、`sh -c "$(curl …)"`、反引号、`<(curl …)` | 否 | 保持整段 |
| 3 | `chmod-777-system` | 谓词（148-171），逐段词法 | `chmod 777` 打到 `/` `~` `/etc` `/usr` `/bin` `/sbin` `/boot` `/var` | 否 | 保持整段 |
| 4 | `sudo` | pattern `\bsudo\b`（203） | 任意位置出现 sudo | 是 | 改命令位 |
| 5 | `fork-bomb` | pattern 结构（208） | `:(){ :\|:& };:` 家族 | 否 | 保持整段 |
| 6 | `dd-raw-device` | pattern（213）：`dd` + `of=/dev/<裸设备>` | dd 直接写裸块设备 | 否 | 保持整段 |
| 7 | `raw-device-write` | pattern（218）：重定向 / tee 到裸设备 | `> /dev/sda`、`tee /dev/nvme0n1` | 否 | 保持整段 |
| 8 | `mkfs` | pattern（223） | `mkfs` / `mkfs.ext4` 等 | 是 | 改命令位 |
| 9 | `wipefs` | pattern（228） | wipefs 清签名 | 是 | 改命令位 |
| 10 | `partition-tool` | pattern（233）：`fdisk`/`parted` + `/dev/<裸设备>` | 分区工具碰裸盘 | 否 | 保持整段 |
| 11 | `reboot-class` | pattern（238） | `shutdown` / `reboot` / `halt` / `poweroff` 任意位置 | 是（`systemctl` 参数位例外） | 改命令位 + 补偿 |
| 12 | `find-delete` | pattern（243） | `find … -delete` / `-exec rm` | 否 | 保持整段 |
| 13 | `crontab-remove` | pattern（248） | `crontab -r` | 否 | 保持整段 |
| 14 | `iptables-flush` | pattern（253） | `iptables -F` | 否 | 保持整段 |
| 15 | `kill-pid1` | pattern（258） | `kill … 1` | 否 | 保持整段 |

判读要点：

- 第 3 条与第 1 条同为谓词，但手段不同：rm 有整文本兜底 `EMBEDDED_RM_RE`（83-84），chmod 没有，因此 `sudo chmod 777 /etc` 靠 `sudo` 规则拦住（实测命中 `sudo`），而 `env chmod 777 /etc` 实测为 `null` —— 这是**既有缺口**，与本次改动无关，按范围不修，仅登记。
- 第 6 / 7 / 10 / 12 / 13 / 14 / 15 条的 pattern 已经把参数写进判定（`of=`、重定向目标、`/dev/…`、`-delete`、`-r`、`-F`、`1`），改成只看命令名等于把参数约束丢掉，会直接变成「任何 `dd` / 任何 `find` / 任何 `crontab` 都拦」或「只看词不看参数 → 全放行」，两种都错。
- 第 4 / 8 / 9 / 11 条的 pattern 只有一个命令名（`reboot-class` 是四选一的名字集合），命令名命中即危险，是本次唯一能安全收窄的一组。

### `splitCommandSegments` 的实现与边界

实现（32-58）：单遍字符扫描，状态只有一个「当前引号」；遇到 `;` `|` `&` 换行即落段，引号内不切，空段丢弃。当前只被 rm / chmod 两条谓词使用（30 行注释也这样写）。实测切段（只读调用）：

| 边界 | 实测输入 | 切段结果 | 影响 |
| --- | --- | --- | --- |
| 基本分隔 | `a; b` / `a && b` / `a \|\| b` / `a \| b` / 换行 | `["a","b"]` | 符合预期，`&&` 与 `\|\|` 产生的空段被丢弃 |
| 引号保护 | `echo "a;b"`、`echo 'a\|b'` | 单段不切 | 支持；单双引号都算 |
| 重定向 | `echo a 2>&1` | `["echo a 2>","1"]` | `&` 被当后台分隔符，多切一段；对命令位规则基本无害，但破坏「段 = 一条简单命令」的严格性 |
| 子 shell | `(cd / && rm -rf /)` | `["(cd /","rm -rf /)"]` | 括号不保护；取命令词必须剥掉段首 `(` 与段尾 `)` |
| 命令替换（含分隔符） | `echo $(a; b)` | `["echo $(a","b)"]` | 内部 `;` 照切，第二段命令词是 `b)` |
| 命令替换（无分隔符） | `echo $(sudo ls)` | 单段 | 命令位判定看不到里面的 sudo，需递归提取 |
| 前导赋值 | `FOO=1 rm -rf /` | 单段 | 两条既有谓词已用 `^[A-Za-z_][A-Za-z0-9_]*=` 跳过，新逻辑须沿用 |
| 路径前缀 | `/usr/bin/sudo -l` | 单段 | 切段不处理路径，靠 `basenameOf`（173-177）取末段 |
| sudo 作前缀词 | `sudo rm -rf /` | 单段，段首词是 sudo | rm 由 `EMBEDDED_RM_RE` 兜住（实测命中 `rm-recursive-root`）；chmod 无兜底（见上） |
| 转义引号 | `echo "a \" ; rm -rf /"` | 切成两段 | 不识别 `\"`；偏保守（多切，不少拦），但会放大误拦面 |
| 续行 | `echo a \` + 换行 + `rm -rf /` | 切成两段 | 不识别反斜杠续行，同上 |
| here-doc | `cat <<EOF` 后正文 | 正文行按普通文本切段 | 不识别 here-doc，正文里的关键词会被当命令 |
| 注释 | `echo 0 # sudo --version` | 单段，注释保留 | 不剥离 `#` 注释；测试 fixture `riskyCommand()` 正是靠这一点命中 |
| 反引号 | `` echo `date` `` | 单段 | 内部无分隔符时不切，同 `$()` |

边界小结：**该函数是「按分隔符切文本」而不是「解析 shell 语法」**，故命令位判定只能建立在它之上并补三条：剥段首尾括号 / 前缀词、剥成对引号、提取 `-c` 字符串与 `$()` 内容。任何依赖它做「完整命令语义」的假设都不成立。

### 现存误拦实例（实测，均来自只读直调）

| 命令 | 现命中规则 | 真实语义 | 应否拦 |
| --- | --- | --- | --- |
| `echo sudo` | `sudo` | 打印字符串 | 否 |
| `grep -rn sudo docs/` | `sudo` | 读文件 | 否 |
| `grep sudo file.txt` | `sudo` | 读文件 | 否 |
| `grep shutdown file.txt` | `reboot-class` | 读文件 | 否 |
| `git commit -m reboot` | `reboot-class` | git 提交，`-m` 实参 | 否 |
| `echo "sudo is a tool"` | `sudo` | 打印字符串 | 否 |
| `echo mkfs.ext4` | `mkfs` | 打印字符串 | 否 |
| `man wipefs` | `wipefs` | 查手册 | 否 |
| `echo reboot` | `reboot-class` | 打印字符串 | 否 |
| `echo 0 # sudo --version` | `sudo` | 注释里的关键词，什么都不执行 | 否 |
| `echo crontab -r` | `crontab-remove` | 打印字符串 | 否，但本次**不**放开（见下） |
| `echo kill 1` | `kill-pid1` | 打印字符串 | 否，但本次**不**放开（见下） |

后两行是刻意保留的误拦：`crontab-remove` / `kill-pid1` 的 pattern 绑了参数，按本轮口径（带参数约束的规则保持整段）不动；放宽它们要另立「参数位置解析」条目，不在本次范围。

### 改命令位后会漏掉的形态与逐条风险

| 形态 | 现命中 | 改后（纯命令位） | 风险 | 处理 |
| --- | --- | --- | --- | --- |
| `systemctl reboot` / `systemctl poweroff` | `reboot-class`（参数位） | 放行 | 高：是重启 / 关机的主要现实路径 | 新增补偿规则（决策 5） |
| `bash -c "sudo apt …"` / `sh -c '…'` | `sudo` | 放行 | 高：提权常见包装 | 递归 `-c` 实参（决策 2c） |
| `echo $(sudo whoami)` / `x=$(reboot)` | 对应规则 | 放行 | 中：命令替换是真实执行 | 递归 `$()` 与反引号（决策 2c） |
| `env FOO=1 sudo …` / `nohup reboot` / `xargs reboot` | 对应规则 | 放行 | 中：包装词在前 | 前缀词链（决策 2b） |
| `if reboot; then …` / `while reboot; do …` | `reboot-class` | 放行 | 中：shell 关键字在前 | 关键字并入前缀词链（决策 2b） |
| `(sudo ls)` / `{ reboot; }` | 对应规则 | 放行 | 低 | 剥段首尾括号（决策 2a） |
| `ssh host reboot` / `docker exec c reboot` | `reboot-class` | 放行 | 中：远端 / 容器内执行，本机看不见语义 | 知情接受，README 登记（决策 6） |
| `subprocess.run(["sudo", …])`（`script_run`） | `sudo` | 放行（若按命令位拆代码文本） | 高：脚本真实提权 | code 文本保持整段（决策 3b） |
| `await tools.bash({command:"sudo …"})`（`run_code`） | `sudo` | 放行（同上） | 高 | 同上 |
| `find . -exec sudo …` | `sudo` | 放行 | 低：`find-delete` 只认 `-exec rm` | 知情接受，README 登记 |
| `'sudo' ls` / `\sudo ls` / `su"do" ls` | `sudo` | `'sudo' ls` 去引号后仍命中；`\sudo ls` 与 `su"do" ls` 放行 | 低 | 去成对引号（决策 2a）；反斜杠与引号拼接形态知情接受 |

### 现有测试覆盖与受影响断言

测试规模 135 例：`blacklist.test.ts` 9 / `guard.test.ts` 97 / `script.test.ts` 22 / `sensitive.test.ts` 7（与 `README.md:138` 一致）。

`blacklist.test.ts` 现有覆盖面：rm 族与普通删除放行、`curl|sh` 四形态、sudo、fork 炸弹、dd 与 `/dev/null` 放行、重定向 / tee、mkfs / wipefs / fdisk、shutdown / reboot、find -delete、crontab -r、iptables -F、kill 1 与 `kill 1234` 放行、chmod 777、回执要素、allowPatterns 与非法正则。

改 scope 后会变红的断言：

- `CHECK_BLACKLIST_COMMAND = "echo sudo ls /"`（`guard.test.ts:1628`）：全文件 24 处引用（另有定义 1 处）。凡以「该文本确实命中 `sudo` 规则」为前提的都会变红 —— 插件命令工具 deny（`839` / `940` / `958` / `969`）、三态与 check 判定（`1647-1650` / `1752` / `1880` / `1983`）、嵌套键路径与遍历上限的填充（`1925` / `1933` / `2092` / `2156` / `2215` / `2283` / `2541` / `2621`）。
- `riskyCommand() = "echo 0 # sudo --version"`（`1380-1383`）：6 处引用（`1388` / `1402` / `1413` / `1439` / `1499` / `1559`），前提同上。
- 两处以 `allowPatterns: ["^echo "]` 为前提的「命中但被放行」断言：`916-930`（`script_run` + `^echo `）与 `1768-1776`（check 下 allowPatterns）。fixture 换成 `sudo ls /` 后 `^echo ` 不再匹配，断言会由「放行」变成「拦」；若保持原 fixture 不动，这两处仍绿但失去意义（不再验证「命中却被放行」），故迁移时必须一并换载体。
- `1748` 用例标题「命令键（command / measureCmd / cmd）整段过命令黑名单层」措辞需改。
- 不受影响：已直接写 `sudo ls /` 的用例（`174` / `269` / `278` / `289-294` / `345` / `709` / `743` / `1164` / `1179` 等，段首即命令位）；`unknownToolPolicy: "deny"` 下按键名拦的用例（fixture 值不参与判定）；`sensitive.test.ts` 与 `script.test.ts`。

### README / docs 的规则表表述位置

| 位置 | 现表述 | 改动必要性 |
| --- | --- | --- |
| `security-guard/README.md:11-13` | 拦截面表格「默认规则」单元：15 条清单 | 必改：条数（16）与 4 条命令位语义 |
| `security-guard/README.md:16` | 「复合命令（`;` `\|` `&` 换行）按段词法分析；`run_code` 与引号内嵌命令另有整文本兜底」 | 必改：写清命令位 / 参数位、前缀词与递归范围 |
| `security-guard/README.md:96-114` | 配置参考（`commandBlacklist.rules` 为纯正则数组） | 必改：一句「用户层规则仍整段匹配」 |
| `security-guard/README.md:133` | 目录结构里 `blacklist.ts` 的一句话 | 宜改：补 scope 机制 |
| `security-guard/README.md:138` | 测试例数 135 | 必改：随新增用例更新 |
| `security-guard/README.md:142` | 「普通正则类规则对整段文本匹配：`echo "sudo is a tool"` 会命中」 | 必改：改后只对 11 条成立，且需补 code 文本口径与 `ssh host reboot` 类已知漏拦 |
| 根 `README.md:30` / `README.zh.md:30` | 一句话简介（无逐条规则） | 不改 |
| `docs/BACKLOG.md:77-80` | 本任务条目正文 | 实现阶段回写（本轮不改） |
| `docs/STATUS.md` | 对照文档 | 用户择时更新，流程内不改 |

### 绕开形态与可检测结构（2026-10-24 追加，用户提问引出）

按「是否在本层口径内」分四类：

| 类别 | 例子 | 本层是否覆盖 |
| --- | --- | --- |
| 一、日常写法 | `/usr/bin/sudo -l`、`s""udo ls`、`\sudo ls`、`env FOO=1 sudo -l`、`FOO=1 sudo -l`、`ls && sudo -l`、`bash -c "sudo ls"`、`echo $(sudo whoami)`、`xargs sudo …`、`find … -exec sudo …` | 是（决策 2 的提取范围） |
| 二、刻意构造 | `c=sudo; $c ls`、`$(printf sudo) ls`、`$'\x73udo'`、`alias x=sudo; x ls`、`sh <<EOF … sudo … EOF`、`eval "$x"`、`. ./x`、`base64 -d f \| sh`、`xxd -r f \| sh` | 部分（见决策 10 至 12） |
| 三、换执行者 | `ssh host sudo …`、`docker exec … sudo …`、`kubectl exec …`、`git -c core.pager=… log`、`EDITOR=… git commit`、分页器 / 编辑器逃逸、`make` / `npm run` 内的脚本、`at` / `crontab` 写入 / `systemd-run` / `nohup … &` | 否（工具层与沙箱层职责；`ssh` 类按决策 6 接受） |
| 四、不经命令层 | `echo b > /proc/sysrq-trigger`、`dd of=/dev/sda`、`blkdiscard`、`sgdisk -Z`、`cryptsetup luksFormat`、脚本文件内的破坏动作 | 部分（`dd` / `raw-device-write` 已有；其余按「命令名即危险」补条目） |

三条结论：

- **引号拼接不是构造**：`s""udo`、`su'do'`、`\sudo` 经令牌化后词面就是 `sudo`，属决策 2 的覆盖范围，不应改判为「拒绝」。
- **二类的共同结构可检测**：命令名不由字面量决定（命令位出现 `$` / `$(` / 反引号），或内容先变形再送入 shell（heredoc 喂 shell、解码器管道）。
- **核查发现既有缺口**：`remote-pipe-shell`（`security-guard/src/blacklist.ts:121-137`）只认 `curl` / `wget` 作上游，`base64 -d f | sh`、`xxd -r f | sh`、`gunzip f | sh` 不在网内 —— 属同类危险，需补（决策 12）。

## 决策

> 2026-10-24 用户确认: 以下 12 项决策按推荐选项定稿 (a / c / b / b / a / a / a / a / a / b / c / b), 实现阶段照此执行, 不再变更; 计划改动文件清单在开工时定稿。

### 1. `scope` 字段形状与缺省值

- a. `scope?: "text" | "command"`，无字段等价 `"text"`；`test` 谓词不读该字段
- b. `scope?: "command"`（单值枚举，无字段等价整段）
- c. `commandOnly?: true`（布尔开关）
- d. 不加字段，`matchCommand` 内按规则 id 硬编码白名单
- **选定 a**。理由：语义自解释，将来要加 `"segment"` 不用改类型；缺省值让 11 条既有 pattern 规则零改动（完全向后兼容）；`policy()` 只投影 `id` / `reason`（`security-guard/src/index.ts:1017-1026`），新字段不外泄；rm / chmod / 远程管道三个谓词各自切段，给它们加 scope 只会制造两套语义。实现约定：`scope === "command"` 时把 pattern 编译结果对「命令词候选」逐条测试，**不要**对整段测试。

### 2. 命令词提取范围（直接决定漏拦面）

- a. 段首词：跳前导 `VAR=`、剥段首 `(`/`{`/`!` 与段尾 `)`/`;`、去成对引号、取 basename
- b. a + 前缀词链（`sudo` `doas` `su` `env` `nohup` `command` `exec` `time` `nice` `stdbuf` `timeout` `xargs` `watch` `busybox`，以及 shell 关键字 `if` `then` `else` `elif` `while` `until` `do`）
- c. b + 递归提取 shell 族 `-c` 实参、`$()`、反引号的内部命令（深度上限 2）
- d. c + 参数位联合判定（命令名命中后再看后继参数组合）
- **选定 c**。理由：只做 a 会漏 `bash -c "sudo …"` 与 `$(sudo …)`，这两类今天是被拦的，属安全底线回退；b 解决 `env` / `nohup` / `xargs` / `if reboot`；d 把参数位又拉回判定，与用户已确认的「参数位出现关键词不算命中」直接冲突。递归只针对会被 shell 真正执行的载体（`-c` 实参、`$()`、反引号），误伤面小，深度上限 2 防递归爆炸。

实测该提取规则的结果（只读模拟）：`env FOO=1 sudo -l` → `[env, sudo]`；`if reboot; then …` → `[if, reboot, …]`；`bash -c "sudo ls /"`（递归）→ `[bash, sudo]`；`echo $(sudo whoami)`（递归）→ `[echo, sudo]`；`( sudo ls )` → `[sudo, ls]`；`git commit -m reboot` → `[git]`（无关键字）。

已知不精确处（知情接受，写进 README 边界）：带取值的短选项会让下一个实参被当成命令词（`sudo -u root reboot` 的后继是 `root`）；但 `sudo` 规则本身已在段首命中，整条命令仍被拦，只是回执 id 为 `sudo` 而非 `reboot-class`，无安全影响。

### 3. 命令文本来源分类（shell 文本 / 代码文本）

- a. 全部文本一律按命令位语义（`run_code` 的 `code`、`script_run` 的 `script` 也拆段）
- b. 收集层给每条文本打 `kind: "shell" | "code"`；`kind === "code"` 时命令位规则退回整段语义（保守）
- c. `code` 文本整体跳过命令黑名单层
- d. 维持现状（不区分，同 a）
- **选定 b**。理由：代码文本不是 shell 命令串，拆段后段首是 `subprocess.run(["sudo", …])` 的 `subprocess.run(["sudo",` 或 `await tools.bash({…})` 的 `await`，必然漏 —— 而这两类今天是拦住的，属回退；c 是纯削弱；a / d 会把「脚本里真实提权」这条路径打开。实现只需在既有收集点打标，不改登记表结构：

| 收集点 | 文本键 | kind |
| --- | --- | --- |
| `SHELL_TOOLS`（`bash` / `shell` / `pwsh`） | `command` / `script` | shell |
| `RUN_CODE_TOOLS`（`run_code`） | `code` / `program` | code |
| 插件命令工具 `script_run` | `script` | code |
| 插件命令工具 `herdr_run` / `herdr_text` / `herdr_key` / `metric_loop` / `task_decompose` | `command` / `text` / `keys[]` / `measureCmd` / `children[].executor.command` 等 | shell |
| `inspectCommand`（外部复查） | `command` | shell |

### 4. 逐条规则是否改（选定 b：改 4 条，其余不动）

- a. 只改 `sudo`
- b. 改 `sudo` / `reboot-class` / `mkfs` / `wipefs`（与 BACKLOG 已确认口径一致）
- c. b + `crontab-remove` / `iptables-flush` / `kill-pid1` / `find-delete` 等参数约束类
- d. 12 条 pattern 规则全改
- **选定 b**。理由：这 4 条的 pattern 只写命令名，命令名即危险；c / d 会把参数约束丢掉（`dd` 只看名字、`find` 只看名字即命中，或反过来全放行），与「安全底线不降」冲突。

| 规则 id | 现语义 | 建议 scope | 漏拦风险 |
| --- | --- | --- | --- |
| `rm-recursive-root` | 谓词：整文本兜底 + 逐段词法（需递归标志 + 高危目标） | 保持整段（`test`，不加 scope） | 无（不改）；`sudo rm -rf /` 靠 `EMBEDDED_RM_RE` 仍命中 |
| `remote-pipe-shell` | 谓词：管道 / 进程替换 / 命令替换四形态 | 保持整段 | 无（不改） |
| `chmod-777-system` | 谓词：逐段 chmod + 模式 777 + 系统目录 | 保持整段 | 无（不改）；既有缺口 `env chmod 777 /etc` 不属本次 |
| `sudo` | 任意位置出现 `sudo` | `command` | 中：`bash -c` / `$()` / 前缀词 → 由决策 2 覆盖；`ssh host sudo` → 决策 6 知情接受 |
| `fork-bomb` | 整段结构正则 | 保持整段 | 无（不改） |
| `dd-raw-device` | `dd` + `of=/dev/<裸设备>` | 保持整段 | 无（不改） |
| `raw-device-write` | 重定向 / tee 到裸设备 | 保持整段 | 无（不改） |
| `mkfs` | 任意位置 `mkfs[.fs]` | `command` | 低：`env` / `bash -c` / `$()` 由决策 2 覆盖；`busybox mkfs…` 由前缀词覆盖 |
| `wipefs` | 任意位置 `wipefs` | `command` | 低：同上 |
| `partition-tool` | `fdisk`/`parted` + `/dev/<裸设备>` | 保持整段 | 无（不改） |
| `reboot-class` | 任意位置 `shutdown`/`reboot`/`halt`/`poweroff` | `command` | 高：`systemctl reboot` → 决策 5 补偿；`ssh host reboot` → 决策 6 |
| `find-delete` | `find` + `-delete` / `-exec rm` | 保持整段 | 无（不改） |
| `crontab-remove` | `crontab` + `-r` | 保持整段 | 无（不改）；`echo crontab -r` 继续误拦，有意保留 |
| `iptables-flush` | `iptables` + `-F` | 保持整段 | 无（不改） |
| `kill-pid1` | `kill` + `1` | 保持整段 | 无（不改）；`echo kill 1` 继续误拦，有意保留 |

### 5. `systemctl` 一类的漏拦补偿

- a. `reboot-class` 保持 pattern + `scope: "command"`；新增第 16 条规则 `systemctl-power`（谓词）
- b. `reboot-class` 改谓词，内部一并覆盖 `systemctl`（不新增 id）
- c. 不补偿，接受 `systemctl reboot` 漏拦
- d. 用整段正则 `systemctl\s+(?:-\S+\s+)*(?:reboot|poweroff|halt|kexec)`
- **选定 a**。理由：严格贴用户已确认的「4 条改命令位」，补偿单独成条、回执 id 精确；d 会把 `grep systemctl reboot file` 重新误拦（正是本次要修的形态）；c 属安全底线让步。b 也可行，但会把参数位判定藏进 `reboot-class` 谓词，规则表读不出「有参数约束」这件事。

补偿规则规格（写进实现与 README）：

- id `systemctl-power`，reason「通过 systemctl 关机 / 重启 / 硬复位，会中断所有在跑的业务」。
- 谓词形态（与 rm / chmod 同型的参数约束类）：逐段取命令词链末端命令为 `systemctl` 时，检查该段 `systemctl` 之后的实参，含 `reboot` / `poweroff` / `halt` / `kexec` 即命中。
- 位置放在 `reboot-class` 之后（规则顺序即回执优先级），两者不重叠：`reboot-class` 只认命令名，`systemctl-power` 只认 `systemctl` 的参数。
- 实测（只读模拟）：`systemctl reboot` → 命中；`systemctl --now reboot` → 命中；`systemctl status nginx` → 放行；`grep systemctl reboot file` → 放行；`systemctl restart nginx` → 放行。
- `init 0` / `telinit 6` / `kexec -e` 今天本来就不命中（`reboot-class` 的 pattern 只含四个词），不属本次回退，登记为既有缺口，不在本条规则里扩。

### 6. `ssh host reboot` 这类「关键词在别的程序实参里」的形态

- a. 不加专门规则；README「边界与限制」写明已知漏拦，并给一条用户层整段正则示例
- b. 新增 `ssh` 专用规则：命令位 `ssh` 且实参含 4 个关键词之一
- c. 新增通用「远端执行器」规则（`ssh` / `ansible` / `kubectl exec` / `docker exec` / `systemd-run`）
- d. 接受漏拦且不写文档
- **选定 a**。理由：用户口径明确把参数位排除在判定外，远端命令就是实参；为 ssh 单开参数位判定等于把本次要修的机制再装回去，且名单会无限膨胀（c）。文档 + 用户层规则把选择权留给用户，符合「默认保守、例外可配置」的既有分工。

### 7. 测试迁移与用例清单

- a. 改写两处 fixture 为命令位形态；两处以 `^echo ` 为前提的放行断言改用仍整段的规则文本；新增一组命令位 / 参数位对照用例
- b. 只加新用例，旧 fixture 不动（会红）
- c. 给旧 fixture 配 `allowPatterns` 绕过（改变测试语义，等于把「命中」测成「放行」）
- d. 删掉以 `echo` 形态为前提的旧用例
- **选定 a**。理由：保留每条断言的原意（命中的仍是默认规则、放行仍按正则），只换载体；d 会丢掉「插件命令工具 / 未登记工具 / 遍历上限」这些与本次无关的回归保护。

迁移细节：

- `CHECK_BLACKLIST_COMMAND` 改为命令位文本，沿用拼接构造（仓库内不出现真实危险字面量）：`["su", "do"].join("") + " ls /"`。
- `riskyCommand()` 改为 `["su", "do"].join("") + " --version"`，语义仍是「无害但确实提权」。
- `916-930` 与 `1768-1776` 两处放行断言改用 `echo crontab -r`（`crontab-remove` 保持整段，`^echo ` 仍可匹配）。
- `1748` 标题的「整段过命令黑名单层」改为「过命令黑名单层」。

用例清单（命中 10 条，全部落在默认规则 id 上）：

| # | 命令 | 期望 |
| --- | --- | --- |
| 1 | `sudo apt update` | 命中 `sudo` |
| 2 | `ls && sudo -l` | 命中 `sudo`（复合命令第二段） |
| 3 | `FOO=1 sudo -l` | 命中 `sudo`（前导赋值） |
| 4 | `/usr/bin/sudo -l` | 命中 `sudo`（路径前缀） |
| 5 | `env FOO=1 sudo -l` | 命中 `sudo`（前缀词链） |
| 6 | `bash -c "sudo ls /"` | 命中 `sudo`（递归 `-c`） |
| 7 | `echo $(sudo whoami)` | 命中 `sudo`（递归 `$()`） |
| 8 | `reboot` / `shutdown -h now` | 命中 `reboot-class` |
| 9 | `systemctl reboot` / `systemctl --now poweroff` | 命中 `systemctl-power` |
| 10 | `mkfs.ext4 /dev/sdb1` / `wipefs -a /dev/sdb` | 命中 `mkfs` / `wipefs` |

回归命中（不改语义，防止改造误伤）：`cat /dev/zero \| dd of=/dev/sda` → `dd-raw-device`；`find . -name '*.log' -delete` → `find-delete`；`crontab -r` → `crontab-remove`；`kill -9 1` → `kill-pid1`；`rm -rf /` 与 `sudo rm -rf /` → `rm-recursive-root`；`curl … \| sh` → `remote-pipe-shell`。

用例清单（放行 10 条）：

| # | 命令 | 期望 |
| --- | --- | --- |
| 1 | `echo sudo` | 放行 |
| 2 | `grep -rn sudo docs/` | 放行 |
| 3 | `grep shutdown file.txt` | 放行 |
| 4 | `git commit -m reboot` | 放行 |
| 5 | `man wipefs` | 放行 |
| 6 | `echo mkfs.ext4` | 放行 |
| 7 | `systemctl status nginx` / `systemctl restart nginx` | 放行 |
| 8 | `grep systemctl reboot file` | 放行（补偿规则不误伤） |
| 9 | `time grep reboot file` | 放行（前缀词只推进到真实命令） |
| 10 | `if grep reboot file; then echo x; fi` | 放行（关键字链不误伤） |

对照用例（改后仍拦，锁住「有意保留的误拦」与 code 文本口径）：`echo crontab -r` → `crontab-remove`；`echo kill 1` → `kill-pid1`；`script_run` 的 `script` 里出现 `sudo` 字面（code 文本，整段判定）→ `sudo`。

### 8. README 同步范围

- a. 改 6 处：`11-13`（条数与命令位说明）、`16`（复合命令 bullet）、`96-114`（用户层规则仍整段）、`133`（目录结构）、`138`（测试例数）、`142`（整段匹配缩到 11 条 + code 文本 + 已知漏拦）
- b. 只改 `142`
- c. 只在 `11-13` 加一句
- d. 不改
- **选定 a**。理由：`142` 明写「普通正则类规则对整段文本匹配」，改后只对 11 条成立；`11-13` 的 15 条清单与 `16` 的「按段词法分析」都要跟着改，否则文档与行为不一致（项目规范要求同步 README）。根 `README.md:30` / `README.zh.md:30` 只有一句话简介，不涉及逐条规则，不改。

### 9. 用户层配置是否暴露 `scope`

- a. 不暴露：`commandBlacklist.rules` 仍是 `string[]`，用户规则一律整段匹配
- b. 改成对象数组 `{ pattern, scope }`
- c. 新增独立配置键 `commandScopedRules`
- d. 保持字符串数组，用前缀标记（如 `command:`）区分
- **选定 a**。理由：b 是破坏性 schema 变更（现有 profile 配置会失效）；c / d 引入第二套书写口径，与「追加规则只做编译、不校验语义」的现有约定相冲突；用户层要表达「宁可误拦」本来就是整段语义。若将来确有需求，按 b 的「字符串 / 对象并存」平滑扩展。

### 10. 命令位由展开产生时是否拒绝

- a. 不处理，按 fail-open 放行
- b. 新增谓词 `dynamic-command`：命令位（段首跳前导赋值与前缀词后的第一个词）出现 `$` / `$(` / 反引号，词面不完整 → 拒绝
- c. 任意位置出现展开即拒绝
- **选定 b**。理由：只拦命令位时误拦面很小（`echo $(date)`、`git rev-parse $(…)` 都在参数位不受影响），而 `$cmd ls`、`$(printf sudo) ls` 这类今天完全无网；c 会拦掉大量正常用法（`echo $(date)`、`cd $(git rev-parse --show-toplevel)`）。边界：不解析展开结果，也不追赋值链（`c=sudo` 与 `$c` 不关联），README 写明。
- 已知漏：变量间接若把命令名放在参数位再展开（`x="sudo ls"; $x`）仍放行；属「刻意构造」的知情接受项。

### 11. heredoc 喂给 shell 的形态

- a. 不处理
- b. 命令词为 shell 族且输入是 heredoc → 整体拒绝
- c. 命令词为 shell 族且输入是 heredoc → 扫正文，命中现有黑名单关键词才拒绝（深度 1，不递归）
- d. 扫正文但只认具名危险命令清单
- **选定 c**。理由：`bash <<EOF` 用于跑正常脚本片段（含 `sudo` 之外的常规命令）有真实需求，整体拒误伤大；正文扫描是文本级、与「不解析 shell 语义」一致；深度 1 防止 heredoc 套 heredoc 的递归成本。命中时回执 id 用 `heredoc-fed-shell`，reason 指明「脚本正文里出现危险命令」。

### 12. 解码 / 解压后送入 shell

- a. 不处理
- b. 扩展 `remote-pipe-shell` 的上游名单（`base64 -d` / `xxd -r` / `gunzip` / `zcat` / `openssl enc -d` / `uudecode`），仍走同一谓词与 reason
- c. 新增独立谓词 `decoded-pipe-shell`
- d. 保持现状
- **选定 b**。理由：危险语义与 curl / wget 完全一致（内容先变形再执行），复用同一 reason 与既有用例更省；c 会产生两条语义重叠的规则，规则表读不出区别。需补用例：`base64 -d f | sh`、`base64 -d f | bash`、`xxd -r f | sh`、`gunzip f | sh`、`openssl enc -d -aes-256-cbc -in f | sh`；放行对照 `base64 -d f > out`、`gzip -d f.gz`。

## 规划

计划改动文件清单（草案，实现阶段定稿）：

- `security-guard/src/blacklist.ts`：`CommandRule.scope`；命令词提取 helper（前导赋值 / 括号 / 引号 / 前缀词 / `-c` 与 `$()` 递归，深度上限 2）；`matchCommand` 第三参数（shell / code）与 command scope 分派；`sudo` / `reboot-class` / `mkfs` / `wipefs` 四条加 `scope: "command"`；新增 `systemctlPowerHit` 谓词与第 16 条规则 `systemctl-power`；新增 `dynamicCommandHit`（决策 10）与 `heredocFedShellHit`（决策 11）谓词及 `dynamic-command` / `heredoc-fed-shell` 两条规则；扩展 `remotePipeShellHit` 的上游名单（决策 12）。
- `security-guard/src/index.ts`：`#decide` 的三个收集点与 `inspectCommand` 打 `kind`；`#decideCollected` 调 `matchCommand` 时传 kind；登记表（`PLUGIN_COMMAND_TOOLS` / `PLUGIN_FILE_TOOLS`）与敏感文件层不动。
- `security-guard/tests/blacklist.test.ts`：新增命令位命中 / 参数位放行 / 复合段 / 前导赋值 / 路径前缀 / 前缀词 / `sh -c` / `$()` / `systemctl` 补偿 / code 文本对照用例；新增 `dynamic-command`（命中 `$cmd ls`、`$(printf sudo) ls`，放行参数位 `echo $(date)`）、`heredoc-fed-shell`（命中正文含 `sudo` 的 heredoc，放行普通 heredoc）、`remote-pipe-shell` 解码器五例（决策 12）；原有 rm / chmod / 管道 / 参数约束类命中用例保持不变。
- `security-guard/tests/guard.test.ts`：两处 fixture 迁移（`CHECK_BLACKLIST_COMMAND` 24 处引用、`riskyCommand()` 6 处引用）、两处 `^echo ` 放行断言改载体、一处用例标题措辞。
- `security-guard/README.md`：`11-13` / `16` / `96-114` / `133` / `138` / `142` 六处；另新增「边界与绕开形态」小节（调研四类表 + 明确不覆盖项：变量间接、别名 / 函数、其它解释器、远端执行、延后执行）。
- `docs/BACKLOG.md`：条目回写（实现阶段完成时移出清单）。

明确不做：本轮不实现任何改动；安全底线不降（宁可误拦不可漏拦的既有取舍只在明确安全的规则上让步）。

## 实现记录

- 2026-10-25：`security-guard/src/blacklist.ts`
  - `CommandRule` 新增可选 `scope: "text" | "command"`（缺省 `text`）。
  - 新增命令词提取：`tokensOf`（剥引号 / 括号 / `!`）、`commandName`（basename）、`commandWords`（逐段跳过 `VAR=`、前缀词链与选项；对 shell 族 `-c`、`eval`、`$()`、反引号递归 2 层）、`substitutionBodies`。
  - 新增谓词：`dynamicCommandHit`（命令位由展开产生）、`systemctlPowerHit`（关机 / 重启 / `kexec`）、`heredocFedShellHit`（shell + heredoc → 正文按现有规则扫一遍，排除自身）。
  - `matchCommand(command, rules, kind)` 增加 `kind`：`command` 范围规则仅对 shell 文本按命令词判定；`kind === "code"` 时退化为整段判定。
  - 4 条规则加 `scope: "command"`：`sudo`、`mkfs`、`wipefs`、`reboot-class`；新增 3 条规则：`dynamic-command`、`heredoc-fed-shell`（排在 `chmod-777-system` 前）、`systemctl-power`（排在 `reboot-class` 后）。
  - `remotePipeShellHit` 增补解码 / 解压上游：`base64 -d|--decode|-D`、`xxd -r`、`uudecode`、`gunzip`、`zcat`、`openssl enc -d`。
- 2026-10-25：`security-guard/src/index.ts` 的命令收集记录加 `kind`（shell 缺省、`run_code` 为 `code`），`matchCommand` 透传。
- 2026-10-25：测试迁移与补齐 —— `CHECK_BLACKLIST_COMMAND` 去掉 `echo` 前缀（改为命令位）、`riskyCommand()` 改为命令位、两处 `allowPatterns: ["^echo "]` → `["^su"]`、一处注释位命中改为 `;` 分段；`tests/blacklist.test.ts` 新增 7 例（命令位 / 参数位 / 递归 / systemctl / 动态命令 / heredoc / 解码管道 / 代码文本退化）。
- 2026-10-25：`security-guard/README.md` 能力表 15 → 18 条并补新规则，「边界与限制」改写命令位口径，新增「绕开形态」表；单测例数 135 → 142。

## 偏差

- `unknownToolPolicy` 的未登记工具扫描、插件命令工具与 `inspectCommand` 的命令文本未标 `kind`（缺省 `shell`），与决策 3 的「工具名决定 kind」在实现上等价（它们都是命令文本）。
- 用户配置层仍复用 `CommandRule` 类型，`scope` 对用户规则可见（决策 9 的 P2 裁剪未做）。
- 排除项（`sed -i` / `tail -f` / 重定向与 heredoc / 字节模式 / 负计数 / 批处理 / 管道上游）未建成独立规则，属命令位口径 + 整段规则的正向前提，不需要 exclude 机制。
- `find -exec <cmd>` 与 `ssh host <cmd>` 明确放行（决策 8 接受的漏拦面）；`bash -c` 与 `eval` 只递归一层字符串实参。

## 测试与证据

- `cd security-guard && npm run check` → 通过。
- `cd security-guard && npm test` → `tests 142 / pass 142 / fail 0`（原 135 例 + 新增 7 例；迁移的 fixture 与断言见实现记录）。
- `cd security-guard && npm run build` → 通过。
- 真机验证见「收尾」。

## 收尾

已关闭（2026-10-25）。提交：`09e80da`。

真机验证（会话已装载新构建）：

- 参数位放行：`echo sudo`、`echo hi | grep sudo` 均执行成功。
- 拒绝：`sudo id`（`sudo`）、`echo aGk= | base64 -d | sh`（`remote-pipe-shell`）、`bash <<'EOF'` 喂 `sudo -n true`（`heredoc-fed-shell`）。
- 危险语义只对 dist 规则求值、不执行：`rm -rf /`、`reboot`、`mkfs.ext4 /dev/sda1`、`systemctl reboot`、`wipefs -a /dev/sdb`、`sudo apt update`、`rm -rf ~/x` 均拒绝；`echo sudo`、`grep shutdown README.md`、`rm -rf ./tmp/x` 放行（`~` 子树拒绝属预期保守口径）。

命名：归档后本文件为 `docs/archived/2026-10-24-security-guard-command-position.md`。
