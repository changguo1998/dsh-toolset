# smoke 脚本：DSH_HOME 收进仓库 tmp 并支持模型覆盖（接取条目: docs/BACKLOG.md §2「smoke 脚本在沙箱内不可跑」）

状态: 关闭　　开启: 2026-11-04　　关闭: 2026-11-04
本文件是本任务唯一的追踪文档与文档改动位置; 计划外的文件不改。

## 目标

1. 让 4 个真机 smoke(`goal-contract` / `metric-loop` / `output-compress` / `security-guard`)在沙箱内可跑: 不再写 `~/.dsh`(只读)与 `~/.local/share/pnpm/store`。
2. 模型面可配: 缺省走本机 tollgate 网关, 模型与 key 由环境变量覆盖。
3. 把整套操作固化成脚本 + 根命令入口。

## 决策

1. 隔离方式: a 每次 `mkdtemp` → b 固定 `$repo/tmp/smoke-dsh-home` + `TMPDIR=$repo/tmp/tmpdir` → c 改 HOME。**选定 b**: 固定路径便于复用 profile 与查日志, 且不影响 pnpm 的 HOME 缓存。
2. 模型注入位置: a 由调用方事后改 profile patch → b 写进各 smoke 生成的 patch。**选定 b**: 三个 smoke 每次运行都重写自己的 `cordis.patch.yml`(实测), 事后改会被覆盖。
3. 模型缺省: `provider=tollgate`, `model=qwen38`(用户 2026-11-04 指定; `qwen38q3` 上游间歇 429 `upstream_locked`, `qwen38`/`qwen38f`/`ds41f` 探测均 200), 可用 `SMOKE_PROVIDER` / `SMOKE_MODEL` 覆盖。
4. pnpm 写盘: profile 的 `pnpm-workspace.yaml` 追加 `storeDir` / `cacheDir` 指向仓库 `.pnpm-store` / `.pnpm-cache`(已 gitignore); 这是 `dsh plugin add` 在沙箱内唯一可行的注入点(实测 CLI 参数无法从外部传入)。

## 规划

计划改动文件清单:

- `scripts/run-smoke.sh`(新增) — 统一入口: 收 DSH_HOME / TMPDIR / 日志, 预建 profile 并注入 pnpm store, 逐包跑并汇总。
- `package.json` — 新增 `test:smoke` 委托上述脚本。
- `goal-contract/smoke/smoke.mjs` — `DSH_HOME` 支持、模型 patch、会话证据改读 `$DSH_HOME/sessions`。
- `metric-loop/smoke/smoke.mjs`、`security-guard/smoke/smoke.mjs`、`output-compress/smoke/smoke.mjs` — 模型 patch 与环境变量; 前两个的 profile 路径改 `DSH_HOME`。
- `security-guard/smoke/smoke.mjs` — `collectToolResults` 兼容会话 v4 格式(见「偏差」)。
- `README.md` / `README.zh.md` — 命令表补 `pnpm run test:smoke` 与用法说明。

明确不做: 不改插件源码; 不改 smoke 的断言口径; 不动 `~/.dsh`。

## 实现记录

- 17:10 4 个 smoke 接上 `SMOKE_PROVIDER` / `SMOKE_MODEL` 并注入 `agent-default-model` + `llm-pi-ai` 段; profile 路径统一到 `DSH_HOME`。
- 17:20 `scripts/run-smoke.sh` 新增, 根 `test:smoke` 接线; 首轮跑: profile 引导失败——`dsh plugin add` 内部 pnpm 写不了 `~/.local/share/pnpm/store`(SQLite 打不开)。把 `storeDir` / `cacheDir` 追加进 profile 的 `pnpm-workspace.yaml` 后通过。
- 17:35 首轮全量: `goal-contract` / `metric-loop` 通过, 另两个 429 `upstream_locked`(`qwen38q3`)。
- 17:50 模型换 `qwen38` 后 `goal-contract` / `metric-loop` 通过; `output-compress` 因模型未按原样执行 `cat`、`security-guard` 卡在会话断言。
- 18:00 `security-guard` 断言失败根因 = 会话格式早已是 v4 (`session.v4.jsonl.zstd`; `~/.dsh/sessions` 里的旧会话同样是 v4, 说明不是 rc.5 引入): `tool/result` 结果拍平成 `content:[{type:'text'}]`、`isError` 提到 message 层, 而原解析只认 v3 的 `type:'tool-result'`。`collectToolResults` 兼容两种格式后通过。
- 18:10 全量复跑 4 个 smoke: 全部 OK(21s / 24s / 36s / 17s), 退出码 0。

## 偏差

- `output-compress` 在 `qwen38` 下第一次失败(模型把一次 `cat` 拆成多段, 未按原样执行), 单独重跑通过; 属模型服从性抖动, 不是脚本缺陷。
- 会话格式长期是 v4、smoke 解析停在 v3 这一既存缺陷不在本次计划内, 但不修则 `security-guard` 恒红, 故顺带修好并兼容两种格式。
- `qwen38q3` 上游锁定期间(`429 upstream_locked`)无法跑通, 已按用户裁定改用 `qwen38`。

## 测试与证据

- `sh scripts/run-smoke.sh`: 退出 0 —— `goal-contract` OK 21s、`metric-loop` OK 24s、`output-compress` OK 36s、`security-guard` OK 17s(日志 `tmp/smoke-logs/*.log`)。
- `security-guard` 断言明细: `isError` 拦截 + 回执齐备, 证据文件 `$DSH_HOME/sessions/--…-/session.v4.jsonl.zstd`。
- `pnpm run check:docs`: 0 错 0 警。
- 未做: CI 上的 smoke(需网关与模型), 本次只在本机验证。
