// TUI/src/app/runtime/commands-config.ts — 配置与策略命令: /config、/policy、/permission、/settings
//
// 2026-11-04 拆分自 TUI/src/app/index.ts 的 App 类体: 方法体只做 this. -> ctx. 改写,
// 跨模块调用经 ctx.self, 公共状态在 ./context.ts.

import { reduceState } from "../state.ts";
import {
  CONFIG_USAGE,
  ConfigValueError,
  configsEqual,
  deleteConfigPath,
  formatConfigDetail,
  formatConfigEntries,
  formatConfigValue,
  parseConfigCommand,
  setConfigPath,
  validateConfigSetValue,
} from "../config-edit.ts";
import type { AppContext } from "./context.ts";

export function createCommandsConfigPart(ctx: AppContext) {
  /**
   * /policy：审批策略两态切换（ask/never）。
   * 无参 → 取当前已知策略（policyBySession 事件回读）切换；未知按宿主默认 ask 为基准。
   * `/policy ask|never` → 显式设置。宿主未挂载 ctx.approval / adapter 缺失 → notice 不可用。
   */
  function handlePolicyCommand(line: string): void {
    const arg = line.slice("/policy".length).trim().toLowerCase();
    const applySet = (policy: "ask" | "never"): void => {
      const adapter = ctx.deps.adapter;
      const setPolicy = adapter.setApprovalPolicy;
      if (!setPolicy) {
        ctx.self.notice("审批策略服务不可用", "warn");
        return;
      }
      // SAFETY: adapter 方法体内依赖 this（approve/interrupt 等同构），必须接收者
      // 绑定调用——setPolicy.call(adapter) 保留实例作 this，避免丢绑定恒 rejected
      void setPolicy
        .call(adapter, policy)
        .then(() => {
          ctx.self.notice(
            policy === "ask"
              ? "审批策略：ask（每次工具调用询问）"
              : "审批策略：never（工具调用自动放行）",
            "success",
          );
        })
        .catch(() => {
          ctx.self.notice("审批策略服务不可用", "warn");
        });
    };
    if (arg === "ask" || arg === "never") {
      applySet(arg);
      return;
    }
    if (arg !== "") {
      ctx.self.notice("用法：/policy [ask|never]", "info");
      return;
    }
    // 无参 → 打开状态选项面板（空格预选、Enter 提交并关闭）；当前策略来自事件回读
    const sid = ctx.state.activeSessionId;
    const current = sid ? ctx.state.policyBySession[sid] : undefined;
    ctx.self.openStatusPanel({
      kind: "policy",
      title: "/policy 审批策略",
      // 展示名沿用旧 Mode 块口径（ask/auto；never 提交值不变，展示用 auto）
      options: [
        { id: "ask", label: "ask", desc: "（每次工具调用询问）" },
        { id: "never", label: "auto", desc: "（工具调用自动放行）" },
      ],
      index: 0,
      selected: current ?? null,
    });
  }

  /**
   * /permission：权限预设（sandbox mode + 审批策略捆绑）。
   * 无参 → 从 ctx.permissionPresets 读当前预设 + 可用列表（含描述）提示；
   * 带参 <name> → 转发宿主 /permission（宿主校验预设名 + approval.setPolicy 写路径）。
   * 宿主未挂载 ctx.permissionPresets → notice 不可用（fail-safe，不崩溃）。
   */
  function handlePermissionCommand(line: string): void {
    const arg = line.slice("/permission".length).trim();
    if (arg !== "") {
      ctx.deps.adapter.runCommand(
        "/permission " + arg,
        ctx.state.activeSessionId ?? undefined,
      );
      return;
    }
    const cat = ctx.deps.adapter.permissionCatalog;
    if (!cat) {
      ctx.self.notice("权限预设服务不可用", "warn");
      return;
    }
    void cat()
      .then((info) => {
        if (ctx.disposed || !info) {
          if (!info) ctx.self.notice("权限预设服务不可用", "warn");
          return;
        }
        // 同步目录进 state（P7 移除状态列 Mode 块后无渲染消费方，保留槽位）
        ctx.self.apply((s) =>
          reduceState(s, { type: "permission-catalog", names: info.names }),
        );
        ctx.self.paint();
        // 打开状态选项面板：选项 = 可用预设（空格预选、Enter 提交转发宿主）
        ctx.self.openStatusPanel({
          kind: "permission",
          title: "/permission 权限预设",
          options: info.entries.map((e) => ({
            id: e.name,
            label: e.name,
            ...(e.description ? { desc: e.description } : {}),
          })),
          index: 0,
          selected: info.current === "" ? null : info.current,
        });
      })
      .catch(() => {
        ctx.self.notice("权限预设服务不可用", "warn");
      });
  }

  /**
   * /policy：审批策略 ask / never。
   */

  /** /settings：只读展示全部设置（settings.describe() → `ns：value` 多行，secret 脱敏）；
   *  服务缺失/读取失败 → warn；本命令不做写回（真实配置 + 乐观锁另立规格）。 */
  function handleSettingsCommand(): void {
    const adapter = ctx.deps.adapter;
    const read = adapter.readSettings;
    if (!read) {
      ctx.self.notice("settings 服务不可用", "warn");
      return;
    }
    void read.call(adapter).then(
      (text) =>
        ctx.self.notice(
          text && text.trim() !== "" ? text : "（无设置项）",
          "info",
        ),
      () => ctx.self.notice("settings 服务不可用", "warn"),
    );
  }

  /** `/config`：插件条目配置编辑面（config-editor）。全部写入经 `configEditor.edit()`：
   *  宿主负责完整候选值校验、原子写 profile patch、与 HMR 串行、更高层覆盖拒绝。
   *  宿主的校验只对有运行时 schema 的插件生效，故 set 在 `change` 回调里先过 TUI 侧值校验
   *  （抛错 = 宿主中止在写盘前，patch 保持原样）。
   *  服务缺失 → 只提示不可用（条目数据只此一个来源，不做假只读列表）。 */
  function handleConfigCommand(line: string): void {
    const adapter = ctx.deps.adapter;
    const decision = parseConfigCommand(line);
    if (decision.kind === "usage") {
      // 用法提示带原因：缺参 / 未知子命令 / 非法 key=value 都在这里
      ctx.self.notice(`${decision.reason}\n${CONFIG_USAGE}`, "warn");
      return;
    }
    const read = adapter.configEntries;
    if (!read) {
      ctx.self.notice(
        "config-editor 服务不可用（profile 未挂载该插件），条目配置不可编辑",
        "warn",
      );
      return;
    }
    if (decision.kind === "list" || decision.kind === "show") {
      void read.call(adapter).then(
        (entries) => {
          if (entries === undefined) {
            ctx.self.notice(
              "config-editor 服务不可用（profile 未挂载该插件），条目配置不可编辑",
              "warn",
            );
            return;
          }
          if (decision.kind === "list") {
            ctx.self.notice(formatConfigEntries(entries), "info");
            return;
          }
          const hit = entries.find((entry) => entry.id === decision.id);
          if (hit === undefined) {
            ctx.self.notice(
              `条目 ${decision.id} 不在可编辑集合内（不存在或不是 profile 直属行）`,
              "warn",
            );
            return;
          }
          ctx.self.notice(formatConfigDetail(hit), "info");
        },
        () => ctx.self.notice("读取条目配置失败（config-editor 抛错）", "warn"),
      );
      return;
    }
    const edit = adapter.editConfigEntry;
    if (!edit) {
      ctx.self.notice(
        "config-editor 服务不可用（profile 未挂载该插件），条目配置不可编辑",
        "warn",
      );
      return;
    }
    // unset 命中「键不存在」时宿主那边的 config 原样返回：写入是空操作，提示单独区分
    let changed = true;
    // 宿主写回归一化：候选值与 inherited 全等 → 本行 config（乃至整行与注释）被删
    let collapsesRow = false;
    void edit
      .call(adapter, decision.id, (current, inherited) => {
        if (decision.kind === "set") {
          // 写盘前拦截：宿主对无运行时 schema 的插件不校验类型（缺陷 1）
          const verdict = validateConfigSetValue(
            decision.id,
            decision.path,
            decision.value,
            [current, inherited],
          );
          if (!verdict.ok) throw new ConfigValueError(verdict.reason);
          const out = setConfigPath(current, decision.path, decision.value);
          if (!out.ok) throw new Error(out.reason);
          collapsesRow = configsEqual(out.config, inherited);
          return out.config;
        }
        const out = deleteConfigPath(current, decision.path);
        changed = out.changed;
        collapsesRow = configsEqual(out.config, inherited);
        return out.config;
      })
      .then(
        () => {
          const key = decision.path.join(".");
          if (decision.kind === "set") {
            const base = `已写入 ${decision.id}: ${key} = ${formatConfigValue(decision.value)}`;
            ctx.self.notice(
              collapsesRow
                ? `${base}（等于 inherited；宿主归一化删掉了本行 override 与其注释，条目仍在）`
                : base,
              collapsesRow ? "warn" : "success",
            );
            return;
          }
          if (!changed) {
            ctx.self.notice(
              `键 ${key} 在 ${decision.id} 的本层 override 里不存在，未改动`,
              "info",
            );
            return;
          }
          const base = `已删除 ${decision.id}: ${key}（该键回到继承值）`;
          ctx.self.notice(
            collapsesRow
              ? `${base}；本行已无 override，宿主归一化连同注释删掉了该 profile 行（条目仍由 bundle 的 insert 提供，生效值即 inherited）`
              : base,
            collapsesRow ? "warn" : "success",
          );
        },
        (err: unknown) => {
          if (err instanceof ConfigValueError) {
            ctx.self.notice(
              `值校验失败：${err.message}；未写入 profile patch`,
              "error",
            );
            return;
          }
          ctx.self.notice(
            `编辑失败：${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        },
      );
  }

  return {
    handlePolicyCommand,
    handlePermissionCommand,
    handleSettingsCommand,
    handleConfigCommand,
  };
}
