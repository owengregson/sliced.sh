// Independent re-measurement probe (review only). Real ONNX ChessMimic head + real TimingModel.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { chessMimicBandFile, MODELS_DIR } from "@core/constants/models";
import { createRng } from "@core/rng";
import { ChessMimicHead } from "@core/timing/chessmimic-head";
import { TimingModel } from "@core/timing/timing-model";
import type { GameMeta, TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { createOrtRuntime } from "@offscreen/ort-loader";
import { createTimingInference } from "@offscreen/timing-inference";

const ROOT = path.resolve(import.meta.dir, "..");
const MIDDLEGAME_FEN = "r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N1P/PP1P1PP1/RNBQR1K1 w - - 0 10";
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const inference = createTimingInference({
	runtime: () =>
		createOrtRuntime({
			importModule: (url: string) => import(url),
			getUrl: (p: string) => pathToFileURL(path.join(ROOT, p)).href,
			threads: 1,
		}),
	store: {
		get: async (name: string) =>
			new Uint8Array(await Bun.file(path.join(ROOT, MODELS_DIR, name)).arrayBuffer()),
	},
});
void chessMimicBandFile;

let qid = 0;
const infer = async (inputs: Record<string, unknown>) => {
	const r = await inference.handle({ kind: "timing", id: `q${qid++}`, inputs } as never);
	return r.probs ? { probs: r.probs as number[], band: (r as { band: string }).band } : null;
};

function line(multipv: number, cp: number, ...pv: string[]) {
	return { multipv, score: { cp }, depth: 10, pvUci: pv, pvSan: [] };
}
function baseCtx(over: Partial<TimingContext> = {}): TimingContext {
	return {
		fen: MIDDLEGAME_FEN,
		ply: 40,
		moves: [],
		myColor: "w",
		chosenMove: "d2d4",
		lines: [
			line(1, 20, "d2d4", "e5d4"),
			line(2, 10, "a2a4", "b5a4"),
			line(3, -5, "b1a3", "c8e6"),
			line(4, -30, "h3h4", "h7h6"),
		],
		evalBeforeOppMove: 25,
		expectedOppReply: null,
		myClockMs: 120_000,
		oppClockMs: 120_000,
		baseSec: 180,
		incSec: 0,
		oppThinkMsHistory: [3000, 4000, 2500],
		myThinkMsHistory: [],
		site: "chesscom",
		targetElo: 1650,
		profile: "balanced",
		engineReady: true,
		inputMethod: "drag",
		autoQueen: true,
		nowMs: 1_000_000,
		...over,
	} as TimingContext;
}

function q(sorted: number[], p: number) {
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN;
}

interface Stats {
	n: number; p10: number; p50: number; p90: number; mean: number; sd: number;
	gmean: number; instant: number; premove: number; normal: number; long: number;
	fastPageShare: number;
}

async function point(
	kind: "cm" | "v1",
	baseSec: number,
	clockS: number,
	n: number,
	seed: string,
	over: Partial<TimingContext> = {}
): Promise<Stats> {
	const head = kind === "v1" ? new V1ParametricHead() : new ChessMimicHead({ infer: infer as never, fallback: new V1ParametricHead(), budgetMs: 600_000 });
	const m = new TimingModel(head, DEFAULT_SETTINGS.timing, createRng(seed));
	const meta: GameMeta = { targetElo: 1650, profile: "balanced", baseSec, incSec: 0, site: "chesscom", gameId: "g" };
	const c = baseCtx({ baseSec, myClockMs: clockS * 1000, oppClockMs: clockS * 1000, ...over });
	const ts: number[] = [];
	const modes: Record<string, number> = { instant: 0, premove: 0, normal: 0, long: 0 };
	let fastPage = 0;
	for (let i = 0; i < n; i++) {
		if (i % 40 === 0) {
			m.startGame({ ...meta, gameId: `g-${clockS}-${i}` });
			await m.prepare(c);
		}
		const plan = m.planMove(c);
		ts.push(plan.thinkMs);
		modes[plan.mode] = (modes[plan.mode] ?? 0) + 1;
		if (plan.thinkMs < 2000) fastPage++;
	}
	const sorted = [...ts].sort((a, b) => a - b);
	const mean = ts.reduce((a, b) => a + b, 0) / ts.length;
	const sd = Math.sqrt(ts.reduce((a, b) => a + (b - mean) ** 2, 0) / ts.length);
	return {
		n, p10: q(sorted, 0.1), p50: q(sorted, 0.5), p90: q(sorted, 0.9), mean, sd,
		gmean: Math.exp(ts.reduce((a, b) => a + Math.log(Math.max(1, b)), 0) / ts.length),
		instant: (modes.instant ?? 0) / n, premove: (modes.premove ?? 0) / n,
		normal: (modes.normal ?? 0) / n, long: (modes.long ?? 0) / n,
		fastPageShare: fastPage / n,
	};
}

const N = Number(process.env.N ?? 800);
const out: Record<string, unknown> = {};

const SWEEPS: Array<[string, number, number[]]> = [
	["1+0", 60, [60, 50, 40, 30, 20, 13, 10, 7, 3, 1.5]],
	["3+0", 180, [180, 150, 120, 90, 60, 40, 30, 20, 10, 5]],
	["10+0", 600, [600, 500, 400, 300, 200, 133, 100, 67, 33, 17]],
];

for (const kind of ["cm", "v1"] as const) {
	for (const [name, baseSec, clocks] of SWEEPS) {
		for (const clockS of clocks) {
			const s = await point(kind, baseSec, clockS, N, `probe-${name}-${clockS}`);
			out[`${kind}|${name}|${clockS}`] = s;
			console.log(
				`${kind} ${name} @${clockS}s  p10 ${s.p10.toFixed(0)} p50 ${s.p50.toFixed(0)} p90 ${s.p90.toFixed(0)} gmean ${s.gmean.toFixed(0)} cv ${(s.sd / s.mean).toFixed(2)} inst ${(100 * s.instant).toFixed(1)}% pre ${(100 * s.premove).toFixed(1)}% sub2s ${(100 * s.fastPageShare).toFixed(1)}%`
			);
		}
	}
}

// ply-0 and ply-1 probes (cm only)
for (const [name, baseSec] of [["1+0", 60], ["3+0", 180], ["10+0", 600]] as const) {
	const s = await point("cm", baseSec, baseSec, N, `ply0-${name}`, {
		fen: START_FEN, ply: 0, moves: [], chosenMove: "e2e4",
		lines: [line(1, 20, "e2e4", "e7e5"), line(2, 12, "d2d4", "d7d5"), line(3, 5, "g1f3", "g8f6"), line(4, 0, "c2c4", "e7e6")],
	});
	out[`cm|ply0|${name}`] = s;
	console.log(`cm ply0 ${name} p10 ${s.p10.toFixed(0)} p50 ${s.p50.toFixed(0)} fast ${(100 * (s.instant + s.premove)).toFixed(1)}% (pre ${(100 * s.premove).toFixed(1)} inst ${(100 * s.instant).toFixed(1)}) sub2s ${(100 * s.fastPageShare).toFixed(1)}%`);
}

await Bun.write(process.env.OUT ?? "/tmp/pace.json", JSON.stringify(out, null, 1));
console.log("written", process.env.OUT);
