// test/service/game-session/session-maia.test.ts — the session's Maia wiring on the simulator
// (2026-09-13): H7.3 the predicted position is pre-inferred on the opponent's clock and handed to
// the pipeline as `policyAnswer` when the reply is the expected one (aborted otherwise); H6.3 one
// size per game, locked by the first move against an opponent-matched drift, re-committed by an
// explicit target change; H8 the premove gate applied when the answer lands after the arm.
import { afterEach, describe, expect, it } from "bun:test";
import { applyMoves, legalMoves } from "@core/chess/san";
import { PREMOVE } from "@core/constants/books";
import { CHESS_START_FEN } from "@core/constants/chess";
import { MAIA } from "@core/constants/maia";
import { automaticDepthForElo } from "@core/engine/depth-policy";
import type { AnalysisRequest, AnalysisUpdate } from "@core/engine/types";
import type { PolicyInferenceInputs, PolicyPort, PolicyResult } from "@core/policy/types";
import {
	ownMoveMaiaElo,
	type RecommendationInput,
	shapedRootSet,
} from "@service/game-session/recommendation";
import type { SessionPipeline } from "@service/game-session/session";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove, PositionSnapshot } from "@typedefs/game";
import { createGameHarness, type GameHarness } from "../../behavioral/game/harness";
import { positionKey } from "../../behavioral/game/scripted-engine";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

const AFTER_E4 = applyMoves(CHESS_START_FEN, ["e2e4"]) as string;

/** A uniform-ish legal-move distribution for `fen`, the size echoed back. */
function answerFor(inputs: PolicyInferenceInputs): PolicyResult {
	const legal = legalMoves(inputs.fen);
	const total = (legal.length * (legal.length + 1)) / 2;
	return {
		moves: legal.map((uci, i) => [uci, (legal.length - i) / total]),
		wdl: [0.3, 0.4, 0.3],
		size: inputs.size,
		ms: 5,
	};
}

/** A scripted policy port: records every query and its abort signal; `hold` parks the answers. */
function fakePolicy(opts: { hold?: boolean } = {}) {
	const calls: PolicyInferenceInputs[] = [];
	const signals: AbortSignal[] = [];
	const parked: Array<{ inputs: PolicyInferenceInputs; resolve: (r: PolicyResult) => void }> = [];
	const port: PolicyPort = {
		infer(inputs, preparation) {
			calls.push(inputs);
			if (preparation?.signal) signals.push(preparation.signal);
			if (opts.hold) return new Promise((resolve) => parked.push({ inputs, resolve }));
			return Promise.resolve(answerFor(inputs));
		},
		warm: () => {},
		dispose: () => {},
	};
	return {
		port,
		calls,
		signals,
		release: () => {
			for (const p of parked.splice(0)) p.resolve(answerFor(p.inputs));
		},
	};
}

/** Record every `RecommendationInput` the session hands its pipeline (the pipeline still runs). */
function tapPipeline(harness: GameHarness): RecommendationInput[] {
	const inputs: RecommendationInput[] = [];
	const session = harness.session() as unknown as { pipeline: SessionPipeline | null };
	const real = session.pipeline;
	if (!real) throw new Error("no pipeline on the session");
	session.pipeline = {
		run: (input) => {
			inputs.push(input);
			return real.run(input);
		},
	};
	return inputs;
}

const formOf = (harness: GameHarness): number =>
	(harness.session() as unknown as { form: { value: number } }).form.value;
const tauOf = (harness: GameHarness): number =>
	(harness.session() as unknown as { timing: { persona: { tau: number } } }).timing.persona.tau;

