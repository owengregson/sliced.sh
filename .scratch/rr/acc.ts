import { blunderTerms } from "@core/strength/blunder-model";
import { createSelectionState } from "@core/strength/move-selector";
const t = (ms: number, base?: number) => blunderTerms(1650, { myClockMs: ms, cpStd: 50, blunderScale: 1, state: createSelectionState(), ...(base === undefined ? {} : { baseMs: base }) });
for (const [lbl, ms, base] of [["3+0 full",180000,180000],["3+0 @1:00",60000,180000],["3+0 @0:30",30000,180000],["3+0 @0:10",10000,180000],["3+0 @0:00",0,180000]] as const) {
  const x = t(ms, base); console.log(`${lbl.padEnd(10)} f_clock ${x.fClock.toFixed(4)}  b ${x.b.toFixed(4)}`);
}
const full = t(180000,180000).b;
console.log(`ratios: 1:00 ${ (t(60000,180000).b/full).toFixed(3) }x  0:30 ${ (t(30000,180000).b/full).toFixed(3) }x  ceiling ${ (t(0,180000).b/full).toFixed(3) }x`);
// cross-speed identity by fraction
for (const fr of [1, 0.5, 1/3, 1/6]) {
  const v = [60000,180000,600000].map(b => t(b*fr, b).fClock);
  console.log(`fraction ${fr.toFixed(3)}: ${v.map(x=>x.toFixed(6)).join("  ")}`);
}
