import { test } from "node:test";
import { buildFrame } from "../src/app/layout.ts";
import { displayWidth } from "../src/app/layout/markdown.ts";
import { rowAnsi } from "./helpers/rowText.ts";
import { initialState, reduceState } from "../src/app/state.ts";
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
test("probe5", () => {
  for (const rows of [40, 24, 12]) {
    for (const cols of [80, 44]) {
      let s = initialState();
      s = reduceState(s, { type: "status", status: { time: "12:00:00", cwd: "/u", git: "main" } });
      s = reduceState(s, { type: "user-line", text: "第一问" });
      s = reduceState(s, { type: "append", text: "回复" });
      s = reduceState(s, { type: "lower-panes", visible: false });
      const fr = buildFrame(s, { rows, cols }).map((r) => strip(rowAnsi(r)));
      const short = fr
        .map((r, i) => [i, displayWidth(r)] as const)
        .filter(([, w]) => w !== cols && w !== 0 && w > 30);
      const hasTitle = fr.some((r) => r.includes("<title>"));
      console.log(`rows=${rows} cols=${cols} titleBar=${hasTitle} 短行=${JSON.stringify(short)}`);
      if (rows === 12 || cols === 44) {
        fr.slice(0, 5).forEach((r, i) => console.log("   ", i, "|" + r + "|"));
      }
    }
  }
});
