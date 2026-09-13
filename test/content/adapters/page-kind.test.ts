// test/content/adapters/page-kind.test.ts
import { describe, expect, it } from "bun:test";
import { isLobbyPath, pageKindFromPath } from "@content/adapters/page-kind";
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

// The queue screen before a game has been queued (owner, 2026-09-13): exactly `/play/online`,
// "no other url". The page kind is `live-lobby` for the whole `/play/online/…` family and for
// `/live`, and the bridge refines it to `live-game` once the board's game object answers — so
// this predicate is the one URL fact the service worker's lobby hold rests on.
describe("isLobbyPath (the exact /play/online queue screen)", () => {
	const table: Array<[string, boolean]> = [
		["/play/online", true],
		["/play/online/", true],
		["/play/online?tab=friends", true],
		["/play/online#queue", true],
		["/play/online/new", false],
		["/play/online/watch", false],
		["/play/onlinex", false],
		["/live", false],
		["/play/computer", false],
		["/game/live/173765478164", false],
		["/game/174252022572", false],
		["/", false],
	];
	for (const [p, lobby] of table) {
		it(`${p} → ${lobby}`, () => {
			expect(isLobbyPath(p)).toBe(lobby);
		});
	}
});
