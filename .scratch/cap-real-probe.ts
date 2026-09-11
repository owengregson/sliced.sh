// Real ONNX head: does the realised PLAN instant share match the cap the head enforces per draw?
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { MODELS_DIR } from "@core/constants/models";
import { createRng } from "@core/rng";
import { ChessMimicHead, instantShareCap } from "@core/timing/chessmimic-head";
import { computeFeatures } from "@core/timing/features";
import { freshState, TimingModel } from "@core/timing/timing-model";
import type { GameMeta, Persona, TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { createOrtRuntime } from "@offscreen/ort-loader";
import { createTimingInference } from "@offscreen/timing-inference";

const ROOT = path.resolve(import.meta.dir, "..");
const MIDDLEGAME_FEN = "r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N1P/PP1P1PP1/RNBQR1K1 w - - 0 10";
const persona: Persona = { s_game: 0, iota: 0.5, pi_p: 0, tau: 0.65, rho_mirror: 0.15, motor_k: 1 };
const inference = createTimingInference({
	runtime: () => createOrtRuntime({ importModule: (u: string) => import(u), getUrl: (p: string) => pathToFileURL(path.join(ROOT, p)).href, threads: 1 }),
	store: { get: async (n: string) => new Uint8Array(await Bun.file(path.join(ROOT, MODELS_DIR, n)).arrayBuffer()) },
});
let qid = 0;
const infer = async (inputs: Record<string, unknown>) => {
	const r = await inference.handle({ kind: "timing", id: `q${qid++}`, inputs } as never);
	return r.probs ? { probs: r.probs as number[], band: (r as { band: string }).band } : null;
};
function line(m: number, cp: number, ...pv: string[]) { return { multipv: m, score: { cp }, depth: 10, pvUci: pv, pvSan: [] }; }
function baseCtx(over: Partial<TimingContext> = {}): TimingContext {
	return { fen: MIDDLEGAME_FEN, ply: 40, moves: [], myColor: "w", chosenMove: "d2d4",
		lines: [line(1,20,"d2d4","e5d4"), line(2,10,"a2a4","b5a4"), line(3,-5,"b1a3"), line(4,-30,"h3h4")],
		evalBeforeOppMove: 25, expectedOppReply: null, myClockMs: 180000, oppClockMs: 180000,
		baseSec: 180, incSec: 0, oppThinkMsHistory: [3000,4000,2500], myThinkMsHistory: [],
		site: "chesscom", targetElo: 1650, profile: "balanced", engineReady: true,
		inputMethod: "drag", autoQueen: true, nowMs: 1000000, ...over } as TimingContext;
}
const HIST = ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f8e7","f1e1","b7b5"];
const N = Number(process.env.N ?? 4000);
const head = new ChessMimicHead({ infer: infer as never, fallback: new V1ParametricHead(), budgetMs: 600000 });

console.log("label                          cap    head%   plan%   plan-sub2s%  p50");
for (const [lbl, baseSec, clockS, hist] of [
	["3+0 @180 no-hist", 180, 180, false], ["3+0 @180 hist", 180, 180, true],
	["3+0 @90  no-hist", 180, 90, false], ["3+0 @90  hist", 180, 90, true],
	["3+0 @30  no-hist", 180, 30, false], ["3+0 @30  hist", 180, 30, true],
	["10+0 @600 no-hist", 600, 600, false], ["10+0 @600 hist", 600, 600, true],
	["10+0 @480 hist", 600, 480, true],
	["1+0 @60 hist", 60, 60, true],
] as const) {
	const c = baseCtx({ baseSec, myClockMs: clockS*1000, oppClockMs: clockS*1000, ...(hist ? { moves: [...HIST] } : {}) });
	const f = computeFeatures(c);
	const cap = instantShareCap(f, "1500_1600");
	await head.prepare(c);
	const st = freshState("g"); st.fen = c.fen;
	const rng = createRng("h");
	let hi = 0;
	for (let i = 0; i < N; i++) { const s = head.sample(f, persona, st, rng, 1); if (s.mode === "instant" || s.mode === "premove") hi++; }
	const m = new TimingModel(new ChessMimicHead({ infer: infer as never, fallback: new V1ParametricHead(), budgetMs: 600000 }), DEFAULT_SETTINGS.timing, createRng("p"));
	const meta: GameMeta = { targetElo: 1650, profile: "balanced", baseSec, incSec: 0, site: "chesscom", gameId: "g" };
	let pi = 0, sub2 = 0; const ts: number[] = [];
	for (let i = 0; i < N; i++) {
		if (i % 40 === 0) { m.startGame({ ...meta, gameId: `g${i}` }); await m.prepare(c); }
		const plan = m.planMove(c);
		if (plan.mode === "instant" || plan.mode === "premove") pi++;
		if (plan.thinkMs < 2000) sub2++;
		ts.push(plan.thinkMs);
	}
	const s = [...ts].sort((a,b)=>a-b);
	console.log(`${lbl.padEnd(20)} ${(100*cap).toFixed(1).padStart(6)} ${(100*hi/N).toFixed(1).padStart(7)} ${(100*pi/N).toFixed(1).padStart(7)} ${(100*sub2/N).toFixed(1).padStart(11)}  ${s[Math.floor(N/2)]?.toFixed(0)}`);
}
