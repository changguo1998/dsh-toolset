import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_HITS,
  TERM_FEEDBACK_SUMMARY,
  checkTerms,
  renderFeedback,
} from "../src/checker.ts";
import { GLOSSARY_SNAPSHOT } from "../src/glossary.generated.ts";

// 测试数据里的旧称按字面写（旧称本身就是要命中的对象）；行尾标注「旧称」以免文档检查误报
const AREA = "活动区"; // 旧称
const DECISION = "决策点"; // 旧称
const RECORD = "过程记录"; // 旧称
const RESPONSE = "返回体"; // 旧称
const REVIEW = "评审"; // 旧称
const LANDING = "落点"; // 旧称
const INPUT_BOX = "输入框"; // 旧称
const STATUS_BAR = "状态栏"; // 旧称
const HINT_AREA = "提示区"; // 旧称
const SHADOW = "影子覆盖事件"; // 旧称
const REGRESSION = "回归"; // 旧称

test("命中界面旧称：给出应当使用、行号与界面名称标记", () => {
  const text = ["开头一句。", `第二行提到${AREA}里的内容。`].join("\n");
  const result = checkTerms(text);
  assert.equal(result.total, 1);
  assert.equal(result.hits.length, 1);
  const hit = result.hits[0]!;
  assert.equal(hit.from, AREA);
  assert.equal(hit.to, "回合区");
  assert.equal(hit.line, 2);
  assert.equal(hit.isInterface, true);
});

test("命中「决策点」：应当使用「决策项」", () => {
  const result = checkTerms(`下面有两个${DECISION}。`);
  assert.deepEqual(
    result.hits.map((hit) => [hit.from, hit.to]),
    [[DECISION, "决策项"]],
  );
});

test("条件型术语（模块 / 工具集 / 收口）不自动判定", () => {
  const text = ["这个模块要改。", "工具集描述要准。", "最后做收口。"].join(
    "\n",
  );
  assert.equal(renderFeedback(text), null);
});

test("已知误配：同句含「夺回归属」时「回归」不报", () => {
  assert.equal(renderFeedback(`${REGRESSION}风险靠夺回归属判断。`), null);
});

test("单说「回归」：要求按语境选「退化 / 守成测试」", () => {
  const feedback = renderFeedback(`这是一个${REGRESSION}。`);
  assert.ok(feedback);
  assert.match(feedback.text, /退化 \/ 守成测试/);
});

test("含「原名」的历史对照句豁免", () => {
  assert.equal(renderFeedback(`${AREA}（原名）现在叫回合区。`), null);
  assert.equal(renderFeedback("这里的旧称只有对照价值。"), null);
});

test("代码块里的旧称照判（决策项 3 = 不加掩码）", () => {
  const text = ["```text", AREA, "```"].join("\n");
  const result = checkTerms(text);
  assert.equal(result.total, 1);
  assert.equal(result.hits[0]!.line, 2);
});

test("同一旧称多处出现只报首次", () => {
  const text = [`${AREA}在这。`, `${AREA}又在这。`].join("\n");
  const result = checkTerms(text);
  assert.equal(result.total, 1);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]!.line, 1);
});

test("无命中返回 null", () => {
  assert.equal(renderFeedback("这条回复没有旧称。"), null);
  assert.equal(renderFeedback(""), null);
});

test("命中数超过上限：只列前 N 条并说明剩余", () => {
  const text = [
    AREA,
    DECISION,
    RECORD,
    RESPONSE,
    REVIEW,
    LANDING,
    INPUT_BOX,
    STATUS_BAR,
    HINT_AREA,
    SHADOW,
  ].join("\n");
  const result = checkTerms(text, { maxHits: 3 });
  assert.equal(result.hits.length, 3);
  assert.equal(result.total, 10);
  const feedback = renderFeedback(text, { maxHits: 3 });
  assert.ok(feedback);
  assert.match(feedback.text, /另有 7 处未列出。/);
});

test("缺省上限是 8", () => {
  const text = [
    AREA,
    DECISION,
    RECORD,
    RESPONSE,
    REVIEW,
    LANDING,
    INPUT_BOX,
    STATUS_BAR,
    HINT_AREA,
  ].join("\n");
  const result = checkTerms(text);
  assert.equal(result.hits.length, DEFAULT_MAX_HITS);
  assert.equal(result.total, 9);
});

test("maxHits = 0 表示不限", () => {
  const text = [AREA, DECISION, RECORD].join("\n");
  assert.equal(checkTerms(text, { maxHits: 0 }).hits.length, 3);
});

test("「落点」行改用具体说法，不直接抄「见推荐术语」", () => {
  const feedback = renderFeedback(`这是${LANDING}。`);
  assert.ok(feedback);
  assert.match(feedback.text, /存储 \/ 审计 \/ 实现 \/ 投递 \/ 文档 \/ 条目/);
});

test("注入文案：带 summary、要求更正后完整重发、不改仓库文件", () => {
  const feedback = renderFeedback(`${AREA}在这。`);
  assert.ok(feedback);
  assert.equal(feedback.summary, TERM_FEEDBACK_SUMMARY);
  assert.match(feedback.text, /完整重发/);
  assert.match(feedback.text, /不要修改仓库里的任何文件或文档/);
  assert.match(feedback.text, /引用示例或历史对照，可忽略本条/);
});

test("快照行都带旧称与应当使用，且条件型标记与 GLOSSARY 口径一致", () => {
  assert.ok(GLOSSARY_SNAPSHOT.length > 0);
  for (const row of GLOSSARY_SNAPSHOT) {
    assert.ok(row.from.length > 0, `空旧称行: ${JSON.stringify(row)}`);
    assert.ok(row.to.length > 0, `空应当使用: ${JSON.stringify(row)}`);
  }
  const conditional = GLOSSARY_SNAPSHOT.filter((row) => row.conditional).map(
    (row) => row.from[0],
  );
  assert.deepEqual(conditional, ["模块", "工具集", "收口"]);
});
