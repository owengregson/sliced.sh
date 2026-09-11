// Residual: a ponder hit with NO armed premove still yields an unphysical cold-start flick.
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { createRng, type Rng } from "@core/rng";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { computeFeatures } from "@core/timing/features";
import { TimingModel } from "@core/timing/timing-model";
import type { DistributionHead, Features, GameMeta, GameTimingState, HeadSample, Persona, TimingContext } from "@core/timing/types";
const MIDDLEGAME_FEN = "r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N1P/PP1P1PP1/RNBQR1K1 w - - 0 10";
function line(m:number,cp:number,...pv:string[]){return {multipv:m,score:{cp},depth:10,pvUci:pv,pvSan:[]};}
class AlwaysPremove implements DistributionHead {
  readonly id = "chessmimic" as const;
  median(){return TIMING_CONSTANTS.premove.maxS;}
  sample(_f:Features,_p:Persona,_st:GameTimingState,rng:Rng):HeadSample{return {tSec: rng.next()*TIMING_CONSTANTS.premove.maxS, mode:"premove", why:[]};}
}
function ctx(over: Partial<TimingContext> = {}): TimingContext {
  return { fen: MIDDLEGAME_FEN, ply: 24, moves: ["e2e4","e7e5","g1f3","b8c6"], myColor: "w", chosenMove: "a2a4",
    lines:[line(1,20,"d2d4","e5d4"),line(2,10,"a2a4","b5a4")],
    evalBeforeOppMove:25, expectedOppReply:"b8c6", myClockMs:120000, oppClockMs:120000,
    baseSec:180, incSec:0, oppThinkMsHistory:[3000,4000,2500], myThinkMsHistory:[1200],
    site:"chesscom", targetElo:1650, profile:"balanced", engineReady:true,
    inputMethod:"drag", autoQueen:true, nowMs:1000000, ...over } as TimingContext;
}
const c = ctx();
const f = computeFeatures(c);
console.log("ponder_hit =", f.ponder_hit, " premove_eligible =", f.premove_eligible);
const m = new TimingModel(new AlwaysPremove(), DEFAULT_SETTINGS.timing, createRng("ph"));
m.startGame({ targetElo:1650, profile:"balanced", baseSec:180, incSec:0, site:"chesscom", gameId:"g" } as GameMeta);
let prem=0; const ts:number[]=[]; const ap:number[]=[]; const or:number[]=[];
for (let i=0;i<500;i++){ const p = m.planMove(ctx({ nowMs: 1_000_000+i })); if (p.mode==="premove") prem++; ts.push(p.thinkMs); ap.push(p.window.approachMs); or.push(p.orientationMs); }
const s=[...ts].sort((a,b)=>a-b);
console.log(`premove mode in ${prem}/500 plans`);
console.log(`thinkMs     min ${s[0]!.toFixed(0)}  p50 ${s[250]!.toFixed(0)}  max ${s[499]!.toFixed(0)}`);
console.log(`approachMs  min ${Math.min(...ap).toFixed(0)}  max ${Math.max(...ap).toFixed(0)}`);
console.log(`orientationMs max ${Math.max(...or).toFixed(0)}`);
console.log(`brief's hand floor: orientation.minMs ${TIMING_CONSTANTS.orientation.minMs} + motor.minMotorMs ${TIMING_CONSTANTS.motor.minMotorMs} = ${TIMING_CONSTANTS.orientation.minMs+TIMING_CONSTANTS.motor.minMotorMs} ms`);
