import { blunderTerms } from "@core/strength/blunder-model";
import { createSelectionState } from "@core/strength/move-selector";
const E = 1650;
const t = (ms: number, base?: number) => blunderTerms(E, { myClockMs: ms, cpStd: 50, blunderScale: 1, state: createSelectionState(), ...(base === undefined ? {} : { baseMs: base }) });
console.log("frac  f_clock      b      | 1+0 clk  3+0 clk  10+0 clk");
for (const fr of [1, 0.8, 2/3, 0.5, 1/3, 2/9, 1/6, 1/9, 1/18, 1/36]) {
	const x = t(180000 * fr, 180000);
	const a = t(60000 * fr, 60000), c = t(600000 * fr, 600000);
	console.log(`${fr.toFixed(3)} ${x.fClock.toFixed(4)} ${x.b.toFixed(4)}  | ${(60*fr).toFixed(1)}s ${(180*fr).toFixed(0)}s ${(600*fr).toFixed(0)}s  same? ${Math.abs(a.fClock-x.fClock)<1e-12 && Math.abs(c.fClock-x.fClock)<1e-12}`);
}
console.log("\nPRE-LANE equivalent (no baseMs, absolute ramp only):");
for (const clk of [180, 150, 120, 90, 60, 40, 30, 20, 10, 5]) {
	const pre = t(clk*1000), post = t(clk*1000, 180000);
	console.log(`3+0 @${clk}s  pre f_clock ${pre.fClock.toFixed(3)} b ${pre.b.toFixed(4)}   post ${post.fClock.toFixed(3)} b ${post.b.toFixed(4)}  ratio ${(post.b/pre.b).toFixed(2)}x`);
}
