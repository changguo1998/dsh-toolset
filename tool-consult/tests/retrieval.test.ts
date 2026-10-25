// tests/retrieval.test.ts — 重叠工具检索回归（决策 5，见
// docs/archived/2026-10-25-tool-consult-matcher-review.md）。
//
// 语料改成「真实措辞」（tests/fixtures/real-descriptions.ts）：44 条从各包源码
// 逐字提取的工具级描述 + 8 条占位（6 宿主核心 + script_run + consult_tools）。
// 此前的 fixture 是手写「目标措辞」，与源码漂移（如「改文件」断言 edit top-1，
// 源码里 hash_edit 的描述含「按 LINE:HASH 锚点改文件」），守的是假想措辞。
//
// 守的是 matcher + aliases + 真实描述措辞：复现已发现的排序错误类别（重复别名 /
// 否定句 / 长描述稀释 / 交叉引用污染 / 别名缺失 / 泛词冲突）。断言只比名次，
// 不写死分数；守护语料随工具描述改动同步（描述层改动归 lint 任务）。

import assert from "node:assert/strict";
import { test } from "node:test";

import { createMatcher } from "../src/matcher.ts";
import {
  CORPUS_DOCS,
  INDEXED_DOCS,
  PLACEHOLDER_DESCRIPTIONS,
  REAL_DESCRIPTIONS,
} from "./fixtures/real-descriptions.ts";

/**
 * 一条检索断言：查询 → 期望工具（候选取其一）落在 top-N。
 *
 * `want` 用数组：同动作族里靠意图区分的工具（edit / hash_edit），源码措辞下可能
 * 互有先后，断言「其一位于前列」比写死单个更贴合现状；`topN = 1` 即 top-1。
 */
interface Case {
  query: string;
  /** 期望命中的工具，多候选取其一。 */
  want: readonly string[];
  /** 要求落在 top-N（1 = top-1）。 */
  topN: number;
  why: string;
}

const CASES: Case[] = [
  {
    query: "任务状态",
    want: ["task_status"],
    topN: 1,
    why: "重复别名「任务状态」曾把 channel_task 顶上去",
  },
  {
    query: "改文件",
    want: ["edit", "hash_edit"],
    topN: 2,
    why: "源码里 hash_edit 描述含「按 LINE:HASH 锚点改文件」（+4 描述加成），edit 次之；原 fixture 写死 edit top-1 属措辞漂移",
  },
  {
    query: "markdown 结构",
    want: ["md_logic"],
    topN: 1,
    why: "855 字符长描述被长度归一化压到第三",
  },
  {
    query: "谁引用了这个符号",
    want: ["code_map"],
    topN: 1,
    why: "交叉引用句「谁引用了某符号用 code_map」曾让 ast_query 排第一",
  },
  {
    query: "执行终端命令",
    want: ["herdr_run"],
    topN: 1,
    why: "bash 的「终端」别名曾压过 herdr_run",
  },
  {
    query: "查找引用",
    want: ["code_map"],
    topN: 1,
    why: "code_map 缺「查找引用 / 符号引用」别名",
  },
  {
    query: "停止任务",
    want: ["task_stop"],
    topN: 1,
    why: "验收语义要能被检索到（取消语义见「取消任务」）",
  },
  {
    query: "取消任务",
    want: ["channel_task"],
    topN: 1,
    why: "同一动作族的另一半：取消语义落在委托工具上",
  },
  {
    query: "发通知",
    want: ["session_channel"],
    topN: 3,
    why: "泛词「通知」与 notice_history 撞词",
  },
  {
    query: "读取终端输出",
    want: ["herdr_read"],
    topN: 3,
    why: "「输出」曾把 herdr_wait 顶上来",
  },
  {
    query: "命令历史",
    want: ["tui_local_log"],
    topN: 3,
    why: "tui_local_log 缺「命令历史 / 本地日志」别名",
  },
  {
    query: "跨会话委托",
    want: ["channel_delegate"],
    topN: 2,
    why: "task_status 描述「跨会话委托任务查 channel_task」吃 +4 加成压过 channel_delegate；top-1 待描述层修措辞（见文末 todo）",
  },
  {
    query: "定时任务",
    want: ["daemon_task"],
    topN: 3,
    why: "正向例子：定时调度应稳定进前三",
  },
  // P1 / P2 高频词（规则族共享「规则」二字，不要求 top-1）
  {
    query: "终端列表",
    want: ["herdr_list"],
    topN: 3,
    why: "P1：终端列表别名",
  },
  {
    query: "终端读取",
    want: ["herdr_read"],
    topN: 5,
    why: "P1：读屏工具与终端族同词，只要求进前列",
  },
  {
    query: "加规则",
    want: ["rule_add"],
    topN: 1,
    why: "P1：源码中 rule_add 的检索入口是别名「加规则」（原 fixture 的「规则管理」是假想措辞，源码无此四字）",
  },
  {
    query: "规则测试",
    want: ["rule_test"],
    topN: 3,
    why: "P1：空跑判定规则",
  },
  {
    query: "契约",
    want: ["goal_contract_draft"],
    topN: 3,
    why: "P1：goal 契约起草",
  },
  {
    query: "偏好",
    want: ["preference_list"],
    topN: 3,
    why: "P2：偏好账簿",
  },
  {
    query: "上下文用量",
    want: ["context_report"],
    topN: 3,
    why: "P2：会话上下文用量",
  },
];

