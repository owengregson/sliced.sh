// Does the lane's detrending (subtract the cross-game mean at the same ply index) survive a
// PHASE-LOCKED limit cycle? Synthetic head, no ONNX. Also prints the per-move-index fast profile.
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { createRng } from "@core/rng";
import { CHESSMIMIC_BUCKETS } from "@core/timing/chessmimic-buckets";
import { ChessMimicHead, type InferResult } from "@core/timing/chessmimic-head";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { TimingModel } from "@core/timing/timing-model";
import type { GameMeta, TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
const FASTMS = TIMING_CONSTANTS.chessmimic.fastMoveMaxS * 1000;
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
function probs(b0: number): number[] { const p = new Array(nB).fill((1-b0)/(nB-1)); p[0]=b0; return p; }
function headWith(p:number[]) { const res: InferResult = { probs: p, band: "1500_1600" };
  return new ChessMimicHead({ infer: () => Promise.resolve(res), fallback: new V1ParametricHead() }); }
function lag1(xs: number[]) { const n=xs.length; if(n<3) return NaN; const m=xs.reduce((a,b)=>a+b,0)/n;
  let num=0,den=0; for(let i=0;i<n-1;i++) num+=(xs[i]!-m)*(xs[i+1]!-m); for(let i=0;i<n;i++) den+=(xs[i]!-m)**2;
  return den>0?num/den:NaN; }
function mean(xs:number[]){return xs.reduce((a,b)=>a+b,0)/xs.length;}
function se(xs:number[]){const m=mean(xs);return Math.sqrt(xs.reduce((a,b)=>a+(b-m)**2,0)/(xs.length-1)/xs.length);}
const G = Number(process.env.G ?? 400), MOVES = 40;
const DRAIN = process.env.DRAIN === "1";

for (const b0 of [0.9, 0.5, 0.3]) {
  const m = new TimingModel(headWith(probs(b0)), DEFAULT_SETTINGS.timing, createRng(`ac-${b0}`));
  const meta: GameMeta = { targetElo:1650, profile:"balanced", baseSec:180, incSec:0, site:"chesscom", gameId:"g" };
  const games: number[][] = []; const fastSeq: number[][] = [];
  for (let g=0; g<G; g++) {
    m.startGame({...meta, gameId:`g${g}`});
    const t: number[] = []; const fs: number[] = [];
    for (let k=0;k<MOVES;k++) {
      const clockS = DRAIN ? 180*(1-0.95*k/(MOVES-1)) : 180;
      const c = ctx({ myClockMs: clockS*1000, oppClockMs: clockS*1000, nowMs: 1_000_000+g*1e6+k*1000 });
      await m.prepare(c);
      const plan = m.planMove(c);
      t.push(Math.log(plan.thinkMs)); fs.push(plan.thinkMs<FASTMS?1:0);
    }
    games.push(t); fastSeq.push(fs);
  }
  // cross-game mean at each ply index
  const plyMean = Array.from({length:MOVES},(_,k)=>mean(games.map(g=>g[k]!)));
  const raw = games.map(lag1).filter(Number.isFinite);
  const det = games.map(g=>lag1(g.map((v,k)=>v-plyMean[k]!))).filter(Number.isFinite);
  const bin = fastSeq.map(lag1).filter(Number.isFinite);
  const prof = Array.from({length:MOVES},(_,k)=>mean(fastSeq.map(g=>g[k]!)));
  console.log(`\n--- bucket0 mass ${b0}, clock ${DRAIN?"draining":"fixed full"}, G=${G} ---`);
  console.log(`raw lag-1       ${mean(raw).toFixed(4)} +- ${se(raw).toFixed(4)}`);
  console.log(`DETRENDED lag-1 ${mean(det).toFixed(4)} +- ${se(det).toFixed(4)}`);
  console.log(`binary lag-1    ${mean(bin).toFixed(4)} +- ${se(bin).toFixed(4)}`);
  console.log(`per-move-index fast rate: ${prof.slice(0,20).map(r=>(100*r).toFixed(0).padStart(3)).join("")}`);
}
