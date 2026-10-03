# message-feedback 激活失败（接取条目：`docs/BACKLOG.md`「dsh 启动告警：`1 entry did not activate. message-feedback ValidationError`」）

状态：关闭　　开启：2026-10-04　　关闭：2026-10-04

## 目标

定位并修掉 fff profile 里 `message-feedback` 行的激活失败（ValidationError），把结论回写文档。

## 调研（根因）

- 挂载：该 `- insert:` 块（`profiles/example/cordis.patch.yml` 与 `~/.dsh/profiles/fff/cordis.patch.yml`，各 10 行）里 message-feedback **只有 id + name、无 `config`**。
- 宿主 schema：`dsh-message-feedback/lib/index.js:159` `static Config = s.object({ maxNoteBytes: s.number().step(1).min(1).required() })` + `:169` 运行时守卫（正整数）⇒ 缺 config 必 ValidationError。
- 告警源：`dsh-app-boot/lib/index.js:3959`（启动告警汇总）。
- 取值依据：上游 `dsh-web-app/cordis.patch.yml` 同 id/name 行带 `config: maxNoteBytes: 8192`（Web 对话框的 note 上限）⇒ 采用 **8192**。
- 审阅更正：① 「rc.2 变严」假设**错**——0.1.7-rc.2 起该字段就是 `.required()`，D3 的「PTY 真机无激活告警」是**假通过**（捕获口径有洞）；② `session-reference.maxReferenceBytes` 无默认但**不需** config（schemastery 语义：只有 `.required()` 才在缺 config 时报错；实测 `validate(undefined)` → ok）⇒ 兄弟行维持现状；③ 全组合复算（base + fff 共 170 行）**无其它同类行**；本仓 21 条 insert 行均无该风险。

## 实现记录

- `profiles/example/cordis.patch.yml`：message-feedback 行补 `config: maxNoteBytes: 8192` + 该 `- insert:` 块注释补「缺 config × `.required()` ⇒ 激活失败，`--dump-config` 查不出」。
- `profiles/README.md` 边界：加同口径规则（新增官方行前核对 schema 的 `.required()`）。
- `docs/host/HOST-PACKAGES.md`：更正被证伪的健康声明 + 记修复与验证。
- `docs/archived/2026-10-02-profile-mount-expansion.md`：加一行更正（归档不改叙事，按仓内先例）。
- **fff 侧未写**（`~/.dsh/profiles/fff/cordis.patch.yml`，需用户授权）：待用户授权后补同一 config 并重启确认。

## 测试与证据

- L1（schema 复算，只读）：`Config["~standard"].validate(undefined)` → `FAIL: $.maxNoteBytes missing required value`；`{maxNoteBytes:8192}` → `ok`。
- L2（隔离 `DSH_HOME` 克隆真机 A/B，`cp -a` 复刻 fff + 共享 node_modules，PTY 启动 22s）：
  - A（现状）：`dsh: warning: 1 entry did not activate` + `message-feedback … ValidationError: invalid config` ✓ 复现用户报障；
  - B（克隆 patch 补 config 后）：`did not activate` 次数 **0**，捕获非空（阳性对照：A 29 行 / B 23 行，B 含正常启动行）。
- 未验证：fff 真机重启（L3，需用户侧执行）；`--dump-config` 对本类缺陷零覆盖（已知，不用于验收）。

## 收尾

- 回写：上面四处文档；`docs/BACKLOG.md` 清理所接条目并重新编号、同步 §2。
- 新发现问题：`scripts/install.sh` 的收尾 `--dump-config` 自检对本类缺陷无覆盖（可加静态检查：无 config 的官方行跑 `validate(undefined)`）——**不追加条目**（属改进建议，待需要时再评估）。
- 临时产物：隔离克隆（`/tmp` 下、mktemp）与 `tmp/l2.env` 已删；无残留。
