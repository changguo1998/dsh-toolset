/**
 * 项目/模块报告（#21）：结构总览 + 模块依赖 + 依赖环 + 未引用的导出文件。
 *
 * 形态参考 dependency-cruiser 的聚合报告：文件级 import 上卷到模块
 * （相对 root 首段目录），提供 modules/imports/importedBy 与环统计。
 */

import type { CodeMapReport, CycleInfo, ModuleStats } from "../types.ts";
import type { CodeGraph } from "../graph/graph.ts";
import { moduleOf } from "../graph/query.ts";

/** 把符号 kind 归一为可聚合的粗类（astKind 到报告槽位）。 */
function kindBucket(kind: string): string {
  const k = kind.toLowerCase();
  if (k.includes("class")) return "class";
  if (k.includes("interface")) return "interface";
  if (k.includes("enum")) return "enum";
  if (k.includes("function") || k.includes("method") || k.includes("arrow")) {
    return "function";
  }
  if (k.includes("variable") || k.includes("let") || k.includes("const")) {
    return "variable";
  }
  if (k.includes("type")) return "type";
  if (k.includes("import")) return "import";
  return "other";
}

export function buildReport(
  root: string,
  graph: CodeGraph,
  unresolved: number,
): CodeMapReport {
  const fileCount = graph.files.size;
  const languageCounts: Record<string, number> = {};
  const kindCounts: Record<string, number> = {};
  let symbolCount = 0;
  let importCount = 0;
  const exportedFiles = new Set<string>();
  const moduleMap = new Map<string, ModuleStats>();

  for (const f of graph.files.values()) {
    languageCounts[f.language] = (languageCounts[f.language] ?? 0) + 1;
    const mod = moduleOf(root, f.path);
    let m = moduleMap.get(mod);
    if (!m) {
      m = {
        name: mod,
        fileCount: 0,
        symbolCount: 0,
        imports: [],
        importedBy: [],
      };
      moduleMap.set(mod, m);
    }
    m.fileCount++;
    for (const sym of f.symbols) {
      symbolCount++;
      m.symbolCount++;
      const bucket = kindBucket(sym.kind);
      kindCounts[bucket] = (kindCounts[bucket] ?? 0) + 1;
      if (sym.exported) exportedFiles.add(f.path);
    }
  }

  // import 统计 + 模块边（文件 import → 上卷到模块，去重、去自环）
  const modImports = new Map<string, Set<string>>();
  for (const f of graph.files.keys()) {
    for (const to of graph.importsOf(f)) {
      importCount++;
      const fromMod = moduleOf(root, f);
      const toMod = moduleOf(root, to);
      if (fromMod === toMod) continue;
      let s = modImports.get(fromMod);
      if (!s) {
        s = new Set();
        modImports.set(fromMod, s);
      }
      s.add(toMod);
    }
  }
  for (const f of graph.files.keys()) {
    const m = moduleMap.get(moduleOf(root, f));
    if (m) m.imports = [...(modImports.get(m.name) ?? [])].sort();
  }
  // importedBy：从模块 import 图反推
  for (const [fromMod, toSet] of modImports) {
    for (const toMod of toSet) {
      const t = moduleMap.get(toMod);
      if (t) t.importedBy.push(fromMod);
    }
  }
  for (const m of moduleMap.values()) m.importedBy.sort();

  // 文件级依赖环（SCC size>=2）
  const moduleCycles: CycleInfo[] = graph.sccCycles().map((c) => ({
    size: c.size,
    members: c.members,
  }));

  // 未引用的导出文件：有导出符号但没有任何文件 import 它
  const unimportedExportFiles = [...exportedFiles]
    .filter((f) => graph.importedBy(f).length === 0)
    .sort();

  return {
    root,
    fileCount,
    symbolCount,
    importCount,
    unresolvedImportCount: unresolved,
    languageCounts,
    kindCounts,
    modules: [...moduleMap.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
    moduleCycles,
    unimportedExportFiles,
  };
}
