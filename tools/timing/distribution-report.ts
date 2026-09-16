/** Fixed-position ONNX diagnostics, plus matched human PGN clocks. No assets are rewritten. */
import "../human-match/defines";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyMoves } from "@core/chess/san";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { MODELS_DIR } from "@core/constants/models";
import { createRng } from "@core/rng";
import { ChessMimicHead } from "@core/timing/chessmimic-head";
import { TimingModel } from "@core/timing/timing-model";
import type { TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { createOrtRuntime } from "@offscreen/ort-loader";
import { createTimingInference } from "@offscreen/timing-inference";
import { timingSettingsFor } from "@service/game-session/presets";
import corpus from "../../test/fixtures/timing/pgn-replay.json";
import { parseGames, parseTimeControl, thinksOf } from "../pgn-clock-reference";

const ROOT = path.resolve(import.meta.dir, "../..");
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const output = process.argv[2];
if (!output)
	throw new Error("Usage: bun tools/timing/distribution-report.ts OUTPUT.json [PGN ...]");
const samples = 256;
const positions = corpus.games.slice(0, 4).map((game) => {
	let fen = START;
	const moves: string[] = [];
	for (const [ply, record] of game.plies.entries()) {
		if (ply >= 22 && "lines" in record && record.lines.length > 0)
			return { fen, moves: [...moves], ply, record, myColor: game.myColor as "w" | "b" };
		moves.push(record.uci);
		fen = applyMoves(fen, [record.uci]) ?? "";
	}
	throw new Error(`No analyzed middle-game position in ${game.id}`);
});
function stats(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	const q = (p: number) => sorted[Math.floor(p * (sorted.length - 1))] ?? 0;
	return {
		n: values.length,
		meanS: values.reduce((a, b) => a + b, 0) / Math.max(1, values.length),
		p10S: q(0.1),
		p50S: q(0.5),
		p90S: q(0.9),
		p95S: q(0.95),
		under1: values.filter((v) => v < 1).length / Math.max(1, values.length),
		over10: values.filter((v) => v > 10).length / Math.max(1, values.length),
	};
}
const inference = createTimingInference({
	runtime: () =>
		createOrtRuntime({
			importModule: (url) => import(url),
			getUrl: (p) => pathToFileURL(path.join(ROOT, p)).href,
			threads: 1,
		}),
	store: {
		get: async (name) =>
			new Uint8Array(await Bun.file(path.join(ROOT, MODELS_DIR, name)).arrayBuffer()),
	},
});
const cells: unknown[] = [];
try {
	for (const targetElo of [800, 1600, 2400, 2800]) {
		for (const [baseSec, incSec] of [
			[60, 0],
			[180, 0],
			[180, 2],
			[600, 5],
		]) {
			if (baseSec === undefined || incSec === undefined) continue;
			for (const fraction of [0.7, 0.4, 0.15]) {
				const values: number[] = [];
				const raw: number[] = [];
				let capBound = 0;
				for (const [position, source] of positions.entries()) {
					const head = new ChessMimicHead({
						infer: async (inputs) => {
							const response = await inference.handle({ kind: "timing", id: "distribution", inputs });
							if (!response.probs) throw new Error(`Inference failed for ${inputs.band}`);
							return { probs: response.probs, band: response.band ?? inputs.band };
						},
						fallback: new V1ParametricHead(),
						budgetMs: 60_000,
					});
					const gameId = `distribution-${targetElo}-${baseSec}-${incSec}-${fraction}-${position}`;
					const model = new TimingModel(
						head,
						timingSettingsFor(DEFAULT_SETTINGS.timing, { baseMs: baseSec * 1000, incMs: incSec * 1000 }),
						createRng(gameId)
					);
					model.startGame({ gameId, targetElo, baseSec, incSec, profile: "balanced", site: "chesscom" });
					const context: TimingContext = {
						fen: source.fen,
						moves: source.moves,
						ply: source.ply,
						myColor: source.myColor,
						chosenMove: source.record.uci,
						lines: source.record.lines ?? [],
						evalBeforeOppMove: null,
						expectedOppReply: null,
						myClockMs: baseSec * fraction * 1000,
						oppClockMs: baseSec * fraction * 1000,
						baseSec,
						incSec,
						oppThinkMsHistory: [],
						myThinkMsHistory: [],
						site: "chesscom",
						targetElo,
						profile: "balanced",
						engineReady: true,
						inputMethod: "drag",
						autoQueen: true,
						nowMs: 1_000_000,
					};
					await head.prepare(context);
					if (head.diagnostics(context.fen).head !== "chessmimic")
						throw new Error("Unexpected fallback");
					for (let i = 0; i < samples; i++) {
						const plan = model.planMove(context);
						values.push(plan.thinkMs / 1000);
						if (plan.features.headSampleSec !== undefined) raw.push(plan.features.headSampleSec);
						if (plan.rationale.some((r) => r.startsWith("cap "))) capBound++;
					}
				}
				cells.push({
					targetElo,
					baseSec,
					incSec,
					fraction,
					...stats(values),
					capBound: capBound / values.length,
					...(raw.length ? { raw: stats(raw) } : {}),
				});
			}
		}
		process.stderr.write(`Completed Elo ${targetElo}\n`);
	}
} finally {
	inference.dispose();
}

const humans = new Map<string, { games: Set<string>; times: number[] }>();
const seen = new Set<string>();
for (const filename of process.argv.slice(3)) {
	for (const game of parseGames(await Bun.file(filename).text())) {
		const key = game.headers.Link ?? JSON.stringify(game);
		if (seen.has(key)) continue;
		seen.add(key);
		const tc = parseTimeControl(game.headers.TimeControl ?? "");
		if (!tc) continue;
		const ours =
			game.headers.White?.toLowerCase() === "gc_elif"
				? 0
				: game.headers.Black?.toLowerCase() === "gc_elif"
					? 1
					: null;
		if (ours === null) continue;
		const side = ours === 0 ? 1 : 0;
		const elo = Number(game.headers[side === 0 ? "WhiteElo" : "BlackElo"]);
		for (const think of thinksOf(game, side, tc.baseSec, tc.incSec)) {
			if (think.moveNo <= 2) continue;
			const band =
				think.fraction > 0.85
					? "1-.85"
					: think.fraction > 0.55
						? ".85-.55"
						: think.fraction > 0.25
							? ".55-.25"
							: ".25-0";
			const group = `${Math.floor(elo / 400) * 400}-${Math.floor(elo / 400) * 400 + 399}|${tc.baseSec}+${tc.incSec}|${band}`;
			const row = humans.get(group) ?? { games: new Set<string>(), times: [] };
			row.games.add(key);
			row.times.push(think.thinkS);
			humans.set(group, row);
		}
	}
}
await Bun.write(
	output,
	`${JSON.stringify(
		{
			method:
				"Four recorded expert middlegame positions, 256 repeated plans each; rating/control substitutions are diagnostics, not held-out human calibration. PGN rows are deduplicated opponents only, first two moves excluded.",
			samplesPerCell: positions.length * samples,
			cells,
			human: [...humans].map(([group, row]) => ({
				group,
				games: row.games.size,
				...stats(row.times),
			})),
		},
		null,
		2
	)}\n`
);
process.stdout.write(`Wrote ${output}\n`);