const matcher = createMatcher(INDEXED_DOCS);

test("守护语料：44 条真实 + 8 条占位，名称唯一", () => {
  assert.equal(Object.keys(REAL_DESCRIPTIONS).length, 44);
  assert.equal(Object.keys(PLACEHOLDER_DESCRIPTIONS).length, 8);
  assert.equal(CORPUS_DOCS.length, 52);
  const names = CORPUS_DOCS.map((doc) => doc.name);
  assert.equal(new Set(names).size, names.length, "语料里有重名工具");
  for (const doc of CORPUS_DOCS) {
    assert.ok(doc.description.trim().length > 0, `${doc.name} 描述为空`);
  }
});

test("检索索引排除 consult_tools（与 src/main.ts 的 buildMatcher 同口径）", () => {
  assert.equal(INDEXED_DOCS.length, CORPUS_DOCS.length - 1);
  assert.ok(!matcher.names().includes("consult_tools"));
  assert.ok(
    !matcher
      .nameGroups()
      .some((group) => group.names.includes("consult_tools")),
  );
  assert.equal(matcher.get("consult_tools"), undefined);
});

for (const { query, want, topN, why } of CASES) {
  const expectation = want.length === 1 ? want[0] : `${want.join(" / ")} 之一`;
  test(`检索「${query}」→ ${expectation} top-${topN}（${why}）`, () => {
    const hits = matcher.search(query, 10);
    const names = hits.map((hit) => hit.name);
    assert.ok(
      want.some((name) => names.includes(name)),
      `「${query}」未命中 ${expectation}：${names.join(" > ")}`,
    );
    assert.ok(
      want.some((name) => names.slice(0, topN).includes(name)),
      `「${query}」${expectation} 应进 top-${topN}，实际：${hits
        .map((hit) => `${hit.name} ${hit.score.toFixed(2)}`)
        .join(" > ")}`,
    );
  });
}

// 已知排序偏差，依赖描述层：lint 任务按决策 7 给 task_status 改「跨会话委托」
// 措辞（删掉那句同款归因）之后再取消 skip，把上面的 topN 收到 1。
test(
  "检索「跨会话委托」→ channel_delegate top-1（待 lint 任务改 task_status 措辞）",
  { skip: "决策 7 描述层归 lint 任务；修好措辞后取消 skip 并转正" },
  () => {
    const names = matcher.search("跨会话委托", 10).map((hit) => hit.name);
    assert.equal(names[0], "channel_delegate", `实际：${names.join(" > ")}`);
  },
);
