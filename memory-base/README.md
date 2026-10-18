# @dsh-toolset/memory-base

DSH（DeepSeek Harness）进程内插件：**分层记忆的存储底座**——S / P / U 三层独立 SQLite（`node:sqlite`）库 + FTS5 双索引。本包只做存储（分层 / 分类 / 读写 / 查询 / 按扩展隔离），提升、审阅、生命周期与容量淘汰归上层插件。

## 定位与读写边界

- **读全局**：`ctx.get('memory')` 八键，跨 kind、跨层查询，调用方不传文件路径、不关心一次会碰几个库。
- **写隔离**：写入与删除**只经 `registerKind(spec)` 返回的作用域句柄**（按 kind + 可写层），全局面没有任何写入键。
- **不注册写工具**：模型侧只有一个只读查询工具 `memory_query`；写权限留在各扩展的句柄上。

## 服务面（`ctx.get('memory')`，八键）

| 键 | 参数要点 | 返回 |
| --- | --- | --- |
| `registerKind(spec)` | `{kind, table?, writableTiers?, preWrite?}`；同步注册、返回写入句柄 | `MemoryScope`（见下） |
| `search(opts)` | `query` 必填；`kind?` / `tier?` / `project?` / `limit?`（缺省 10，clamp 1..100）/ `fuzzy?` | `SearchHit[]`（带 `kind` / `tier` / `score`） |
| `list(opts?)` | `kind?` / `tier?` / `project?` / `limit?`（缺省 20，clamp 1..100）/ `offset?` | `StoreRow[]`（`created_at` 倒序） |
| `checkPrivacy(text)` | 隐私底线查询（内置 + `persistRules.denyPatterns`） | 命中返回模式源串，否则 `null` |
| `getSummary()` | 无 | `{ready, kinds[{kind, table, writableTiers, rows}], tiers[{tier, path, created}], chunkCount, sourceCount}`；`created: false` = 该层库尚未创建 |
| `whenReady()` | 无 | `Promise<MemoryBundle>`（`apply` 同步建 bundle，故恒 resolve） |
| `usage()` | 无 | `{tier, path, bytes}[]`，**只报已创建的库** |
| `migrate({from, mode})` | 只有 `from: "v1"` / `mode: "drop"` | `{dbPath, removed[]}`；删库文件与 `-wal` / `-shm`，不备份、不静默删 |

## 写入作用域句柄（`MemoryScope`）

```ts
interface MemoryScope {
  readonly kind: string;
  readonly writableTiers: readonly Tier[];   // 注册时归一（缺省 ["session"]）
  put(input: ScopePutInput): Promise<PutResult>;
  forget(refs: readonly { tier: Tier; ids: readonly number[] }[]): Promise<number>;
}
interface ScopePutInput {
  content: string;
  tier?: Tier;              // 缺省 "session"；不在 writableTiers 内 → 抛错
  project?: string;         // 缺省用配置的 project（再缺省 process.cwd()）
  title?: string;
  importance?: number;      // clamp 1..5，可被 preWrite 建议覆盖
  source?: { kind: "session" | "file" | "url" | "tool_result" | "manual"; ref?: string; label?: string };
  sessionId?: string;       // 写 S 层必需；写 P / U 层可选（给了就落 session_id 列）
}
interface PutResult { ids: number[]; sourceId: number; created: number; skipped?: "empty" | "short" | "pattern" | "kind" | "hook" }
```

**拒写的两种形态**（唯一两种失败风格）：

**抛错**（参数级 / 权限级）与 **`skipped`**（内容级，`ids` 为空、不落库、不抛错）——逐条触发与表现见 `docs/DESIGN.md` §3 的「拒写的两种形态」表与 §8 失败语义汇总。

## 分类注册

本包只提供**分类机制**，不规定有哪些分类——「偏好」「技能沉淀」这类语义归各自上层插件，代码里不出现具体分类名。

```ts
const scope = memory.registerKind({
  kind: "preference",
  writableTiers: ["project"],
  preWrite: (input) => ({ accept: !input.content.startsWith("敏感"), importance: 4 }),
});
```

- **一类一张物理表**（`kind_<归一化>`，标识符白名单校验）；表在**首次写入**时才建（空表不建），新增分类 = 加表，不需要数据迁移。
- **`writableTiers` 是层维度的写隔离**：想写 P / U 必须显式声明，越权层调用抛错。
- **`preWrite(input)`** 在隐私闸之后、INSERT 之前执行（可返回 Promise），可拒绝或建议 `importance`；入参 `{content, title?, project, kind}` **不含 `tier`**——需要按层分别拦截就拆 kind（先例：`preference` + `preference_user`）。
- 同名 / 同表重复注册、表名撞保留名、`writableTiers` 非法或为空数组，均抛错。
- kind 名由注册方自定，本包不校验也不维护全量清单。

## 分层与落点

三层库文件 / 落点 / 指纹（`SESS` / `PROJ` / `USER`）与不变量见 `docs/DESIGN.md` §1。

