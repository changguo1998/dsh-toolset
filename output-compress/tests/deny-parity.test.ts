// tests/deny-parity.test.ts — 跨包隐私常量一致性（设计 §5；不得 npm 依赖）：
// 1) 指纹封印：本包常量序列化指纹必须 === 硬编码 PIN（单侧改常量即红，
//    报错写明「同步两包后更新两侧 PIN」——PIN 派生算法两侧各留注释）；
// 2) 行为对拍：同一组测试向量在两侧模式源串下命中结果一致（防同改同错）。
// 向量表两侧各留一份相同副本（不得 import 对方）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  DENY_PATTERN_SOURCES,
  privacyPin,
  matchDenyPattern,
} from "../src/deny-patterns.ts";

/** 跨包一致 PIN：两侧常量按序 {source}|{flags} "\n" join 后 sha256。
 *  派生算法（两侧同）：JSON 化前逐条 `${source}|${flags}` 换行拼接。 */
const PRIVACY_PIN =
  "e5c2dd8552156641cf03b09d40d9f3182de9bbfd187c8f85b31757536353ef8a";

/** 行为对拍向量（两侧同副本）：[text, 期望命中与否]。 */
const VECTORS: ReadonlyArray<readonly [string, boolean]> = [
  ["-----BEGIN RSA PRIVATE KEY-----", true],
  ["-----BEGIN CERTIFICATE-----", false],
  ["key: sk-abcdefghijklmnopqrst", true],
  ["sk-short", false],
  ["token: ghp_" + "a".repeat(20), true],
  ["AKIAIOSFODNN7EXAMPLE", true],
  ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz", true],
  ["password: supersecretvalue", true],
  ["password: short", false],
  ["普通中文内容无凭据", false],
];

test("指纹封印：常量序列化指纹 === 跨包 PIN（单侧漂移即红）", () => {
  assert.equal(
    privacyPin(),
    PRIVACY_PIN,
    "跨包一致常量已漂移：同步 memory-base/src/rules.ts 与本包 deny-patterns.ts 后，更新两侧 PIN",
  );
});

test("行为对拍：两侧模式源串对同一向量命中一致", () => {
  // 源串集合本身逐条相等（防排序/条数漂移）。
  const expected = DENY_PATTERN_SOURCES.map((p) => `${p.source}|${p.flags}`);
  assert.equal(
    createHash("sha256").update(expected.join("\n")).digest("hex"),
    PRIVACY_PIN,
  );
  for (const [text, shouldMatch] of VECTORS) {
    const hit = matchDenyPattern(text);
    assert.equal(
      hit !== null,
      shouldMatch,
      `向量「${text.slice(0, 30)}」期望 ${shouldMatch ? "命中" : "放行"}，实得 ${hit}`,
    );
  }
});
