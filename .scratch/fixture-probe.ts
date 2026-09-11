// How fixture-dependent are the lane's absolute ms figures? Same clock, different move history.
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MODELS_DIR } from "@core/constants/models";
import { createRng } from "@core/rng";
import { ChessMimicHead } from "@core/timing/chessmimic-head";
import { distributionMedianSec } from "@core/timing/chessmimic-buckets";
import { TimingModel } from "@core/timing/timing-model";
import type { GameMeta, TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { createOrtRuntime } from "@offscreen/ort-loader";
import { createTimingInference } from "@offscreen/timing-inference";

const ROOT = path.resolve(import.meta.dir, "..");
const MIDDLEGAME_FEN = "r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N1P/PP1P1PP1/RNBQR1K1 w - - 0 10";
const inference = createTimingInference({
	runtime: () => createOrtRuntime({ importModule: (u: string) => import(u), getUrl: (p: string) => pathToFileURL(path.join(ROOT, p)).href, threads: 1 }),
	store: { get: async (n: string) => new Uint8Array(await Bun.file(path.join(ROOT, MODELS_DIR, n)).arrayBuffer()) },
});
let qid = 0;
const probsSeen: number[][] = [];
const infer = async (inputs: Record<string, unknown>) => {
	const r = await inference.handle({ kind: "timing", id: `q${qid++}`, inputs } as never);
	if (r.probs) probsSeen.push(r.probs as number[]);
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
const LONG_MOVES = ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f8e7","f1e1","b7b5"];
const N = Number(process.env.N ?? 800);
async function run(label: string, over: Partial<TimingContext>) {
	const head = new ChessMimicHead({ infer: infer as never, fallback: new V1ParametricHead(), budgetMs: 600000 });
	const m = new TimingModel(head, DEFAULT_SETTINGS.timing, createRng("fx"));
	const meta: GameMeta = { targetElo: 1650, profile: "balanced", baseSec: (over.baseSec ?? 180), incSec: 0, site: "chesscom", gameId: "g" };
	const c = baseCtx(over);
	probsSeen.length = 0;
	const ts: number[] = []; let inst = 0;
	for (let i = 0; i < N; i++) {
		if (i % 40 === 0) { m.startGame({ ...meta, gameId: `g${i}` }); await m.prepare(c); }
		const p = m.planMove(c); ts.push(p.thinkMs); if (p.mode === "instant" || p.mode === "premove") inst++;
	}
	const s = [...ts].sort((a,b)=>a-b);
	const first = probsSeen[0] ?? [];
	console.log(`${label}: p10 ${s[Math.floor(0.1*N)]?.toFixed(0)} p50 ${s[Math.floor(0.5*N)]?.toFixed(0)} p90 ${s[Math.floor(0.9*N)]?.toFixed(0)} fast ${(100*inst/N).toFixed(1)}%  | model p(b0) ${(first[0]??0).toFixed(3)} p(b1) ${(first[1]??0).toFixed(3)} distMedian ${distributionMedianSec("1500_1600", first).toFixed(2)}s`);
}
for (const clk of [180, 60, 30]) {
	await run(`3+0 @${clk}s  no move history`, { myClockMs: clk*1000, oppClockMs: clk*1000 });
	await run(`3+0 @${clk}s  12-move history`, { myClockMs: clk*1000, oppClockMs: clk*1000, moves: LONG_MOVES });
}
