// tests/retrieval.test.ts — 重叠工具检索回归（决策 5，见
// docs/archived/2026-10-24-tool-description-review.md）。
//
// fixture 放七组重叠对的「目标措辞」短描述（不是完整源码副本）：它守的是
// matcher + aliases + 措辞模式，复现已发现的 6 类排序错误（重复别名 / 否定句 /
// 长描述稀释 / 交叉引用污染 / 别名缺失 / 泛词冲突）。源码事实由各包
// tests/tool.test.ts 的关键词断言守，两者不互相替代；断言只比名次，不写死分数。

import assert from "node:assert/strict";
import { test } from "node:test";

import { createMatcher, type ToolDoc } from "../src/matcher.ts";

/** 七组重叠对的目标措辞（P0 改完的短描述）。 */
const DOCS: ToolDoc[] = [
  // 宿主核心工具：用最短的英文描述占位（真实描述在安装树里，不属本仓）
  { name: "bash", description: "Run a shell command." },
  { name: "read", description: "Read a UTF-8 text file." },
  { name: "write", description: "Write a UTF-8 text file." },
  { name: "edit", description: "Literal string replacement in one file." },
  { name: "glob", description: "Find files by path pattern." },
  { name: "grep", description: "Search file contents with a regexp." },
  // 任务树
  {
    name: "task_status",
    description:
      "查看嵌套任务树（帧、轮次、父子关系）。列任务 / 取消任务用 channel_task。",
  },
  {
    name: "task_stop",
    description:
      "对任务执行 RET 验收，通过则完成并向上 join。取消委托用 channel_task。",
  },
  {
    name: "task_execute",
    description: "发起叶子任务声明的 executor 后端并回填执行证据。",
  },
  {
    name: "task_implement",
    description:
      "完成一个叶子任务并写入产出（model 后端用本工具，其余后端用 task_execute）。",
  },
  {
    name: "task_decompose",
    description: "把一个待细化任务拆成子任务。",
  },
  // 跨会话委托
  {
    name: "channel_task",
    description:
      "委托任务管理：查委托状态 / 列委托任务 / 取消委托。嵌套任务树用 task_status。",
  },
  {
    name: "channel_delegate",
    description:
      "把一个任务委托给另一个会话执行并回收结果；结果的显式回传用 channel_task_result。",
  },
  {
    name: "session_channel",
    description:
      "跨会话消息通道：列会话、发消息、查收件箱、管别名。委托任务用 channel_delegate。",
  },
  {
    name: "channel_task_result",
    description: "回传委托任务的结果（worker 侧）。",
  },
  // 行级 / 按节 / 文件级改写
  {
    name: "hash_edit",
    description:
      "对文件应用 LINE:HASH 锚点编辑（按行号精确改行）。文件级字面量替换用 edit，按节改 Markdown 用 md_logic。",
  },
  {
    name: "hash_read",
    description: "读取文件的行内容并返回 LINE:HASH 锚点，为锚点编辑准备输入。",
  },
  {
    name: "md_logic",
    description:
      "单文件 Markdown 逻辑结构（按节改写）：出节树 / 块 / 链接，按节整节替换或删除。",
  },
  // 只读摘要与文档图
  {
    name: "fs_digest",
    description:
      "上下文感知文件读取：outline / signatures / pruned，只读。Markdown 深查用 md_logic。",
  },
  {
    name: "md_map",
    description:
      "项目级 Markdown 引用图：callers / impact / 断链。单文件结构用 md_logic，代码结构用 code_map。",
  },
  {
    name: "code_map",
    description: "代码结构与引用地图：符号引用、调用关系、影响面。",
  },
  {
    name: "ast_query",
    description: "语法级查询：按 AST 模式找代码，文本检索用 grep。",
  },
  { name: "ast_replace", description: "语法级结构化替换，默认 dry-run 预览。" },
  // 终端
  {
    name: "herdr_run",
    description:
      "向已创建的 herdr 终端提交命令（终端执行）。一次性命令用 bash，只输入文本用 herdr_text。",
  },
  {
    name: "herdr_read",
    description: "取终端屏内容；读文件用 read，等稳定输出用 herdr_wait。",
  },
  {
    name: "herdr_text",
    description: "向终端注入字面量文本（不回车），提交命令用 herdr_run。",
  },
  { name: "herdr_key", description: "发送按键序列。注入文本用 herdr_text。" },
  { name: "herdr_create", description: "新建终端，返回 terminal_id。" },
  { name: "herdr_wait", description: "等待终端输出稳定。" },
  // 其余工具：只作为干扰项，保持措辞短
  {
    name: "metric_loop",
    description: "指标驱动自动循环，运行中用 daemon_task 按提示排下次唤醒。",
  },
  {
    name: "daemon_task",
    description:
      "面向会话投递的进程内定时调度：按选择器到点投递提示文本或执行 slash 命令。",
  },
  {
    name: "notice_history",
    description:
      "读 notice 历史原文：已被 compaction 折叠出上下文的一次性事件交代，取回后读最近 N 条。",
  },
  {
    name: "tui_local_log",
    description:
      "读 TUI 本地输出旁路日志：$ 模式命令与结果、TUI 命令提示行，也用于核对命令历史。",
  },
  // P1 / P2 工具：重叠对与高频检索词
  {
    name: "herdr_list",
    description: "列本会话创建的终端，逐条标 foreground / registered。",
  },
  {
    name: "herdr_info",
    description: "终端进程探活：判断命令是否还在跑，不取屏。",
  },
  {
    name: "coagent",
    description:
      "拉起 / 收尾独立进程的长驻 dsh 会话，只管起停，派任务用 channel_delegate。",
  },
  {
    name: "agent_group",
    description: "同事模型群组的编排：建组、加成员、建连接、派指令、结算。",
  },
  {
    name: "memory_query",
    description: "只读查询跨会话记忆库；查偏好用 preference_list。",
  },
  {
    name: "preference_list",
    description: "列出偏好账簿条目，只读；登记用 preference_add。",
  },
  { name: "preference_add", description: "登记一条用户偏好建议，落候选待审。" },
  { name: "preference_remove", description: "撤销一条偏好（按 id）。" },
  { name: "rule_add", description: "新增一条注入规则（规则管理入口之一）。" },
  { name: "rule_list", description: "只读列出生效规则与引擎状态。" },
  { name: "rule_update", description: "更新一条规则的字段。" },
  { name: "rule_remove", description: "删除一条规则。" },
  {
    name: "rule_test",
    description: "试跑规则：对给定文本判定哪些规则会命中。",
  },
  {
    name: "context_report",
    description: "查看会话的上下文用量报告：token 分桶、上下文占用比例。",
  },
  {
    name: "goal_contract_draft",
    description: "起草 goal 契约：定点目标与 Done-when 条款。",
  },
  {
    name: "script_run",
    description: "执行一段脚本并返回 stdout / stderr；一条命令用 bash。",
  },
  {
    name: "consult_tools",
    description: "按用途查找并揭示工具，咨询即授权。",
  },
];

