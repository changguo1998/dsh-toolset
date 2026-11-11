import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, resolveConfig, inject, name } from "../src/index.ts";
import { LADDER_TEXT } from "../src/ladder.ts";

/** section 注册记录。 */
interface SectionRecord {
  name: string;
  order: number;
  text: string;
  interpolate?: boolean;
}

/** 假 ctx：记录 section 注册并统计注销。 */
function fakeCtx(options: { noSystemPrompt?: boolean } = {}): {
  sections: SectionRecord[];
  disposed: () => number;
  ctx: Record<string, unknown>;
} {
  const sections: SectionRecord[] = [];
  let disposed = 0;
  const ctx: Record<string, unknown> = {};
  if (options.noSystemPrompt !== true) {
    ctx["systemPrompt"] = {
      section: (section: SectionRecord) => {
        sections.push(section);
        return () => {
          disposed += 1;
        };
      },
    };
  }
  return { sections, disposed: () => disposed, ctx };
}

test("resolveConfig：缺省开启 + 内置阶梯文本，显式 false 关闭", () => {
  const c = resolveConfig();
  assert.equal(c.enabled, true, "缺省开启（2026-10-05 起）");
  assert.equal(c.text, LADDER_TEXT);
  assert.equal(resolveConfig({ enabled: false }).enabled, false);
  assert.equal(resolveConfig({ enabled: true }).enabled, true);
  assert.equal(resolveConfig({ text: "" }).text, LADDER_TEXT, "空串回退内置");
});

test("阶梯文本含 7 级判据与关键规则（文案漂移守卫）", () => {
  for (const kw of [
    "YAGNI",
    "复用",
    "标准库",
    "原生特性",
    "已装依赖",
    "一行",
    "最少",
  ]) {
    assert.ok(LADDER_TEXT.includes(kw), `阶梯文本应含「${kw}」`);
  }
  for (const kw of ["根因", "最短 diff"]) {
    assert.ok(LADDER_TEXT.includes(kw), `规则应含「${kw}」`);
  }
});

test("apply：开启时注册静态 section（固定 name / order / interpolate）", () => {
  const fake = fakeCtx();
  const dispose = apply(fake.ctx);
  assert.equal(fake.sections.length, 1);
  const section = fake.sections[0]!;
  assert.equal(section.name, "ponytail/ladder");
  assert.equal(section.order, 4100);
  assert.equal(section.text, LADDER_TEXT);
  assert.equal(section.interpolate, false);
  dispose();
  assert.equal(fake.disposed(), 1, "dispose 注销 section");
});

test("apply：enabled=false 时不注册 section", () => {
  const fake = fakeCtx();
  const dispose = apply(fake.ctx, { enabled: false });
  assert.equal(fake.sections.length, 0);
  assert.equal(typeof dispose, "function");
});

test("apply：text 覆盖生效", () => {
  const fake = fakeCtx();
  apply(fake.ctx, { text: "[ponytail] 自定义正文" });
  assert.equal(fake.sections[0]?.text, "[ponytail] 自定义正文");
});

test("apply：systemPrompt 缺席 → 告警且不抛，dispose 为空操作", () => {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const fake = fakeCtx({ noSystemPrompt: true });
    const dispose = apply(fake.ctx);
    assert.equal(typeof dispose, "function");
    dispose();
    assert.ok(
      writes.some((w) => w.includes("systemPrompt 不可用")),
      "应告警 systemPrompt 缺席",
    );
  } finally {
    process.stderr.write = original;
  }
});

test("契约符号：name / inject", () => {
  assert.equal(name, "ponytail");
  assert.deepEqual(inject, ["systemPrompt"]);
});
