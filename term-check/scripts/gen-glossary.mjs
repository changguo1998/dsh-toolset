// term-check/scripts/gen-glossary.mjs — 生成 term-check/src/glossary.generated.ts（术语表快照）
//
// 解析口径复用 dev/standard/rules.mjs 的 loadGlossary（与 `pnpm run check:docs` 同源），
// 不另写一套表解析；本脚本只负责把解析结果固化成随包发布的 TS 快照。
//
// 用法：
//   node scripts/gen-glossary.mjs             # 重写快照
//   node scripts/gen-glossary.mjs --check     # 只校验快照与当前 GLOSSARY 是否一致（不一致退出码 1）
//   node scripts/gen-glossary.mjs --root <目录>   # 指定仓库根（缺省本包上一级；测试用临时根）

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
/** 本包所在仓库根（含 dev/standard 与 docs/GLOSSARY.md）。 */
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
/** 生成产物路径。 */
const OUT_FILE = resolve(SCRIPT_DIR, "../src/glossary.generated.ts");
/** 快照数组在产物里的定位标记（`--check` 据此取出正文做语义比对）。 */
const ARRAY_MARKER = "/* prettier-ignore */ [";

/** 解析命令行。 */
function parseArgs(argv) {
  const options = { check: false, root: REPO_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    if (arg === "--root") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--root 缺少目录参数");
      options.root = resolve(value);
      i += 1;
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  return options;
}

/** 把 GLOSSARY 解析结果压成快照行（字段顺序固定 —— 产物可稳定比对）。 */
function toRows(glossary) {
  return glossary.map((row) => ({
    from: row.from,
    to: row.to,
    note: row.note,
    isInterface: row.isInterface,
    conditional: row.conditional,
  }));
}

/** 渲染产物全文。 */
function render(rows) {
  const body = rows.map((row) => `    ${JSON.stringify(row)},`).join("\n");
  return `/**
 * 术语表快照（**生成产物, 禁止手改**）：由 \`term-check/scripts/gen-glossary.mjs\` 从
 * \`docs/GLOSSARY.md\`「禁止术语」表生成，解析复用 \`dev/standard/rules.mjs\` 的 \`loadGlossary\`。
 * 改术语表后重跑 \`pnpm run gen:glossary\`；两边不一致时 \`term-check/tests/glossary.test.ts\` 会报红。
 */

/** 「禁止术语」表的一行。 */
export interface GlossaryRow {
  /** 旧称（同一行可含多个, 用 \`/\` 分隔）。 */
  readonly from: readonly string[];
  /** 应当使用。 */
  readonly to: string;
  /** 条件与例外（原文）。 */
  readonly note: string;
  /** 是否界面名称（\`term.interface\`）。 */
  readonly isInterface: boolean;
  /** 条件型术语: 与包并列指层次时保留, 不自动判定。 */
  readonly conditional: boolean;
}

/** 快照正文（行序与 GLOSSARY 表一致）。 */
export const GLOSSARY_SNAPSHOT: readonly GlossaryRow[] =
  ${ARRAY_MARKER}
${body}
  ];
`;
}

/** 从产物文本里取出快照数组正文（已是 JSON 数组）。 */
function extractArray(source) {
  const start = source.indexOf(ARRAY_MARKER);
  if (start < 0) throw new Error(`产物缺定位标记「${ARRAY_MARKER}」`);
  const from = start + ARRAY_MARKER.length - 1; // 指向 `[`
  const end = source.lastIndexOf("];");
  if (end < from) throw new Error("产物结构损坏: 找不到数组结尾");
  // 每行一个 JSON 对象（行尾逗号不是合法 JSON）, 逐行解析
  return source
    .slice(from + 1, end)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line.replace(/,$/, "")));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rules = await import(
    pathToFileURL(join(REPO_ROOT, "dev/standard/rules.mjs")).href
  );
  const rows = toRows(rules.loadGlossary(options.root));
  if (rows.length === 0)
    throw new Error("GLOSSARY 解析出 0 行, 拒绝写出空快照");
  if (options.check) {
    const onDisk = extractArray(readFileSync(OUT_FILE, "utf8"));
    const same = JSON.stringify(onDisk) === JSON.stringify(rows);
    if (!same) {
      process.stderr.write(
        `[term-check] 快照与 docs/GLOSSARY.md 不一致（磁盘 ${onDisk.length} 行 / 当前 ${rows.length} 行），请重跑 pnpm run gen:glossary\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`ok: 快照与 GLOSSARY 一致（${rows.length} 行）\n`);
    return;
  }
  writeFileSync(OUT_FILE, render(rows), "utf8");
  process.stdout.write(
    `wrote src/glossary.generated.ts (${rows.length} rows)\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`[term-check] 生成失败：${String(error)}\n`);
  process.exitCode = 1;
});