/** 一条检索断言：查询 → 期望工具（must rank top-1 或仅 top-3）。 */
interface Case {
  query: string;
  want: string;
  /** true = 必须 top-1；false = 只要求进 top-N（缺省 3）。 */
  top1: boolean;
  /** 只要求落在 top-N（缺省 3）。 */
  topN?: number;
  why: string;
}

const CASES: Case[] = [
  {
    query: "任务状态",
    want: "task_status",
    top1: true,
    why: "重复别名「任务状态」曾把 channel_task 顶上去",
  },
  {
    query: "改文件",
    want: "edit",
    top1: true,
    why: "「不改文件」否定句曾让 fs_digest / ast_replace 假阳性",
  },
  {
    query: "markdown 结构",
    want: "md_logic",
    top1: true,
    why: "855 字符长描述被长度归一化压到第三",
  },
  {
    query: "谁引用了这个符号",
    want: "code_map",
    top1: true,
    why: "交叉引用句「谁引用了某符号用 code_map」曾让 ast_query 排第一",
  },
  {
    query: "执行终端命令",
    want: "herdr_run",
    top1: true,
    why: "bash 的「终端」别名曾压过 herdr_run",
  },
  {
    query: "查找引用",
    want: "code_map",
    top1: true,
    why: "code_map 缺「查找引用 / 符号引用」别名",
  },
  {
    query: "停止任务",
    want: "task_stop",
    top1: false,
    why: "验收语义要能被检索到（取消语义见下一条）",
  },
  {
    query: "发通知",
    want: "session_channel",
    top1: false,
    why: "泛词「通知」与 notice_history 撞词",
  },
  {
    query: "读取终端输出",
    want: "herdr_read",
    top1: false,
    why: "「输出」曾把 herdr_wait 顶上来",
  },
  {
    query: "命令历史",
    want: "tui_local_log",
    top1: false,
    why: "tui_local_log 缺「命令历史 / 本地日志」别名",
  },
  {
    query: "跨会话委托",
    want: "channel_delegate",
    top1: true,
    why: "task_stop 描述里的「取消跨会话委托任务」曾把本查询顶到验收工具",
  },
  {
    query: "定时任务",
    want: "daemon_task",
    top1: false,
    why: "正向例子：定时调度应稳定进前三",
  },
  // P1 / P2 高频词（断言进 top-3；规则族共享「规则」二字，不要求 top-1）
  {
    query: "终端列表",
    want: "herdr_list",
    top1: false,
    why: "P1：终端列表别名",
  },
  {
    query: "终端读取",
    want: "herdr_read",
    top1: false,
    topN: 5,
    why: "P1：读屏工具与终端族同词，只要求进前列",
  },
  { query: "规则管理", want: "rule_add", top1: false, why: "P1：规则管理入口" },
  {
    query: "规则测试",
    want: "rule_test",
    top1: false,
    why: "P1：空跑判定规则",
  },
  {
    query: "契约",
    want: "goal_contract_draft",
    top1: false,
    why: "P1：goal 契约起草",
  },
  { query: "偏好", want: "preference_list", top1: false, why: "P2：偏好账簿" },
  {
    query: "上下文用量",
    want: "context_report",
    top1: false,
    why: "P2：会话上下文用量",
  },
];

const matcher = createMatcher(DOCS);

for (const { query, want, top1, topN = 3, why } of CASES) {
  test(`检索「${query}」→ ${want} ${top1 ? "top-1" : `top-${topN}`}（${why}）`, () => {
    const hits = matcher.search(query, 10);
    const names = hits.map((hit) => hit.name);
    assert.ok(
      names.includes(want),
      `「${query}」未命中 ${want}：${names.join(" > ")}`,
    );
    if (top1) {
      assert.equal(
        names[0],
        want,
        `「${query}」top-1 应为 ${want}，实际：${hits
          .map((hit) => `${hit.name} ${hit.score.toFixed(2)}`)
          .join(" > ")}`,
      );
    } else {
      assert.ok(
        names.slice(0, topN).includes(want),
        `「${query}」${want} 应进 top-${topN}，实际：${names.join(" > ")}`,
      );
    }
  });
}
