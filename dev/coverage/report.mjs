#!/usr/bin/env node
// 覆盖率聚合: 读 NODE_V8_COVERAGE 的原始 JSON, 只统各包 src, 输出 JSON 与每包一张表。
// 行覆盖按 V8 range 与实际源码行取交集; 分支覆盖按 V8 的 block range 统计。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const covDir = resolve(root, process.argv[2] ?? "tmp/coverage");
const outFile = resolve(root, process.argv[3] ?? "tmp/coverage/report.json");

/** 该相对路径是否属于某个包的 src (排除 tests / dist / node_modules / 仓库外)。 */
function isPackageSource(rel) {
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  if (
    rel.includes(`${sep}node_modules${sep}`) ||
    rel.includes(`${sep}tests${sep}`) ||
    rel.includes(`${sep}dist${sep}`)
  )
    return false;
  return rel.includes(`${sep}src${sep}`);
}

/** 合并同一个文件在多个测试进程里的 range: 同偏移取最大命中次数。 */
function mergeRanges(into, functions) {
  for (const fn of functions ?? []) {
    const ranges = fn.ranges ?? [];
    for (let index = 0; index < ranges.length; index += 1) {
      const range = ranges[index];
      const key = `${range.startOffset}:${range.endOffset}`;
      const prev = into.get(key);
      const count = range.count ?? 0;
      if (!prev || count > prev.count) {
        into.set(key, {
          start: range.startOffset,
          end: range.endOffset,
          count,
          block: Boolean(fn.isBlockCoverage) && index > 0,
        });
      }
    }
  }
}

/** 偏移量 -> 行号 (0 基), 供 range 与源码行取交集。 */
function lineIndex(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  };
}

/** 只把非空、非注释行算进分母, 避免注释与空行拉低行覆盖。 */
function isCodeLine(text) {
  const trimmed = text.trim();
  return (
    trimmed !== "" &&
    !trimmed.startsWith("//") &&
    !trimmed.startsWith("*") &&
    !trimmed.startsWith("/*")
  );
}

/** 连续行号压成 `12-14, 20` 形式。 */
function compressLines(lines) {
  const parts = [];
  for (let i = 0; i < lines.length; i += 1) {
    let end = i;
    while (end + 1 < lines.length && lines[end + 1] === lines[end] + 1)
      end += 1;
    parts.push(end > i ? `${lines[i]}-${lines[end]}` : String(lines[i]));
    i = end;
  }
  return parts.join(", ");
}

const files = new Map();
for (const entry of readdirSync(covDir)) {
  if (!entry.endsWith(".json") || entry === "report.json") continue;
  let data;
  try {
    data = JSON.parse(readFileSync(resolve(covDir, entry), "utf8"));
  } catch {
    continue;
  }
  for (const script of data.result ?? []) {
    if (!script.url?.startsWith("file:")) continue;
    let path;
    try {
      path = fileURLToPath(script.url);
    } catch {
      continue;
    }
    const rel = relative(root, path);
    if (!isPackageSource(rel)) continue;
    if (!files.has(rel)) files.set(rel, new Map());
    mergeRanges(files.get(rel), script.functions);
  }
}

const packages = new Map();
for (const [rel, ranges] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
  const source = readFileSync(resolve(root, rel), "utf8");
  const lineText = source.split("\n");
  const lineOf = lineIndex(source);
  const lineHit = new Map();
  let branchTotal = 0;
  let branchCovered = 0;
  for (const range of ranges.values()) {
    if (range.block) {
      branchTotal += 1;
      if (range.count > 0) branchCovered += 1;
    }
    if (range.start >= range.end) continue;
    const first = lineOf(range.start);
    const last = lineOf(range.end - 1);
    const span = range.end - range.start;
    for (let line = first; line <= last; line += 1) {
      if (!isCodeLine(lineText[line] ?? "")) continue;
      const prev = lineHit.get(line);
      if (!prev || span < prev.span)
        lineHit.set(line, { count: range.count, span });
    }
  }
  const total = new Set(lineHit.keys());
  const covered = new Set(
    [...lineHit].filter(([, hit]) => hit.count > 0).map(([line]) => line),
  );
  const uncovered = [...total]
    .filter((line) => !covered.has(line))
    .sort((a, b) => a - b);
  const pkg = rel.split(sep)[0];
  if (!packages.has(pkg))
    packages.set(pkg, {
      files: [],
      lines: { total: 0, covered: 0 },
      branches: { total: 0, covered: 0 },
    });
  const bucket = packages.get(pkg);
  bucket.files.push({
    file: rel,
    lines: { total: total.size, covered: covered.size },
    branches: { total: branchTotal, covered: branchCovered },
    uncovered,
  });
  bucket.lines.total += total.size;
  bucket.lines.covered += covered.size;
  bucket.branches.total += branchTotal;
  bucket.branches.covered += branchCovered;
}

const totals = {
  lines: { total: 0, covered: 0 },
  branches: { total: 0, covered: 0 },
};
for (const bucket of packages.values()) {
  totals.lines.total += bucket.lines.total;
  totals.lines.covered += bucket.lines.covered;
  totals.branches.total += bucket.branches.total;
  totals.branches.covered += bucket.branches.covered;
}

function percent(part, whole) {
  return whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;
}

const report = {
  generatedAt: new Date().toISOString(),
  totals,
  packages: Object.fromEntries(
    [...packages].map(([pkg, bucket]) => [
      pkg,
      {
        lines: bucket.lines,
        branches: bucket.branches,
        files: bucket.files.map((file) => ({
          ...file,
          uncovered: compressLines(file.uncovered),
        })),
      },
    ]),
  ),
};
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);

const out = [];
out.push("## 覆盖率汇总", "", "| 包 | 行 | 分支 |", "| --- | --- | --- |");
for (const [pkg, bucket] of packages) {
  out.push(
    `| ${pkg} | ${percent(bucket.lines.covered, bucket.lines.total)} (${bucket.lines.covered}/${bucket.lines.total}) | ${percent(bucket.branches.covered, bucket.branches.total)} (${bucket.branches.covered}/${bucket.branches.total}) |`,
  );
}
out.push(
  "",
  `合计: 行 ${percent(totals.lines.covered, totals.lines.total)}, 分支 ${percent(totals.branches.covered, totals.branches.total)}`,
);
for (const [pkg, bucket] of packages) {
  out.push(
    "",
    `### ${pkg}`,
    "",
    "| 文件 | 行 | 分支 | 未覆盖行 |",
    "| --- | --- | --- | --- |",
  );
  for (const file of bucket.files) {
    out.push(
      `| ${file.file} | ${percent(file.lines.covered, file.lines.total)} (${file.lines.covered}/${file.lines.total}) | ${percent(file.branches.covered, file.branches.total)} (${file.branches.covered}/${file.branches.total}) | ${file.uncovered || "-"} |`,
    );
  }
}
process.stdout.write(
  `${out.join("\n")}\n覆盖率 JSON: ${relative(root, outFile)}\n`,
);
