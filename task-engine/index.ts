// index.ts — 包入口：re-export 插件入口（cordis `{name, inject, apply}`）
//
// 编译产出 dist/index.js（package.json main 指向），业务代码仍在 src/。
// 相对导入用 .ts 扩展名（NodeNext + rewriteRelativeImportExtensions，与 src/ 一致）。

export * from "./src/main.ts";