describe("H7.3 — the predicted position is pre-inferred on the opponent's clock", () => {
	it("issues the query for the predicted position with the pipeline's inputs, and hands the answer to the pipeline when the reply lands", async () => {
		const policy = fakePolicy();
		h = await createGameHarness({
			myColor: "b",
			gameId: "maia-pre-infer",
			policy: policy.port,
			settings: { strength: { targetElo: 1200, matchOpponentRating: false } },
			script: { prefer: new Map([[positionKey(CHESS_START_FEN), ["e2e4"]]]) },
		});
		const inputs = tapPipeline(h);
		await h.arrive(); // the start position: white (the opponent) to move
		expect(await h.until(() => policy.calls.length === 1, 5_000)).toBe(true);
		const query = policy.calls[0];
		expect(query?.fen).toBe(AFTER_E4);
		expect(query?.size).toBe("79m");
		expect(query?.historyFens).toEqual([CHESS_START_FEN, AFTER_E4]);
		// The pipeline's own rating for that position, from the same budget input the pre-analysis
		// was sized by — pressure, slider and H5's context terms included.
		expect(query?.selfElo).toBe(
			ownMoveMaiaElo(
				{
					fen: AFTER_E4,
					ply: 1,
					myClockMs: 300_000,
					oppClockMs: 300_000,
					timeControl: { baseMs: 300_000, incMs: 2_000 },
					tau: tauOf(h),
					budgetUsedRatio: 0,
					targetElo: 1200,
					form: formOf(h),
					maia: true,
				},
				h.settings()
			).selfElo
		);
		expect(query?.oppoElo).toBe(query?.selfElo ?? -1);
		expect(policy.signals[0]?.aborted).toBe(false);

		// The opponent plays what was predicted: the answer is the pipeline's `policyAnswer`.
		await h.arrive("e2e4");
		expect(await h.until(() => inputs.length === 1, 5_000)).toBe(true);
		const input = inputs[0];
		expect(input?.snapshot.fen).toBe(AFTER_E4);
		expect(input?.maiaSize).toBe("79m");
		expect(input?.policyAnswer?.fen).toBe(AFTER_E4);
		expect(input?.policyAnswer?.result.size).toBe("79m");
		expect(input?.policyAnswer?.historyPlies).toBe(2);
		expect(input?.policyAnswer?.selfElo).toBe(query?.selfElo ?? -1);
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
	}, 60_000);

	it("aborts the query when the position moves on, and hands the pipeline nothing for another reply", async () => {
		const policy = fakePolicy({ hold: true });
		h = await createGameHarness({
			myColor: "b",
			gameId: "maia-pre-infer-abort",
			policy: policy.port,
			settings: { strength: { targetElo: 1200, matchOpponentRating: false } },
			script: { prefer: new Map([[positionKey(CHESS_START_FEN), ["e2e4"]]]) },
		});
		const inputs = tapPipeline(h);
		await h.arrive();
		expect(await h.until(() => policy.calls.length === 1, 5_000)).toBe(true);
		expect(policy.signals[0]?.aborted).toBe(false);
		// The opponent plays something else while the query is still out.
		await h.arrive("d2d4");
		expect(policy.signals[0]?.aborted).toBe(true);
		policy.release();
		expect(await h.until(() => inputs.length === 1, 5_000)).toBe(true);
		expect(inputs[0]?.policyAnswer).toBeUndefined();
		const session = h.session() as unknown as { predictedPolicy: unknown };
		expect(session.predictedPolicy).toBeNull();
	}, 60_000);
});

