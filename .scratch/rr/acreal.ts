// Real ONNX, realistic draining trajectory: raw / detrended / binary lag-1 of per-move think time.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { MODELS_DIR } from "@core/constants/models";
import { createRng } from "@core/rng";
import { ChessMimicHead } from "@core/timing/chessmimic-head";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { TimingModel } from "@core/timing/timing-model";
import type { GameMeta, TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { createOrtRuntime } from "@offscreen/ort-loader";
import { createTimingInference } from "@offscreen/timing-inference";
const ROOT = path.resolve(import.meta.dir, "..");
const FASTMS = TIMING_CONSTANTS.chessmimic.fastMoveMaxS * 1000;
const MIDDLEGAME_FEN = "r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N1P/PP1P1PP1/RNBQR1K1 w - - 0 10";
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const inference = createTimingInference({
  runtime: () => createOrtRuntime({ importModule: (u: string) => import(u), getUrl: (p: string) => pathToFileURL(path.join(ROOT, p)).href, threads: 1 }),
  store: { get: async (n: string) => new Uint8Array(await Bun.file(path.join(ROOT, MODELS_DIR, n)).arrayBuffer()) },
});
let qid = 0;
const infer = async (inputs: Record<string, unknown>) => {
  const r = await inference.handle({ kind: "timing", id: `q${qid++}`, inputs } as never);
  return r.probs ? { probs: r.probs as number[], band: (r as { band: string }).band } : null;
};
function line(m:number,cp:number,...pv:string[]){return {multipv:m,score:{cp},depth:10,pvUci:pv,pvSan:[]};}
const HIST = ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f8e7","f1e1","b7b5","a4b3","d7d6","c2c3","e8g8"];
function ctxFor(ply:number, baseSec:number, clockS:number, nowMs:number): TimingContext {
  const inBook = ply < 16;
  return { fen: inBook && ply < 4 ? START_FEN : MIDDLEGAME_FEN, ply, moves: HIST.slice(0, ply), myColor:"w",
    chosenMove: inBook ? "d2d4" : "a2a4",
    lines:[line(1,20,"d2d4","e5d4"),line(2,10,"a2a4","b5a4"),line(3,-5,"b1a3"),line(4,-30,"h3h4")],
    evalBeforeOppMove:25, expectedOppReply:null, myClockMs:clockS*1000, oppClockMs:clockS*1000,
    baseSec, incSec:0, oppThinkMsHistory:[3000,4000,2500], myThinkMsHistory:[],
    site:"chesscom", targetElo:1650, profile:"balanced", engineReady:true,
    inputMethod:"drag", autoQueen:true, nowMs } as TimingContext;
}
function lag1(xs:number[]){const n=xs.length;if(n<3)return NaN;const m=xs.reduce((a,b)=>a+b,0)/n;
  let num=0,den=0;for(let i=0;i<n-1;i++)num+=(xs[i]!-m)*(xs[i+1]!-m);for(let i=0;i<n;i++)den+=(xs[i]!-m)**2;return den>0?num/den:NaN;}
function mean(xs:number[]){return xs.reduce((a,b)=>a+b,0)/xs.length;}
function se(xs:number[]){const m=mean(xs);return Math.sqrt(xs.reduce((a,b)=>a+(b-m)**2,0)/(xs.length-1)/xs.length);}
const G = Number(process.env.G ?? 150), MOVES = 40;
console.log("speed  moves  raw lag-1        detrended lag-1   binary lag-1      per-move fast %(1..16)");
for (const [speed, baseSec] of [["1+0",60],["3+0",180],["10+0",600]] as const) {
  const m = new TimingModel(new ChessMimicHead({ infer: infer as never, fallback: new V1ParametricHead(), budgetMs: 600000 }), DEFAULT_SETTINGS.timing, createRng(`acr-${speed}`));
  const meta: GameMeta = { targetElo:1650, profile:"balanced", baseSec, incSec:0, site:"chesscom", gameId:"g" };
  const games:number[][]=[]; const fastSeq:number[][]=[];
  for (let g=0; g<G; g++) {
    m.startGame({...meta, gameId:`${speed}-g${g}`});
    const t:number[]=[]; const fs:number[]=[];
    for (let k=0;k<MOVES;k++) {
      const clockS = baseSec*(1-0.95*k/(MOVES-1));
      const c = ctxFor(2*k, baseSec, clockS, 1_000_000+g*1e6+k*1000);
      await m.prepare(c); const plan = m.planMove(c);
      t.push(Math.log(plan.thinkMs)); fs.push(plan.thinkMs<FASTMS?1:0);
    }
    games.push(t); fastSeq.push(fs);
  }
  const plyMean = Array.from({length:MOVES},(_,k)=>mean(games.map(g=>g[k]!)));
  const raw = games.map(lag1).filter(Number.isFinite);
  const det = games.map(g=>lag1(g.map((v,k)=>v-plyMean[k]!))).filter(Number.isFinite);
  const bin = fastSeq.map(lag1).filter(Number.isFinite);
  const prof = Array.from({length:MOVES},(_,k)=>mean(fastSeq.map(g=>g[k]!)));
  console.log(`${speed.padEnd(6)} ${String(G*MOVES).padStart(5)}  ${mean(raw).toFixed(4)} +-${se(raw).toFixed(4)}  ${mean(det).toFixed(4)} +-${se(det).toFixed(4)}  ${mean(bin).toFixed(4)} +-${se(bin).toFixed(4)}  ${prof.slice(0,16).map(r=>(100*r).toFixed(0).padStart(3)).join("")}`);
}
