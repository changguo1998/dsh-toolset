// tests/normalize.test.ts — content 块 → 纯文本 的拼接口径
//
// 口径（2026-10-04 起）：多 `text` 块**直连**，不插分隔换行——块是同一段正文的连续
// 切片，插 `\n` 会在正文开头 / 句中多出换行；模型自己写的换行在块内，原样保留。
// 与结算路径（`assistant/message` 的 `join("")`）同口径。

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTextBlocks } from "../src/app/adapter/normalize.ts";

test("extractTextBlocks：多块直连，不插入分隔换行", () => {
  assert.equal(
    extractTextBlocks([
      { type: "text", text: "你好" },
      { type: "text", text: "第二行" },
    ]),
    "你好第二行",
  );
});

test("extractTextBlocks：首块为空不产生前导换行；模型自带换行保留", () => {
  assert.equal(
    extractTextBlocks([
      { type: "text", text: "" },
      { type: "text", text: "正文开头" },
    ]),
    "正文开头",
  );
  // 模型自己输出的换行（含首块自带）原样保留
  assert.equal(
    extractTextBlocks([
      { type: "text", text: "\n" },
      { type: "text", text: "正文" },
    ]),
    "\n正文",
  );
  assert.equal(
    extractTextBlocks([
      { type: "text", text: "第一段。\n\n" },
      { type: "text", text: "第二段。" },
    ]),
    "第一段。\n\n第二段。",
  );
});

test("extractTextBlocks：reasoning / tool-result 省略；非数组返回空串", () => {
  assert.equal(
    extractTextBlocks([
      { type: "reasoning", text: "思考中（省略）" },
      { type: "text", text: "正文" },
      { type: "tool-result", content: [{ type: "text", text: "工具输出" }] },
    ]),
    "正文",
  );
  assert.equal(extractTextBlocks(undefined), "");
  assert.equal(extractTextBlocks("正文"), "");
});
