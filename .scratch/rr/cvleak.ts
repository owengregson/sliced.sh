// Does the CV-guard redraw loop still leak past the bound? Game length 6/12/40/200, 90% bucket-0.
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { createRng } from "@core/rng";
import { CHESSMIMIC_BUCKETS } from "@core/timing/chessmimic-buckets";
import { ChessMimicHead, type InferResult } from "@core/timing/chessmimic-head";
import { computeFeatures } from "@core/timing/features";
import { TimingModel } from "@core/timing/timing-model";
import { urgencyFactor } from "@core/timing/pressure";
import type { GameMeta, TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
const MIDDLEGAME_FEN = "r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N1P/PP1P1PP1/RNBQR1K1 w - - 0 10";
function line(m:number,cp:number,...pv:string[]){return {multipv:m,score:{cp},depth:10,pvUci:pv,pvSan:[]};}
function ctx(over: Partial<TimingContext> = {}): TimingContext {
  return { fen: MIDDLEGAME_FEN, ply: 40, moves: [], myColor: "w", chosenMove: "a2a4",
    lines:[line(1,20,"d2d4","e5d4"),line(2,10,"a2a4","b5a4"),line(3,-5,"b1a3"),line(4,-30,"h3h4")],
    evalBeforeOppMove:25, expectedOppReply:null, myClockMs:180000, oppClockMs:180000,
    baseSec:180, incSec:0, oppThinkMsHistory:[3000,4000,2500], myThinkMsHistory:[],
    site:"chesscom", targetElo:1650, profile:"balanced", engineReady:true,
    inputMethod:"drag", autoQueen:true, nowMs:1000000, ...over } as TimingContext;
}
const nB = CHESSMIMIC_BUCKETS["1500_1600"].bucket_probabilities.length;
const p = new Array(nB).fill(0.1/(nB-1)); p[0] = 0.9;
const res: InferResult = { probs: p, band: "1500_1600" };
const c = ctx(); const f = computeFeatures(c);
const hs = (1500 && CHESSMIMIC_BUCKETS["1500_1600"].bucket_probabilities);
const human = (hs[0] ?? 0) + (hs[1] ?? 0);
const cap = 1 - urgencyFactor(f) * (1 - human);
console.log(`budget at this cell = ${(100*cap).toFixed(1)} %   (humanFastShare ${(100*human).toFixed(2)} %)`);
console.log("gameLen  plans   instant%  sub2s%   ratio to budget");
for (const L of [1, 3, 6, 12, 40, 200]) {
  const m = new TimingModel(new ChessMimicHead({ infer: () => Promise.resolve(res), fallback: new V1ParametricHead() }), DEFAULT_SETTINGS.timing, createRng("cv"));
  const meta: GameMeta = { targetElo: 1650, profile: "balanced", baseSec: 180, incSec: 0, site: "chesscom", gameId: "g" };
  const N = 20000; let inst=0, sub2=0;
  for (let i=0;i<N;i++){ if (i % L === 0) { m.startGame({...meta, gameId:`g${i}`}); await m.prepare(c); }
    const plan = m.planMove(ctx({ nowMs: 1_000_000 + i*1000 }));
    if (plan.mode==="instant") inst++; if (plan.thinkMs<2000) sub2++; }
  console.log(`${String(L).padStart(7)} ${String(N).padStart(6)} ${(100*inst/N).toFixed(1).padStart(9)} ${(100*sub2/N).toFixed(1).padStart(7)}   x${(sub2/N/cap).toFixed(2)}`);
}
