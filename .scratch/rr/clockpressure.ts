// Item 4: is clockPressureMs live? Which term binds, per base clock?
import { SELECTION_CONSTANTS } from "@core/strength/constants";
import { tcClass } from "@core/timing/features";
const B = SELECTION_CONSTANTS.blunder;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
function abs(ms: number) { return clamp((B.clockPressureMs - ms) / B.clockPressureMs, 0, 1); }
function rel(ms: number, baseMs: number) {
  return clamp((B.clockPressureFraction - clamp(ms / baseMs, 0, 1)) / B.clockPressureFraction, 0, 1);
}
const FRACTIONS10 = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.25, 1/12, 0];
const FRACTIONS12 = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 1/3, 0.25, 1/6, 1/12, 0];
console.log("base_s  tcClass   abs-wins/10  abs-wins/12  (strictly greater)");
for (const baseS of [5, 10, 15, 20, 25, 30, 60, 180, 600]) {
  const baseMs = baseS * 1000;
  const w10 = FRACTIONS10.filter((fr) => abs(baseMs*fr) > rel(baseMs*fr, baseMs)).length;
  const w12 = FRACTIONS12.filter((fr) => abs(baseMs*fr) > rel(baseMs*fr, baseMs)).length;
  console.log(`${String(baseS).padStart(5)}  ${tcClass(baseS,0).padEnd(9)} ${String(w10).padStart(10)}  ${String(w12).padStart(11)}`);
}
console.log("\n15+1 -> tcClass", tcClass(15,1), " 10+0s ->", tcClass(10,0), " 30+0 ->", tcClass(30,0), " 25+0 ->", tcClass(25,0));
console.log("\nDetail base 15 s:");
for (const fr of FRACTIONS12) {
  const ms = 15000*fr;
  console.log(`  clock ${(ms/1000).toFixed(2)}s  abs ${abs(ms).toFixed(4)}  rel ${rel(ms,15000).toFixed(4)}  binds ${abs(ms)>rel(ms,15000)?"ABS":abs(ms)<rel(ms,15000)?"rel":"tie"}`);
}
console.log("\nDetail base 20 s:");
for (const fr of FRACTIONS12) {
  const ms = 20000*fr;
  console.log(`  clock ${(ms/1000).toFixed(2)}s  abs ${abs(ms).toFixed(4)}  rel ${rel(ms,20000).toFixed(4)}  binds ${abs(ms)>rel(ms,20000)?"ABS":abs(ms)<rel(ms,20000)?"rel":"tie"}`);
}
console.log("\nDetail base 25 s:");
for (const fr of FRACTIONS12) {
  const ms = 25000*fr;
  console.log(`  clock ${(ms/1000).toFixed(2)}s  abs ${abs(ms).toFixed(4)}  rel ${rel(ms,25000).toFixed(4)}  binds ${abs(ms)>rel(ms,25000)?"ABS":abs(ms)<rel(ms,25000)?"rel":"tie"}`);
}
