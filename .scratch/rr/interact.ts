import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { createRng } from "@core/rng";
import { CHESSMIMIC_BUCKETS } from "@core/timing/chessmimic-buckets";
import { ChessMimicHead, fastShareCap, type InferResult } from "@core/timing/chessmimic-head";
import { computeFeatures } from "@core/timing/features";
import { TimingModel } from "@core/timing/timing-model";
import type { GameMeta, TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
const MIDDLEGAME_FEN = "r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N1P/PP1P1PP1/RNBQR1K1 w - - 0 10";
function line(m:number,cp:number,...pv:string[]){return {multipv:m,score:{cp},depth:10,pvUci:pv,pvSan:[]};}
function ctx(over: Partial<TimingContext> = {}): TimingContext {
  return { fen: MIDDLEGAME_FEN, ply: 40, moves: [], myColor:"w", chosenMove:"a2a4",
    lines:[line(1,20,"d2d4","e5d4"),line(2,10,"a2a4","b5a4")],
    evalBeforeOppMove:25, expectedOppReply:null, myClockMs:180000, oppClockMs:180000,
    baseSec:180, incSec:0, oppThinkMsHistory:[3000,4000,2500], myThinkMsHistory:[],
    site:"chesscom", targetElo:1650, profile:"balanced", engineReady:true,
    inputMethod:"drag", autoQueen:true, nowMs:1000000, ...over } as TimingContext;
}
const nB = CHESSMIMIC_BUCKETS["1500_1600"].bucket_probabilities.length;
function probs(b0:number){const p=new Array(nB).fill(0);p[0]=b0;p[5]=1-b0;return p;}
function headWith(p:number[]){const r:InferResult={probs:p,band:"1500_1600"};
  return new ChessMimicHead({infer:()=>Promise.resolve(r),fallback:new V1ParametricHead()});}
const N = 20000;
console.log("b0mass  clock   budget  gameLen   instant%   addedFast-rate   ratio-to-budget");
for (const [b0, clockS] of [[0.9,180],[0.5,180],[0.25,180],[0.18,180],[0.9,18]] as const) {
  const c = ctx({ myClockMs: clockS*1000, oppClockMs: clockS*1000 });
  const cap = fastShareCap(computeFeatures(c), "1500_1600");
  for (const L of [1,3,6,12,40,200]) {
    const m = new TimingModel(headWith(probs(b0)), DEFAULT_SETTINGS.timing, createRng(`ix-${b0}-${L}`));
    const meta: GameMeta = {targetElo:1650,profile:"balanced",baseSec:180,incSec:0,site:"chesscom",gameId:"g"};
    let inst=0;
    for (let i=0;i<N;i++){ if(i%L===0){m.startGame({...meta,gameId:`g${i}`}); await m.prepare(c);} 
      const p=m.planMove(ctx({myClockMs:clockS*1000,oppClockMs:clockS*1000,nowMs:1_000_000+i}));
      if (p.mode==="instant") inst++; }
    console.log(`${b0.toFixed(2)}    ${String(clockS).padStart(4)}  ${(100*cap).toFixed(1).padStart(6)} ${String(L).padStart(8)} ${(100*inst/N).toFixed(1).padStart(10)}   ${"".padStart(14)}   x${(inst/N/cap).toFixed(3)}`);
  }
}
