import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyToolRegisterError,
  decideCatalogSelfCheck,
  decideDenyFailure,
  decideDenyResidual,
  decideMissingService,
} from "../src/degrade.ts";

test("catalog 自检失败：整体不接管并带原因", () => {
  const decision = decideCatalogSelfCheck("服务未挂载");
  assert.equal(decision.kind, "catalog-self-check");
  assert.equal(decision.action, "abort");
  assert.equal(decision.warn, true);
  assert.match(decision.message, /服务未挂载/);
  assert.match(decision.message, /不接管/);
});

test("deny 失败与残留都要求不接管", () => {
  const failure = decideDenyFailure(new Error("boom"));
  assert.equal(failure.kind, "deny-restrict");
  assert.equal(failure.action, "abort");
  assert.match(failure.message, /boom/);
  const residual = decideDenyResidual(["team_task_list"]);
  assert.equal(residual.kind, "deny-residual");
  assert.equal(residual.action, "abort");
  assert.match(residual.message, /team_task_list/);
});

test("服务缺失：插件不启用", () => {
  assert.equal(decideMissingService().kind, "missing-service");
  assert.equal(decideMissingService().action, "abort");
});

test("注册失败分类：重名 / 其他", () => {
  assert.equal(
    classifyToolRegisterError(
      new Error('tool "consult_tools" is already registered in this scope'),
    ),
    "duplicate",
  );
  assert.equal(classifyToolRegisterError(new Error("nope")), "other");
});
