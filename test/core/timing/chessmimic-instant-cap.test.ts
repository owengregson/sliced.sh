// test/core/timing/chessmimic-instant-cap.test.ts — fix C round 3: how often the head is allowed to
// answer `instant`, bounded by what humans actually do.
//
// Letting bucket 0 reach the plan (`chessmimic-head.ts`, 2026-09-10) gave the model its fast tail
// back, which it needed: it had been producing 0 instant plans in 2000. But the ChessMimic clock
// feature is partly a game-phase proxy and the model has no base-clock input, so a 10+0 game at
// 480 s — four fifths of its clock still on the board — reads to it like a 5+3 opening and it puts
// 85 % of its mass on bucket 0. Measured on a realistic 10+0 trajectory, plies 10–24 came out
// 50–85 % instant. Four opening moves in five fired off without a pause is a mechanical tell, and a
// worse one than the defect it replaced.
//
// So the instant share is capped, and the cap comes from the bands' own empirical priors rather than
// from taste: `buckets.json` carries `bucket_probabilities` measured over 1 000 000 real human blitz
// moves per band. An `instant` plan is `orientation + motor + U(0.05, 0.25) s`, so it reaches the page
// as a 0.7–1.1 s move — a bucket-0-or-1 move in the model's own terms. Humans play those
//
//   17.8 % of the time (1200–1300), 21.3 % (1500–1600), 24.7 % (1800–1900)
//
// so that share, per band, is the cap at a full clock. It then widens as the clock falls, driven by
// the same `urgencyFactor` the rest of the lane uses, because a human in time trouble really does play
// most moves in under two seconds — `cap = 1 − urgency · (1 − humanFastShare)`.
//
// Why the relative clock and not the phase: a 10+0 at 480 s and a 3+0 at 18 s are both middlegames,
// and 85 % instant is wrong in the first and right in the second. Phase cannot separate them; the
// fraction of the game's own clock that is left can, and does. The per-(speed, phase) cells are
// asserted below as a *consequence* of that cap, which is what the cap is for.
import { describe, expect, it } from "bun:test";
import { createRng } from "@core/rng";
import { CHESSMIMIC_BUCKETS } from "@core/timing/chessmimic-buckets";
import {
	ChessMimicHead,
	humanFastShare,
	type InferResult,
	instantShareCap,
} from "@core/timing/chessmimic-head";
import { computeFeatures } from "@core/timing/features";
import { urgencyFactor } from "@core/timing/pressure";
import { freshState } from "@core/timing/timing-model";
import type { Features, Persona, TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { ctx } from "./helpers";

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
 * Realised shares over `n` samples of one prepared position. `instant` and `premove` are reported
 * apart because only the first is capped: a premove is a §7.4 decision about a move that can be
 * entered before the opponent replies, and the cap has no business touching it.
 */
async function sharesOf(
	c: TimingContext,
	n = 3000,
	seed = "cap"
): Promise<{ instant: number; premove: number; fast: number }> {
	const h = headWith(heavyBucketZero());
	await h.prepare(c);
	const f = computeFeatures(c);
	const st = freshState("g");
	st.fen = c.fen;
	const rng = createRng(seed);
	let instant = 0;
	let premove = 0;
	for (let i = 0; i < n; i++) {
		const s = h.sample(f, persona, st, rng, 1);
		if (s.mode === "instant") instant++;
		else if (s.mode === "premove") premove++;
	}
	return { instant: instant / n, premove: premove / n, fast: (instant + premove) / n };
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

describe("instantShareCap", () => {
	it("is the band's human fast share on a full clock, at every speed", () => {
		for (const baseSec of [60, 180, 600]) {
			const f = featuresFor({ baseSec, myClockMs: baseSec * 1000, oppClockMs: baseSec * 1000 });
			expect(instantShareCap(f, "1500_1600"), `${baseSec}s`).toBeCloseTo(
				humanFastShare("1500_1600"),
				12
			);
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
				const cap = instantShareCap(f, "1500_1600");
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
				expect(instantShareCap(f, "1500_1600"), `${baseSec}s at ${fraction}`).toBeCloseTo(
					1 - urgencyFactor(f) * (1 - humanFastShare("1500_1600")),
					12
				);
			}
	});
});

describe("ChessMimicHead: the realised instant share respects the cap", () => {
	it("thins a 90 %-bucket-0 distribution down to the cap on a full clock", async () => {
		// The mutation that kills this case is removing the cap: the realised share goes to 0.9.
		const c = ctx({ baseSec: 180, myClockMs: 180_000, oppClockMs: 180_000 });
		const f = computeFeatures(c);
		expect(f.premove_eligible).toBe(0);
		const cap = instantShareCap(f, "1500_1600");
		const { instant } = await sharesOf(c);
		expect(instant).toBeLessThanOrEqual(cap * 1.15);
		// and it is not thinned to nothing: the fast tail is still there
		expect(instant).toBeGreaterThanOrEqual(cap * 0.7);
	});

	it("no (speed class, game phase) cell is dominated by instant plans on a full clock", async () => {
		// The property the cap exists for, stated per cell. A full clock is the worst case: that is
		// where the cap is tightest and where a 10+0 opening was reading 85 %.
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
				// `chosenMove` is deliberately the *second* line, so `in_book` is 0 and the position is
				// not premove-eligible: this case is about the capped channel. The uncapped one — a book
				// move, a recapture, a ponder hit, the only legal move — is the case below.
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
				const { instant, premove } = await sharesOf(c, 2000, `${speed}-${phaseName}`);
				expect(premove).toBe(0);
				rows.push(`${speed}/${f.phase} ${(100 * instant).toFixed(1)} %`);
				expect(instant, `${speed}/${phaseName}`).toBeLessThanOrEqual(
					instantShareCap(f, "1500_1600") * 1.15
				);
				// "cannot dominate" in the plainest sense
				expect(instant, `${speed}/${phaseName}`).toBeLessThan(0.5);
			}
		console.log(`instant share by cell, full clock, 90 % bucket-0 mass: ${rows.join(" · ")}`);
	});

	it("still lets a game in real time trouble play fast", async () => {
		// The other half: the cap must not clip the regime the owner asked to be quicker.
		const c = ctx({ baseSec: 180, myClockMs: 18_000, oppClockMs: 18_000 });
		const f = computeFeatures(c);
		expect(instantShareCap(f, "1500_1600")).toBeGreaterThan(0.5);
		expect((await sharesOf(c, 2000, "trouble")).instant).toBeGreaterThan(0.5);
	});

	it("the first move of the game is exempt, and stays fast at every speed", async () => {
		// The interaction the owner's report makes load-bearing: "realistically we should make first
		// move really quickly". Ply 0 is an opening-book move (`in_book`, so §7.4-eligible), which means
		// it goes down the *premove* branch and the cap never sees it. A cap that stopped a 10+0 opening
		// being 50–85 % instant must not also stop 1.e4 being immediate — so that is asserted here, per
		// speed class, and it is the case that fails if the cap is ever applied to the eligible channel.
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
			expect(f.premove_eligible, speed).toBe(1);
			const { instant, premove, fast } = await sharesOf(c, 2000, `first-${speed}`);
			rows.push(
				`${speed} fast ${(100 * fast).toFixed(1)} % (premove ${(100 * premove).toFixed(1)} %, instant ${(100 * instant).toFixed(1)} %)`
			);
			// Every draw that lands in bucket 0 comes back fast here — nothing is thinned away — and
			// bucket 0 carries 90 % of this fixture's mass.
			expect(fast, speed).toBeGreaterThan(0.8);
		}
		console.log(`first move of the game, 90 % bucket-0 mass: ${rows.join(" · ")}`);
	});
});
