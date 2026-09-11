// "Never slower" — paired plan-level scan with a head that is identical in both trees.
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
function baseCtx(over: Partial<TimingContext> = {}): TimingContext {
	return { fen: MIDDLEGAME_FEN, ply: 40, moves: [], myColor: "w", chosenMove: "d2d4",
		lines: [line(1,20,"d2d4","e5d4"), line(2,10,"a2a4","b5a4"), line(3,-5,"b1a3"), line(4,-30,"h3h4")],
		evalBeforeOppMove: 25, expectedOppReply: null, myClockMs: 180000, oppClockMs: 180000,
		baseSec: 180, incSec: 0, oppThinkMsHistory: [3000,4000,2500], myThinkMsHistory: [],
		site: "chesscom", targetElo: 1650, profile: "balanced", engineReady: true,
		inputMethod: "drag", autoQueen: true, nowMs: 1000000, ...over } as TimingContext;
}
const N = Number(process.env.N ?? 3000);
const out: Record<string, { gmean: number; p50: number; mean: number }> = {};
for (const [name, baseSec, medianS] of [["1+0", 60, 2], ["3+0", 180, 4], ["10+0", 600, 6], ["3+2", 180, 4]] as const) {
	const incSec = name === "3+2" ? 2 : 0;
	for (let i = 0; i <= 40; i++) {
		const clockS = (baseSec * i) / 40;
		for (const [plyName, ply] of [["mid", 40], ["open", 6], ["end", 70]] as const) {
			const m = new TimingModel(new Blind(medianS, 0.9), DEFAULT_SETTINGS.timing, createRng(`ns-${name}-${clockS}-${ply}`));
			const meta: GameMeta = { targetElo: 1650, profile: "balanced", baseSec, incSec, site: "chesscom", gameId: "g" };
			const c = baseCtx({ baseSec, incSec, ply, myClockMs: clockS * 1000, oppClockMs: clockS * 1000 });
			const ts: number[] = [];
			for (let k = 0; k < N; k++) { if (k % 40 === 0) m.startGame({ ...meta, gameId: `g-${clockS}-${ply}-${k}` }); ts.push(m.planMove(c).thinkMs); }
			const s = [...ts].sort((a, b) => a - b);
			out[`${name}|${plyName}|${clockS.toFixed(2)}`] = {
				gmean: Math.exp(ts.reduce((a, b) => a + Math.log(Math.max(1, b)), 0) / ts.length),
				p50: s[Math.floor(N / 2)] ?? 0,
				mean: ts.reduce((a, b) => a + b, 0) / ts.length,
			};
		}
	}
}
await Bun.write(process.env.OUT ?? "/tmp/ns.json", JSON.stringify(out, null, 1));
console.log("cells", Object.keys(out).length);
