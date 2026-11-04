# install 自检的 check/build 链提取改为兼容 `-C`(接取条目: `docs/BACKLOG.md`「`scripts/test-install.sh` 的 check/build 链一致性检查仍按 `--prefix` 提取」)

状态: 关闭　　开启: 2026-11-04　　关闭: 2026-11-04
本文件是本任务唯一的追踪文档与文档改动位置; 计划外的文件不改。

## 目标

让 `scripts/test-install.sh` 的接线一致性断言在根 `package.json` 已改用 `pnpm -C <包> run <脚本>` 的形态下仍然成立, 使 install 脚本自检不再常驻一个红项。

## 调研

- 断言位置: `scripts/test-install.sh:548-564`. 内嵌 `node -e` 取根 `package.json` 的 `check` / `build` 链:
  `(scripts[name].match(/--prefix (\S+) run /g) || []).map((s) => s.split(" ")[1])`.
- 现状形态: 根 `package.json` 的 `check` / `build` 均为 34 段 `pnpm -C <包> run check|build` 以 `&&` 串联, 无 `--prefix`.
- 实测 (HEAD, 2026-11-04): 用同一正则提取, `check` 0 条 / `build` 0 条.
  ```
  旧提取 check 条数: 0 build: 0
  ```
  → 断言输出 `check/build 链提取为空；集合不一致： vs <34 个包>`, 故该断言在 HEAD 恒失败.
- 参照物未被破坏: `canonical_pkgs`(`scripts/install.sh` 与 `scripts/test-parallel.sh` 的 `default_pkgs`) 的提取用的是 `sed -n 's/^canonical_pkgs="\(.*\)"$/\1/p'`, 不涉及本问题.
- 历史: 该断言随 2026-10-03 的 install.sh 硬化落地, 当时根链为 `pnpm --prefix <包> run …`; 后续改用 `-C` 时未同步此处 (来源见条目的 `docs/archived/2026-11-04-host-upgrade-0.2.1-rc.5-install.md`「测试与证据」).

## 决策

1. 提取口径
   - a. 只认 `-C`, 断言在旧形态链上失效
   - b. 同时接受 `-C` 与 `--prefix` 两种形态, 逐段按 `&&` 切分后取首个匹配
   - c. 改断言只比集合、不比顺序
   - 选定 **b**: 两种形态都合法, 兼容写法对将来回退或混用不设假限制; 顺带保留原有的「集合一致 + check 与 build 同序」两条校验强度.

## 规划

任务拆分:

1. 重写 `extract`: 按 `&&` 切段, 每段匹配 `^pnpm (-C <dir>|--prefix <dir>) run <script>`, 取目录; 两种形态兼容.
2. 复跑 `sh scripts/test-install.sh` 全绿, 并单独验证提取结果 = 34 个包.

计划改动的文件清单:

- `scripts/test-install.sh`(仅 §11 的内嵌 `node -e` 提取部分)
- `docs/BACKLOG.md`(条目接取状态 / 关闭时移除)
- `docs/implementation/2026-11-04-test-install-chain-extract.md`(本文件)

明确不做的部分:

- 不改根 `package.json` 的 `check` / `build` 链形态(不改被测对象).
- 不动 `canonical_pkgs` / `default_pkgs` 的 `sed` 提取.
- 不新增用例(该断言本身就是用例, 修好即转绿).

## 实现记录

1. 改 `scripts/test-install.sh:552-558` 的内嵌 `extract`: 由全文正则改为按 `&&` 切段 + 每段匹配 `^pnpm (?:-C (\S+)|--prefix (\S+)) run `, 取 `hit[1] || hit[2]`. 其余判定(空链 / 同序 / 集合 / 目录存在)原样保留.
2. 单独验证提取: `check` 34 条 / `build` 34 条, 同序 `true`, 首三项 `clock-base,TUI,herdr-integration`.
3. 反向验证: 混合形态 `pnpm -C a … && pnpm --prefix b …` 提取为 `a,b`; 故意让 check / build 末项不同包时仍判「不一致」, 说明兼容写法没有放松校验强度.
4. `format` 作用于追踪文档与 `scripts/test-install.sh`; `docs/BACKLOG.md` 仅改状态词, 未跑 formatter 以免全文件重排(mdformat 会重排长行), diff 实测 2 行(1 增 1 删).

## 偏差

无. 计划三项全部落地, 未新增文件与用例.

## 测试与证据

| 命令 | 结果 |
| --- | --- |
| `sh scripts/test-install.sh` | `[test-install] 全部 117 项通过`, 含「canonical_pkgs 与 test-parallel.sh default_pkgs 同序」「canonical_pkgs 与根 check/build 链一致（集合 + check==build 同序）」「canonical_pkgs 每个目录都存在」 |
| `pnpm run check` | 退出 0(34 包 `tsc --noEmit`) |
| `pnpm run check:docs` | `✓ check:docs 通过: 111 篇现行 Markdown / 901 个 .ts, 规则 0 项, 错误 0 / 警告 0` |
| 提取单测式验证 | 修复前 0 / 0 条, 修复后 34 / 34 条且同序 |

## 收尾

- 待办: 条目在本文件中标「完成」并从 `docs/BACKLOG.md` §2 移除; 本文件移入 `docs/archived/`.
- 回写: 无需改 DESIGN / README / ROADMAP(只改脚本内一处提取口径, 对外用法不变).
- 遗留: 无.
