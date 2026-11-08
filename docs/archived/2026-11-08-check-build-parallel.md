# check / build 根委托链并行化（接取条目：docs/BACKLOG.md「check / build 根委托链并行化」）

状态：关闭　　开启：2026-11-08　　关闭：2026-11-08
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. 根 `pnpm run check` / `build` 由 38 包串行 `&&` 链改为与 `test` 同款并行调度：复用或扩展 `scripts/test-parallel.sh` 的 parallel / xargs 两路、`set -u` 累计退出、包清单双向校验、只跑存在的包。
2. 根 `package.json` 三链（check / build / test）统一一个并行入口。
3. 处理 build 依赖序：`code-map` / `md-map` 在 `ast-tools` / `md-logic` 之后构建（复用 `install.sh` 已实现的排序）。
4. 保持失败汇总语义与 `test-parallel.sh` 一致（不 fail-fast）；全仓 check / build / test 行为不回退, 相关测试全绿。

## 调研

- **根委托链现状**: `package.json:7` / `:8` 是 38 个 `pnpm -C <包> run check` / `run build` 用 `&&` 串起来的**单行**命令（墙钟 = 各包耗时之和）; `:9` 的 `test` 已委托 `scripts/test-parallel.sh`。
- **既有调度已可复用**: `scripts/test-parallel.sh` 用 `TEST_SCRIPT` 选包内脚本（缺省 `test`, 注释明确「可传 test:integration / test:e2e」）, 单包执行单元 `scripts/test-one.sh` 从 `package.json` 取出脚本体直接 `sh -c` 执行, 包内没有该脚本时记 SKIP —— 即 `TEST_SCRIPT=check` / `build` 天然可用, 无需改调度。
- **两处不满足**: ① 汇总行 `grep -oE "pass [0-9]+|fail [0-9]+"`（`scripts/test-parallel.sh:82`）对 check / build 的日志命中为空, 会打印一串空白; ② 构建有跨包依赖 —— `install.sh:417-431` 注释写明「跨包源码依赖只有两处（code-map → ast-tools、md-map → md-logic）, 依赖方放到第二批」, 而 `test-parallel.sh` 是单批平铺。
- **install.sh 的并行构建**: 自带 `BUILD_JOBS` / `BUILD_RUNNER`（auto / parallel / xargs / serial）与两批调度（`scripts/install.sh:432-484`）, 但它作用于 **profile 安装**, 不改根 `pnpm run build`。
- **包清单**: `test-parallel.sh:22` 的 `default_pkgs` 与 `install.sh:44` 的 `canonical_pkgs`、根 `package.json` 的串行链三处一致（38 个包）, 且脚本内有双向校验（清单里有目录没有 / 目录有清单漏列都告警）。

## 决策

1. 并行入口的做法: a 扩展既有 `scripts/test-parallel.sh`（`TEST_SCRIPT` 已支持, 补 build 两批与汇总行）/ b 新建 `scripts/run-all.sh <check|build|test>` 包一层 / c 根 `package.json` 里内联 GNU parallel。
   选定 a —— 调度、xargs 兜底、双向校验、不 fail-fast 的聚合都已跑通并有文档, 复用比自己再写一套省事且不引入第二处维护点; b 会多一层只做转发的脚本; c 失去 xargs 兜底与清单校验。代价是脚本名字仍叫 test, 文件头会写明「它包办 check / build / test」。
2. build 依赖序: a 分两批（第一批除 `code-map` / `md-map`, 第二批这两个）/ b 单批（`dist/` 已存在时多数情况也能过）。
   选定 a —— 全新环境（无 `dist/`）单批会因 `code-map` / `md-map` 找不到依赖包类型而失败; a 与 `install.sh` 同口径。
3. 失败语义: a 不 fail-fast, 全部跑完再汇总（与 test 一致）/ b 一失败就停。
   选定 a —— 一次看到所有失败包, 与既有 `test` 行为一致。
4. 汇总行: a 非 `test` 脚本省略 `pass/fail` 计数, 只打 `OK` / `FAIL` + 耗时 / b 原样打印（会出现空计数）。
   选定 a —— check / build 的日志本来就没有 pass/fail 计数, 打空串只会误导。

## 规划

- 计划改动文件清单:
  - `scripts/test-parallel.sh`（文件头口径改为「check / build / test 通用并行入口」; `TEST_SCRIPT=build` 时按两批调度; 汇总行只在 `TEST_SCRIPT` 为 test 系时解析 pass/fail）
  - `package.json`（`check` / `build` 两条改成 `TEST_SCRIPT=check sh scripts/test-parallel.sh` / `TEST_SCRIPT=build sh scripts/test-parallel.sh`）
  - `AGENTS.md`（「命令」一节说明 check / build / test 都是并行入口, 与 test 同款）
  - `README.md` / `README.zh.md`（若命令表提到串行委托链, 同步; 双侧同构）
