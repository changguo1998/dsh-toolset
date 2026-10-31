#!/usr/bin/env node
// 覆盖率采集入口: 以 NODE_V8_COVERAGE 跑全包测试, 原始 JSON 落 tmp/coverage。
// 由根 `pnpm run test:coverage` 调起; 聚合与报告见同目录 report.mjs。
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = resolve(root, "tmp/coverage");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = spawnSync("sh", ["scripts/test-parallel.sh"], {
  cwd: root,
  env: { ...process.env, NODE_V8_COVERAGE: outDir },
  stdio: "inherit",
});
process.exit(result.status ?? 1);
