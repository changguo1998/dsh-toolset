/**
 * 创建期目标校验单测（2026-10-21 条目「创建指向不可解析会话的 S 档任务仍弹写透告警」）：
 * `sessionPaths` 可选读取、只有 S 档校验、不可解析返回原因文案。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createTargetValidator, TARGET_UNRESOLVABLE } from "../src/target.ts";

test("createTargetValidator：服务缺失 → undefined（不校验, 决策 D6）", () => {
  assert.equal(createTargetValidator(undefined), undefined);
  assert.equal(createTargetValidator(null), undefined);
  assert.equal(createTargetValidator({ get: () => undefined }), undefined);
  // 形状不符（没有 sessionDirFor）同样视为不可用
  assert.equal(createTargetValidator({ get: () => ({}) }), undefined);
  assert.equal(
    createTargetValidator({ get: () => ({ sessionDirFor: "nope" }) }),
    undefined,
  );
});

test("createTargetValidator：S 档探测会话目录, P / U 档放行", () => {
  const validator = createTargetValidator({
    get: (serviceName: string) =>
      serviceName === "sessionPaths"
        ? {
            sessionDirFor: (sessionId: string): string => {
              if (sessionId === "sess-ok") return `/tmp/sessions/${sessionId}`;
              throw new Error(`会话「${sessionId}」不在宿主的 sessions 里`);
            },
          }
        : undefined,
  });
  assert.ok(validator !== undefined);

  assert.equal(validator("sess-ok", "S"), null);
  assert.match(String(validator("sess-gone", "S")), /不在宿主的 sessions 里/);
  // P / U 档落 project / user 层, 不依赖会话目录
  assert.equal(validator("sess-gone", "P"), null);
  assert.equal(validator("sess-gone", "U"), null);
});

test("createTargetValidator：直接属性读兜底（无 ctx.get 的宿主）", () => {
  const validator = createTargetValidator({
    sessionPaths: {
      sessionDirFor: () => {
        throw new Error("解析失败");
      },
    },
  });
  assert.ok(validator !== undefined);
  assert.equal(validator("any", "S"), "解析失败");
});

test("错误码常量与工具返回一致", () => {
  assert.equal(TARGET_UNRESOLVABLE, "session_unresolvable");
});