- 明确不做: 不改 `install.sh` 的构建并行面、不改各包脚本、不引入新依赖（仍只用 parallel / xargs）。
- 验证: `pnpm run check` / `build` / `test` 三条实跑并记录墙钟; 失败语义抽查（人为让某包失败时是否仍跑完并汇总——用环境变量注入的方式不引入仓库改动, 具体做法在实现记录里写明）; `pnpm run check:docs`。

## 实现记录

- 2026-11-08: `scripts/test-parallel.sh` 改为 check / build / test 通用入口: 文件头口径重写; `target="${TEST_SCRIPT:-test}"`; `TEST_SCRIPT=build` 时把 `code-map` / `md-map` 抽到第二批（`batch1` / `batch2` 依次 dispatch）; 汇总行的 `pass/fail` 计数只在 `test*` 目标下解析。
- 2026-11-08: 调度抽成 `dispatch()` 函数（parallel → xargs 两路, 均不可用返回 2 时退出）; **包失败不再中断脚本** —— 首次实现让 dispatch 的非零码直接退出, 会吞掉汇总（`auto-approve` 的接线断言当时红, 见「偏差」）, 改为 `|| true` 后仍由退出码文件聚合出 `FAIL` + 日志。
- 2026-11-08: 根 `package.json` 的 `check` / `build` 由 38 包 `&&` 串行链改为 `TEST_SCRIPT=check sh scripts/test-parallel.sh` / `TEST_SCRIPT=build sh scripts/test-parallel.sh`（`test` 不变）。
- 2026-11-08: `auto-approve/tests/wiring.test.ts` 的接线断言同步: 原来断言「根 check / build 里有 `pnpm -C <本包>`」, 改成「根 check / build 委托并行入口」+ 仍校验本包在 `default_pkgs` / `canonical_pkgs` 里且两处同序。
- 2026-11-08: 文档同步: `AGENTS.md` 命令节、`README.md` / `README.zh.md` 命令表（双侧同构）; `scripts/test-one.sh` 头注释口径（脚本可为 check / build）。

## 偏差

- 计划外改了 `auto-approve/tests/wiring.test.ts`: 该包有一条接线断言直接匹配根 `package.json` 里的 `pnpm -C auto-approve run`, 并行化后这条串行链不存在（`pnpm run test` 因此红过一次）。属本次改动的必然连带, 已按新口径改写（不是删除断言）。
- 首次实现的 `dispatch` 错误处理过严: 任一包失败即 `exit 1` 且不打印汇总（实测 `pnpm run test` 只输出 `Test failed`, 看不到是哪个包）。**已修**: dispatch 用 `|| true` 吞掉聚合退出码, 只有「parallel 与 xargs 都不可用」才提前退出。
- 计划里「README 若提到串行委托链则同步」: 两个 README 的命令表确实写了三条命令的注释, 已同步; 其余章节（安装器并行构建一节）与本改动无关, 未动。

## 测试与证据

- `pnpm run check`: 38 个包全 `OK`, 墙钟 **4.7 s**（改前串行链为各包耗时之和, 38 包逐个 `tsc`）。
- `pnpm run build`: 38 个包全 `OK`, 墙钟 **5.9 s**。
- `pnpm run test`: 38 个包全 `OK`（含 pass/fail 计数）, 墙钟 17.8 s。
- 构建依赖序实测: `rm -rf ast-tools/dist md-logic/dist code-map/dist md-map/dist` 后 `pnpm run build` 仍全绿, 四个 `dist/` 都重新产出 —— 证明两批调度生效（单批在全新环境下会因依赖包无类型声明而失败）。
- 失败语义实测（用 `tmp/` 下的一次性假包, 不入库, 跑完即删）: `tmp/failpkg`（`test` 脚本 `exit 7`）→ 输出 `FAIL tmp/failpkg 26 ms` + 「失败包日志」节 + 退出码 1; `tmp/passpkg`（`build` 脚本 `echo built`）在 `TEST_SCRIPT=build` 下 → `OK tmp/passpkg 26 ms` 且无 pass/fail 计数（决策 4 = a）。
- 不存在包: `TEST_SCRIPT=build sh scripts/test-parallel.sh nonexistent-pkg` → `SKIP  nonexistent-pkg（目录不存在）`, 退出码 0。
- 守成: `pnpm run test:tui` 1871 pass / 0 fail; `auto-approve` 单包 184 pass / 0 fail。
- `pnpm run check:docs`: 119 篇现行 Markdown / 959 个 .ts, 错误 0 / 警告 0。

## 收尾

- BACKLOG 条目已移除, 本文件移入 `docs/archived/`。
- 回写: `AGENTS.md`（命令节）; `README.md` / `README.zh.md`（命令表, 双侧同构）。
- 遗留: 脚本名仍叫 `test-parallel.sh`（决策 1 = a 的既定取舍, 文件头已写明它包办三条命令）; 若将来要改名, 需同步 `install.sh` 注释与相关文档, 另开条目。
