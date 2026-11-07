# 插件端到端用例

每个插件一条进程内真宿主用例：`e2e/<包>.test.ts` 经 `@deepseek-ai/dsh/profile-boot` 的 `runProfile()` 装配 `@deepseek-ai/dsh-base` + 被测包（服务依赖按需追加），在临时 `DSH_HOME` 与独立 profile 里执行工具、注入会话事件并断言落盘结果。

## 运行

```sh
pnpm run test:e2e          # 37 条，并发 4；--test-force-exit 收尾
pnpm run test:e2e:tui      # TUI 原有的 demo:build -- --smoke + smoke:pty
```

`test:e2e` 不进 `pnpm run test`；包内用例面不变。

## 前置

- 根 `devDependencies` 的 `@deepseek-ai/dsh` 钉在 `0.2.2-rc.1`，`dsh-base` 随之固定（宿主版本不随本机全局安装漂移）。
- 外部命令：`ast-grep`（`ast-tools`）、`python`（`script-interpreter`）、`redis-server` / `redis-cli`（`session-channel` 与 `agent-group`）、`herdr`（`herdr-use` 只读列举；`herdr-integration` 用进程内 unix socket 自足）。
- 夹具一律写 `tmp/e2e/<随机>/`，用例结束删除；`tmp/` 已在 `.gitignore`。

## 夹具

`e2e/harness.ts`：

| 能力 | 说明 |
| --- | --- |
| `bootPackage(dir, options)` | 建临时 `DSH_HOME`、写 profile 清单（`dsh-base` + 被测包 + `extraPackages`）、把仓库包符号链接进 profile 的 `node_modules`、起树 |
| `options.patch` | 覆盖 profile 用户层 `cordis.patch.yml`（函数形态可先拿临时 home 生成配置路径） |
| `options.prepare` | 起树前准备外部资源（本地 Redis、unix socket 服务、helper 链接） |
| `options.env` | 起树前注入环境变量（herdr 握手） |
| `host.callTool(name, args, { agent })` | 经 `ctx.tools.execute()` 走宿主完整工具管线；`agent` 用于会话归属类工具 |
| `host.createAgent()` | 用 `ctx.agents.create()` 建真实 agent / 会话（供 goal、task、context 等会话面） |
| `captureInjections(agent)` / `appendTurn` / `appendStepEnd` | 拦截 rule-engine 的三条投递路径、按真实事件形态驱动回合与步边界 |
| `waitFor` | 异步落盘/投递的轮询等待 |

个别用例读取宿主服务的只读内部字段（如 `sessionTitle.registration.provider.id`）以确认接管成功，属夹具侧观察点，不改被测代码。
