// Controller dynamics: synthetic head, controllable bucket-0 mass. No ONNX.
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { createRng } from "@core/rng";
import { CHESSMIMIC_BUCKETS } from "@core/timing/chessmimic-buckets";
import { ChessMimicHead, type InferResult } from "@core/timing/chessmimic-head";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { computeFeatures } from "@core/timing/features";
import { TimingModel } from "@core/timing/timing-model";
import type { GameMeta, TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
const FAST = TIMING_CONSTANTS.chessmimic.fastMoveMaxS * 1000;
const MIDDLEGAME_FEN = "r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N1P/PP1P1PP1/RNBQR1K1 w - - 0 10";
function line(m: number, cp: number, ...pv: string[]) { return { multipv: m, score: { cp }, depth: 10, pvUci: pv, pvSan: [] }; }
function ctx(over: Partial<TimingContext> = {}): TimingContext {
  return { fen: MIDDLEGAME_FEN, ply: 40, moves: [], myColor: "w", chosenMove: "a2a4",
    lines: [line(1,20,"d2d4","e5d4"), line(2,10,"a2a4","b5a4"), line(3,-5,"b1a3"), line(4,-30,"h3h4")],
    evalBeforeOppMove: 25, expectedOppReply: null, myClockMs: 180000, oppClockMs: 180000,
    baseSec: 180, incSec: 0, oppThinkMsHistory: [3000,4000,2500], myThinkMsHistory: [],
    site: "chesscom", targetElo: 1650, profile: "balanced", engineReady: true,
    inputMethod: "drag", autoQueen: true, nowMs: 1000000, ...over } as TimingContext;
}
const nB = CHESSMIMIC_BUCKETS["1500_1600"].bucket_probabilities.length;
function probs(spec: Record<number, number>): number[] {
  const p = new Array(nB).fill(0); let used = 0;
  for (const [k, v] of Object.entries(spec)) { p[Number(k)] = v; used += v; }
  const rest = Math.max(0, 1 - used) / (nB - Object.keys(spec).length);
  for (let i = 0; i < nB; i++) if (!(i in spec)) p[i] = rest;
  return p;
}
function headWith(p: number[]) {
  const res: InferResult = { probs: p, band: "1500_1600" };
  return new ChessMimicHead({ infer: () => Promise.resolve(res), fallback: new V1ParametricHead() });
}
function lag1(xs: number[]) {
  const n = xs.length; const m = xs.reduce((a,b)=>a+b,0)/n;
  let num=0, den=0;
  for (let i=0;i<n-1;i++) num += (xs[i]!-m)*(xs[i+1]!-m);
  for (let i=0;i<n;i++) den += (xs[i]!-m)**2;
  return den>0 ? num/den : 0;
}
const G = 400, MOVES = 40;

for (const [label, spec] of [
  ["90% bucket0", {0: 0.9}],
  ["30% bucket0", {0: 0.3}],
  ["20% bucket0 50% bucket1", {0: 0.2, 1: 0.5}],
  ["5% bucket0", {0: 0.05}],
] as const) {
  const c = ctx();
  const f = computeFeatures(c);
  const m = new TimingModel(headWith(probs(spec as never)), DEFAULT_SETTINGS.timing, createRng("loop"));
  const meta: GameMeta = { targetElo: 1650, profile: "balanced", baseSec: 180, incSec: 0, site: "chesscom", gameId: "g" };
  const perMove: number[][] = Array.from({ length: MOVES }, () => []);
  const seqs: number[][] = [];
  for (let g = 0; g < G; g++) {
    m.startGame({ ...meta, gameId: `g${g}` });
    await m.prepare(c);
    const seq: number[] = [];
    for (let k = 0; k < MOVES; k++) {
      const plan = m.planMove(ctx({ nowMs: 1_000_000 + g*1e6 + k*1000 }));
      const fast = plan.thinkMs < FAST ? 1 : 0;
      perMove[k]!.push(fast); seq.push(fast);
    }
    seqs.push(seq);
  }
  const rates = perMove.map((a) => a.reduce((x,y)=>x+y,0)/a.length);
  const ac = seqs.map(lag1).filter(Number.isFinite);
  const acMean = ac.reduce((a,b)=>a+b,0)/ac.length;
  console.log(`\n--- ${label}, full 3+0 clock, budget ${(100*(1-1*(1-0.2129))).toFixed(1)}% ---`);
  console.log("fast rate by move index (1..40):");
  console.log("  " + rates.map((r,i)=>`${i+1}:${(100*r).toFixed(0)}`).join(" "));
  console.log(`  whole-game fast rate ${(100*rates.reduce((a,b)=>a+b,0)/MOVES).toFixed(1)} %   mean lag-1 autocorr of the fast/slow sequence ${acMean.toFixed(3)}`);
  // short games
  for (const L of [3, 6, 10, 20]) {
    const r = rates.slice(0, L).reduce((a,b)=>a+b,0)/L;
    console.log(`  first ${String(L).padStart(2)} moves only: fast rate ${(100*r).toFixed(1)} %`);
  }
}
