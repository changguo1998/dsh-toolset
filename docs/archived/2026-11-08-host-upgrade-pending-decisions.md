# 宿主升级待裁定: fs-observation-policy 守卫恢复 与 apply_patch 启用取舍（接取条目：docs/BACKLOG.md「宿主升级待裁定: fs-observation-policy 守卫恢复 与 apply_patch 启用取舍」）

状态：已完成　　开启：2026-11-08　　关闭：2026-11-08
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. 由用户裁定是否恢复官方「读后改前」守卫：恢复则 profile patch 加 `- id: fs-observation-policy` + `disabled: false`；不恢复则维持 rc.1 出厂形态并在文档注明取舍。
2. 由用户裁定是否启用 `apply_patch`：启用则先完成「apply_patch 写面覆盖」再开 `tool-fs` 的 `config.applyPatch: true`；不启用则维持 `false` 并同步 `escalation-hint` 提示面边界。
3. 裁定结果落 profile（fff / fff-test）与相关文档, 并回写 `docs/host/HOST-UPGRADE-0.2.2-rc.1.md` §12 的待裁定状态。

## 决策（2026-11-08 用户批准, 两项都取「维持现状」）

| 编号 | 决策项 | 结论 | 关键依据 |
| --- | --- | --- | --- |
| 1 | `fs-observation-policy` 是否恢复 | 不恢复, 维持 `disabled: true` | 官方 benchmark 后统一定为 `disabled: true`; 观察不持久, 会话恢复须重读; 本机多写者场景 `FS_STALE_VERSION` 误报面大; 兜底已有 security-guard + 沙箱 + git; 恢复只需一行 patch |
| 2 | `apply_patch` 是否启用 | 不启用, 维持 `applyPatch: false` | 与 `hash_edit`(行级锚点 + stale 校验) 和 `write` 重叠; 应用阶段失败即停且不回滚; 相对路径窄面未收口; 每次请求多一段 schema 与 guidance, 与工具面收敛相反 |

## 计划改动文件清单

- `docs/host/HOST-UPGRADE-0.2.2-rc.1.md`（§12 由「仍待裁定」改为「已裁」, 逐项写结论与依据）
- `docs/implementation/2026-11-08-host-upgrade-pending-decisions.md`（本文件）
- `docs/BACKLOG.md`（条目关闭并重排编号）

不改 profile: 两项都维持 rc.1 出厂形态, 故 fff / fff-test 不需要任何 patch 行。

## 实现记录

1. 复核安装树实际取值（避免用官方文档当事实）: `dsh-base/cordis.patch.yml:292-300` 是 `fs-observation-policy: disabled: true` + `tool-fs: config.applyPatch: false`; profile 的 `node_modules` 只有本仓包, `dsh-base` 从全局安装解析, 故以上即生效值。
2. 与官方升级指南的一处不一致已记明: `docs/upgrade-guide/v0.2.2-alpha.2/fs-observation-policy-default-off/guide.zh.md` 写 `dsh-base` 的 `tool-fs` 行是 `applyPatch: true`, 但本机 rc.1 装的是 `false` —— 以安装树为准, `docs/BACKLOG.md` 的原描述正确。
3. `docs/host/HOST-UPGRADE-0.2.2-rc.1.md` §12 标题改为「升级后的取舍裁定 (2026-11-08 已裁)」, 前两项各写结论 + 四条依据（官方 Agent Note、官方 README 的观察不持久、本机多写者场景、启用后请求体量）, 并保留「将来要恢复/启用的前置条件」。

## 验证

- `dsh-base` 与 profile 的实际取值与裁定一致（未改任何配置文件）: `grep -n "applyPatch" <dsh>/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml` → `300: applyPatch: false`; `fs-observation-policy` 行 → `disabled: true`。
- `pnpm run check:docs`: 错误 0 / 警告 0。

## 未覆盖

- 未做真机会话对照（关/开守卫各跑一轮编辑）—— 裁定依据是官方 benchmark 记录与本机场景分析, 不是本机实测对比。
- `docs/host/` 文档不参与变更流程的强制检查, 只跑了 `check:docs`。
