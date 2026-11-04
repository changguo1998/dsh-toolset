// TUI/src/app/adapter/dsh-panels.ts — 面板查询: 各面板的只读服务面成员
//
// 由 dsh.ts 的 createRealDshAdapter 机械搬出（行为不变）。只依赖上下文对象。

import { parseContractObjective, findTask, flattenTasks } from "./contracts.ts";
import { aggregateSearchSources, loopRowDetail } from "./search-aggregate.ts";
import type {
  DshAdapter,
  AgentRowInfo,
  AgentGroupViewLike,
  CommandPanelRow,
  KnowledgeBundleSummaryLike,
  MemoryRowRef,
  ContractParseResult,
  WorkflowRunLike,
  SearchSourceLike,
  ContentBlockLike,
  AgentPresetInfo,
  ConfigEntrySummary,
} from "./types.ts";
import { collectJobs } from "./history-normalize.ts";
import { formatSettingValue } from "./session-records.ts";
import type { AdapterContext } from "./context.ts";

export function createPanelBridge(ctx: AdapterContext) {
  const s = ctx.state;
  const { opts } = ctx;

  // /workflows 面板行：runs 集合 → CommandPanelRow[]（running → active 黄 / done → inactive 灰）。
  // 行归一只在 refreshWorkflows 主动调用时 emit（面板打开）；tool-workflow 增量事件仅更新
  // 内部 Map、不 emit 额外事件（避免污染既有事件流尾索引断言），面板实时性由 App 打开期间
  // 定时刷新承担（与 /agents 同款定时刷新基建）。
  const workflowRows = (): {
    title: string;
    detail: string;
    status: string;
  }[] =>
    Array.from(s.workflowRuns.values()).map((r) => ({
      title: r.name,
      detail: `${r.phase} · 成员 ${r.membersDone}/${r.members}`,
      status: r.status === "running" ? "active" : "inactive",
    }));

  const part: Partial<DshAdapter> = {
    async permissionCatalog() {
      const svc = opts.permissionPresets;
      if (
        !svc ||
        typeof svc.current !== "function" ||
        !Array.isArray(svc.names)
      ) {
        return undefined;
      }
      let current = "";
      try {
        // SAFETY: 服务结构面仅保证 names/current；activeAgent.session.events 宽松读取——
        // 缺 events / 服务抛错都降级（current 置空），绝不崩。
        const child = s.activeAgent as
          { session?: { events?: readonly unknown[] } } | null | undefined;
        const events = child?.session?.events ?? [];
        const c = svc.current(events);
        if (typeof c === "string") current = c;
      } catch {
        /* 服务读异常 → 当前值降级为空 */
      }
      // 展示描述宽松读取（PresetSpec.name/description，非结构面保证；缺省回落键名）。
      // SAFETY: 结构面之外的身份 presets 表仅作展示增强——字段缺失/形状不符时
      // 下方的 optional chaining 与 typeof 检查全部走降级（回落键名），不成立也不会崩。
      const specTable = (
        svc as unknown as {
          presets?: Record<string, { name?: string; description?: string }>;
        }
      ).presets;
      const entries = [...svc.names].map((key) => {
        const spec = specTable?.[key];
        return {
          key,
          name:
            typeof spec?.name === "string" && spec.name !== ""
              ? spec.name
              : key,
          ...(typeof spec?.description === "string" && spec.description !== ""
            ? { description: spec.description }
            : {}),
        };
      });
      return { current, names: [...svc.names], entries };
    },
    async agentPresetCatalog() {
      // P3：agent 预设目录——可用预设（ctx.agentPresets.list）+ 当前选中（agent-preset/selected
      // 事件回读）+ 未来会话默认（defaultId）。宿主未挂载服务 → undefined（顶层提示不可用）。
      const svc = opts.agentPresets;
      if (!svc || typeof svc.list !== "function") return undefined;
      const presets: AgentPresetInfo["presets"] = [];
      try {
        // SAFETY: 仅依赖 list() 元素 id；name/description 宽松读取（缺省回落 id），绝不崩。
        for (const row of await svc.list()) {
          const rec = row as {
            id?: unknown;
            name?: unknown;
            description?: unknown;
          };
          if (typeof rec?.id !== "string" || rec.id === "") continue;
          presets.push({
            id: rec.id,
            name:
              typeof rec.name === "string" && rec.name !== ""
                ? rec.name
                : rec.id,
            ...(typeof rec.description === "string" && rec.description !== ""
              ? { description: rec.description }
              : {}),
          });
        }
      } catch {
        return undefined;
      }
      // 当前选中回读：activeAgent.session.events 末条 agent-preset/selected（latest-wins）
      let current = "";
      try {
        const child = s.activeAgent as
          { session?: { events?: readonly unknown[] } } | null | undefined;
        const events = child?.session?.events ?? [];
        for (let i = events.length - 1; i >= 0; i--) {
          const ev = events[i] as {
            type?: unknown;
            data?: { agentPreset?: unknown };
          };
          if (
            ev?.type === "agent-preset/selected" &&
            typeof ev.data?.agentPreset === "string"
          ) {
            current = ev.data.agentPreset;
            break;
          }
        }
      } catch {
        /* 回读异常 → 当前值保持空 */
      }
      const defaultId = typeof svc.defaultId === "string" ? svc.defaultId : "";
      return { current, defaultId, presets };
    },
    async refreshJobs() {
      // P3：读 ctx.jobs.list() 全量快照（caller=当前会话，owner-relative），经 jobs-changed
      // 推送（reducer 更新 /jobs 面板）。宿主未挂载 ctx.jobs / list 缺失 → reject
      // （调用方 notice「jobs 服务不可用」，绝不静默假成功）。
      const svc = opts.jobs;
      if (!svc || typeof svc.list !== "function") {
        throw new Error("jobs 服务不可用");
      }
      // caller = 当前会话 id（0.1.7 起 `JobRegistry` 的 caller 为裸 SessionId 字符串）
      const jobs = collectJobs(svc.list(s.activeSessionId));
      ctx.emit({ type: "jobs-changed", sessionId: s.activeSessionId, jobs });
    },
    async killJob(id) {
      // P3：取消后台任务 → ctx.jobs.kill(id, caller)。宿主未挂载 → reject（面板 notice）。
      // caller 同上（owner-relative 权限核对）。
      if (s.disposed) return;
      const svc = opts.jobs;
      if (!svc || typeof svc.kill !== "function") {
        throw new Error("jobs 服务不可用");
      }
      svc.kill(id, s.activeSessionId);
    },
    // 命令注册表目录（ctx.commands.list(agent)：CommandDescriptor[]）：仅取 name/description
    // 供输入补全；服务未暴露 list 或读取异常 → undefined（调用方降级为仅本地命令）
    commandList() {
      const svc = opts.commands;
      if (!svc || typeof svc.list !== "function") return undefined;
      const agent = s.activeCommandAgent ?? s.activeAgent;
      if (!agent) return undefined;
      try {
        const out: { name: string; desc: string }[] = [];
        for (const d of svc.list(agent) ?? []) {
          const name = typeof d?.name === "string" ? d.name : "";
          if (!name) continue;
          out.push({
            name,
            desc: typeof d.description === "string" ? d.description : "",
          });
        }
        return out;
      } catch {
        return undefined;
      }
    },
    /** 拉取 skills 列表并归一化后经 command-panel-data 推送（服务缺失 → reject；
     *  读取失败 → 事件带 error，面板显示红行）。描述取首行以适配单行渲染。 */
    async refreshSkills(filter?: string): Promise<void> {
      const svc = opts.skills;
      if (!svc || typeof svc.list !== "function") {
        throw new Error("skills 未挂载（宿主无技能服务）");
      }
      try {
        const list = (await svc.list()) ?? [];
        const needle = (filter ?? "").toLowerCase();
        const matched =
          needle === ""
            ? list
            : list.filter((skill) =>
                `${skill.name} ${skill.description ?? ""} ${skill.whenToUse ?? ""}`
                  .toLowerCase()
                  .includes(needle),
              );
        ctx.emit({
          type: "command-panel-data",
          kind: "skills",
          rows: matched.map((skill) => ({
            title: skill.name,
            detail:
              (skill.description ?? skill.whenToUse ?? "").split("\n")[0] ?? "",
            payload: skill.name,
          })),
        });
      } catch (err) {
        ctx.emit({
          type: "command-panel-data",
          kind: "skills",
          rows: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    /** 读取单个 skill 正文（Enter 详情）；服务缺失或读取失败 → undefined */
    async skillDetail(name: string): Promise<string | undefined> {
      const svc = opts.skills;
      if (!svc || typeof svc.get !== "function") return undefined;
      try {
        const def = await svc.get(name);
        return def?.content;
      } catch {
        return undefined;
      }
    },
    /** 拉取子代理列表并归一化后推送两处：/agents 面板（command-panel-data；diagnostic 与
     *  一次性条目不可中断——payload 置空，后者附 `blockedReason` 原因）与**状态列 Agents 块**
     *  （agents-changed，BACKLOG TUI#39；过滤 `unavailable` 诊断，见 TUI#56）。
     *  数据源：`listDescendants`（富条目 + depth），取 depth=1 的直接子代。 */
    async refreshAgents(): Promise<void> {
      const svc = opts.subagents;
      if (typeof svc?.listDescendants !== "function") {
        throw new Error("subagents 未挂载（宿主无子代理服务）");
      }
      try {
        // 会话别名（状态列 Agents 块显示名 = 别名 ?? label）：增强项，读取失败静默
        const aliasById = new Map<string, string>();
        try {
          const list = await opts.sessionChannel?.()?.aliasList();
          if (list?.ok === true) {
            for (const e of list.aliases ?? [])
              aliasById.set(e.sessionId, e.alias);
          }
        } catch {
          // 别名读取失败不阻塞目录刷新
        }
        const entries = (
          (await svc.listDescendants(s.activeSessionId)) ?? []
        ).filter((entry) => (entry.depth ?? 1) === 1);
        // 状态列 Agents 块：与面板同源归一化（label / 状态 / 异常标记），但**只保留当前活跃
        // 的行**——已结束子代（`activity: "inactive"` = 会话已不在）与全部诊断条目都不上
        // 状态列（详情仍在 /agents 面板；BACKLOG「状态列 Agents 块只列运行中 / 存活且无
        // 诊断的子代理」，含 TUI#56 的 unavailable 口径）
        const agentRows: AgentRowInfo[] = entries
          .filter(
            (entry) =>
              entry.kind !== "diagnostic" && entry.activity === "running",
          )
          .map((entry) => {
            const diagnostic = entry.kind === "diagnostic";
            const id = entry.id ?? "-";
            const alias = aliasById.get(id);
            const work = s.lastToolBySession.get(id);
            // 条目 1：条目行符号的闪烁速率（无样本不填 → 布局侧走缺省档）
            const tps = s.rateBySession.get(id)?.tps;
            return {
              id,
              label: diagnostic
                ? `（诊断：${entry.reason ?? "unknown"}）`
                : (entry.label ?? "(未命名)"),
              // 投影目录形态无 activity → 退用 mode（one-shot/continuable/unknown）作状态语义
              status: diagnostic
                ? "diagnostic"
                : (entry.activity ?? entry.mode ?? ""),
              // 状态列 Agents 块：别名 + 工作内容（无别名 / 无记录时省略该段）
              ...(alias !== undefined ? { alias } : {}),
              ...(work !== undefined ? { work } : {}),
              ...(tps !== undefined ? { tps } : {}),
              ...(diagnostic
                ? { diagnostic: { reason: entry.reason ?? "unknown" } }
                : {}),
            };
          });
        // 清理已离场会话的工具摘要（防无界增长）
        const liveIds = new Set(agentRows.map((r) => r.id));
        for (const id of s.lastToolBySession.keys()) {
          if (!liveIds.has(id)) s.lastToolBySession.delete(id);
        }
        for (const id of s.rateBySession.keys()) {
          if (!liveIds.has(id)) s.rateBySession.delete(id);
        }
        ctx.emit({
          type: "command-panel-data",
          kind: "agents",
          rows: entries.map((entry) => {
            const diagnostic = entry.kind === "diagnostic";
            const oneShot = entry.mode === "one-shot";
            const title = diagnostic
              ? `（诊断：${entry.reason ?? "unknown"}）`
              : (entry.label ?? "(未命名)");
            const detail = [
              entry.mode ?? "",
              entry.activity ?? "",
              entry.hasChildren === true ? "has-children" : "",
            ]
              .filter((p) => p !== "")
              .join(" · ");
            return {
              title,
              detail,
              // 投影目录形态无 activity → 退用 mode（one-shot/continuable/unknown）作状态语义
              status: diagnostic
                ? "diagnostic"
                : (entry.activity ?? entry.mode ?? ""),
              // 可中断载荷：诊断条目无可用 id；一次性条目宿主的 interrupt 是 accepted
              // no-op（只支持 live continuable）→ 同样不给载荷，改以 blockedReason 说明
              payload: diagnostic || oneShot ? undefined : entry.id,
              ...(oneShot && !diagnostic
                ? {
                    blockedReason:
                      "一次性子代理不支持中断（宿主仅支持 continuable）",
                  }
                : {}),
            };
          }),
        });
        ctx.emit({
          type: "agents-changed",
          sessionId: s.activeSessionId,
          agents: agentRows,
        });
      } catch (err) {
        ctx.emit({
          type: "command-panel-data",
          kind: "agents",
          rows: [],
          error: err instanceof Error ? err.message : String(err),
        });
        // 状态列：枚举失败不静默留旧数据，以**异常态**一行呈现（渲染红 + reason）
        ctx.emit({
          type: "agents-changed",
          sessionId: s.activeSessionId,
          agents: [
            {
              id: "-",
              label: "agents 目录不可用",
              status: "diagnostic",
              diagnostic: { reason: "unavailable" },
            },
          ],
        });
      }
    },
    /** 中断一个子代理（`interrupt(id, {kind:'user', parentSessionId: activeSessionId})`）；
     *  服务缺失或调用失败 → reject（调用方 notice）。 */
    async interruptAgent(childSessionId: string): Promise<void> {
      const svc = opts.subagents;
      if (!svc || typeof svc.interrupt !== "function") {
        throw new Error("subagents 未挂载（宿主无子代理服务）");
      }
      svc.interrupt(childSessionId, {
        kind: "user",
        parentSessionId: s.activeSessionId,
      });
    },
    /** 拉取工具 schema（`schemas()` 全局视图）按 `filter` 过滤后推送；描述取首行 */
    async refreshTools(filter?: string): Promise<void> {
      const svc = opts.tools;
      if (!svc || typeof svc.schemas !== "function") {
        throw new Error("tools 未挂载（宿主无工具服务）");
      }
      try {
        const schemas = svc.schemas() ?? [];
        const needle = (filter ?? "").toLowerCase();
        // filter 只匹配工具名子串（描述不参与，避免描述误命中）
        const matched =
          needle === ""
            ? schemas
            : schemas.filter((s) => s.name.toLowerCase().includes(needle));
        ctx.emit({
          type: "command-panel-data",
          kind: "tools",
          rows: matched.map((s) => ({
            title: s.name,
            detail: (s.description ?? "").split("\n")[0] ?? "",
            payload: s.name,
          })),
        });
      } catch (err) {
        ctx.emit({
          type: "command-panel-data",
          kind: "tools",
          rows: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    /** 读取单个工具详情（名称 + 描述 + 参数 schema JSON）；服务缺失或读取失败 → undefined */
    async toolDetail(name: string): Promise<string | undefined> {
      const svc = opts.tools;
      if (!svc || typeof svc.get !== "function") return undefined;
      try {
        const def = svc.get(name);
        if (!def) return undefined;
        const lines = [name];
        const description = def["description"];
        if (typeof description === "string" && description !== "") {
          lines.push("", description);
        }
        const parameters = def["parameters"];
        if (parameters !== undefined) {
          lines.push("", "参数：", JSON.stringify(parameters, null, 2) ?? "");
        }
        return lines.join("\n");
      } catch {
        return undefined;
      }
    },
    /** 读取全部设置（`settings.describe()` 枚举 ns + 当前值，`ns：value` 每行一行；
     *  secret 项脱敏为 `<redacted>`）；服务缺失或读取失败 → undefined。 */
    async readSettings(): Promise<string | undefined> {
      const svc = opts.settings;
      if (!svc || typeof svc.describe !== "function") return undefined;
      try {
        const descs = svc.describe() ?? [];
        if (descs.length === 0) return "（无设置项）";
        return descs
          .map((d) => {
            const ns = d["ns"];
            const hasSecret =
              Array.isArray(d["secrets"]) && d["secrets"].length > 0;
            const valueText = hasSecret
              ? "<redacted>"
              : formatSettingValue(d["value"]);
            return ns !== undefined && ns !== ""
              ? `${String(ns)}：${valueText}`
              : valueText;
          })
          .join("\n");
      } catch {
        return undefined;
      }
    },
    /** 列出 config-editor 的可编辑条目（`configuration()` → 纯数据快照）；服务缺失 /
     *  形状不符 / 读取抛错 → undefined。 */
    async configEntries(): Promise<readonly ConfigEntrySummary[] | undefined> {
      const svc = opts.configEditor;
      if (!svc || typeof svc.configuration !== "function") return undefined;
      try {
        const rows = svc.configuration() ?? [];
        const out: ConfigEntrySummary[] = [];
        for (const row of rows) {
          const id = row?.entry?.options?.id;
          if (typeof id !== "string" || id === "") continue;
          const name = row.entry.options?.name;
          out.push({
            id,
            name: typeof name === "string" ? name : "",
            inherited: row.inherited ?? {},
            override: row.override ?? {},
          });
        }
        return out;
      } catch {
        return undefined;
      }
    },
    /** 按 id 重新解析当前 Entry 再调 `configEditor.edit()`：不缓存 Loader 对象（HMR 重载后
     *  旧 Entry 即失效，宿主会以「entry is no longer available」拒绝）。服务缺失 → reject
     *  中文提示；宿主拒绝 → reject 原样文案（上层统一加「编辑失败：」前缀）。 */
    async editConfigEntry(
      id: string,
      change: (
        current: Record<string, unknown>,
        inherited: Record<string, unknown>,
      ) => Record<string, unknown>,
    ): Promise<void> {
      const svc = opts.configEditor;
      if (
        !svc ||
        typeof svc.edit !== "function" ||
        typeof svc.entries !== "function"
      ) {
        throw new Error(
          "config-editor 未挂载（profile 未装该插件），条目配置不可编辑",
        );
      }
      const entry = (svc.entries() ?? []).find(
        (candidate) => candidate?.options?.id === id,
      );
      if (entry === undefined) {
        throw new Error(
          `条目 ${id} 不在可编辑集合内（不存在或不是 profile 直属行）`,
        );
      }
      await svc.edit(entry, change);
    },
    /** 任务面板：经 task-engine `query()` 只读面先序展平为行（标题 + 状态）推送；未挂载 reject。
     *  多轮（森林 > 1 棵）时给**轮根行**标注轮次——标注放 title **行首**（行右侧先被
     *  `truncateToWidth` 截掉，detail 尾的标注在窄面板会先消失）；标注只在本映射里加，
     *  不写进 `flattenTasks`（`findTask` / taskDetail 复用同一函数，详情不加轮次行）。 */
    async refreshTasks(): Promise<void> {
      const svc = opts.taskEngine;
      if (!svc || typeof svc.query !== "function") {
        throw new Error("taskEngine 未挂载（宿主无任务引擎查询面）");
      }
      try {
        const snap = svc.query();
        const forest = snap.tasks;
        // 轮根 id → 轮次：引擎 `round`（id 跳号不代表轮次）**全有才用**；任一轮根缺 `round`
        // 则整片回落轮根序号——避免同一森林里两种口径混用串号（多轮与 `round` 同版本引入，
        // 旧版引擎恒单根，故该回落实际不可达）
        const allRounded = forest.every((t) => typeof t.round === "number");
        const roundOf = new Map(
          forest.map((t, i): [string, number] => [
            t.id,
            allRounded && typeof t.round === "number" ? t.round : i + 1,
          ]),
        );
        const currentRootId = forest[forest.length - 1]?.id;
        const multiRound = forest.length > 1;
        const rows = flattenTasks(forest).map((t) => {
          const round = t.depth === 0 ? roundOf.get(t.id) : undefined;
          const tag =
            !multiRound || round === undefined
              ? ""
              : t.id === currentRootId
                ? `当前轮 ${round} · `
                : `旧轮 ${round} · `;
          return {
            title: `${tag}${t.depth > 0 ? `${"  ".repeat(t.depth)}${t.title}` : t.title}`,
            detail: `${t.status}${t.needDecompose ? " · 待拆分" : ""}`,
            status: t.status,
            payload: t.id,
          };
        });
        ctx.emit({
          type: "command-panel-data",
          kind: "task",
          rows,
        });
      } catch (err) {
        ctx.emit({
          type: "command-panel-data",
          kind: "task",
          rows: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    /** 循环面板：经 metric-loop `list()` 归一化为行（measureCmd/id + 状态·方向·轮数
     *  ·best·更新时间）；running → status active（黄）、stopped → inactive（灰）；未挂载 reject */
    async refreshLoops(): Promise<void> {
      const svc = opts.metricLoop;
      if (!svc || typeof svc.list !== "function") {
        throw new Error("metricLoop 未挂载（宿主无循环查询面）");
      }
      try {
        const loops = svc.list() ?? [];
        const rows: CommandPanelRow[] = loops.map((s) => ({
          title: s.measureCmd && s.measureCmd !== "" ? s.measureCmd : s.id,
          detail: loopRowDetail(s),
          status: s.status === "running" ? "running" : "inactive",
          payload: s.id,
        }));
        ctx.emit({ type: "command-panel-data", kind: "loop", rows });
      } catch (err) {
        ctx.emit({
          type: "command-panel-data",
          kind: "loop",
          rows: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    /** /group：经 agentGroup 只读服务 `status()` 拉取当前会话群组清单/单组详情，
     *  归一化返回值供 notice 渲染（不 emit 面板数据）；失败面（state_unavailable /
     *  session_paths_unavailable / group_not_found）原样透传；未挂载 reject */
    async readGroupStatus(
      sessionId: string,
      groupName?: string,
    ): Promise<
      | {
          ok: true;
          groups: readonly { name: string; view: AgentGroupViewLike }[];
        }
      | { ok: false; error: string; reason?: string; next?: string }
    > {
      const svc = opts.agentGroup;
      if (!svc || typeof svc.status !== "function") {
        throw new Error("agentGroup 未挂载（宿主无群组查询面）");
      }
      return svc.status(sessionId, groupName);
    },
    /** /search：经 ctx.web.search（统一多 provider 搜索 seam）拉取并归一化行推
     *  command-panel-data(kind=search)。title 缺省回落 URL host（与 dsh-tool-web 一致）；
     *  detail = url + snippet 首段、payload = url（Enter 打开详情）。宿主未挂载 web.search
     *  → reject（调用方 warn 不空开面板）。 */
    async search(query: string, maxResults = 10): Promise<void> {
      // provider 集合：opts.web（host 派生）+ options.searchProviders（TUI 本地可配置）
      // —— seam 是 provider-selecting 非聚合，TUI 侧负责并行遍历与合并/去重/排序。
      const providers: {
        id: string;
        search(): Promise<{ sources: readonly SearchSourceLike[] }>;
      }[] = [];
      const svc = opts.web;
      const webSearch =
        svc && typeof svc.search === "function" ? svc.search : undefined;
      if (webSearch) {
        providers.push({
          id: "web",
          search: () => webSearch({ query, maxResults }),
        });
      }
      if (Array.isArray(opts.searchProviders)) {
        for (const p of opts.searchProviders) {
          if (p && typeof p.search === "function") {
            providers.push({ id: p.id, search: () => p.search(query) });
          }
        }
      }
      if (providers.length === 0) {
        throw new Error("web 未挂载（宿主无搜索面）");
      }
      const agg = await aggregateSearchSources({
        providers,
        query,
        maxResults,
      });
      if (agg.failed > 0 && agg.success === 0) {
        // 全部失败 → 调用方 notice warn（不空开面板数据）
        throw new Error("所有搜索 provider 均失败");
      }
      ctx.emit({ type: "command-panel-data", kind: "search", rows: agg.rows });
    },
    /** /council：并行拉起 count（默认 2）个评审子代理（ctx.subagents.start，one-shot）
     *  对 target 各自给独立意见。任一 run 失败降级保留其余（idea 行列失败注明）；
     *  run 自身不 reject（stopReason:'error'），基础设施异常 reject → 调用方 warn。
     *  汇总 ≤4 行：各行 = `评审 N：<output 首行>`；全部失败 text = 失败说明。 */
    async council(target: string, count = 2): Promise<string> {
      const svc = opts.subagents;
      if (!svc || typeof svc.start !== "function") {
        throw new Error("subagents 未暴露 start（宿主无子代理启动面）");
      }
      const n = Math.max(1, Math.min(4, Math.floor(count)));
      const startFn = svc.start;
      if (typeof startFn !== "function") {
        throw new Error("subagents 未暴露 start（宿主无子代理启动面）");
      }
      const results = await Promise.allSettled(
        Array.from({ length: n }, (_, i) =>
          Promise.resolve(
            startFn("one-shot", {
              label: `council-${i + 1}`,
              prompt: [
                {
                  type: "text",
                  text:
                    `请对以下目标/问题给出独立的评审意见（指出风险、遗漏与改进建议，` +
                    `简明扼要，3 行以内）：\n\n${target}`,
                },
              ],
              parent: s.activeAgent as unknown,
            }),
          ).then(async (run): Promise<{ ok: boolean; text: string }> => {
            const result = run ? await run.result : undefined;
            // run 无 result / 无输出 且 stopReason=error → 该评审判定失败（降级保留序号）
            if (!result) return { ok: false, text: "（无结果）" };
            const output = Array.isArray(result.output)
              ? result.output
                  .filter((b): b is ContentBlockLike & { text?: string } => !!b)
                  .map((b) => b.text ?? "")
                  .filter((t) => t !== "")
                  .join(" ")
              : typeof result.text === "string"
                ? result.text
                : "";
            const trimmed = output.trim();
            if (trimmed !== "") return { ok: true, text: trimmed };
            const reason =
              typeof result.error === "string" && result.error !== ""
                ? result.error
                : (result.stopReason ?? "无输出");
            return { ok: result.stopReason !== "error", text: reason };
          }),
        ),
      );
      const lines = results.map((r, i) => {
        const body =
          r.status === "fulfilled"
            ? (r.value.text.trim().split("\n")[0] ?? "（无意见）")
            : `失败：${String(r.reason)}`;
        return `评审 ${i + 1}：${body}`;
      });
      const okCount = results.filter(
        (r) => r.status === "fulfilled" && r.value.ok,
      ).length;
      if (okCount === 0) {
        return `council 失败：${count} 个评审均未返回意见`;
      }
      return [`council（${okCount}/${n} 成功）`, ...lines].join("\n");
    },
    /** /workflows 面板：读 adapter 维护的 tool-workflow 运行集合推 command-panel-data；
     *  宿主未挂载 workflowEngine → reject（调用方 warn 不空开面板）。 */
    async refreshWorkflows(): Promise<void> {
      const eng = opts.workflowEngine;
      if (!eng) {
        throw new Error("workflowEngine 未挂载（宿主无工作流引擎）");
      }
      ctx.emit({
        type: "command-panel-data",
        kind: "workflows",
        rows: workflowRows(),
      });
    },
    /** 契约回读：优先 goal-contract 只读面（opts.goalContract.parseContract），宿主未挂载
     *  （当前 goal-contract 不 expose 服务）→ 内置同构回读兜底（不依赖跨包 import） */
    get workflowRuns(): readonly WorkflowRunLike[] {
      return Array.from(s.workflowRuns.values());
    },
    contractSummary(objectiveText: string): ContractParseResult {
      const svc = opts.goalContract;
      if (svc && typeof svc.parseContract === "function") {
        try {
          const r = svc.parseContract(objectiveText);
          if (r && typeof r === "object") {
            return r;
          }
        } catch {
          // service 实现异常 → 回落内置回读
        }
      }
      return parseContractObjective(objectiveText);
    },
    /** 循环详情（Enter）：list() 中定位该 id，输出 4 行（id/状态·停止原因/配置/进度·最优） */
    async loopDetail(id: string): Promise<string | undefined> {
      const svc = opts.metricLoop;
      const found = svc?.list?.()?.find((s) => s.id === id);
      if (!found) {
        return undefined;
      }
      const statusLine =
        found.status === "running"
          ? `状态：运行中`
          : `状态：已停止${found.stopReason ? `（${found.stopReason}）` : ""}`;
      const cfg = [
        `方向：${found.direction === "min" ? "最小化" : "最大化"}`,
        found.measureCmd
          ? `目标：${found.measureCmd}`
          : "目标：无（metricless）",
      ].join(" · ");
      return [
        `循环：${found.id}`,
        statusLine,
        cfg,
        `轮 ${found.rounds ?? 0}/${found.maxRounds ?? "?"} · 窗口 ${found.window ?? 0} · best ${found.best ?? "n/a"}`,
      ].join("\n");
    },
    /** 知识库概要：`getSummary()` 同步优先，否则 `whenReady()` 等待就绪；未就绪 →
     *  返回说明文本（调用方以 info 呈现）；服务缺失 → reject（调用方 warn）。 */
    async memorySummary(): Promise<string> {
      const svc = opts.knowledge;
      if (
        !svc ||
        (typeof svc.getSummary !== "function" &&
          typeof svc.whenReady !== "function")
      ) {
        throw new Error("knowledge 未挂载（宿主无知识库查询面）");
      }
      // 就绪概要行（helper）
      const linesOf = (
        s: KnowledgeBundleSummaryLike | undefined,
      ): string | undefined => {
        if (!s) return undefined;
        if (!s.ready) return "知识库尚未就绪（异步建库中）";
        return [
          "知识库：就绪",
          `路径：${s.dbPath}`,
          `chunks：${s.chunkCount} · sources：${s.sourceCount}`,
        ].join("\n");
      };
      try {
        if (typeof svc.getSummary === "function") {
          const direct = linesOf(svc.getSummary());
          if (direct !== undefined) return direct;
        }
        if (typeof svc.whenReady === "function") {
          const awaited = await svc
            .whenReady()
            .then((b) => linesOf(b?.summary?.()))
            .catch(() => undefined);
          if (awaited !== undefined) return awaited;
        }
        return "知识库尚未就绪（apply 尚未创建库或启动失败）";
      } catch {
        return "知识库尚未就绪（读取失败）";
      }
    },
    /** `/memory search`：跨全域检索（LayeredHit 宽松形态透传）。 */
    async memorySearch(args: {
      query: string;
      limit?: number;
    }): Promise<unknown[] | undefined> {
      const search = opts.knowledge?.search;
      if (typeof search !== "function") return undefined;
      return search({ query: args.query, limit: args.limit ?? 10 });
    },
    /** `/memory list`：跨 kind 列举（管理面定位用；行带 `id` / `tier` / `kind`）。 */
    async memoryList(args: {
      tier?: "project" | "user";
      kind?: string;
      limit?: number;
    }): Promise<unknown[] | undefined> {
      const list = opts.knowledge?.list;
      if (typeof list !== "function") return undefined;
      return list({
        ...(args.tier === undefined ? {} : { tier: args.tier }),
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        limit: args.limit ?? 20,
      });
    },
    /** `/memory remove`：管理面删除（S 层 / 未注册 kind 等参数级错误折算成 reason）。 */
    async memoryForget(ref: MemoryRowRef): Promise<{
      ok: boolean;
      removed: number;
      reason?: string;
    }> {
      const forget = opts.knowledge?.forget;
      if (typeof forget !== "function") {
        return {
          ok: false,
          removed: 0,
          reason: "管理面不可用（memory-base 未挂载或版本过旧）",
        };
      }
      try {
        const removed = await forget([ref]);
        return { ok: true, removed };
      } catch (error: unknown) {
        return {
          ok: false,
          removed: 0,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    /** `/memory replace`：管理面就地更新（失败时原行不动；skipped 原样透出）。 */
    async memoryReplace(
      ref: MemoryRowRef,
      patch: { content: string; title?: string; importance?: number },
    ): Promise<{ ok: boolean; skipped?: string | undefined }> {
      const update = opts.knowledge?.update;
      if (typeof update !== "function") {
        return {
          ok: false,
          skipped: "管理面不可用（memory-base 未挂载或版本过旧）",
        };
      }
      try {
        const result = await update(ref, patch);
        return result.ok
          ? { ok: true }
          : { ok: false, skipped: result.skipped };
      } catch (error: unknown) {
        return {
          ok: false,
          skipped: error instanceof Error ? error.message : String(error),
        };
      }
    },
    /** `/memory add`：管理面用户直写（内容闸门与 preWrite 仍生效；kind 必填）。 */
    async memoryAdd(input: {
      content: string;
      kind: string;
      tier: "project" | "user";
    }): Promise<{ ok: boolean; skipped?: string | undefined }> {
      const remember = opts.knowledge?.remember;
      if (typeof remember !== "function") {
        return {
          ok: false,
          skipped: "管理面不可用（memory-base 未挂载或版本过旧）",
        };
      }
      try {
        const result = await remember(input);
        if (result.skipped !== undefined || (result.ids?.length ?? 0) === 0) {
          return { ok: false, skipped: result.skipped };
        }
        return { ok: true };
      } catch (error: unknown) {
        return {
          ok: false,
          skipped: error instanceof Error ? error.message : String(error),
        };
      }
    },
    /** 守卫面板：经 security-guard `recent()` 归一化为行（工具名 + 放行/拦截 + 原因首行）；
     *  deny → status failed（红）、allow → success（绿）；未挂载 reject */
    async refreshGuard(): Promise<void> {
      const svc = opts.guard;
      if (!svc || typeof svc.recent !== "function") {
        throw new Error("guard 未挂载（宿主无安全守卫查询面）");
      }
      try {
        const recs = svc.recent() ?? [];
        const rows: CommandPanelRow[] = recs.map((r) => ({
          title: r.toolName,
          detail:
            r.verdict === "deny"
              ? `拦截${typeof r.reason === "string" && r.reason !== "" ? ` · ${(r.reason.split("\n")[0] ?? "").slice(0, 60)}` : ""}`
              : "放行",
          status: r.verdict === "deny" ? "failed" : "success",
          payload: undefined,
        }));
        ctx.emit({ type: "command-panel-data", kind: "guard", rows });
      } catch (err) {
        ctx.emit({
          type: "command-panel-data",
          kind: "guard",
          rows: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    /** 策略快照（Enter 详情）：`policy()` → 4 行摘要（启用/黑名单/敏感文件/拦截计数），适配 notice 视口 */
    async guardPolicy(): Promise<string | undefined> {
      const svc = opts.guard;
      const snap = svc?.policy?.();
      if (!snap) {
        return undefined;
      }
      try {
        const cb = snap.commandBlacklist;
        const sf = snap.sensitiveFiles;
        const denyCount = (svc?.recent?.() ?? []).filter(
          (r) => r.verdict === "deny",
        ).length;
        return [
          `守卫：${snap.enabled ? "启用" : "停用"}`,
          `命令黑名单：${cb?.rules?.length ?? 0} 条规则 · 放行 ${cb?.allowPatterns?.length ?? 0} 条`,
          `敏感文件：${sf?.rules?.length ?? 0} 条规则 · 放行 ${sf?.allowedPaths?.length ?? 0} 条`,
          `拦截记录：最近 ${denyCount} 条`,
        ].join("\n");
      } catch {
        return undefined;
      }
    },
    /** 任务详情（Enter）：在 query().tasks 先序中定位该 id，输出标题/状态/id/需拆分，
     *  并按 query().frameStack 标注该任务在帧栈中的位置（objective「帧栈详情供 Enter 详情」）。 */
    async taskDetail(id: string): Promise<string | undefined> {
      const svc = opts.taskEngine;
      const snap = svc?.query?.();
      if (!snap) {
        return undefined;
      }
      try {
        const found = findTask(snap.tasks, id);
        if (!found) {
          return undefined;
        }
        const stack = snap.frameStack ?? [];
        const idx = stack.indexOf(id);
        const stackLine =
          idx === -1
            ? "不在帧栈"
            : idx === stack.length - 1
              ? "栈顶（下一待处理）"
              : `第 ${idx + 1}/${stack.length} 帧`;
        // 帧栈并入状态行：notice 多行在 activity 视口只显前 4 行，独立第 5 行会被裁掉
        return [
          `任务：${found.title}`,
          `状态：${found.status} · 帧栈：${stackLine}`,
          `id：${found.id}`,
          `需拆分：${found.needDecompose ? "是" : "否"}`,
        ].join("\n");
      } catch {
        return undefined;
      }
    },
  };

  return { part };
}
