// Never-slower sweep: real ONNX, plan level, 40-move games. Runs unchanged on pre-lane and tip.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { MODELS_DIR } from "@core/constants/models";
import { createRng } from "@core/rng";
import { ChessMimicHead } from "@core/timing/chessmimic-head";
import { computeFeatures } from "@core/timing/features";
import { TimingModel } from "@core/timing/timing-model";
import type { GameMeta, TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { createOrtRuntime } from "@offscreen/ort-loader";
import { createTimingInference } from "@offscreen/timing-inference";

const ROOT = path.resolve(import.meta.dir, "..");
const MIDDLEGAME_FEN = "r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N1P/PP1P1PP1/RNBQR1K1 w - - 0 10";
const inference = createTimingInference({
  runtime: () => createOrtRuntime({ importModule: (u: string) => import(u), getUrl: (p: string) => pathToFileURL(path.join(ROOT, p)).href, threads: 1 }),
  store: { get: async (n: string) => new Uint8Array(await Bun.file(path.join(ROOT, MODELS_DIR, n)).arrayBuffer()) },
});
let qid = 0;
const infer = async (inputs: Record<string, unknown>) => {
  const r = await inference.handle({ kind: "timing", id: `q${qid++}`, inputs } as never);
  return r.probs ? { probs: r.probs as number[], band: (r as { band: string }).band } : null;
};
function line(m: number, cp: number, ...pv: string[]) { return { multipv: m, score: { cp }, depth: 10, pvUci: pv, pvSan: [] }; }
const HIST = ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f8e7","f1e1","b7b5","a4b3","d7d6","c2c3","e8g8"];
function baseCtx(over: Partial<TimingContext> = {}): TimingContext {
  return { fen: MIDDLEGAME_FEN, ply: 40, moves: [], myColor: "w", chosenMove: "d2d4",
    lines: [line(1,20,"d2d4","e5d4"), line(2,10,"a2a4","b5a4"), line(3,-5,"b1a3"), line(4,-30,"h3h4")],
    evalBeforeOppMove: 25, expectedOppReply: null, myClockMs: 180000, oppClockMs: 180000,
    baseSec: 180, incSec: 0, oppThinkMsHistory: [3000,4000,2500], myThinkMsHistory: [],
    site: "chesscom", targetElo: 1650, profile: "balanced", engineReady: true,
    inputMethod: "drag", autoQueen: true, nowMs: 1000000, ...over } as TimingContext;
}
const N = Number(process.env.N ?? 2000);
function gmean(xs: number[]) { let s = 0; for (const x of xs) s += Math.log(Math.max(1e-9, x)); return Math.exp(s / xs.length); }
function pct(xs: number[], q: number) { const s=[...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(q*s.length))] ?? 0; }

console.log("cell                               inbook  inst%  prem%  sub2s%   p50    gmean");
for (const [speed, baseSec] of [["1+0",60],["3+0",180],["10+0",600]] as const)
for (const frac of [1.0, 0.8, 0.5, 1/3, 1/6] as const)
for (const [pos, ply, chosen] of [["book",8,"d2d4"],["book",12,"d2d4"],["off",14,"a2a4"],["off",40,"a2a4"]] as const) {
  const clockS = baseSec * frac;
  const c = baseCtx({ baseSec, myClockMs: clockS*1000, oppClockMs: clockS*1000, ply, chosenMove: chosen, moves: HIST.slice(0, Math.min(ply, HIST.length)) });
  const f = computeFeatures(c);
  const m = new TimingModel(new ChessMimicHead({ infer: infer as never, fallback: new V1ParametricHead(), budgetMs: 600000 }), DEFAULT_SETTINGS.timing, createRng(`sw-${speed}-${frac}-${pos}-${ply}`));
  const meta: GameMeta = { targetElo: 1650, profile: "balanced", baseSec, incSec: 0, site: "chesscom", gameId: "g" };
  let inst=0, prem=0, sub2=0; const ts: number[] = [];
  for (let i=0;i<N;i++) {
    if (i % 40 === 0) { m.startGame({ ...meta, gameId: `g${i}` }); await m.prepare(c); }
    const plan = m.planMove(c);
    if (plan.mode === "instant") inst++; else if (plan.mode === "premove") prem++;
    if (plan.thinkMs < 2000) sub2++;
    ts.push(plan.thinkMs);
  }
  const lbl = `${speed} f=${frac.toFixed(2)} ${pos}${ply}`;
  console.log(`${lbl.padEnd(34)} ${String(f.in_book).padStart(4)} ${(100*inst/N).toFixed(1).padStart(6)} ${(100*prem/N).toFixed(1).padStart(6)} ${(100*sub2/N).toFixed(1).padStart(7)} ${pct(ts,0.5).toFixed(0).padStart(6)} ${gmean(ts).toFixed(0).padStart(7)}`);
}