describe("H10 — the pre-analysis is shaped exactly as the own-move search", () => {
	it("the predicted position's pre-analysis carries the same root set the own move asks for, and the own move is a cache hit", async () => {
		const policy = fakePolicy();
		h = await createGameHarness({
			myColor: "b",
			gameId: "maia-shaped-symmetry",
			policy: policy.port,
			settings: { strength: { targetElo: 1200, matchOpponentRating: false } },
			// the cache's depth gate is `depthCap − 2`; the ponder's PVs carry a continuation so the
			// engine's best move for the predicted position is *known* before it is searched
			script: {
				prefer: new Map([[positionKey(CHESS_START_FEN), ["e2e4"]]]),
				depth: automaticDepthForElo(1200),
				pvDepth: 2,
			},
		});
		const inputs = tapPipeline(h);
		await h.arrive(); // white (the opponent) to move: ponder → predict e2e4 → pre-infer → pre-analyse
		expect(await h.until(() => policy.calls.length === 1, 5_000)).toBe(true);
		const shapedGo = (): string[] =>
			h.transport.goLines.filter((line) => line.includes("searchmoves"));
		expect(await h.until(() => shapedGo().length === 1, 5_000)).toBe(true);
		const query = policy.calls[0] as PolicyInferenceInputs;
		const preAnalysis = shapedGo()[0] ?? "";
		const roots = preAnalysis.slice(preAnalysis.indexOf("searchmoves ") + 12).split(" ");
		// the ponder line after e2e4 continues with the scripted engine's first legal reply
		const known = legalMoves(AFTER_E4)[0] as string;
		expect(roots).toEqual(shapedRootSet(answerFor(query), AFTER_E4, [known]));
		expect(roots).toContain(known);
		expect(preAnalysis).toContain(`depth ${automaticDepthForElo(1200)} `);

		// the opponent plays what was predicted: the held answer carries the known moves it was
		// shaped with, the pipeline builds the identical set, and no second shaped `go` is issued
		await h.arrive("e2e4");
		expect(await h.until(() => inputs.length === 1, 5_000)).toBe(true);
		expect(inputs[0]?.policyAnswer?.fen).toBe(AFTER_E4);
		expect(inputs[0]?.policyAnswer?.knownTopMoves).toEqual([known]);
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
		expect(shapedGo()).toHaveLength(1);
		const rec = h.session().recommendation();
		expect(rec?.lines.map((line) => line.pvUci[0]).sort()).toEqual([...roots].sort());
		expect(rec?.chosen.source).toBe("maia");
		expect(roots).toContain(rec?.chosen.uci ?? "");
	}, 60_000);
});

describe("H6.3 — one Maia size per game", () => {
	it("locks the size at the first move: an opponent-matched drift changes neither the warm nor the size; an explicit target change re-commits to the same (only) size without a new warm", async () => {
		const policy = fakePolicy();
		const warmed: number[] = [];
		h = await createGameHarness({
			myColor: "b",
			gameId: "maia-commit",
			policy: policy.port,
			warmPolicy: (targetElo) => warmed.push(targetElo),
			settings: {
				strength: { targetElo: 1200, matchOpponentRating: true, personaEloOffset: 0 },
			},
			script: { prefer: new Map([[positionKey(CHESS_START_FEN), ["e2e4"]]]) },
		});
		const inputs = tapPipeline(h);
		expect(await h.until(() => warmed.length === 1, 1_000)).toBe(true);
		expect(warmed).toEqual([1200]);
		await h.arrive();
		await h.arrive("e2e4"); // our first move is decided here: the size is locked
		expect(await h.until(() => inputs.length === 1, 5_000)).toBe(true);
		expect(inputs[0]?.maiaSize).toBe("79m");
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);

		// The opponent's rating arrives late and moves the target two bands up: nothing switches.
		await h.drive(() => h.site.opponent({ isBot: false, name: "them", ratingEstimate: 2100 }));
		await h.advance(50);
		expect(h.session().targetElo()).toBe(2100);
		expect(warmed).toEqual([1200]);

		// Our reply and the next opponent turn: the pre-inference still asks the committed size.
		const before = policy.calls.length;
		await h.drive(() => {
			h.site.board.submit("e7", "e5");
		});
		await h.arrive();
		expect(await h.until(() => policy.calls.length > before, 5_000)).toBe(true);
		expect(policy.calls.at(-1)?.size).toBe("79m");
		await h.arrive("g1f3");
		expect(await h.until(() => inputs.at(-1)?.snapshot.ply === 3, 5_000)).toBe(true);
		expect(inputs.at(-1)?.targetElo).toBe(2100);
		expect(inputs.at(-1)?.maiaSize).toBe("79m");

		// The user changes the stored target by hand: that is a new commitment and the target moves
		// — but since 2026-09-13 there is one size, so the re-commit lands on 79M again and the warm
		// (deduped on the size) asks for nothing. Before, 1500 re-committed to 23M and warmed it.
		await h.patch({ strength: { targetElo: 1500, matchOpponentRating: false } });
		await h.advance(50);
		expect(h.session().targetElo()).toBe(1500);
		expect(warmed).toEqual([1200]);
		expect(policy.calls.every((c) => c.size === "79m")).toBe(true);
	}, 90_000);
});

