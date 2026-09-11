// test/core/timing/chessmimic-instant-cap.test.ts — fix C round 4: how often the head is allowed to
// send a move to the page fast, bounded by what humans actually do.
//
// Letting bucket 0 reach the plan (`f96c13f`) gave the model its fast tail back, which it needed: it
// had been producing 0 instant plans in 2000. Round 3 bounded that channel at the band's human
// sub-2-second rate. Review found two things wrong with that, both about *what the number is a number
// of*, and round 4 fixes them:
//
//   1. the anchor bounded a subset at the superset's rate. `humanFastShare` is the human rate of moves
//      reaching the board inside `fastMoveMaxS`; round 3 applied it to the bucket-0 channel alone,
//      while bucket-1 draws reach the page under two seconds too. Measured on the real ONNX bands at
//      the cap's own motivating case (10+0, 480 s, off book), bucket 1 carries 49.1 % of the model's
//      mass, and the page saw 61.6 % of moves under two seconds against a 21.3 % anchor;
//   2. it was a **per-position ceiling** derived from a **marginal over positions**, which is a
//      category error. A marginal does not license a per-position ceiling of the same value: a
//      calibrated model is supposed to say "this position is obvious" sometimes.
//
// Both are fixed by moving the budget to where the anchor lives. `fastPlanShare` reads this game's own
// realised share of plans that came in under `fastMoveMaxS` — straight off `state.plannedMs`, which is
// the page-visible think time, not a proxy — and the fast channel is closed while that share is over
// `fastShareCap`. So the quantity bounded is the one the anchor measures (moves reaching the page
// fast), at the aggregation the anchor has (a rate over positions), and the per-position conditional
// is left alone, which is the model's job.
//
// Three properties fall out of that shape, and each is asserted below:
//
//   * it is measured at the **plan**, so `sampleGuarded`'s CV-guard redraws — which gave every
//     rejected draw another chance at `instant` and leaked up to +10 pp past the round-3 head-level
//     cap — are inside the controlled loop rather than outside it;
//   * the **first move of a game is always allowed**, with no exemption written anywhere: an empty
//     `plannedMs` is a realised share of 0, which is under every cap. That replaces round 3's blanket
//     §7.4-eligibility exemption, which covered plies 0–15 whenever we played the top move and left
//     the 10+0 opening uncapped for the first eight of our moves;
//   * a game is never pushed **below** the budget, so the owner's "the bot never comes up with the
//     move instantly" stays fixed wherever the game has room.
import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { createRng } from "@core/rng";
import { CHESSMIMIC_BUCKETS } from "@core/timing/chessmimic-buckets";
import {
	ChessMimicHead,
	fastAddedShare,
	fastShareCap,
	humanFastShare,
	type InferResult,
} from "@core/timing/chessmimic-head";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { computeFeatures } from "@core/timing/features";
import { urgencyFactor } from "@core/timing/pressure";
import { freshState, TimingModel } from "@core/timing/timing-model";
import type { Features, GameMeta, Persona, TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { AFTER_EXD5, ctx } from "./helpers";

const persona: Persona = { s_game: 0, iota: 0.5, pi_p: 0, tau: 0.65, rho_mirror: 0.15, motor_k: 1 };

/** An endgame: four pawns and a rook each, so non-pawn material is under `ENDGAME_MATERIAL`. */
const ENDGAME_FEN = "4k3/pppp4/8/8/8/8/PPPP4/R3K2R w KQ - 0 30";
/** A middlegame with every piece still on (the shared fixture), and an opening position. */
const OPENING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Nearly all the mass on bucket 0: the worst case the cap has to hold. */
function heavyBucketZero(): number[] {
	const p = new Array<number>(30).fill(0);
	p[0] = 0.9;
	p[5] = 0.1;
	return p;
}

function headWith(probs: number[], band = "1500_1600"): ChessMimicHead {
	const res: InferResult = { probs, band };
	return new ChessMimicHead({
		infer: () => Promise.resolve(res),
		fallback: new V1ParametricHead(),
	});
}

/**
 * Realised shares **at the plan**, over games of `movesPerGame` moves — which is where the page reads
 * them, and the level review found the round-3 head-level assertion was missing by up to +10 pp
 * (`sampleGuarded` re-draws up to `cvGuard.maxResamples` times and `break`s on `instant`, so every
 * rejected draw got another chance at it).
 *
 * `instant` and `premove` are reported apart because only the first is budgeted: a premove is a §7.4
 * decision about a move that can be entered before the opponent replies, and the budget has no
 * business touching it. `underFast` is the quantity the anchor actually names — the share of plans
 * that reach the page inside `fastMoveMaxS`.
 */
async function planShares(
	c: TimingContext,
	n = 3000,
	seed = "cap",
	movesPerGame = 40
): Promise<{ instant: number; premove: number; fast: number; underFast: number }> {
	const h = headWith(heavyBucketZero());
	const m = new TimingModel(h, DEFAULT_SETTINGS.timing, createRng(seed));
	const meta: GameMeta = {
		targetElo: 1650,
		profile: "balanced",
		baseSec: c.baseSec,
		incSec: c.incSec,
		site: "chesscom",
		gameId: "g",
	};
	let instant = 0;
	let premove = 0;
	let underFast = 0;
	const fastMs = TIMING_CONSTANTS.chessmimic.fastMoveMaxS * 1000;
	for (let i = 0; i < n; i++) {
		if (i % movesPerGame === 0) {
			m.startGame({ ...meta, gameId: `${seed}-${i}` });
			await m.prepare(c);
		}
		const plan = m.planMove(c);
		if (plan.mode === "instant") instant++;
		else if (plan.mode === "premove") premove++;
		if (plan.thinkMs < fastMs) underFast++;
	}
	return {
		instant: instant / n,
		premove: premove / n,
		fast: (instant + premove) / n,
		underFast: underFast / n,
	};
}

function featuresFor(over: Partial<TimingContext>): Features {
	return computeFeatures(ctx(over));
}

describe("the human fast share, read off the bands' own priors", () => {
	it("is bucket 0 + bucket 1 of the band's empirical prior — 1 000 000 real blitz moves a band", () => {
		// Pinned to the data, not transcribed: if `buckets.json` is re-exported the cap tracks it.
		for (const band of ["1200_1300", "1500_1600", "1800_1900"] as const) {
			const prior = CHESSMIMIC_BUCKETS[band].bucket_probabilities;
			expect(humanFastShare(band)).toBeCloseTo((prior[0] ?? 0) + (prior[1] ?? 0), 12);
		}
		// the shipped band's value, so a silent change to the derivation is visible here
		expect(humanFastShare("1500_1600")).toBeGreaterThan(0.2);
		expect(humanFastShare("1500_1600")).toBeLessThan(0.22);
		// stronger players snap more often — the data says so, and the cap follows it
		expect(humanFastShare("1200_1300")).toBeLessThan(humanFastShare("1500_1600"));
		expect(humanFastShare("1500_1600")).toBeLessThan(humanFastShare("1800_1900"));
	});
});

describe("fastShareCap", () => {
	it("is the band's human fast share on a full clock, at every speed", () => {
		for (const baseSec of [60, 180, 600]) {
			const f = featuresFor({ baseSec, myClockMs: baseSec * 1000, oppClockMs: baseSec * 1000 });
			expect(fastShareCap(f, "1500_1600"), `${baseSec}s`).toBeCloseTo(humanFastShare("1500_1600"), 12);
		}
	});

	it("widens as the clock falls — time trouble is when humans really do play fast", () => {
		for (const baseSec of [60, 180, 600]) {
			let previous = 0;
			for (const fraction of [1, 0.8, 0.6, 0.4, 0.2, 0.1, 0]) {
				const f = featuresFor({
					baseSec,
					myClockMs: baseSec * fraction * 1000,
					oppClockMs: baseSec * fraction * 1000,
				});
				const cap = fastShareCap(f, "1500_1600");
				expect(cap, `${baseSec}s at ${fraction}`).toBeGreaterThanOrEqual(previous);
				expect(cap).toBeLessThan(1);
				previous = cap;
			}
		}
	});

	it("is `1 − urgency · (1 − humanFastShare)`, so it means the same thing at every speed", () => {
		for (const baseSec of [60, 180, 600])
			for (const fraction of [1, 0.5, 0.25, 0.1]) {
				const f = featuresFor({
					baseSec,
					myClockMs: baseSec * fraction * 1000,
					oppClockMs: baseSec * fraction * 1000,
				});
				expect(fastShareCap(f, "1500_1600"), `${baseSec}s at ${fraction}`).toBeCloseTo(
					1 - urgencyFactor(f) * (1 - humanFastShare("1500_1600")),
					12
				);
			}
	});
});

describe("fastAddedShare: the budget is this game's own realised rate for the added channel", () => {
	it("is 0 on an empty history — which is why the first move of a game is always allowed", () => {
		// Round 3 needed an explicit §7.4-eligibility exemption to keep 1.e4 instant, and that exemption
		// covered plies 0-15 whenever we played the top move. This replaces it with nothing at all: a
		// game with no plans yet has a realised rate of 0, which is under every budget.
		expect(fastAddedShare(freshState("g"))).toBe(0);
	});

	it("counts only the added channel, over every plan", () => {
		const st = freshState("g");
		st.plannedMs.push(100, 100, 100, 100);
		st.fastAdded = 2;
		expect(fastAddedShare(st)).toBeCloseTo(0.5, 12);
		st.fastAdded = 3;
		expect(fastAddedShare(st)).toBeCloseTo(0.75, 12);
		// plans that did NOT come from the added channel are in the denominator only — a game full of
		// the model's own bucket-1 moves does not consume the lane's budget, which is what stopped the
		// actuator saturating.
		st.plannedMs.push(100, 100, 100, 100);
		expect(fastAddedShare(st)).toBeCloseTo(0.375, 12);
	});
});

describe("ChessMimicHead: the realised page-level fast share respects the budget", () => {
	it("holds a 90 %-bucket-0 distribution to the budget at the plan, not just at the head", async () => {
		// The mutation that kills this case is removing the budget: the realised share goes to ~0.9.
		// Asserted at `planMove`, so `sampleGuarded`'s redraws are inside the loop being measured.
		const c = ctx({ baseSec: 180, myClockMs: 180_000, oppClockMs: 180_000 });
		const f = computeFeatures(c);
		expect(f.premove_eligible).toBe(0);
		const cap = fastShareCap(f, "1500_1600");
		const { underFast, instant } = await planShares(c);
		expect(underFast).toBeLessThanOrEqual(cap * 1.06);
		// and the fast tail is still there rather than thinned to nothing
		expect(instant).toBeGreaterThan(0.15);
	});

	it("no (speed class, game phase) cell exceeds the budget at the plan, on a full clock", async () => {
		const rows: string[] = [];
		for (const [speed, baseSec] of [
			["bullet", 60],
			["blitz", 180],
			["rapid", 600],
		] as const)
			for (const [phaseName, fen, ply] of [
				["opening", OPENING_FEN, 4],
				["middlegame", ctx().fen, 40],
				["endgame", ENDGAME_FEN, 60],
			] as const) {
				// `chosenMove` is the second line on purpose: `in_book` is 0, so this measures the
				// budgeted channel rather than §7.4's.
				const c = ctx({
					fen,
					ply,
					chosenMove: "a2a4",
					baseSec,
					myClockMs: baseSec * 1000,
					oppClockMs: baseSec * 1000,
				});
				const f = computeFeatures(c);
				expect(f.premove_eligible, `${speed}/${phaseName}`).toBe(0);
				const { underFast, premove } = await planShares(c, 2000, `${speed}-${phaseName}`);
				expect(premove).toBe(0);
				rows.push(`${speed}/${f.phase} ${(100 * underFast).toFixed(1)} %`);
				expect(underFast, `${speed}/${phaseName}`).toBeLessThanOrEqual(
					fastShareCap(f, "1500_1600") * 1.06
				);
				// "cannot dominate" in the plainest sense
				expect(underFast, `${speed}/${phaseName}`).toBeLessThan(0.5);
			}
		console.log(`plan-level share under fastMoveMaxS by cell, full clock: ${rows.join(" · ")}`);
	});

	it("never slower than pre-lane: over budget, the added channel falls back to what 2c6b7d3 did", async () => {
		// The assertion review M1 and m11 asked for, and the one that would have caught round 4's
		// 15-of-60 never-slower breach. The property is structural rather than statistical: the budget's
		// *closed* path is the pre-lane path, so a closed budget cannot be slower than `2c6b7d3`, and its
		// open path returns `instant`, which is faster. Both halves are asserted here.
		const c = ctx({ baseSec: 180, myClockMs: 180_000, oppClockMs: 180_000, chosenMove: "a2a4" });
		const f = computeFeatures(c);
		expect(f.premove_eligible).toBe(0);
		const h = headWith(heavyBucketZero());
		await h.prepare(c);
		const rng = createRng("never-slower");

		// A game far over its budget: every draw from the added channel must come back as a bucket ≥ 1
		// sample — which is exactly, and only, what the pre-lane branch produced for this position.
		const over = freshState("g");
		over.fen = c.fen;
		over.plannedMs.push(...new Array<number>(20).fill(1000));
		over.fastAdded = 20;
		expect(fastAddedShare(over)).toBeGreaterThan(fastShareCap(f, "1500_1600"));
		let rejected = 0;
		for (let i = 0; i < 400; i++) {
			const sample = h.sample(f, persona, over, rng, 1);
			expect(sample.addedFast).toBeUndefined();
			expect(sample.mode === "normal" || sample.mode === "long").toBe(true);
			if (sample.why.join(" ").includes("over the fast budget")) rejected++;
		}
		// bucket 0 carries 90 % of this fixture, and every one of those draws was turned away; the rest
		// never entered the branch at all (they drew bucket 5 directly).
		expect(rejected / 400).toBeGreaterThan(0.8);

		// And under budget it is the faster path, marked so `planMove` can count it.
		const under = freshState("g");
		under.fen = c.fen;
		let added = 0;
		for (let i = 0; i < 400; i++) {
			const sample = h.sample(f, persona, under, rng, 1);
			if (sample.addedFast === true) {
				added++;
				expect(sample.mode).toBe("instant");
			}
		}
		expect(added).toBeGreaterThan(0);
	});

	it("never slower than pre-lane: the §7.4-eligible channel is not budgeted at all", async () => {
		// The other half of the breach: round 4 budgeted this channel, and because `2c6b7d3` returned
		// `instant` here unconditionally, budgeting it made the in-book opening of every time control
		// slower than the build the owner played. It is ungated again, and that is asserted against a
		// state that is far over budget.
		const c = ctx({
			fen: AFTER_EXD5,
			myColor: "b",
			ply: 3,
			moves: ["e2e4", "d7d5", "e4d5"],
			expectedOppReply: "e4d5",
			chosenMove: "d8d5",
			lines: [
				{ multipv: 1, score: { cp: -10 }, depth: 10, pvUci: ["d8d5"], pvSan: [] },
				{ multipv: 2, score: { cp: -60 }, depth: 10, pvUci: ["g8f6"], pvSan: [] },
			],
		});
		const f = computeFeatures(c);
		expect(f.premove_eligible).toBe(1);
		const h = headWith(heavyBucketZero());
		await h.prepare(c);
		const over = freshState("g");
		over.fen = c.fen;
		over.plannedMs.push(...new Array<number>(20).fill(1000));
		over.fastAdded = 20;
		expect(fastAddedShare(over)).toBeGreaterThan(fastShareCap(f, "1500_1600"));
		const rng = createRng("eligible-ungated");
		let fast = 0;
		for (let i = 0; i < 400; i++) {
			const sample = h.sample(f, persona, over, rng, 1);
			// never counted against the budget, whatever the game has done
			expect(sample.addedFast).toBeUndefined();
			if (sample.mode === "instant" || sample.mode === "premove") fast++;
		}
		// bucket 0 carries 90 % of this fixture, and all of it still gets through
		expect(fast / 400).toBeGreaterThan(0.8);
	});

	it("still lets a game in real time trouble play fast", async () => {
		// The other half: the budget must not clip the regime the owner asked to be quicker.
		const c = ctx({ baseSec: 180, myClockMs: 18_000, oppClockMs: 18_000 });
		const f = computeFeatures(c);
		expect(fastShareCap(f, "1500_1600")).toBeGreaterThan(0.5);
		expect((await planShares(c, 2000, "trouble")).underFast).toBeGreaterThan(0.5);
	});

	it("the first move of the game is fast at every speed, with no exemption in the code", async () => {
		// "realistically we should make first move really quickly" — and the property is now structural:
		// the budget is a function of this game's own history, and at ply 0 there is none. Measured as
		// the *first* plan of a fresh game, which is the only move the owner's report is about.
		const rows: string[] = [];
		for (const [speed, baseSec] of [
			["bullet", 60],
			["blitz", 180],
			["rapid", 600],
		] as const) {
			const c = ctx({
				fen: OPENING_FEN,
				ply: 0,
				moves: [],
				chosenMove: "d2d4",
				baseSec,
				myClockMs: baseSec * 1000,
				oppClockMs: baseSec * 1000,
			});
			const f = computeFeatures(c);
			expect(f.in_book, speed).toBe(1);
			const { fast } = await planShares(c, 1200, `first-${speed}`, 1);
			rows.push(`${speed} ${(100 * fast).toFixed(1)} %`);
			// bucket 0 carries 90 % of this fixture's mass and a first move is never budgeted away
			expect(fast, speed).toBeGreaterThan(0.8);
		}
		console.log(`first move of the game, 90 % bucket-0 mass: ${rows.join(" · ")}`);
	});
});
