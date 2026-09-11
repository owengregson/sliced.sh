// test/core/timing/first-move-floor.test.ts — fix C round 4, hand-off 1: a `premove`-mode plan is only
// honourable when a move really was pre-entered, and at our first move of a game nothing was.
//
// `premove` mode skips `boundByCap` and the physical floor (`if (mode === "premove") totalS = tSec`),
// and `allocateWindow` hands the plan `approachMs = thinkMs` with zero orientation — on the premise
// that the hand is already on the piece, pre-positioned during the opponent's think.
//
// Nothing pre-positions the hand from that mode. The only readers of `plan.mode === "premove"` are
// `move-window.ts` (the window split), `preview-select.ts` (no previews) and the panel's copy; the
// executor's premove path is keyed on `rec.chosen.source === "premove"`, a different quantity. So the
// mode on its own produces a **100–220 ms whole move from a cold start** — measured p50 157 ms at
// ply 0 on the real ONNX bands (review hand-off 1) — against the brief's own 400–900 ms for approach,
// press, drag and release. No hand can do that.
//
// It was reachable because `premove_eligible` is `ponder_hit || is_recapture || in_book ||
// is_only_legal`, and the last three say a premove would have been *reasonable to enter*, not that one
// *was* entered. `in_book` alone made it reachable at ply 0, and again at ply 2 with no prediction at
// all. The condition that actually means "we were waiting on this position with the move entered" is
// `ponder_hit`: we predicted the reply and the opponent played it. Appendix D §3a.5's premove logit is
// untouched; what is gated is whether the resulting mode is physically honourable.
//
// This also closes a hole an existing assertion was guarding by luck:
// `test/behavioral/game/premove.test.ts`'s "an unexpected reply is analysed normally — no premove is
// played" passes on its own seed and fails on 4 of 5 other seeds on `2c6b7d3` (measured), because
// `forbidPremove` only covers the `replan("opponent-moved")` path and a session re-entering through
// `onPosition` → `runPipeline` reaches `planMove` with it false.
import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { createRng, type Rng } from "@core/rng";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { TimingModel } from "@core/timing/timing-model";
import type {
	DistributionHead,
	Features,
	GameMeta,
	GameTimingState,
	HeadSample,
	Persona,
} from "@core/timing/types";
import { ctx } from "./helpers";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** A head that always wants a premove — the worst case for this floor. */
class AlwaysPremoveHead implements DistributionHead {
	readonly id = "chessmimic" as const;
	median(): number {
		return TIMING_CONSTANTS.premove.maxS;
	}
	sample(_f: Features, _p: Persona, _st: GameTimingState, rng: Rng): HeadSample {
		return { tSec: rng.next() * TIMING_CONSTANTS.premove.maxS, mode: "premove", why: [] };
	}
}

const meta: GameMeta = {
	targetElo: 1650,
	profile: "balanced",
	baseSec: 180,
	incSec: 0,
	site: "chesscom",
	gameId: "first-move",
};

/** Ply 0 as white: in book, so `premove_eligible` is 1 and the premove branch is reachable. */
function firstMove(over: Partial<Parameters<typeof ctx>[0]> = {}) {
	return ctx({
		fen: START_FEN,
		ply: 0,
		moves: [],
		chosenMove: "e2e4",
		lines: [
			{ multipv: 1, score: { cp: 20 }, depth: 10, pvUci: ["e2e4"], pvSan: [] },
			{ multipv: 2, score: { cp: 10 }, depth: 10, pvUci: ["d2d4"], pvSan: [] },
		],
		myThinkMsHistory: [],
		oppThinkMsHistory: [],
		...over,
	});
}

function model(seed: string) {
	const m = new TimingModel(new AlwaysPremoveHead(), DEFAULT_SETTINGS.timing, createRng(seed));
	m.startGame(meta);
	return m;
}