describe("H8 — the premove gate when the answer lands after the arm", () => {
	it("drops an armed premove the model gives under PREMOVE.maiaMinProb in the predicted position, keeps one it would play", async () => {
		h = await createGameHarness({
			myColor: "b",
			gameId: "maia-premove-gate",
			policy: fakePolicy().port,
			settings: { strength: { targetElo: 1200, matchOpponentRating: false } },
		});
		type Arm = { reply: string; chosen: ChosenMove; fen: string; reason: string };
		const session = h.session() as unknown as {
			premove: Arm | null;
			premoveEntry: unknown;
			gatePremoveWithPolicy(reply: string, predicted: string, result: PolicyResult): void;
		};
		const chosen: ChosenMove = {
			uci: "e7e5",
			san: "e5",
			from: "e7",
			to: "e5",
			source: "premove",
			rankInLines: 0,
			rationale: [],
		};
		const arm = (): Arm => ({ reply: "e2e4", chosen, fen: CHESS_START_FEN, reason: "loss2nd" });
		const answer = (p: number): PolicyResult => ({
			moves: [
				["e7e5", p],
				["c7c5", 1 - p],
			],
			wdl: [0.3, 0.4, 0.3],
			size: "79m",
		});
		session.premove = arm();
		session.gatePremoveWithPolicy("e2e4", AFTER_E4, answer(PREMOVE.maiaMinProb - 0.05));
		expect(session.premove).toBeNull();

		session.premove = arm();
		session.gatePremoveWithPolicy("e2e4", AFTER_E4, answer(PREMOVE.maiaMinProb + 0.05));
		expect(session.premove).not.toBeNull();

		// An answer for a different reply (another position) gates nothing.
		session.gatePremoveWithPolicy("d2d4", AFTER_E4, answer(0));
		expect(session.premove).not.toBeNull();
	});
});

describe("active policy eligibility and stale work", () => {
	// Owner, 2026-09-15: one division at the Maia cutoff. This started at 3100 in the removed prior
	// band and crossed its 3200 ceiling; it now starts at the cutoff itself and crosses that.
	it("pre-infers and warms Maia at the cutoff, then stops Maia after a matched target crosses it", async () => {
		const policy = fakePolicy({ hold: true });
		const warmTargets: number[] = [];
		h = await createGameHarness({
			myColor: "b",
			policy: policy.port,
			warmPolicy: (target) => warmTargets.push(target),
			settings: {
				strength: { targetElo: MAIA.eloMax, matchOpponentRating: true, personaEloOffset: 0 },
			},
			script: { prefer: new Map([[positionKey(CHESS_START_FEN), ["e2e4"]]]) },
		});
		await h.arrive();
		expect(await h.until(() => policy.calls.length > 0, 5000)).toBe(true);
		expect(warmTargets).toEqual([MAIA.eloMax]);
		expect(policy.calls[0]?.selfElo).toBeLessThanOrEqual(3000);
		await h.drive(() => h.site.opponent({ isBot: false, name: "higher", ratingEstimate: 3300 }));
		expect(policy.signals[0]?.aborted).toBe(true);
		const count = policy.calls.length;
		policy.release();
		await h.advance(1000);
		expect(policy.calls).toHaveLength(count);
		expect(warmTargets).toEqual([MAIA.eloMax, 3300]);
		const state = h.session() as unknown as {
			predictedPolicy: unknown;
			gameMaia: { size: string | null };
		};
		expect(state.predictedPolicy).toBeNull();
		expect(state.gameMaia.size).toBeNull();
	});

	it("rejects a late answer when only opponent conditioning changes on the same board", async () => {
		const policy = fakePolicy({ hold: true });
		h = await createGameHarness({
			myColor: "b",
			policy: policy.port,
			settings: { strength: { targetElo: 2800, matchOpponentRating: false } },
			script: { prefer: new Map([[positionKey(CHESS_START_FEN), ["e2e4"]]]) },
		});
		await h.arrive();
		expect(await h.until(() => policy.calls.length > 0, 5000)).toBe(true);
		const first = policy.calls[0];
		await h.drive(() => h.site.opponent({ isBot: false, name: "known", ratingEstimate: 2900 }));
		expect(h.session().targetElo()).toBe(2800);
		expect(policy.signals[0]?.aborted).toBe(true);
		policy.release();
		await h.advance(50);
		const state = h.session() as unknown as { predictedPolicy: { identity: string } | null };
		if (state.predictedPolicy) expect(state.predictedPolicy.identity).toContain("2900");
		expect(first?.oppoElo).not.toBe(2900);
	});

	it("re-enables the fixed model after an engine-only game has already made its first decision", async () => {
		const policy = fakePolicy();
		const warmed: number[] = [];
		h = await createGameHarness({
			myColor: "w",
			policy: policy.port,
			warmPolicy: (target) => warmed.push(target),
			settings: { strength: { targetElo: 3300, matchOpponentRating: true, personaEloOffset: 0 } },
		});
		await h.arrive();
		expect(await h.until(() => h.session().recommendation() !== null, 5000)).toBe(true);
		expect(policy.calls).toHaveLength(0);
		await h.drive(() => h.site.opponent({ isBot: false, name: "lower", ratingEstimate: 2800 }));
		expect(await h.until(() => policy.calls.length > 0, 5000)).toBe(true);
		expect(policy.calls.at(-1)?.size).toBe("79m");
		expect(warmed).toEqual([3300, 2800]);
		const state = h.session() as unknown as { gameMaia: { size: string | null } };
		expect(state.gameMaia.size).toBe("79m");
	});
});

