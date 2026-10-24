// tests/aliases.test.ts — 别名表数据断言（决策 4 / 决策 5，见
// docs/archived/2026-10-24-tool-description-review.md）。
//
// 别名权重 4，是仅次于名称的检索杠杆；重复别名会让同分排序把错的工具顶上来，
// 别名等于另一个工具名会让名称短语加成同时命中两个文档。这里只查数据，
// 不跑 matcher —— 排序回归见 tests/retrieval.test.ts。

import assert from "node:assert/strict";
import { test } from "node:test";

import { ALIASES } from "../src/aliases.ts";

/**
 * 本仓注册的 46 个模型侧工具名（P0 调研 §1 的工具面盘点）。
 * 宿主工具（bash / read / edit / glob / grep …）也进 ALIASES，但不在这份清单里。
 */
export const TOOL_NAMES: readonly string[] = [
  // task-engine
  "task_decompose",
  "task_implement",
  "task_execute",
  "task_stop",
  "task_status",
  // session-channel
  "session_channel",
  "channel_delegate",
  "channel_task",
  "channel_task_result",
  // hash-edit
  "hash_read",
  "hash_edit",
  // md-logic / md-map
  "md_logic",
  "md_map",
  // fs-digest / metric-loop
  "fs_digest",
  "metric_loop",
  // herdr-use
  "herdr_list",
  "herdr_read",
  "herdr_info",
  "herdr_wait",
  "herdr_create",
  "herdr_close",
  "herdr_label",
  "herdr_text",
  "herdr_key",
  "herdr_run",
  // ast-tools / code-map
  "ast_query",
  "ast_replace",
  "code_map",
  // rule-engine
  "rule_add",
  "rule_list",
  "rule_update",
  "rule_remove",
  "rule_test",
  // agent-group / coagent / memory-base
  "agent_group",
  "coagent",
  "memory_query",
  // goal-contract / metric / daemon / context-report
  "goal_contract_draft",
  "daemon_task",
  "context_report",
  // preference-analysis
  "preference_list",
  "preference_add",
  "preference_remove",
  // script-interpreter / TUI
  "script_run",
  "notice_history",
  "tui_local_log",
  // tool-consult（刻意不入索引）
  "consult_tools",
];

/** 刻意不入检索索引的工具（`consult_tools` 是查询入口本身）。 */
const NOT_INDEXED = new Set(["consult_tools"]);

/** 既有表里的双字别名（历史保留；新增别名至少 3 字）。 */
const LEGACY_TWO_CHAR = new Set([
  "确认",
  "提问",
  "技能",
  "待办",
  "分解",
  "验收",
  "命令",
  "脚本",
  "读取",
  "编辑",
  "检索",
  "委托",
  "委派",
  "记忆",
  "大纲",
  "判稳",
  "看屏",
  "读屏",
  "按键",
  "中断",
  "打字",
  "守护",
  "按节",
]);

/** 全部别名（去掉工具名键，只留词）。 */
function allAliases(): string[] {
  return Object.values(ALIASES).flatMap((list) => [...list]);
}

test("别名表：覆盖 46 个工具名清单，键都合法", () => {
  const hostTools = new Set([
    "bash",
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "todo_write",
    "ask_user_question",
    "skill",
    "workflow",
    "subagent",
  ]);
  const known = new Set([...TOOL_NAMES, ...hostTools]);
  for (const key of Object.keys(ALIASES)) {
    assert.ok(known.has(key), `别名表的键 ${key} 不在工具清单里`);
  }
});

test("除 consult_tools 外每个工具至少 1 条别名", () => {
  const missing = TOOL_NAMES.filter(
    (name) => !NOT_INDEXED.has(name) && (ALIASES[name] ?? []).length === 0,
  );
  assert.deepEqual(missing, [], `缺别名的工具：${missing.join(" / ")}`);
});

test("别名全局唯一（不跨工具复用）", () => {
  const seen = new Map<string, string>();
  for (const [tool, list] of Object.entries(ALIASES)) {
    for (const alias of list) {
      const owner = seen.get(alias);
      assert.equal(
        owner,
        undefined,
        `别名「${alias}」同时挂给 ${owner} 与 ${tool}`,
      );
      seen.set(alias, tool);
    }
  }
});

test("别名不等于另一个工具名，也不是单字泛词", () => {
  const toolNames = new Set(TOOL_NAMES);
  for (const [tool, list] of Object.entries(ALIASES)) {
    for (const alias of list) {
      assert.doesNotMatch(
        alias,
        /^[a-z][a-z0-9]*_[a-z0-9_]+$/,
        `${tool} 的别名「${alias}」形似工具名`,
      );
      assert.ok(
        !toolNames.has(alias),
        `${tool} 的别名「${alias}」等于另一个工具名`,
      );
      // 禁单字泛词；既有表里的双字词（「命令」/「委派」…）是已实测命中的口语词，
      // 新词不许再加双字，避免「通知」「终端」这类泛词冲突复发
      const length = [...alias].length;
      assert.ok(length >= 2, `${tool} 的别名「${alias}」是单字泛词`);
      if (length === 2) {
        assert.ok(
          LEGACY_TWO_CHAR.has(alias),
          `${tool} 的别名「${alias}」是双字泛词（新增别名至少 3 字）`,
        );
      }
      assert.equal(alias, alias.trim(), `${tool} 的别名「${alias}」首尾有空白`);
    }
    assert.equal(new Set(list).size, list.length, `${tool} 的别名列表内有重复`);
  }
});

test("冲突三例显式断言：「任务状态」「通知」「终端」", () => {
  const owners = (alias: string): string[] =>
    Object.entries(ALIASES)
      .filter(([, list]) => list.includes(alias))
      .map(([tool]) => tool);

  // 任务状态：只属于 task-engine 的嵌套任务树；channel_task 改用委托措辞
  assert.deepEqual(owners("任务状态"), ["task_status"]);
  assert.ok(ALIASES["task_status"]?.includes("任务树查看"));
  assert.ok(ALIASES["channel_task"]?.includes("委托状态"));
  assert.ok(!(ALIASES["channel_task"] ?? []).includes("任务状态"));

  // 通知：session_channel 用「跨会话通知」，不与 notice_history 的名称撞词
  assert.ok(ALIASES["session_channel"]?.includes("跨会话通知"));
  assert.ok(!(ALIASES["session_channel"] ?? []).includes("通知"));

  // 终端：裸「终端」删除（它把 bash 顶到「执行终端命令」的 top-1）；
  // 「终端命令」归 herdr_run（终端执行是本工具的动作），bash 只留通用命令词
  assert.ok(!(ALIASES["bash"] ?? []).includes("终端"));
  assert.ok(!(ALIASES["bash"] ?? []).includes("终端命令"));
  assert.ok(ALIASES["herdr_run"]?.includes("终端命令"));
  assert.ok(ALIASES["herdr_run"]?.includes("终端执行"));
  assert.deepEqual(owners("终端"), []);
});

test("P0 补缺失：hash_read / hash_edit / channel_task_result / code_map / md_logic", () => {
  for (const name of ["hash_read", "hash_edit", "channel_task_result"]) {
    assert.ok((ALIASES[name] ?? []).length > 0, `${name} 缺别名`);
  }
  assert.ok(ALIASES["code_map"]?.includes("查找引用"));
  assert.ok(ALIASES["code_map"]?.includes("符号引用"));
  assert.ok(ALIASES["md_logic"]?.includes("markdown 结构"));
  assert.ok(ALIASES["md_logic"]?.includes("按节改写"));
});
