# @dsh-toolset/tool-consult

## 定位

DSH（DeepSeek Harness）工具咨询插件：首请求起工具声明常驻且字节稳定, 非初始工具只给短定义; 模型用一句话描述要做什么, `consult_tools` 按关键词索引返回名称与一句话, 揭示后按工具投递完整说明与参数 schema. 揭示不改工具声明.

设计与证据链见 `docs/implementation/2026-11-13-tool-reveal-redesign.md`（关闭后归档）与项目级 `docs/BACKLOG.md` 的已完成索引.

## 能力

- **全量短清单常驻**: 14 个初始工具保留宿主完整定义; 其余非初始、非条件工具在 agent 作用域 shadow 成短说明 + 宽松占位, 完整说明与完整 schema 收进 `@dsh-toolset/tool-surface` 的 catalog. 工具声明在固定路由与固定就绪状态下从首请求起不变.
- **揭示只追加正文**: 揭示 = 会话授权集合 + 每工具一条 `pinNotes.hold("revealed:<工具名>")` 全文（`description` + `input_schema`）; 不新增、不删除、不重排声明, 也不调用 `tools.restrict`.
- **未揭示门禁**: 纳入管理的工具在未授权时由 `tools/pre-execute` 拒绝, 文案指向 `tool_consult`, `error.info.code = TOOL_NOT_REVEALED`; 揭示后放行.
- **条件工具白名单**: `allowedWhenTools` 内的条件工具保持宿主原样（`when` 与完整定义都在）; 名单外的条件工具用一次静态 `restrict({ deny })` 从模型面彻底移除, 不进检索索引、不可揭示、不投递.
- **咨询即授权**: `consult_tools(query | names, limit, reveal)`; `reveal: false` 只预览, 不写授权. 授权在本会话内只增不减.
- **可行动错误**: 调用未揭示的工具返回「先经 tool_consult 查询」的文案, 不是裸的 `unknown tool`.

## 配置

| 字段 | 缺省 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关; `false` 时整体不 shadow、不 deny、不投递 |
| `initialTools` | 14 个: `bash` / `read` / `glob` / `grep` / `ask_user_question` / `skill` / `write` / `edit` / `read_image` / `web_search` / `web_fetch` / `job_output` / `job_list` / `job_kill` | 保留完整定义; 支持 `*` / `?` 通配 |
| `allowedWhenTools` | `web_search` / `web_fetch` | 允许保留宿主原样的条件工具; 放行新条件工具只加名字 |
| `applyTo` | `roots` | `roots`（只管理根代理）/ `all` |
| `maxResults` | `5` | 单次返回上限（1 至 20） |
| `audit` | `false` | 预留: 写 `tool-consult/*` 审计事件 |

旧版 `maskMode` / `revealScope` / `maxRevealed` / `maxPinned` / `ttlTurns` / `disabledWhenTools` 已废弃; 命中时每次 apply 告警一次并忽略.

## 用法

profile 的 `cordis.patch.yml` 插入本包（本包自带 `cordis.patch.yml` 时随 bundle 生效）:

```yaml
- insert:
    - id: tool-consult
      name: '@dsh-toolset/tool-consult'
      config:
        initialTools: [bash, read, glob, grep, ask_user_question, skill, write, edit, read_image, web_search, web_fetch, job_output, job_list, job_kill]
        allowedWhenTools: [web_search, web_fetch]
```

`tool-surface` 必须比 `tool-consult` 先挂载; `scripts/install.sh` 的规范顺序已满足. 主 profile 需重跑 `scripts/install.sh --profile fff --sync` 才会带上本包对 `tool-surface` 的新依赖.

## 边界

- **失败即不接管**: catalog 自检失败（`toolSurface` 未挂载 / 多实例 / 已包装工具缺 catalog 项）时整个插件不接管; 静态 deny 失败或 `schemas(agent)` 残留时当前代理不接管; 两者都撤掉已做注册并告警一次, 工具面回退宿主默认. 上述保证只覆盖成功接管的状态.
- **白名单内条件工具**: 保持宿主原样, 会随 readiness 进出 header; 不 shadow / 不 deny / 不包装.
- **晚注册工具**: 非条件工具不补 shadow, 不进 managed 集合, 默认放行（以完整定义出现属已知边界）; 条件工具由 `tools/change` 重算并补 deny.
- **子代理**: 缺省 `applyTo: roots`, 不遮蔽 / 不 deny; `all` 才逐代理管理.
- **静态 deny 集合**: 只覆盖全局条件工具; agent 作用域注册的条件工具不受 `restrict` 约束（本仓当前无此用法）.
- **注入通道**: 完整说明与 schema 只经 `pinNotes.hold` 按工具投递; `pin-note` 缺席时揭示仍写授权, 但正文不投递, 只告警.
- **短说明指向名**: 各包短说明里的 `tool_consult` 为历史统一写法, 实际入口是 `consult_tools`.

## 测试

```sh
pnpm run check             # tsc --noEmit（含 tests）
pnpm run build             # 编译到 dist/
pnpm run test              # 单元: 配置 / 授权集合 / 检索 / 工具 / shadow / 门禁 / hold
pnpm run test:integration  # 集成: 装配 apply 与宿主接线
pnpm run test:coverage     # 单元 + 集成一起跑，报告落 tmp/cov-tool-consult
```