/** The hand's own floor for a non-premove window: orientation + minimal motor. */
const PHYSICAL_FLOOR_MS = TIMING_CONSTANTS.orientation.minMs + TIMING_CONSTANTS.motor.minMotorMs;

describe("a premove-mode plan requires that a move really was pre-entered", () => {
	it("converts a premove-mode sample to instant, and takes the hand's physical time", () => {
		const m = model("first");
		for (let i = 0; i < 200; i++) {
			const plan = m.planMove(firstMove({ nowMs: 1_000_000 + i }));
			expect(plan.mode).not.toBe("premove");
			// the review's measured defect: a 100-220 ms whole move from a cold start
			expect(plan.thinkMs).toBeGreaterThanOrEqual(PHYSICAL_FLOOR_MS);
			// and the hand really does get an approach and an orientation, not `approachMs = thinkMs`
			expect(plan.orientationMs).toBeGreaterThanOrEqual(TIMING_CONSTANTS.orientation.minMs);
			expect(plan.window.approachMs).toBeLessThan(plan.thinkMs);
		}
	});

	it("is still fast — the intent survives, only the physics is added", () => {
		// It must not become a think: `instant` is `orientation + motor + U(0.05, 0.25) s`.
		const m = model("fast");
		const ts: number[] = [];
		for (let i = 0; i < 200; i++) ts.push(m.planMove(firstMove({ nowMs: 1_000_000 + i })).thinkMs);
		const sorted = [...ts].sort((a, b) => a - b);
		const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
		expect(median).toBeLessThan(2000);
	});

	it("a ponder hit mid-game keeps premove mode — but the plan still clears the physical floor", () => {
		// Two assertions that have to hold together, and review Important 4 found the second one missing:
		// this must not disable premoves generally (§7.4's whole point is the move entered during the
		// opponent's think, and `ponder_hit` says the reply was predicted and played), **and** the plan
		// must still be physically deliverable. It was not: with `ponder_hit = 1` the premove branch
		// produced a 100–209 ms whole move, p50 154 ms, `approachMs = thinkMs`, orientation 0 — the same
		// signature the ponder-hit gate removed for the no-prediction case.
		//
		// `ponder_hit` is a proxy: the only thing that actually enters a move is the session's §7.4 path,
		// which sets `chosen.source = "premove"` and builds its own plan in `session.ts` — it never
		// reaches `planMove` (verified: `source: "premove"` is assigned only inside `tryPremove`). So a
		// premove-mode plan out of `planMove` is a hovered hand that has not pressed, and press + drag +
		// release still cost the physical floor.
		const m = model("later");
		let premoves = 0;
		for (let i = 0; i < 400; i++) {
			const plan = m.planMove(
				firstMove({
					ply: 4,
					moves: ["e2e4", "e7e5", "g1f3", "b8c6"],
					expectedOppReply: "b8c6",
					myThinkMsHistory: [1200],
					nowMs: 1_000_000 + i,
				})
			);
			if (plan.mode === "premove") premoves++;
			expect(plan.thinkMs).toBeGreaterThanOrEqual(PHYSICAL_FLOOR_MS);
		}
		expect(premoves).toBeGreaterThan(0);
	});

	it("an in-book position with no prediction is not a premove either — ply 2, the other cold start", () => {
		// The second reachable cold start, and the one an existing behavioural assertion was guarding by
		// luck: `in_book` alone made `premove_eligible` 1 at ply 2 with `expectedOppReply` null, so the
		// plan came back `premove p=0.52` and a ~150 ms flick went to the page.
		const m = model("ply2");
		for (let i = 0; i < 200; i++) {
			const plan = m.planMove(
				firstMove({
					ply: 2,
					moves: ["e2e4", "e7e5"],
					expectedOppReply: null,
					myThinkMsHistory: [900],
					nowMs: 1_000_000 + i,
				})
			);
			expect(plan.mode).not.toBe("premove");
			expect(plan.thinkMs).toBeGreaterThanOrEqual(PHYSICAL_FLOOR_MS);
		}
	});
});
