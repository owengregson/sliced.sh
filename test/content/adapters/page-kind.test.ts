// test/content/adapters/page-kind.test.ts
import { describe, expect, it } from "bun:test";
import { detectChesscomPageKind, detectLichessPageKind } from "@content/adapters/page-kind";
import { createTabDom } from "@test/sim/dom/tab-dom";
import type { PageKind } from "@typedefs/game";
import { loadFixture, pageDocument } from "./helpers";

describe("detectChesscomPageKind (Appendix C §1.1)", () => {
	const table: Array<[string, PageKind]> = [
		["/game/live/173765478164", "live-game"],
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
			expect(detectChesscomPageKind(p)).toBe(kind);
		});
	}
});

describe("detectLichessPageKind (Appendix C §2.1)", () => {
	const urlTable: Array<[string, PageKind]> = [
		["/abcdefgh1234", "live-game"],
		["/abcdefgh", "live-game"],
		["/abcdefgh/white", "live-game"],
		["/abcdefgh/black", "live-game"],
		["/analysis", "analysis"],
		["/analysis/chess960", "analysis"],
		["/abcdefgh/white/analysis", "analysis"],
		["/study/AbCdEfGh", "analysis"],
		["/training", "puzzles"],
		["/training/mateIn2", "puzzles"],
		["/training/AbCdE", "puzzles"],
		["/storm", "puzzles"],
		["/racer", "puzzles"],
		["/streak", "puzzles"],
		["/@/thibault", "other"],
		["/games", "other"],
		["/tournament/AbCdEfGh", "other"],
		["/", "other"],
	];
	for (const [p, kind] of urlTable) {
		it(`${p} (no DOM) → ${kind}`, () => {
			expect(detectLichessPageKind(p, null)).toBe(kind);
		});
	}

	it("uses main.round + body.playing when the DOM is available", () => {
		const player = loadFixture("lichess-round-white");
		expect(detectLichessPageKind("/abcdefgh1234", pageDocument(player))).toBe("live-game");
		const tv = loadFixture("lichess-tv");
		expect(detectLichessPageKind("/tv", pageDocument(tv))).toBe("live-spectate");
		const spectate = createTabDom("https://lichess.org/abcdefgh");
		spectate.setHTML('<main class="round"><div class="round__app"></div></main>');
		expect(detectLichessPageKind("/abcdefgh", pageDocument(spectate))).toBe("live-spectate");
		const analyse = createTabDom("https://lichess.org/abcdefgh/white/analysis");
		analyse.setHTML('<main class="analyse"></main>');
		expect(detectLichessPageKind("/abcdefgh/white/analysis", pageDocument(analyse))).toBe("analysis");
	});
});
