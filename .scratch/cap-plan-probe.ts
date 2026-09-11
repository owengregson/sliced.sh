// Does the instant cap survive `sampleGuarded`'s resample loop? Head-level share vs plan-level share.
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { createRng } from "@core/rng";
import { ChessMimicHead, humanFastShare, instantShareCap } from "@core/timing/chessmimic-head";
import { computeFeatures } from "@core/timing/features";
import { freshState, TimingModel } from "@core/timing/timing-model";
import type { GameMeta, Persona, TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";

const MIDDLEGAME_FEN = "r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N1P/PP1P1PP1/RNBQR1K1 w - - 0 10";
const persona: Persona = { s_game: 0, iota: 0.5, pi_p: 0, tau: 0.65, rho_mirror: 0.15, motor_k: 1 };

function line(multipv: number, cp: number, ...pv: string[]) {
	return { multipv, score: { cp }, depth: 10, pvUci: pv, pvSan: [] };
}
function baseCtx(over: Partial<TimingContext> = {}): TimingContext {
	return {
		fen: MIDDLEGAME_FEN, ply: 40, moves: [], myColor: "w", chosenMove: "a2a4",
		lines: [line(1, 20, "d2d4", "e5d4"), line(2, 10, "a2a4", "b5a4"), line(3, -5, "b1a3"), line(4, -30, "h3h4")],
		evalBeforeOppMove: 25, expectedOppReply: null,
		myClockMs: 180_000, oppClockMs: 180_000, baseSec: 180, incSec: 0,
		oppThinkMsHistory: [3000, 4000, 2500], myThinkMsHistory: [],
		site: "chesscom", targetElo: 1650, profile: "balanced", engineReady: true,
		inputMethod: "drag", autoQueen: true, nowMs: 1_000_000, ...over,
	} as TimingContext;
}
function heavy(): number[] { const p = new Array<number>(30).fill(0); p[0] = 0.9; p[5] = 0.1; return p; }
function headWith(probs: number[]) {
	return new ChessMimicHead({ infer: () => Promise.resolve({ probs, band: "1500_1600" }), fallback: new V1ParametricHead() });
}

const N = Number(process.env.N ?? 20000);
console.log("humanFastShare(1500_1600) =", humanFastShare("1500_1600").toFixed(6));

for (const [label, baseSec, clockS] of [["3+0 full", 180, 180], ["10+0 full", 600, 600], ["1+0 full", 60, 60], ["3+0 @90", 180, 90], ["3+0 @18", 180, 18]] as const) {
	const c = baseCtx({ baseSec, myClockMs: clockS * 1000, oppClockMs: clockS * 1000 });
	const f = computeFeatures(c);
	const cap = instantShareCap(f, "1500_1600");

	// (a) head-level, exactly as the lane's test measures it
	const h = headWith(heavy());
	await h.prepare(c);
	const st = freshState("g"); st.fen = c.fen;
	const rng = createRng("head");
	let hi = 0;
	for (let i = 0; i < N; i++) if (h.sample(f, persona, st, rng, 1).mode === "instant") hi++;

	// (b) plan-level, through the real TimingModel (sampleGuarded + the CV guard)
	const m = new TimingModel(headWith(heavy()), DEFAULT_SETTINGS.timing, createRng("plan"));
	const meta: GameMeta = { targetElo: 1650, profile: "balanced", baseSec, incSec: 0, site: "chesscom", gameId: "g" };
	let pi = 0; let sub2 = 0; const ts: number[] = [];
	const GAME = Number(process.env.GAME ?? 40);
	for (let i = 0; i < N; i++) {
		if (i % GAME === 0) { m.startGame({ ...meta, gameId: `g${i}` }); await m.prepare(c); }
		const plan = m.planMove(c);
		if (plan.mode === "instant") pi++;
		if (plan.thinkMs < 2000) sub2++;
		ts.push(plan.thinkMs);
	}
	const sorted = [...ts].sort((a, b) => a - b);
	console.log(
		`${label}: cap ${(100 * cap).toFixed(1)}%  head-level instant ${(100 * hi / N).toFixed(1)}%  PLAN-level instant ${(100 * pi / N).toFixed(1)}%  plan sub-2s ${(100 * sub2 / N).toFixed(1)}%  p50 ${sorted[Math.floor(N / 2)]?.toFixed(0)}`
	);
}
