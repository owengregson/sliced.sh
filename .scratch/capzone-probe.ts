// Targeted paired scan of the hard-cap regime, where boundByCap's `cap · U(0.75,1)` can make the
// post-lane (smaller) input land ABOVE the pre-lane capped value.
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { createRng, type Rng } from "@core/rng";
import { TimingModel } from "@core/timing/timing-model";
import type { DistributionHead, Features, GameMeta, GameTimingState, HeadSample, Persona, TimingContext } from "@core/timing/types";
const MIDDLEGAME_FEN = "r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N1P/PP1P1PP1/RNBQR1K1 w - - 0 10";
class Blind implements DistributionHead {
	readonly id = "chessmimic" as const;
	constructor(private readonly medianS: number, private readonly sigma: number) {}
	median(): number { return this.medianS; }
	sample(_f: Features, _p: Persona, _st: GameTimingState, rng: Rng): HeadSample {
		return { tSec: this.medianS * Math.exp(this.sigma * rng.normal()), mode: "normal", why: [] };
	}
}
function line(m: number, cp: number, ...pv: string[]) { return { multipv: m, score: { cp }, depth: 10, pvUci: pv, pvSan: [] }; }
function baseCtx(o: Partial<TimingContext> = {}): TimingContext {
	return { fen: MIDDLEGAME_FEN, ply: 40, moves: [], myColor: "w", chosenMove: "d2d4",
		lines: [line(1,20,"d2d4","e5d4"), line(2,10,"a2a4","b5a4"), line(3,-5,"b1a3"), line(4,-30,"h3h4")],
		evalBeforeOppMove: 25, expectedOppReply: null, myClockMs: 180000, oppClockMs: 180000,
		baseSec: 180, incSec: 0, oppThinkMsHistory: [3000,4000,2500], myThinkMsHistory: [],
		site: "chesscom", targetElo: 1650, profile: "balanced", engineReady: true,
		inputMethod: "drag", autoQueen: true, nowMs: 1000000, ...o } as TimingContext;
}
const N = Number(process.env.N ?? 4000);
const out: Record<string, { gmean: number; p50: number; mean: number }> = {};
const CASES: Array<[string, number, number, number[]]> = [
	// name, baseSec, head medianS, clocks (the cap-binding band + the low tail)
	["1+0", 60, 2, [35, 34, 33, 32, 31, 30, 29, 28, 27, 25, 22, 20, 15, 10, 7, 5, 3, 2, 1.5, 1]],
	["3+0", 180, 4, [180, 140, 120, 105, 90, 70, 60, 45, 36, 30, 25, 20, 15, 12, 10, 7, 5, 3, 2, 1.5]],
	["10+0", 600, 8, [600, 420, 350, 300, 240, 180, 120, 90, 60, 45, 36, 30, 25, 20, 15, 10, 5, 3, 2, 1.5]],
];
for (const [name, baseSec, medianS, clocks] of CASES)
	for (const clockS of clocks)
		for (const [pn, ply] of [["mid", 40], ["open", 6], ["end", 70]] as const) {
			const m = new TimingModel(new Blind(medianS, 0.9), DEFAULT_SETTINGS.timing, createRng(`cz-${name}-${clockS}-${ply}`));
			const meta: GameMeta = { targetElo: 1650, profile: "balanced", baseSec, incSec: 0, site: "chesscom", gameId: "g" };
			const c = baseCtx({ baseSec, ply, myClockMs: clockS * 1000, oppClockMs: clockS * 1000 });
			const ts: number[] = [];
			for (let k = 0; k < N; k++) { if (k % 40 === 0) m.startGame({ ...meta, gameId: `g-${clockS}-${ply}-${k}` }); ts.push(m.planMove(c).thinkMs); }
			const s = [...ts].sort((a, b) => a - b);
			out[`${name}|${pn}|${clockS}`] = { gmean: Math.exp(ts.reduce((a,b)=>a+Math.log(Math.max(1,b)),0)/ts.length), p50: s[Math.floor(N/2)] ?? 0, mean: ts.reduce((a,b)=>a+b,0)/ts.length };
		}
await Bun.write(process.env.OUT ?? "/tmp/cz.json", JSON.stringify(out, null, 1));
console.log("cells", Object.keys(out).length);
