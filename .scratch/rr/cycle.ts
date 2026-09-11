// Real ONNX: per-move-index fast rate and lag-1 autocorrelation of the fast/slow sequence.
// Fixed position per cell, so one inference per game (planMove reuses the prepared draw).
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { MODELS_DIR } from "@core/constants/models";
import { createRng } from "@core/rng";
import { ChessMimicHead } from "@core/timing/chessmimic-head";
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
const HIST = ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f8e7","f1e1","b7b5"];
function ctx(over: Partial<TimingContext> = {}): TimingContext {
  return { fen: MIDDLEGAME_FEN, ply: 40, moves: [...HIST], myColor: "w", chosenMove: "a2a4",
    lines: [line(1,20,"d2d4","e5d4"), line(2,10,"a2a4","b5a4"), line(3,-5,"b1a3"), line(4,-30,"h3h4")],
    evalBeforeOppMove: 25, expectedOppReply: null, myClockMs: 180000, oppClockMs: 180000,
    baseSec: 180, incSec: 0, oppThinkMsHistory: [3000,4000,2500], myThinkMsHistory: [],
    site: "chesscom", targetElo: 1650, profile: "balanced", engineReady: true,
    inputMethod: "drag", autoQueen: true, nowMs: 1000000, ...over } as TimingContext;
}
function lag1(xs: number[]) { const n=xs.length, m=xs.reduce((a,b)=>a+b,0)/n; let num=0,den=0;
  for (let i=0;i<n-1;i++) num+=(xs[i]!-m)*(xs[i+1]!-m); for (let i=0;i<n;i++) den+=(xs[i]!-m)**2; return den>0?num/den:0; }
const G = Number(process.env.G ?? 400), MOVES = 40;
console.log("cell                          fast%  lag1-AC   per-move-index fast rate (%)");
for (const [speed, baseSec] of [["1+0",60],["3+0",180],["10+0",600]] as const)
for (const frac of [1.0, 0.5, 1/3] as const)
for (const [pos, ply, chosen] of [["book",8,"d2d4"],["off",40,"a2a4"]] as const) {
  const clockS = baseSec*frac;
  const c = ctx({ baseSec, myClockMs: clockS*1000, oppClockMs: clockS*1000, ply, chosenMove: chosen, moves: HIST.slice(0, Math.min(ply, HIST.length)) });
  const m = new TimingModel(new ChessMimicHead({ infer: infer as never, fallback: new V1ParametricHead(), budgetMs: 600000 }), DEFAULT_SETTINGS.timing, createRng(`cy-${speed}-${frac}-${pos}`));
  const meta: GameMeta = { targetElo: 1650, profile: "balanced", baseSec, incSec: 0, site: "chesscom", gameId: "g" };
  const perMove: number[][] = Array.from({length:MOVES},()=>[]); const acs: number[] = [];
  for (let g=0; g<G; g++) {
    m.startGame({ ...meta, gameId: `g${g}` }); await m.prepare(c);
    const seq: number[] = [];
    for (let k=0;k<MOVES;k++) { const plan = m.planMove(ctx({ ...c, nowMs: 1_000_000+g*1e6+k*1000 })); const f = plan.thinkMs<2000?1:0; perMove[k]!.push(f); seq.push(f); }
    const a = lag1(seq); if (Number.isFinite(a)) acs.push(a);
  }
  const rates = perMove.map(a=>a.reduce((x,y)=>x+y,0)/a.length);
  const overall = rates.reduce((a,b)=>a+b,0)/MOVES;
  const ac = acs.reduce((a,b)=>a+b,0)/Math.max(1,acs.length);
  console.log(`${`${speed} f=${frac.toFixed(2)} ${pos}${ply}`.padEnd(28)} ${(100*overall).toFixed(1).padStart(5)} ${ac.toFixed(3).padStart(8)}   ${rates.slice(0,16).map(r=>(100*r).toFixed(0).padStart(3)).join("")}`);
}