- **层级恒开启**，没有开关也没有单库形态；**库惰性创建**——`apply` 只解析落点，首次写到某层才建 / 打开该库。
- **S 层落点经 `session-paths` 的 `sessionDirFor(sessionId)` 解析**：本包不自己拼路径、不读宿主会话服务。该服务未挂载时 S 层写入按明示例外报错，P / U 层不受影响。
- 同一进程可能同时存在主会话与子代理会话，S 层按 `(tier, sessionId)` 惰性打开并缓存，各落各库。
- 检索排序：**U > P > S**，同层按分数。

## 模型侧工具 `memory_query`（只读）

- `action`：`search`（缺省，全文检索）/ `list`（按 kind 结构化列举）；
- 参数：`query`（search 必填）、`kind?`、`tier?`、`project?`、`limit?`（缺省 10，clamp 1..100）、`fuzzy?`（仅 search）、`offset?`（仅 list）；
- 输出带 `kind` / `tier` 标签；单行正文超 300 字符截断标注，命中数达 `limit` 标「已截断」；空结果给 `(无命中)` / `(无条目)`；
- 参数里没有文件路径与命令文本，故**不进** `security-guard` 的登记表；写侧不对模型开放。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dshHome` | `~/.dsh` | U 库落点根（`<dshHome>/memory-base/user.db`） |
| `projectRoot` | `process.cwd()` | P 库落点根（`<projectRoot>/.dsh/project.db`） |
| `project` | `process.cwd()` | 缺省归属项目键（句柄未给 `project` 时用） |
| `journalMode` | `"wal"` | `wal` / `delete` / `truncate` / `persist` |
| `persistRules` | 无 | `{minChars?, denyPatterns?}`：最小长度与追加拒绝模式（内置隐私模式始终生效，非法正则只记 warning） |
| `listLimit` | `20` | `list` 的缺省上限（clamp 1..100） |
| `legacyDbPath` | `~/.dsh/memory-base/memory.db` | `migrate` 作用的旧库路径 |

## 使用示例

```ts
import { createMemoryBundle, createGlobalService } from "@dsh-toolset/memory-base";

// 无宿主形态（测试 / demo）：直接建 bundle；sessionPaths 由调用方提供。
const bundle = createMemoryBundle({
  config: { dshHome: "/home/me/.dsh", projectRoot: "/repo", project: "my-project" },
  sessionPaths: { sessionDirFor: (id) => `/home/me/.dsh/sessions/.../${id}` },
});
const memory = createGlobalService(bundle, { project: "my-project" });

const note = memory.registerKind({ kind: "note", writableTiers: ["session", "project"] });
await note.put({ content: "会话要点", sessionId: "s1" });
await note.put({ content: "项目结论", tier: "project" });
await memory.search({ query: "要点 OR 结论" });
await memory.list({ kind: "note" });
bundle.dispose();
```

宿主侧由 bundle 契约自动调用 `apply(ctx, config)`：同步建 bundle → `ctx.provide("memory", 八键)` → 注册 `memory_query`（宿主缺 `tools` 时只记日志）。profile 挂载（`~/.dsh/profiles/<p>`）以 `link:` 指向本包：

```yaml
- id: memory-base
  name: '@dsh-toolset/memory-base'
  config:
    project: 'my-project'
```

S 层写入需要 `session-paths` 插件同在组合里（它 `provide: ["sessionPaths"]`）；本包用 `ctx.get("sessionPaths")` 探测，**不写进 `inject`**。

## 边界与限制

- **已知边界**（CJK 召回与 `LIKE` 兜底及转义、去重全局、隐私形态匹配、不做价值判断、token 估算、层权重、删除不传播、同进程共享）见 `docs/DESIGN.md` §10。
- **`search` 无写副作用**：命中不刷新任何列（`last_referenced` 已随列删除下线）。
- 库文件 `0o600`、父目录 `0o700`；**一库一指纹**，指纹或版本不符一律拒绝打开（不整库重置）；旧库清空走显式 `migrate({from: "v1", mode: "drop"})`。
- **已知窗口**：TUI `/memory add` 与 `/memory review` 依赖已删除的 `remember` / `candidates.*`，属 TUI 侧待适配；`/memory search` 走全局只读面不受影响。

## 测试

```sh
npm run check   # tsc -p tsconfig.json --noEmit
npm run build   # tsc -p tsconfig.json → dist/
npm run test    # node --experimental-transform-types --test 'tests/*.test.ts'
npm run demo    # node --experimental-transform-types demo/main.ts（末行 demo OK）
npm run smoke   # node smoke/smoke.mjs（自包含自检，不依赖模型凭据）
```

61 例（`schema` 5 + `knowledge` 12 + `kinds` 8 + `tiers` 9 + `bundle-tiers` 9 + `exposure` 3 + `tools` 8 + `rules` 4 + `migrate` 3）。

`demo` 演示句柄写入三层、隐私闸 / `preWrite` / 越权层、跨层检索与列举、真删、`memory_query` 渲染。`smoke` 是确定性自检：惰性建库 → 三层写入 → 指纹断言 → 全局读面 → 闸门 → 真删 → 工具面 → 可选报告宿主机版本；失败保留临时目录。

## 文档

- 设计取舍、机制与实现落点：`docs/DESIGN.md`（定位 / 分层 / 句柄 / 闸门 / 查询 / Schema / 失败语义 / 边界 / 实现落点与踩坑）。
- 待办：`docs/BACKLOG.md`。
