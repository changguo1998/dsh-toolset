# 修 `test-install.sh` 既有红灯：标题接管守卫计数过时（接取条目：docs/BACKLOG.md「`test-install.sh` 既有红灯：标题接管守卫计数过时」）

状态：关闭　　开启：2026-10-08　　关闭：2026-10-08
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`sh scripts/test-install.sh` 全绿跑完。当前第 17 项失败，且 `fail()` 立即 `exit 1`，其后的约 32 项检查从未执行过。

## 调研

复现（2026-10-08，`sh scripts/test-install.sh`，退出码 1，输出存 `tmp/test-install-before.log`）：

```
[test-install] 通过：…（16 项）
[test-install] 失败：守卫：补 1 处禁用块（…/profiles/tguard/cordis.patch.yml 的非注释行中「disabled: true」出现 3 次；期望 1）
```

**根因**：`assert_active_count_eq`（`scripts/test-install.sh:85-90`）数的是**整个 patch 文件**的非注释行；而 profile 的 `cordis.patch.yml` 由 `profiles/example/cordis.patch.yml` 复制而来，该示例自 `1e17b50`（2026-10-07「卸载 DeepSeek 账号登录链」）起含 **2 条活跃 `disabled: true`**（`- id: deepseek-account` / `- id: llm-deepseek-account`，示例文件 110-114 行）。断言想验的是「脚本补了 1 处禁用块」，实得 2（示例自带）+ 1（生成）= 3。

断言写于示例还没有活跃 `disabled: true` 行时，因此**把示例内容耦合进了测试**——这是本次要修的根因，不是示例内容有问题（示例口径见 `docs/BACKLOG.md` §6「挂起」）。

同一根因影响 6 处断言（语义均为「验生成区里有 X」）：

| 断言位置 | 验什么 | 现在 | 修后 |
| --- | --- | --- | --- |
| `:205` | 补 1 处禁用块 | 红（3 ≠ 1） | 绿 |
| `:229` | 夹具已清掉生成区 | 红（2 ≠ 0） | 绿 |
| `:234` | 带开关按内容补回生成区 | 红（3 ≠ 1） | 绿 |
| `:247` | 无 provider/model 时仍补禁用 | 红（3 ≠ 1） | 绿 |
| `:249` | 首轮不写路由 | 绿（巧合：示例里对应行是注释） | 绿 |
| `:259` | 补齐值后重试补上路由 | 绿（同上） | 绿 |

后两处现在靠巧合成立（示例文件 88-93 行的 `session-title-cutoff` 示例仍是注释态）；一旦示例按注释所述放开，就会以同样方式复红。

## 决策

- **选项 A：按示例现状改期望**（4 处期望改 2 / 2 / 3 / 3）。4 行 diff，但把示例当前内容硬编码进测试；示例再增删 `disabled: true` 行即复红——`docs/BACKLOG.md` §6 已写明「桌面版部署请删掉这两条」，属可预期的近期变动。**否决**。
- **选项 B（选定）：计数只统计脚本生成区**。新增 `assert_generated_count_eq`，统计范围为**首个 `# install.sh generated: title-takeover-` sentinel 起至文件尾**；把上表 6 处断言切过去。生成区恒为「文件尾追加」（`scripts/install.sh:661-712` 的 `title_write` 只 `cat >>`），故「sentinel → EOF」等价于生成区。改后测试只与**脚本自己的产物**耦合，与示例内容解耦。

## 规划

### 计划改动文件清单

| 文件 | 改动 |
| --- | --- |
| `scripts/test-install.sh` | 新增 `assert_generated_count_eq`；6 处生成区断言切换 |
| `docs/BACKLOG.md` | 条目标〔进行中〕→（收尾时）标完成并从 §2 清理 |
| `docs/implementation/2026-10-08-test-install-guard-count.md` | 本追踪文档 |

### 明确不做

