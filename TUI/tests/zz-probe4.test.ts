import { test } from "node:test";
import { buildFrame } from "../src/app/layout.ts";
import { displayWidth } from "../src/app/layout/markdown.ts";
import { rowAnsi } from "./helpers/rowText.ts";
import { initialState, reduceState } from "../src/app/state.ts";
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
function dump(tag: string, st: ReturnType<typeof initialState>) {
  const rows = buildFrame(st, { rows: 24, cols: 80 }).map((r) => strip(rowAnsi(r)));
  console.log("=== " + tag + " ===");
  rows.forEach((r, i) => {
    const w = displayWidth(r);
    if (w !== 80) console.log(i, "w=" + w, "|" + r + "|");
  });
}
test("probe4", () => {
  let s = initialState();
  s = reduceState(s, { type: "status", status: { time: "12:00:00", cwd: "/u", git: "main" } });
  s = reduceState(s, { type: "user-line", text: "第一问" });
  s = reduceState(s, { type: "append", text: "回复一段正文" });
  dump("shown", s);
  dump("hidden", reduceState(s, { type: "lower-panes", visible: false }));
});
