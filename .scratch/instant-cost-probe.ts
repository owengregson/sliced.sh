// What an `instant` plan actually costs the page, and what a bucket-1 (1-2 s) draw costs.
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { createRng } from "@core/rng";
import { ChessMimicHead } from "@core/timing/chessmimic-head";
import { TimingModel } from "@core/timing/timing-model";
import type { GameMeta, TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";

const MIDDLEGAME_FEN = "r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N1P/PP1P1PP1/RNBQR1K1 w - - 0 10";
function line(m: number, cp: number, ...pv: string[]) { return { multipv: m, score: { cp }, depth: 10, pvUci: pv, pvSan: [] }; }
function baseCtx(over: Partial<TimingContext> = {}): TimingContext {
	return { fen: MIDDLEGAME_FEN, ply: 40, moves: [], myColor: "w", chosenMove: "a2a4",
		lines: [line(1,20,"d2d4","e5d4"), line(2,10,"a2a4","b5a4"), line(3,-5,"b1a3"), line(4,-30,"h3h4")],
		evalBeforeOppMove: 25, expectedOppReply: null, myClockMs: 180000, oppClockMs: 180000,
		baseSec: 180, incSec: 0, oppThinkMsHistory: [3000,4000,2500], myThinkMsHistory: [],
		site: "chesscom", targetElo: 1650, profile: "balanced", engineReady: true,
		inputMethod: "drag", autoQueen: true, nowMs: 1000000, ...over } as TimingContext;
}
function headWith(probs: number[]) {
	return new ChessMimicHead({ infer: () => Promise.resolve({ probs, band: "1500_1600" }), fallback: new V1ParametricHead() });
}
function q(s: number[], p: number) { return s[Math.min(s.length-1, Math.floor(p*s.length))] ?? NaN; }
const N = 20000;
for (const [lbl, probs] of [
	["90% b0 / 10% b5", (() => { const p = new Array(30).fill(0); p[0]=0.9; p[5]=0.1; return p; })()],
	["100% b1 (1-2 s)", (() => { const p = new Array(30).fill(0); p[1]=1; return p; })()],
	["100% b2 (2-3 s)", (() => { const p = new Array(30).fill(0); p[2]=1; return p; })()],
] as const) {
	const m = new TimingModel(headWith([...probs]), DEFAULT_SETTINGS.timing, createRng("ic"));
	const meta: GameMeta = { targetElo: 1650, profile: "balanced", baseSec: 180, incSec: 0, site: "chesscom", gameId: "g" };
	const c = baseCtx();
	const inst: number[] = []; const other: number[] = [];
	for (let i = 0; i < N; i++) {
		if (i % 40 === 0) { m.startGame({ ...meta, gameId: `g${i}` }); await m.prepare(c); }
		const p = m.planMove(c);
		(p.mode === "instant" ? inst : other).push(p.thinkMs);
	}
	inst.sort((a,b)=>a-b); other.sort((a,b)=>a-b);
	if (inst.length) console.log(`${lbl} INSTANT n=${inst.length}: min ${inst[0]?.toFixed(0)} p10 ${q(inst,0.1).toFixed(0)} p50 ${q(inst,0.5).toFixed(0)} p90 ${q(inst,0.9).toFixed(0)} max ${inst[inst.length-1]?.toFixed(0)}  | frac<1000ms ${(100*inst.filter(x=>x<1000).length/inst.length).toFixed(1)}% frac<2000ms ${(100*inst.filter(x=>x<2000).length/inst.length).toFixed(1)}%`);
	if (other.length) console.log(`${lbl} OTHER   n=${other.length}: min ${other[0]?.toFixed(0)} p10 ${q(other,0.1).toFixed(0)} p50 ${q(other,0.5).toFixed(0)} p90 ${q(other,0.9).toFixed(0)}  | frac<2000ms ${(100*other.filter(x=>x<2000).length/other.length).toFixed(1)}%`);
}
