// TUI/src/app/runtime/commands-host.ts — 宿主域列表命令: /skills、/tools、/search、/council、/workflows 等
//
// 2026-11-04 拆分自 TUI/src/app/index.ts 的 App 类体: 方法体只做 this. -> ctx. 改写,
// 跨模块调用经 ctx.self, 公共状态在 ./context.ts.

import { lastTextBySource } from "../layout/pipeline/sections.ts";
import { contractSummaryText, groupStatusText } from "../adapter/dsh.ts";
import { activeGoalSnapshot } from "../state.ts";
import { slashCommandArg } from "../commands.ts";
import { sectionsOf } from "../layout/pipeline/frame.ts";
import type { AppContext } from "./context.ts";

export function createCommandsHostPart(ctx: AppContext) {
  /** /skills [filter]：共享列表面板（kind=skills），filter 在归一化阶段过滤 */
  function handleSkillsCommand(line: string): void {
    ctx.self.openListPanel({
      kind: "skills",
      label: "skills",
      refresh: ctx.deps.adapter.refreshSkills,
      filter: slashCommandArg(line),
    });
  }

  /** /tools [filter]：共享列表面板（kind=tools），filter 在归一化阶段过滤 */
  function handleToolsCommand(line: string): void {
    ctx.self.openListPanel({
      kind: "tools",
      label: "tools",
      refresh: ctx.deps.adapter.refreshTools,
      filter: slashCommandArg(line),
    });
  }

  /** /search：网页搜索面板（kind=search，列表）。经 adapter.search（ctx.web 统一多
   *  provider 搜索 seam）拉取并归一化行（title ?? host、detail=url·snippet、payload=url，
   *  Enter 展示来源地址）；宿主未挂载 web.search → warn 不空开面板。 */
  function handleSearchCommand(line: string): void {
    const query = slashCommandArg(line).trim();
    if (query === "") {
      ctx.self.notice("usage: /search <query>", "warn");
      return;
    }
    const search = ctx.deps.adapter.search;
    if (!search) {
      ctx.self.notice("web 服务不可用", "warn");
      return;
    }
    ctx.self.openListPanel({
      kind: "search",
      label: "web",
      refresh: (q?: string) => {
        const fn = ctx.deps.adapter.search;
        if (!fn) return Promise.reject(new Error("web 未挂载"));
        return fn.call(ctx.deps.adapter, q ?? "", 10);
      },
      filter: query,
    });
  }

  /** /council：二次意见（notice 型）——并行拉起 N（默认 2，可带参）个评审子代理对
   *  当前对话目标各自给独立意见，adapter.council 汇总后 info 展示；宿主未暴露
   *  subagents.start → warn 不假启动。 */
  function handleCouncilCommand(line: string): void {
    const adapter = ctx.deps.adapter;
    const council = adapter.council;
    if (!council) {
      ctx.self.notice("council 不可用（宿主无子代理启动面）", "warn");
      return;
    }
    // 带参数 count（1-4），无参默认 2
    const arg = slashCommandArg(line);
    const count = /^[1-4]$/.test(arg) ? Number(arg) : 2;
    // 当前目标：有 goal 快照取 objective，否则回落到最近用户输入（节模型来源；
    // 无则占位文案）
    const snapshot = activeGoalSnapshot(
      ctx.state,
      ctx.state.activeSessionId ?? undefined,
    );
    const lastUser = lastTextBySource(sectionsOf(ctx.state), "user");
    const target = snapshot
      ? snapshot.objective
      : (lastUser ?? "（无具体目标，请评审当前任务）");
    void council
      .call(adapter, target, count)
      .then((text) => ctx.self.notice(text, "info"))
      .catch(() =>
        ctx.self.notice("council 不可用（宿主无子代理启动面）", "warn"),
      );
  }

  /** /workflows：工作流运行面板（kind=workflows，只读列表）。adapter 维护的
   *  tool-workflow 运行集合为数据源（事件增量推送）；宿主未挂载 workflowEngine → warn。 */
  function handleWorkflowsCommand(): void {
    ctx.self.openListPanel({
      kind: "workflows",
      label: "workflowEngine",
      refresh: ctx.deps.adapter.refreshWorkflows,
      filter: "",
    });
  }

  /** /contract：契约概览（notice 型）——取当前会话 goal 快照的 objective，经
   *  adapter.contractSummary（goal-contract 只读面优先、内置同构回读兜底）解析
   *  Done-when 段为条款摘要；无目标或解析失败 → warn。 */
  function handleContractCommand(): void {
    const snapshot = activeGoalSnapshot(
      ctx.state,
      ctx.state.activeSessionId ?? undefined,
    );
    if (!snapshot) {
      ctx.self.notice("当前无活动目标/契约（无 goal 快照）", "warn");
      return;
    }
    const summary = ctx.deps.adapter.contractSummary;
    if (!summary) {
      ctx.self.notice("契约解析不可用", "warn");
      return;
    }
    const result = summary.call(ctx.deps.adapter, snapshot.objective);
    ctx.self.notice(
      contractSummaryText(result, 40),
      result.ok ? "info" : "warn",
    );
  }

  /** /loop：共享列表面板（kind=loop），经 adapter.refreshLoops 拉取活动/历史循环。
   *  前置：metric-loop 只读查询面已挂 ctx（C5 完成）。 */
  function handleLoopCommand(): void {
    ctx.self.openListPanel({
      kind: "loop",
      label: "metricLoop",
      refresh: ctx.deps.adapter.refreshLoops,
      filter: "",
    });
  }

  /** /group [组名]：群组状态（notice 型）——当前会话作为管理者会话，经
   *  adapter.readGroupStatus（agent-group 只读服务面）拉取清单/单组视图；
   *  未挂载或查询失败 → warn（失败面 error+reason 原样带出，组不存在时 reason
   *  含现有组清单），成功 → info。 */
  function handleGroupCommand(line?: string): void {
    const readGroupStatus = ctx.deps.adapter.readGroupStatus;
    if (!readGroupStatus) {
      ctx.self.notice("agentGroup 服务不可用（未挂载 agent-group）", "warn");
      return;
    }
    const raw = (line ?? "").replace(/^\/group/, "").trim();
    const groupName = raw === "" ? undefined : raw;
    const sessionId = ctx.state.activeSessionId ?? undefined;
    if (!sessionId) {
      ctx.self.notice("当前无活动会话，无法读取群组状态", "warn");
      return;
    }
    void readGroupStatus(sessionId, groupName).then(
      (result) => {
        if (!result.ok) {
          // 失败信封：error 是稳定错误码、reason 是可读描述、next 是下一步 / 现有组清单
          // （决策项 5：组不存在 → 提示现有组名）。notice 面向人，拼可读字段。
          const parts = [result.reason ?? result.error];
          if (result.next) parts.push(result.next);
          ctx.self.notice(parts.join("；"), "warn");
          return;
        }
        ctx.self.notice(groupStatusText(result.groups, groupName), "info");
      },
      () =>
        ctx.self.notice("agentGroup 服务不可用（未挂载 agent-group）", "warn"),
    );
  }

  /** /guard：共享列表面板（kind=guard），经 adapter.refreshGuard 拉取拦截/放行记录；
   *  前置：security-guard 只读查询面已挂 ctx（C3 补全）。 */
  function handleGuardCommand(): void {
    ctx.self.openListPanel({
      kind: "guard",
      label: "guard",
      refresh: ctx.deps.adapter.refreshGuard,
      filter: "",
    });
  }

  /** /task：共享列表面板（kind=task），经 adapter.refreshTasks 拉取任务树；
   *  前置：task-engine 只读查询面已挂 ctx（C1 补全）。 */
  function handleTaskCommand(): void {
    ctx.self.openListPanel({
      kind: "task",
      label: "taskEngine",
      refresh: ctx.deps.adapter.refreshTasks,
      filter: "",
    });
  }

  return {
    handleSkillsCommand,
    handleToolsCommand,
    handleSearchCommand,
    handleCouncilCommand,
    handleWorkflowsCommand,
    handleContractCommand,
    handleLoopCommand,
    handleGroupCommand,
    handleGuardCommand,
    handleTaskCommand,
  };
}
