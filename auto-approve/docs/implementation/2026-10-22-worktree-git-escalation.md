# 放行 worktree 内的 git 提交（沙箱升级白名单）

状态：进行中　　开启：2026-10-22　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

并行开发时，各组代理在自己的 git worktree 里执行 `git add` / `git commit` 需要写工作区之外的
`.git/worktrees/<name>/`（索引）与公共 `.git/objects`、`.git/refs`，因此会请求沙箱升级到
`danger-full-access`；缺省升级白名单为空，每次都要人工点面板。目标是在 auto-approve 的缺省配置里
放行这类提交，同时不放开命令注入面。

## 调研

- 升级请求只带 `toolName` / `callId` / `reason`，命令原文由本插件的 `callId → 参数` 表提供；
  白名单两维判定：命令正则命中 **且** 目标模式在 `to` 内（`auto-approve/src/rules.ts:151-200`）。
- 命令规则只看命令文本，**看不到 cwd 与分支**；因此无法机械区分「主检出」与「worktree」。
  实际约束来自沙箱本身：主检出里的 git 写操作都在工作区内，不会触发升级；worktree 的 git 目录在
  工作区外，才会触发升级。规则只在升级请求上生效，故等价于「只对工作区外的 git 目录生效」。
- 风险：`to: danger-full-access` 会放行整条命令，故正则必须锚定整串并排除复合命令（`;`、`&&`、`|`、
  换行），否则 `git commit && rm -rf /` 会被一并放行。
- 另一层风险：`git commit` 会执行仓库内的 hook（`pre-commit` 等），hook 可执行任意代码；这是
  仓库自身内容，属用户可控范围，不在本条处理。

## 决策

1. 只放行三个简单形态：`git add`、`git commit`、`git tag`，允许带 `-C <path>` 前缀。
2. 正则锚定整串并排除复合命令：`^git +(?:-C +[^ ]+ +)?(?:add|commit|tag)(?: +[^;&|]*)?$`。
3. 目标模式只给 `danger-full-access`（`workspace-write` 对工作区外路径无效）。
4. 规则写在包缺省补丁 `auto-approve/cordis.patch.yml`，所有用本 bundle 的 profile 生效；
   `deny.escalation.to` 优先于它，需要收紧的用户仍可用拒绝名单覆盖。

## 规划

### 计划改动文件清单

- `auto-approve/cordis.patch.yml`（新增 `escalation.allow` 一条）
- `auto-approve/README.md`（配置示例补规则；「沙箱升级白名单」节补限制说明）
- `auto-approve/tests/decide.test.ts`（行为用例：命中 / 复合命令不命中 / 目标模式不符不命中）
- `auto-approve/tests/bundle.test.ts`（补丁文件包含该规则的守卫断言）
- `auto-approve/docs/BACKLOG.md`（条目登记与关闭）

### 验收

- `cd auto-approve && npm run check && npm test` 全绿。
- 行为用例：`git commit -m "x"` + `danger-full-access` → `allowed-once`、`ruleId` 为本规则；
  `git commit -m x && rm -rf /tmp/x` → 不命中；`git commit` + `workspace-write` → 不命中。
- 真机：worktree 内提交不再弹面板（待主分支重启后验证，本条不做真机验收）。
