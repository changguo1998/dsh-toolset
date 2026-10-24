# tool-consult：`tools/change` 自激死循环（宿主广播被当作动作输入）

状态：已完成（2026-10-24 修复并真机复验）　　开启：2026-10-24　　关闭：2026-10-24
范围：`tool-consult` 包内（`src/main.ts`、`tests/fake-host.ts`、`tests/main.test.ts`）

## 1. 现象

带 `tool-consult` 的 profile 启动后卡死：控制台停在若干插件日志之后，无 TUI，进程 CPU 120%+，
`Ctrl-C` 无效，只能 `kill -9`；`SIGUSR2` 诊断报告也写不出来（事件循环已停摆）。
不挂 `tool-consult` 的同一组合启动正常。

## 2. 复现（独立 profile）

用 `DSH_HOME=tmp/dsh-home` 建独立 profile（`scripts/install.sh --profile tctest`，不碰 `~/.dsh`），
用 `script -qec` 给伪终端并加 25s 硬超时，按配置分档跑：

| 配置 | 结果 |
| --- | --- |
| 不含 tool-consult | 正常（日志 258 KB，TUI 起来） |
| allowlist（缺省） | 卡死（日志 0 字节，仅 6 行启动日志，被超时杀） |
| denylist | 卡死（同上） |
| `maskMode: off` | 正常（139 KB） |

结论：只有走 `tools.restrict()` 的路径会卡死。

## 3. 根因

宿主 `dsh-tools` 的 `ScopedLayers` 在任何层变化后同步 `ctx.emit("tools/change")`
（`lib/index.js:2784`），而 `tools.restrict()` 自身就是一次层变化。旧实现把这个广播当成动作输入：

```
tools/change 监听 → applyMask() → agentTools.restrict() → 宿主 emit("tools/change") → 监听再进 → ...
```

每一次 `disposeMask()` 同样会 emit，于是「设遮罩 / 撤遮罩」互相触发，无限自激：
主线程一直在同步事件里打转，定时器与信号都轮不到，所以 CPU 打满、`Ctrl-C` 与 `SIGUSR2` 全失效。

最小复现（假宿主，`restrict` 里同步 emit）：单次 `apply()` 触发 **20003 次** emit，只因测试里设了上限才退出。

## 4. 修法（按「广播是返回值，不是输入」）

1. `tools/change` 监听只做两件**只读**的事：重建检索索引（`runtime.matcher`）、回读校验已有遮罩；
   不再调用 `applyMask`。
2. 新增 `verifyMask()`：用 `tools.schemas(agent)` 回读该代理实际可见的工具名，与该生效名单比对，
   缺项或多出都算漂移；漂移只告警一次（`warnedDrift`），**不重设遮罩**。
3. `applyMask()` 成功后调 `recordMask()` 记下 `appliedAllow` / `appliedHidden` 并立刻回读一次，
   把「设置是否生效」当场变成结果，而不是留给下一次广播。
4. 咨询工具的运行时 API 改用 `get matcher()` 实时取值，否则第 1 条的索引重建对已注册的
   `consult_tools` 不生效（原先闭包取的是旧快照）。

## 5. 验证

- 单测：46 通过（原 43 + 新增 3）。新增用例在旧实现上 3 条全红（`restrict` 同步广播那条 230ms 后爆栈），
  修复后全绿：
  - `restrict` 同步广播 `tools/change`：只施加一条遮罩，不告警；
  - `tools/change` 广播只复核：`restrictCalls` 不增加；
  - 遮罩未生效（宿主不按遮罩过滤）：告警一次且不重设。
- 真机（`tmp/dsh-home` 独立 profile，含 tool-consult，缺省 allowlist）：正常启动，TUI 起来；
  会话记录里模型看到的工具面正是 9 个核心 + `consult_tools`（`bash read write edit glob grep todo_write ask_user_question skill consult_tools`），说明遮罩真的生效而非降级。

## 6. 遗留

- 同名问题在其它消费 `tools/change` 的插件里未逐个排查（本次只改 tool-consult）。
- `~/.dsh/profiles/fff` 已挂回 tool-consult（34 个 bundle，2026-10-24），本条不再待办。

## 7. 收尾（2026-10-24 归档）

- 提交：`105bb23`（`tool-consult/src/main.ts` + 两个测试文件）；追踪文档随本次归档入库。
- 验收：包内 46 例全绿、根 `npm run check` 通过、独立 profile 真机启动正常且遮罩生效；工作区 fff profile 挂载后本会话工具面为 9 核心 + `consult_tools`。
- 关闭依据：自激死循环已消除，广播改为只读回读校验，回归用例覆盖三种情形。