describe("prepared holds preserve routing boundaries", () => {
	for (const targetElo of [3000, 3001, 3201]) {
		it(`holds at the actual ${targetElo} target with matching search provenance`, async () => {
			h = await createGameHarness({
				myColor: "b",
				policy: fakePolicy().port,
				settings: { strength: { targetElo, matchOpponentRating: false } },
				script: {
					prefer: new Map([[positionKey(CHESS_START_FEN), ["e2e4"]]]),
					depth: automaticDepthForElo(targetElo),
					pvDepth: 2,
				},
			});
			type Prepared = {
				fen: string;
				lines: EvalLine[];
				request: AnalysisRequest;
				bestmove: string | null;
				comparison?: AnalysisUpdate;
			};
			const state = h.session() as unknown as {
				snapshot: PositionSnapshot;
				predictedAnalysis: Prepared | null;
				validPredictedAnalysis(snapshot: PositionSnapshot): Prepared | null;
				readyMoveFrom(
					fen: string,
					lines: EvalLine[],
					snapshot: PositionSnapshot,
					request: AnalysisRequest,
					best: string | null,
					comparison?: AnalysisUpdate
				): ChosenMove | null;
			};
			await h.arrive();
			expect(await h.until(() => state.predictedAnalysis !== null, 5000)).toBe(true);
			const prepared = state.validPredictedAnalysis(state.snapshot);
			expect(prepared).not.toBeNull();
			if (!prepared) return;
			expect(prepared.request.targetElo).toBe(targetElo);
			expect(prepared.request.moves).toEqual(["e2e4"]);
			const chosen = state.readyMoveFrom(
				prepared.fen,
				prepared.lines,
				state.snapshot,
				prepared.request,
				prepared.bestmove,
				prepared.comparison
			);
			expect(chosen).not.toBeNull();
			const rationale = chosen?.rationale.join(" ") ?? "";
			// One division since 2026-09-15: 3001 was the removed prior band ("maia prior:"); it now
			// holds the plain engine move like every target above the cutoff.
			if (targetElo <= MAIA.eloMax) {
				expect(chosen?.source).toBe("maia");
				expect(rationale).not.toContain("maia prior:");
			} else {
				expect(chosen?.source).toBe("engine-elo");
				expect(rationale).not.toContain("maia prior:");
			}
			prepared.request.targetElo = targetElo - 1;
			expect(state.validPredictedAnalysis(state.snapshot)).toBeNull();
			prepared.request.targetElo = targetElo;
			prepared.request.limit.depth = 1;
			expect(state.validPredictedAnalysis(state.snapshot)).toBeNull();
		});
	}
});
