import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { inject, name, provide } from "../src/main.ts";
import { resolveConfig } from "../src/config.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function sourceFiles(): string[] {
  const dir = join(packageRoot, "src");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(dir, file));
}

test("bundle 契约：name / inject / provide / Config / apply 导出齐备", () => {
  assert.equal(name, "auto-approve");
  assert.deepEqual(inject, ["approval", "tools"]);
  assert.deepEqual(provide, ["autoApprove"]);
  const entry = readFileSync(join(packageRoot, "index.ts"), "utf8");
  assert.match(entry, /export \* from "\.\/src\/main\.ts"/);
  const main = readFileSync(join(packageRoot, "src", "main.ts"), "utf8");
  assert.match(main, /export function apply/);
  assert.match(main, /export type \{ Config \}/);
});

/** 去掉注释（只扫代码本体；注释里会出现「不调用 ctx.get("guard")」这类说明）。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("R3 反向验证：代码里没有 guard 服务调用（不依赖 security-guard）", () => {
  const forbidden = [
    /inspectCommand/,
    /get\(\s*["']guard["']\s*\)/,
    /provide\(\s*["']guard["']\s*\)/,
  ];
  for (const file of sourceFiles()) {
    const text = stripComments(readFileSync(file, "utf8"));
    for (const pattern of forbidden) {
      assert.equal(pattern.test(text), false, `${file} 命中 ${pattern}`);
    }
  }
  assert.equal(inject.includes("guard"), false);
});

test("cordis.patch.yml：按 R6 缺省 enabled: true + mode: rules", () => {
  const patch = readFileSync(join(packageRoot, "cordis.patch.yml"), "utf8");
  assert.match(patch, /id: auto-approve/);
  assert.match(patch, /name: '@dsh-toolset\/auto-approve'/);
  assert.match(patch, /enabled: true/);
  assert.match(patch, /mode: rules/);
  const defaults = resolveConfig(undefined);
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.mode, "rules");
});

test("接线三处：根 check/build 链、test-parallel default_pkgs、install canonical_pkgs 都含本包", () => {
  const root = readJson<{ scripts: Record<string, string> }>(
    join(repoRoot, "package.json"),
  );
  for (const script of ["check", "build"]) {
    assert.match(root.scripts[script] ?? "", /npm --prefix auto-approve run/);
  }
  const parallel = readFileSync(
    join(repoRoot, "scripts", "test-parallel.sh"),
    "utf8",
  );
  const defaultPkgs = /default_pkgs="([^"]+)"/.exec(parallel)?.[1] ?? "";
  assert.equal(defaultPkgs.split(/\s+/).includes("auto-approve"), true);
  const install = readFileSync(join(repoRoot, "scripts", "install.sh"), "utf8");
  const canonical = /canonical_pkgs="([^"]+)"/.exec(install)?.[1] ?? "";
  assert.equal(canonical.split(/\s+/).includes("auto-approve"), true);
  assert.equal(canonical, defaultPkgs, "两处清单同序");
});

test("package.json：dsh.bundle 声明与入口", () => {
  const pkg = readJson<{
    name: string;
    main: string;
    dsh?: { bundle?: { patch?: string } };
  }>(join(packageRoot, "package.json"));
  assert.equal(pkg.name, "@dsh-toolset/auto-approve");
  assert.equal(pkg.main, "dist/index.js");
  assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
});
