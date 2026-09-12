# 任务：security-guard

> 本文件为 herdr worktree 任务契约。**只允许修改本 worktree 的 `security-guard/` 目录内文件**（pre-commit 钩子强制，其他目录/根文件的提交会被拒绝）。

## 目标

实现危险命令黑名单拦截 + 敏感文件保护策略层：在 dsh 沙箱/权限体系之上加一层「黑名单语义」策略（当前 dsh 是沙箱强制，非黑名单），拦截危险 shell 命令与对敏感文件的读写。

## 来源

`docs/DEVELOPMENT-BACKLOG.md` #27（pi-defender）：危险命令黑名单拦截 + 敏感文件保护策略层；dsh 侧 `sandbox / bash-sandbox / permission-presets` 之上加策略层（对比文档 §3.5）。

## 复用底座（不新建）

- `sandbox` / `bash-sandbox`：命令执行面（拦截点在命令下发前）
- `permission-presets`：权限预设
- `credentials` 面：可顺带覆盖敏感信息（若涉及）
- 参考主仓 `knowledge-base/` 插件模板（`dsh.bundle` + `cordis.patch.yml` + `src/` + `tests/` + `smoke/`）

## 接口对齐

`DSH-CTX-API.md`（0.1.5-rc.2 契约）+ 词汇表。策略层语义：

- 黑名单：模式匹配危险命令（如 `rm -rf /`、`sudo`、`curl | sh` 等），命中即拦 + 可配置放行
- 敏感文件：保护路径清单（如 `~/.ssh/`、`.env`、凭据文件），读写拦截 + 可配置放行
- 策略默认值 + 用户层覆盖配置

## 交付物（均在 `security-guard/` 下）

- `security-guard/package.json`（含 `dsh.bundle` 键）+ `cordis.patch.yml`
- `security-guard/src/`：黑名单匹配、敏感路径守卫、命中回执（拦截原因 + 放行方式）+ DSH bundle 接入面
- `security-guard/tests/*.test.ts`：黑名单命中/放行、敏感路径读写拦截、配置覆盖
- `security-guard/smoke/smoke.mjs`：真实 dsh 会话验证拦截行为（可选，若 host 面有命令下发缝）

## 完成门槛

1. `npm --prefix security-guard run check`（tsc --noEmit 严格）通过
2. `npm --prefix security-guard run test` 全绿（node --test）
3. `npm --prefix security-guard run build` 产出 `dist/`
4. 改动文件执行 `format <文件...>`
5. 独立 profile `~/.dsh/profiles/dsh-security-guard`（`link:` 指向本 worktree）+ smoke/人工验证拦截行为

## 硬约束

- 只改 `security-guard/` 目录；其余目录与根文件一律禁止改动
- 提交仅限本 worktree 的 `feat/security-guard` 分支；不 merge main、不 push
- 不装全仓依赖，自包依赖按需最小
- 黑名单默认值须保守（宁可误拦不可漏拦）；不实现任务未提及的额外功能；代码注释中文、标识符英文
