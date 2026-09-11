// Is the "first move of a game is always allowed" property still true at round 6?
// Off-book first plan of a fresh game vs in-book, 90% bucket-0 fixture.
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { createRng } from "@core/rng";
import { CHESSMIMIC_BUCKETS } from "@core/timing/chessmimic-buckets";
import { ChessMimicHead, fastShareCap, type InferResult } from "@core/timing/chessmimic-head";
import { computeFeatures } from "@core/timing/features";
import { TimingModel } from "@core/timing/timing-model";
import type { GameMeta, TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
const OPENING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const MIDDLEGAME_FEN = "r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N1P/PP1P1PP1/RNBQR1K1 w - - 0 10";
function line(m:number,cp:number,...pv:string[]){return {multipv:m,score:{cp},depth:10,pvUci:pv,pvSan:[]};}
const nB = CHESSMIMIC_BUCKETS["1500_1600"].bucket_probabilities.length;
const P = new Array(nB).fill(0); P[0]=0.9; P[5]=0.1;
function headWith(){ const r: InferResult = {probs:P, band:"1500_1600"};
  return new ChessMimicHead({ infer: () => Promise.resolve(r), fallback: new V1ParametricHead() }); }
function ctx(over: Partial<TimingContext> = {}): TimingContext {
  return { fen: MIDDLEGAME_FEN, ply: 40, moves: [], myColor:"w", chosenMove:"a2a4",
    lines:[line(1,20,"d2d4","e5d4"),line(2,10,"a2a4","b5a4")],
    evalBeforeOppMove:25, expectedOppReply:null, myClockMs:180000, oppClockMs:180000,
    baseSec:180, incSec:0, oppThinkMsHistory:[3000,4000,2500], myThinkMsHistory:[],
    site:"chesscom", targetElo:1650, profile:"balanced", engineReady:true,
    inputMethod:"drag", autoQueen:true, nowMs:1000000, ...over } as TimingContext;
}
const N = 3000;
console.log("case                                    in_book elig  cap    FIRST-plan fast%  (40-move game fast%)");
for (const [lbl, over] of [
  ["ply 0, in book (1.e4)", { fen: OPENING_FEN, ply: 0, moves: [] as string[], chosenMove: "d2d4" }],
  ["ply 0, OFF book (2nd line)", { fen: OPENING_FEN, ply: 0, moves: [] as string[], chosenMove: "a2a4" }],
  ["ply 40 middlegame, off book", {}],
  ["ply 20 off book (joined mid-game)", { ply: 20, moves: [] as string[], chosenMove: "a2a4" }],
] as const) {
  const c = ctx(over as Partial<TimingContext>);
  const f = computeFeatures(c);
  const cap = fastShareCap(f, "1500_1600");
  // first plan of a fresh game, every time
  let fast1 = 0;
  const m1 = new TimingModel(headWith(), DEFAULT_SETTINGS.timing, createRng("fm1"));
  const meta: GameMeta = { targetElo:1650, profile:"balanced", baseSec:180, incSec:0, site:"chesscom", gameId:"g" };
  for (let i=0;i<N;i++){ m1.startGame({...meta, gameId:`g${i}`}); await m1.prepare(c);
    const p = m1.planMove(ctx({...(over as Partial<TimingContext>), nowMs:1_000_000+i}));
    if (p.mode==="instant"||p.mode==="premove") fast1++; }
  // 40-move games for contrast
  let fast40 = 0;
  const m2 = new TimingModel(headWith(), DEFAULT_SETTINGS.timing, createRng("fm2"));
  for (let i=0;i<N;i++){ if (i%40===0){ m2.startGame({...meta, gameId:`h${i}`}); await m2.prepare(c); }
    const p = m2.planMove(ctx({...(over as Partial<TimingContext>), nowMs:1_000_000+i}));
    if (p.mode==="instant"||p.mode==="premove") fast40++; }
  console.log(`${lbl.padEnd(38)} ${String(f.in_book).padStart(5)} ${String(f.premove_eligible).padStart(5)} ${(100*cap).toFixed(1).padStart(6)} ${(100*fast1/N).toFixed(1).padStart(16)}  ${(100*fast40/N).toFixed(1).padStart(8)}`);
}
