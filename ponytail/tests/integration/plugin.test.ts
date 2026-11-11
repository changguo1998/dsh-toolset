import assert from "node:assert/strict";
import test from "node:test";

import { apply, inject, name } from "../../src/index.ts";
import { LADDER_TEXT } from "../../src/ladder.ts";

/** section 注册记录。 */
interface SectionRecord {
  name: string;
  order: number;
  text: string;
  interpolate?: boolean;
}

/** 假宿主：systemPrompt.section 记录注册项。 */
function assemble(config?: Parameters<typeof apply>[1]): {
  sections: SectionRecord[];
  dispose: () => void;
  disposed: () => number;
} {
  const sections: SectionRecord[] = [];
  let disposed = 0;
  const ctx = {
    systemPrompt: {
      section: (section: SectionRecord) => {
        sections.push(section);
        return () => {
          disposed += 1;
        };
      },
    },
  };
  const dispose = apply(ctx, config);
  return { sections, dispose, disposed: () => disposed };
}

test("装配: 契约符号齐备, 开启时注册一个静态 section", () => {
  const a = assemble();
  assert.equal(name, "ponytail");
  assert.deepEqual(inject, ["systemPrompt"]);
  assert.equal(a.sections.length, 1);
  assert.equal(a.sections[0]?.name, "ponytail/ladder");
  assert.equal(a.sections[0]?.order, 4100);
  assert.equal(a.sections[0]?.interpolate, false);
  a.dispose();
  assert.equal(a.disposed(), 1);
});

test("装配: 正文含 7 级判据与根因规则", () => {
  const a = assemble();
  const text = a.sections[0]?.text ?? "";
  for (const kw of [
    "YAGNI",
    "复用",
    "标准库",
    "原生特性",
    "已装依赖",
    "一行",
  ]) {
    assert.ok(text.includes(kw), `注入正文应含「${kw}」`);
  }
  assert.equal(text, LADDER_TEXT);
  a.dispose();
});

test("开关: enabled false 不注册 section, 也不告警", () => {
  const a = assemble({ enabled: false });
  assert.equal(a.sections.length, 0);
  a.dispose();
  assert.equal(a.disposed(), 0);
});

test("配置面: text 覆盖生效", () => {
  const a = assemble({ text: "[ponytail] 自定义正文" });
  assert.equal(a.sections[0]?.text, "[ponytail] 自定义正文");
  a.dispose();
});

test("宿主面: ctx 为 null / undefined 时按服务缺席告警且不抛", () => {
  for (const ctx of [null, undefined]) {
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const dispose = apply(ctx);
      assert.equal(typeof dispose, "function", "无服务时返回空操作 dispose");
      assert.doesNotThrow(() => dispose());
    } finally {
      process.stderr.write = original;
    }
    assert.deepEqual(
      writes.map((line) => line.trim()),
      [
        "[ponytail] warn: ctx.systemPrompt 不可用，ponytail 阶梯不会注入（请检查宿主版本）",
      ],
      `ctx=${String(ctx)} 只告警一次`,
    );
  }
});
