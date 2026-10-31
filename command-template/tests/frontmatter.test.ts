// tests/frontmatter.test.ts — 模板解析：YAML 子集的正向形态与逐条错误路径。
//
// 正向用例锁定支持的子集（折叠块 / 字面块 / 引号标量 / 注释 / 嵌套映射与序列 / 步骤 id 缺省），
// 错误用例逐个锁定 TemplateParseError 的可读消息（模板作者的唯一诊断面）。

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTemplate, TemplateParseError } from "../src/frontmatter.ts";

/** 以固定 source 解析一段模板文本. */
function parse(text: string) {
  return parseTemplate(text, "/tmp/case.md");
}

/** 断言解析抛 TemplateParseError 且消息命中给定片段. */
function rejects(text: string, expected: RegExp): void {
  assert.throws(
    () => parse(text),
    (err: unknown) => {
      assert.ok(err instanceof TemplateParseError, String(err));
      assert.match(err.message, expected);
      return true;
    },
  );
}

test("frontmatter: 折叠块 / 字面块 / 引号标量 / 整行注释按子集解析", () => {
  const spec = parse(`---
name: fold
description: "带引号 描述"
# 整行注释不参与解析
input: '名字'
steps:
  - id: a
    prompt: >
      第一行
      第二行
  - id: b
    prompt: |
      保留
        缩进
---`);
  assert.equal(spec.description, "带引号 描述", "双引号成对时去掉引号");
  assert.equal(spec.inputHint, "名字", "单引号成对时去掉引号");
  assert.equal(spec.steps[0]?.prompt, "第一行 第二行", "> 折叠成单行");
  assert.equal(spec.steps[1]?.prompt, "保留\n  缩进", "| 保留换行与相对缩进");
});

test("frontmatter: 嵌套映射 / 模板级模型继承 / 步骤 id 缺省", () => {
  const spec = parse(`---
name: nested
description: d
model:
  provider: deepseek
  model: deepseek-v4-pro
steps:
  - prompt: p1
  - type: prompt
    prompt: p2
---`);
  assert.deepEqual(spec.model, {
    provider: "deepseek",
    model: "deepseek-v4-pro",
  });
  assert.deepEqual(
    spec.steps.map((step) => step.id),
    ["step1", "step2"],
    "id 缺省按序号补",
  );
  assert.equal(spec.steps[0]?.type, "agent", "steps 项缺省 agent");
  assert.deepEqual(spec.steps[0]?.model, spec.model, "agent 步继承模板级模型");
  assert.equal(spec.steps[1]?.model, undefined, "prompt 步不继承模板级模型");
  // 模型简写：只有模型名
  const shorthand = parse(`---
name: short
description: d
model: m1
---
正文`);
  assert.deepEqual(shorthand.model, { model: "m1" });
});

test("frontmatter: 空值键解析为空串, 尾随空格与纯注释行不影响结果", () => {
  const spec = parse(`---
name: blanks
description: d   
input:
# 注释
---

正文`);
  assert.equal(spec.inputHint, "");
  assert.equal(spec.description, "d");
  assert.equal(spec.steps[0]?.prompt, "正文", "正文去掉首尾空白");
});

test("frontmatter: 块标量保留内部空行, 去掉尾部空行", () => {
  const spec = parse(`---
name: block
description: d
steps:
  - id: a
    prompt: |
      第一段

      第二段

---`);
  assert.equal(spec.steps[0]?.prompt, "第一段\n\n第二段");
});

test("frontmatter: front-matter 结构错误逐个报可读原因", () => {
  rejects("没有 front-matter", /缺少 front-matter/);
  rejects("---\nname: a\ndescription: d\n", /front-matter 未闭合/);
  rejects("---\nname: a\ndescription: d\n---\n", /既无 steps 也无正文/);
  rejects(
    "---\nname: a\ndescription: d\n  bad: 1\n---\n",
    /第 3 行：缩进意外（期望 0 空格）/,
  );
  rejects(
    "---\nname: a\ndescription: d\nsteps:\n\t- prompt: p\n---\n",
    /缩进不支持 Tab/,
  );
  rejects(
    "---\nname: a\ndescription: d\nmodel:\n  deepseek\n---\nx",
    /第 4 行：不是 key: value/,
  );
  rejects("---\nname: a\ndescription: d\nsteps: [a]\n---\n", /不支持流式集合/);
});

test("frontmatter: 步骤 / 裁判 / 模型的字段错误逐个报可读原因", () => {
  rejects(
    "---\nname: a\ndescription: d\nsteps: 一个\n---\nx",
    /steps: 期望序列/,
  );
  rejects("---\nname: a\ndescription: d\nsteps:\n---\nx", /steps: 期望序列/);
  rejects(
    "---\nname: a\ndescription: d\nsteps:\n  - id: Bad\n    prompt: p\n---\n",
    /步骤 id 非法（Bad）/,
  );
  rejects(
    "---\nname: a\ndescription: d\nsteps:\n  - id: a\n    prompt: p\n  - id: a\n    prompt: q\n---\n",
    /步骤 id 重复（a）/,
  );
  rejects(
    "---\nname: a\ndescription: d\nsteps:\n  - id: a\n---\n",
    /步骤 a 缺 prompt/,
  );
  rejects(
    "---\nname: a\ndescription: d\nsteps:\n  - id: a\n    prompt: p\n    bestOf: 0\n---\n",
    /bestOf 须为正整数/,
  );
  rejects(
    "---\nname: a\ndescription: d\nsteps:\n  - id: a\n    prompt: p\n    judge: 文字\n---\n",
    /judge: 期望映射/,
  );
  rejects(
    "---\nname: a\ndescription: d\nsteps:\n  - id: a\n    prompt: p\n    judge:\n      model: m\n---\n",
    /judge 缺 prompt/,
  );
  rejects(
    "---\nname: a\ndescription: d\nmodel:\n  other: x\n---\nx",
    /model: 需 provider 或 model/,
  );
  rejects(
    "---\nname: a\ndescription: d\nsteps:\n  - aaa\n    bbb\n---\n",
    /第 5 行：序列项缩进意外/,
  );
});
