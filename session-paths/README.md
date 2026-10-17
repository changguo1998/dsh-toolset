# session-paths

DSH（DeepSeek Harness）会话目录编码插件：**复刻宿主的目录编码**，并以服务形态 `sessionPaths` 供其他插件共用 —— 仓内唯一事实源，各消费方不再自己拼路径。

## 为什么有这个包

宿主把每个会话的目录建成：

```
<sessionsRoot>/<projectKey(cwd)>/<encodeSegment(sessionId)>/
```

本机 `<sessionsRoot>` = `~/.dsh/sessions`，桶名形如 `--home-guochang-Projects-dsh-toolset--`。这三个编码函数在宿主包里**不导出**（`@deepseek-ai/dsh-session-persistence-jsonl` 只导出 `JsonlCompressionSchema` 与默认类），`dsh-session` / `dsh-session-persistence` 也没有面向插件的目录读取面 —— 插件拿不到该路径。

仓内先前的做法是各写一份，其中 `memory-base` 那份（只做「去前导斜杠 + 分隔符换 `-`」）算出来的目录**并不存在**。故按仓内既有的「约定自足小函数复制 + 注释标注出处」口径复制一份，收敛为单一服务。

## 服务面

`ctx.get("sessionPaths")`：

| 方法 | 语义 |
| --- | --- |
| `root()` | 已 resolve 的绝对路径（sessions 根） |
| `projectKey(cwd)` | 宿主 `projectKey` 的忠实复刻：`--…--` 外壳、`~XXXX` 转义、251 截断 |
| `projectDir(cwd)` | `cwd` 缺失（`undefined`）→ `<root>/_no-cwd` |
| `sessionDir(cwd, sessionId)` | `<projectDir>/<encodeSegment(sessionId)>` |
| `sessionDirFor(sessionId)` | 只有会话 id 时用它：内部经宿主 `sessions` 取 `header.cwd`（缺失走 `_no-cwd`），再走 `sessionDir`；`sessions` 不可用或会话取不到 → 抛明示例外。同步、不建目录 |
| `ensureSessionDir(cwd, sessionId)` | **唯一写盘入口**：`mkdir -p`（0700）、幂等，返回目录路径 |

纯函数同时以具名导出对外透出（`import { projectKey } from "@dsh-toolset/session-paths"`），供手里同时有 `cwd` 与 `sessionId` 的调用方与对拍测试直接使用。

## 配置

```yaml
- id: session-paths
  name: '@dsh-toolset/session-paths'
  config:
    root: /path/to/sessions      # 可选
```

`root` 缺省按 `DSH_HOME` 环境变量推：`<DSH_HOME>/sessions`；无该变量回落 `~/.dsh/sessions`。给相对路径时按进程 cwd resolve 成绝对路径。

## 边界语义

1. 四个纯函数**不落盘**、**不因目录不存在报错**，只在入参非法时按宿主同语义抛（空 `cwd` / 空 `sessionId`）。
2. `ensureSessionDir` 是**唯一写盘入口**，权限 0700、幂等；纯函数永不调用它。
3. `sessionDirFor` 同步、不落盘、**不建目录** —— 宿主建会话时就建好了会话目录（内含 `session.lock` 与 `session.v4.jsonl.zstd`）。它是本包唯一依赖宿主服务的面。
4. 目录存在性由宿主负责，本包不保证、也不校验可写性：消费方真正写文件 / 开库时遇到目录不存在或不可写，按各自的失败口径处理（不静默换路径）。
5. **不写进 `inject`**：宿主 `sessions` 只在 `sessionDirFor` 里可选读取。宿主缺该服务时本包照常加载，纯函数与 `ensureSessionDir` 的消费方不受影响；只有 `sessionDirFor` 抛明示例外。
6. 服务缺失或 `sessionDirFor` 抛错时由调用方自行降级（如 memory-base 的 S 层不可用、output-compress 的 `skipped.session-dir-missing`）。

## 出处与复核

`src/encode.ts` 复刻自 `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`：

| 函数 | 行号 |
| --- | --- |
| `encodeSegment` | `853-865` |
| `projectKey` | `875-894` |
| `projectDir` | `902-905` |
| `sessionDir` | `912-914` |

宿主升级后按此复核编码是否漂移（漂移复核属独立任务）。复刻含宿主**有意保留的有损**行为：分隔符合并、`~XXXX` 转义、251 截断。

## 用法

```ts
// 手里同时有 cwd 与 sessionId（纯函数面，不落盘）
const paths = ctx.get("sessionPaths");
const dir = paths.sessionDir("/home/u/proj", sessionId);

// 只有 sessionId（同步解析，内部取 cwd）
const dir2 = ctx.get("sessionPaths").sessionDirFor(sessionId);

// 需要落盘时显式调用唯一写盘入口
await ctx.get("sessionPaths").ensureSessionDir("/home/u/proj", sessionId);
```

## 测试

```sh
npm --prefix session-paths run check   # 两个 program 的类型检查
npm --prefix session-paths run test    # 23 例：编码对拍 + 服务面（假 ctx / 假 sessions）
```

编码对拍的期望值来源：本机 `~/.dsh/sessions/` 的真实桶名（七个），以及从宿主已安装包里截出四个函数、在本地 eval 出的真实实现（合成向量覆盖 `~XXXX` 转义、连续分隔符合并、`_no-cwd`、`.` 与 `..`、251 截断），断言一律逐字符相等。
