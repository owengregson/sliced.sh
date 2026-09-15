// test/service/game-session/board-effects-chips.test.ts — `Settings.automation.moveQualityChips`
// (settings layout, 2026-09-13): with the chips off the reporter posts the rays of every landed
// move and nothing else — no verdict is prepared, no search is issued, no chip follows later.
import { describe, expect, it } from "bun:test";
import type { GamePortCommand } from "@core/constants/messages";
import type { AnalysisRequest } from "@core/engine/types";
import { BoardEffectsReporter } from "@service/game-session/board-effects";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function reporter(
	chips: boolean | undefined,
	targetElo?: number
): {
	r: BoardEffectsReporter;
	posts: GamePortCommand[];
	searches: AnalysisRequest[];
} {
	const posts: GamePortCommand[] = [];
	const searches: AnalysisRequest[] = [];
	const r = new BoardEffectsReporter({
		searcher: () => ({
			analyse(req) {
				searches.push(req);
				return {
					id: req.id,
					stop: () => Promise.resolve(),
					result: new Promise(() => {}),
				} as never;
			},
		}),
		post: (cmd) => posts.push(cmd),
		...(targetElo === undefined ? {} : { getTargetElo: () => targetElo }),
		...(chips === undefined ? {} : { chips: () => chips }),
	});
	return { r, posts, searches };
}

const landed = (uci: string, mine: boolean) => ({
	beforeFen: START,
	historyFen: START,
	historyMoves: [],
	uci,
	ply: 0,
	mine,
});

describe("BoardEffectsReporter · moveQualityChips", () => {
	it("routes quality searches by the active target while preserving an unrestricted referee", () => {
		const { r, searches } = reporter(true, 3201);
		r.report({ moves: [landed("e2e4", true)], lines: [] });
		expect(searches.length).toBeGreaterThan(0);
		for (const search of searches) {
			expect(search.targetElo).toBe(3201);
			expect(search.elo).toBeUndefined();
		}
		r.dispose();
	});
	it("off: report posts the rays of each move with no quality and issues no search", () => {
		const { r, posts, searches } = reporter(false);
		r.prepare({ beforeFen: START, history: { fen: START, moves: [] }, uci: "e2e4", ply: 0 });
		expect(searches).toHaveLength(0);
		r.report({ moves: [landed("e2e4", true)], lines: [] });
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({ kind: "effects", mine: true });
		expect("quality" in (posts[0] as Record<string, unknown>)).toBe(false);
		expect(searches).toHaveLength(0);
		expect(r.stats().delivered).toBe(0);
		r.dispose();
	});

	it("on (or unspecified): a landed move without lines opens a verdict and searches for it", () => {
		for (const chips of [true, undefined]) {
			const { r, posts, searches } = reporter(chips);
			r.report({ moves: [landed("e2e4", true)], lines: [] });
			expect(posts).toHaveLength(1);
			expect(searches.length).toBeGreaterThan(0);
			r.dispose();
		}
	});
});
