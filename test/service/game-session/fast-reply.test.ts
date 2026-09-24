import { describe, expect, it } from "bun:test";
import { LIMITS } from "@core/constants/limits";
import { SEARCH_BUDGET } from "@core/constants/search";
import { fastReplyBudget, isFastReply } from "@service/game-session/recommendation/fast-reply";
import type { RecommendationInput } from "@service/game-session/recommendation/types";
import type { ChosenMove } from "@typedefs/game";

const BEFORE_EXD5 = "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const AFTER_EXD5 = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";
const QUIET = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";

function input(
	over: Partial<RecommendationInput> & { fen?: string; ply?: number } = {}
): RecommendationInput {
	const { fen = AFTER_EXD5, ply = 3, ...rest } = over;
	return {
		snapshot: { fen, ply, timeControl: { baseMs: 180_000, incMs: 0 } },
		moves: ["e2e4", "d7d5", "e4d5"],
		priorFen: BEFORE_EXD5,
		targetElo: 2600,
		form: 0,
		...rest,
	} as unknown as RecommendationInput;
}

const book = (uci: string | null) => Promise.resolve(uci ? ({ uci } as ChosenMove) : null);
const never = () => new Promise<ChosenMove | null>(() => {});

describe("the fast-reply rule", () => {
	it("is a fast reply when the opponent's-turn analysis already rated the obvious recapture best", async () => {
		expect(await isFastReply(input({ ponderedAnswer: "d8d5" }), book(null))).toBe(true);
	});
	it("keeps the full search for a recapture nothing pondered, or pondered another answer", async () => {
		expect(await isFastReply(input(), book(null))).toBe(false);
		expect(await isFastReply(input({ ponderedAnswer: null }), book(null))).toBe(false);
		expect(await isFastReply(input({ ponderedAnswer: "g8f6" }), book(null))).toBe(false);
	});
	it("is a fast reply when the book answers in the opening", async () => {
		const i = input({ fen: QUIET, ply: 3, moves: ["e2e4", "e7e5", "g1f3"], priorFen: null });
		expect(await isFastReply(i, book("b8c6"))).toBe(true);
		expect(await isFastReply(i, book(null))).toBe(false);
	});
	it("does not wait long for a book that has not answered", async () => {
		const i = input({ fen: QUIET, ply: 3, moves: ["e2e4", "e7e5", "g1f3"], priorFen: null });
		const t0 = performance.now();
		expect(await isFastReply(i, never())).toBe(false);
		expect(performance.now() - t0).toBeLessThan(SEARCH_BUDGET.fastReplyBookWaitMs + 200);
	});
	it("leaves Maia's own opening choices and max strength alone", async () => {
		const low = input({
			fen: QUIET,
			ply: 3,
			moves: ["e2e4", "e7e5", "g1f3"],
			priorFen: null,
			targetElo: 1200,
		});
		expect(await isFastReply(low, book("b8c6"))).toBe(false);
		expect(
			await isFastReply(input({ targetElo: LIMITS.eloMax, ponderedAnswer: "d8d5" }), book(null))
		).toBe(false);
	});
	it("caps only the movetime, keeping the breadth and depth the cache keys on", () => {
		const budget = { movetimeMs: 600, depthCap: 20, multiPv: 12 };
		const capped = fastReplyBudget(budget, input());
		expect(capped).toEqual({ ...budget, movetimeMs: SEARCH_BUDGET.fastReplyMs.blitz });
		const short = { ...budget, movetimeMs: 150 };
		expect(fastReplyBudget(short, input())).toBe(short);
	});
});
