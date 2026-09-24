/** Real-game replay. PGN marginals are references, not evidence that random positions are human. */
import { afterAll, describe, expect, it } from "bun:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyMoves } from "@core/chess/san";
import { BOOK, BOOKS } from "@core/constants/books";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { MODELS_DIR } from "@core/constants/models";
import { createRng } from "@core/rng";
import { createBookPolicy } from "@core/strength/book/book-policy";
import { ChessMimicHead } from "@core/timing/chessmimic-head";
import { TimingModel } from "@core/timing/timing-model";
import type { TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { createOrtRuntime } from "@offscreen/ort-loader";
import { createTimingInference } from "@offscreen/timing-inference";
import { timingSettingsFor } from "@service/game-session/presets";
import { ownMoveBudget } from "@service/game-session/recommendation";
import type { EvalLine } from "@typedefs/engine";
import humanClock from "../../fixtures/human-clock-reference.json";
import corpus from "../../fixtures/timing/pgn-replay.json";
import { median, START_FEN } from "./helpers";

const ROOT = path.resolve(import.meta.dir, "../../..");
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
afterAll(() => inference.dispose());
/** The bundled theory books (`THEORY_BOOKS`), read from the checkout. */
const book = createBookPolicy({
	loadBook: async (name) =>
		new Uint8Array(await Bun.file(path.join(ROOT, BOOKS.dir, name)).arrayBuffer()),
	repertoire: async () => null,
});
afterAll(() => book.dispose());
const head = new ChessMimicHead({
	infer: async (inputs) => {
		const reply = await inference.handle({ kind: "timing", id: "replay", inputs });
		return reply.probs ? { probs: reply.probs, band: reply.band ?? inputs.band } : null;
	},
	fallback: new V1ParametricHead(),
	budgetMs: 60_000,
});
interface Row {
	move: number;
	fraction: number;
	plannedS: number;
	chargedS: number;
	leftS: number;
}
interface GameResult {
	rows: Row[];
	flagged: boolean;
	expectedMoves: number;
}
async function replay(baseSec: number, seed: number): Promise<GameResult[]> {
	const out: GameResult[] = [];
	for (const game of corpus.games) {
		const timingSettings = timingSettingsFor(DEFAULT_SETTINGS.timing, {
			baseMs: baseSec * 1000,
			incMs: 0,
		});
		// 2026-09-15: the model's knobs and a `Settings` are different types now (`timingSettings`
		// carries `moveTimeScale`, the stored profile carries `baseSpeed`). `ownMoveBudget` reads
		// `timing.respectBudget` and the strength block, both of which the defaults already carry,
		// and since the same date it reads no speed knob at all — so the replay is unchanged.
		const settings = DEFAULT_SETTINGS;
		const model = new TimingModel(head, timingSettings, createRng(`pgn-clock-${game.id}-${seed}`));
		model.startGame({
			targetElo: 2400,
			profile: "balanced",
			baseSec,
			incSec: 0,
			site: "chesscom",
			gameId: `${game.id}-${seed}`,
		});
		head.reset();
		let fen = START_FEN;
		let priorFen: string | null = null;
		let left = baseSec * 1000;
		let opponent = baseSec * 1000;
		const moves: string[] = [];
		const ours: number[] = [];
		const theirs: number[] = [];
		const rows: Row[] = [];
		const myColor = game.myColor as "w" | "b";
		const expectedMoves = game.plies.filter(
			(_, ply) => (ply % 2 === 0 ? "w" : "b") === myColor
		).length;
		let flagged = false;
		for (const [ply, record] of game.plies.entries()) {
			const color = ply % 2 === 0 ? "w" : "b";
			if (color === myColor) {
				const lines: EvalLine[] = "lines" in record ? record.lines : [];
				expect(lines.length).toBeGreaterThan(0);
				const context: TimingContext = {
					fen,
					ply,
					moves: [...moves],
					myColor,
					chosenMove: record.uci,
					lines,
					evalBeforeOppMove: null,
					expectedOppReply: null,
					myClockMs: left,
					oppClockMs: opponent,
					baseSec,
					incSec: 0,
					oppThinkMsHistory: theirs.slice(-8),
					myThinkMsHistory: ours.slice(-8),
					site: "chesscom",
					targetElo: 2400,
					profile: "balanced",
					engineReady: true,
					inputMethod: "drag",
					autoQueen: true,
					nowMs: 1_000_000 + ply * 1000,
					// What the session supplies (2026-09-24): the position before the opponent's reply
					// (the calibration's recapture test) and the book flag when the move is theory.
					priorFen,
					...((await book.bookMoves?.(fen))?.includes(record.uci) && ply <= BOOK.maxPly
						? { inBook: true }
						: {}),
				};
				await model.prepare(context);
				// The session infers the chosen move's timed-move row before planning it.
				await model.prepareMove(context);
				const plan = model.planMove(context);
				const search = ownMoveBudget(
					{
						fen,
						ply,
						myClockMs: left,
						oppClockMs: opponent,
						timeControl: { baseMs: baseSec * 1000, incMs: 0 },
						tau: model.persona.tau,
						budgetUsedRatio: 0,
						targetElo: 2400,
					},
					settings
				);
				// Preparation and the reserved physical gesture share the sampled window. A late
				// search can consume all optional time, but the gesture is still owed. This is a
				// reservation estimate; actual CDP geometry/transport can overrun it.
				const charged = Math.max(plan.thinkMs, search.movetimeMs + plan.window.approachMs);
				rows.push({
					move: rows.length + 1,
					fraction: left / (baseSec * 1000),
					plannedS: plan.thinkMs / 1000,
					chargedS: charged / 1000,
					leftS: (left - charged) / 1000,
				});
				model.observe(charged, plan, {
					gameId: model.state.gameId,
					ply,
					adaptPace: charged <= plan.thinkMs,
				});
				left -= charged;
				ours.push(charged);
				if (left <= 0) {
					flagged = true;
					break;
				}
			} else {
				const next = Math.max(0, ((record.clockAfterS * baseSec) / 180) * 1000);
				theirs.push(Math.max(0, opponent - next));
				opponent = next;
			}
			moves.push(record.uci);
			priorFen = fen;
			const next = applyMoves(fen, [record.uci]);
			if (!next) throw new Error(`Invalid corpus move ${game.id}:${ply}`);
			fen = next;
		}
		out.push({ rows, flagged, expectedMoves });
	}
	return out;
}
const sweeps = new Map<number, Promise<GameResult[]>>();
function sweep(base: number): Promise<GameResult[]> {
	let pending = sweeps.get(base);
	if (!pending) {
		pending = (async () => [...(await replay(base, 0)), ...(await replay(base, 1))])();
		sweeps.set(base, pending);
	}
	return pending;
}
function atMove(games: GameResult[], move: number): number {
	return median(games.flatMap((g) => (g.rows[move - 1] ? [g.rows[move - 1]!.leftS] : [])));
}
const middle = (rows: Row[]) => rows.filter((r) => r.fraction <= 0.85 && r.fraction > 0.55);
const share = (rows: Row[], pick: (r: Row) => boolean) => rows.filter(pick).length / rows.length;
const report = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

// Resample whole games because adjacent moves are correlated. This is a retrospective
// regression envelope, not a confidence claim about all humans at this rating.
function humanWindow(): number[][] {
	return corpus.games.map((game) => {
		let clock = 180;
		const samples: number[] = [];
		for (const [ply, record] of game.plies.entries()) {
			if ((ply % 2 === 0 ? "w" : "b") === game.myColor) continue;
			if (clock / 180 <= 0.85 && clock / 180 > 0.55) samples.push(clock - record.clockAfterS);
			clock = record.clockAfterS;
		}
		return samples;
	});
}
function humanRateEnvelope(predicate: (seconds: number) => boolean): [number, number] {
	const games = humanWindow();
	const rng = createRng("pgn-game-bootstrap");
	const rates: number[] = [];
	for (let i = 0; i < 2000; i++) {
		const sample = Array.from(
			{ length: games.length },
			() => games[Math.floor(rng.next() * games.length)] ?? []
		).flat();
		rates.push(sample.filter(predicate).length / sample.length);
	}
	rates.sort((a, b) => a - b);
	return [rates[50] ?? 0, rates[1949] ?? 1];
}

describe("complete PGN games with native timing and uncached execution cost", () => {
	it("retains the PGN clock milestones and completes all long games without a flag", async () => {
		const games = await sweep(180);
		report({
			timeControl: "3+0",
			games: games.length,
			at20: atMove(games, 20),
			at30: atMove(games, 30),
			at40: atMove(games, 40),
			at50: atMove(games, 50),
			flags: games.filter((g) => g.flagged).length,
		});
		expect(atMove(games, 20)).toBeGreaterThanOrEqual(90);
		expect(atMove(games, 30)).toBeGreaterThanOrEqual(55);
		expect(atMove(games, 50)).toBeGreaterThan(0);
		for (const game of games) {
			expect(game.flagged).toBe(false);
			expect(game.rows.length).toBe(game.expectedMoves);
		}
	}, 300_000);
	it("restores the fast middle-clock tail without excessive long thinks", async () => {
		const rows = middle((await sweep(180)).flatMap((g) => g.rows));
		const fast = share(rows, (r) => r.chargedS < 1);
		const long = share(rows, (r) => r.chargedS > 10);
		report({
			window: "0.85-0.55",
			n: rows.length,
			median: median(rows.map((r) => r.chargedS)),
			fast,
			long,
			human: {
				n: humanWindow().flat().length,
				median: median(humanWindow().flat()),
				fast: humanRateEnvelope((seconds) => seconds < 1),
				long: humanRateEnvelope((seconds) => seconds > 10),
			},
		});
		expect(rows.length).toBeGreaterThan(100);
		const [fastLow, fastHigh] = humanRateEnvelope((seconds) => seconds < 1);
		const [longLow, longHigh] = humanRateEnvelope((seconds) => seconds > 10);
		expect(fast).toBeGreaterThanOrEqual(fastLow);
		expect(fast).toBeLessThanOrEqual(fastHigh);
		expect(long).toBeGreaterThanOrEqual(longLow);
		expect(long).toBeLessThanOrEqual(longHigh);
	}, 300_000);
	// Until 2026-09-24 this required ≥ 240 s at move 40, a regression guard with no human evidence
	// behind it, which the upstream top band passed by thinking too fast in rapid. Humans rated
	// 2300–2499 at 10+0 keep a median of ~143 s after move 40 and only ~25 % keep ≥ 240 s
	// (`human-clock-reference.json`, generated from the chess.com crawl by
	// tools/timing-finetune/human_clock_reference.py). The bot must neither hoard nor burn its
	// clock: its median must sit inside the human interquartile range (docs/models.md §9;
	// data/timing/finetune/RESULTS.md).
	it("keeps a human rapid clock at move 40: neither hoarding nor burning time", async () => {
		const games = await sweep(600);
		const at40 = atMove(games, 40);
		report({
			timeControl: "10+0",
			games: games.length,
			at40,
			human: { median: humanClock.medianS, p25: humanClock.p25S, p75: humanClock.p75S },
			flags: games.filter((g) => g.flagged).length,
		});
		expect(at40).toBeGreaterThanOrEqual(humanClock.p25S);
		expect(at40).toBeLessThanOrEqual(humanClock.p75S);
		for (const game of games) expect(game.flagged).toBe(false);
	}, 300_000);
});