- **不给 `fail()` 加「累计失败、跑完全部检查」模式**：本条目的病是计数过时，不是失败即停；改测试框架的失败语义超出条目范围。
- **不把 `scripts/test-install.sh` 接进 npm scripts**（如 `test:install`）：条目未提，属另一件事。
- **不改 `profiles/example/cordis.patch.yml`**：示例内容本身正确（`deepseek-account` 两条是有意禁用），错的是断言的统计范围。
- 不动 `scripts/install.sh`：生成区行为正确，本次是测试侧修正。

## 实现记录

- 2026-10-08：`scripts/test-install.sh` 新增 `assert_generated_count_eq`（`:91-96`）——`awk` 从首个 `# install.sh generated: title-takeover-` sentinel 起输出到文件尾，其余判定与 `assert_active_count_eq` 相同（丢注释行 + 固定串计数）。
- 6 处「验生成区」语义的断言切到新助手：`:211`（补 1 处禁用块）、`:235`（夹具已清掉生成区）、`:240`（按内容补回生成区）、`:253`（无 provider/model 时仍补禁用）、`:255`（首轮不写路由）、`:265`（重试补上路由）。
- 净改动 +6 / -6 行（新增 6 行助手 + 6 行改名）；`scripts/install.sh` 与 `profiles/example/cordis.patch.yml` 未改（见「明确不做」）。
- 保持全文件计数的断言不动（`:212-216` 的 `provider: bogus` / `provider: ustc` / sentinel、`:280-281` 的自定义 id 两处）——它们的语义本就是「整个 patch 里出现几次」。

## 测试与证据

机械门禁与验证（本机，2026-10-08）：

| 命令 | 结果 |
| --- | --- |
| `sh scripts/test-install.sh`（修前） | 退出码 1；16 项通过后第 17 项失败（`disabled: true` 出现 3 次；期望 1），其后 **68** 项从未执行 |
| `sh scripts/test-install.sh`（修后） | 退出码 0；`[test-install] 全部 84 项通过` |
| `sh -n scripts/test-install.sh` | 无输出（语法正确） |
| `shfmt -i 4 -ci -s -sr -d scripts/test-install.sh` | 无 diff（改动已符合仓库格式） |
| `npm run check` | 退出码 0（本次未改 TS；按流程跑机械门禁） |

- 日志：`tmp/test-install-before.log` / `tmp/test-install-after.log`（临时文件，收尾清理）。
- **助手非空转的证明**：新助手若匹配不到生成区（例如 sentinel 文本写错），计数恒为 0，则 3 处「期望 1」的断言会立刻失败——它们通过，说明 `awk` 的范围确实覆盖了生成区。反向同理：若 `install.sh` 不再写禁用块，这 3 处会红，回归仍抓得到。
- 未做的验证：未在真机 profile 上跑 `install.sh --sync --take-over-title`（本次只改测试的统计口径，`install.sh` 行为未变）。
- 条目原文与实测不符之处（备查）：条目写「后续约 32 项检查不再执行」（按 §1 索引「49 例」推算），实际该脚本现有 **84** 项断言，被跳过的是 **68** 项。§1 索引的「49 例」是 2026-10-03 新增时的历史数字，本次不改。

## 收尾

- 条目（`docs/BACKLOG.md`「`test-install.sh` 既有红灯：标题接管守卫计数过时」）标完成并从 §2 清理移除；余下 5 条按当前顺序重编号（旧 2-6 → 新 1-5），表内 4 处行内前置引用与 §2「当前可开工顺序」注记同步重写（可执行序 **2 → 4 → 5 → 1 → 3**）。
- 本追踪文档从 `docs/implementation/` 移入 `docs/archived/`（用 `mv` 而非 `git mv`：该文件自建起未提交，不在 git 索引中），状态置「关闭」。
- 回写 `DESIGN.md` / `README.md` / `ROADMAP.md`：无——本次只改测试的统计口径，不涉架构、用法与方向。
- `docs/STATUS.md`：按流程不改（用户择时更新）。
- 临时文件：`tmp/test-install-before.log`、`tmp/test-install-after.log` 已删（`tmp/` 下其余文件早于本任务，未动）。
- 遗留：无。
