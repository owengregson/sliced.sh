// test/content/adapters/page-kind.test.ts
import { describe, expect, it } from "bun:test";
import { pageKindFromPath } from "@content/adapters/page-kind";
import type { PageKind } from "@typedefs/game";

describe("pageKindFromPath (Appendix C §1.1)", () => {
	const table: Array<[string, PageKind]> = [
		["/game/live/173765478164", "live-game"],
		// the URL a real live game actually has (owner's capture, 2026-09-09)
		["/game/174252022572", "live-game"],
		["/game/174252022572/", "live-game"],
		// an archived game is not a live session
		["/games/view/173765478164", "other"],
		["/games/archive", "other"],
		["/play/online", "live-lobby"],
		["/play/online/new", "live-lobby"],
		["/play/online/watch", "live-lobby"],
		["/live", "live-lobby"],
		["/live#g=123", "live-lobby"],
		["/play/computer", "vs-computer"],
		["/play/computer/nelson", "vs-computer"],
		["/play/bots", "vs-computer"],
		["/play/bots/nelson", "vs-computer"],
		["/game/daily/12345", "daily"],
		["/daily/game/1", "daily"],
		["/analysis", "analysis"],
		["/analysis/game/live/173765478164", "analysis"],
		["/analysis/game/pgn/abc", "analysis"],
		["/puzzles", "puzzles"],
		["/puzzles/rated", "puzzles"],
		["/puzzles/rush", "puzzles"],
		["/puzzles/battle", "puzzles"],
		["/variants/crazyhouse", "other"],
		["/", "other"],
		["/member/hikaru", "other"],
	];
	for (const [p, kind] of table) {
		it(`${p} → ${kind}`, () => {
			expect(pageKindFromPath(p)).toBe(kind);
		});
	}
});
