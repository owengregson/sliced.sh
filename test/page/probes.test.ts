// test/page/probes.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { SELECTORS } from "@content/adapters/selectors";
import { type AnyPageProgram, bindCode, emit } from "@pagescript";
import { cursorProbe } from "../../src/page/cursor-probe";
import { focusProbe } from "../../src/page/focus-probe";
import { programs } from "../../src/page/index";
import { verifyMoveProbe } from "../../src/page/verify-move-probe";
import { type FakeGame, fakeGame, forbiddenIn, makeWindow, runProgram, SEED } from "./helpers";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
});

function win(url = "https://www.chess.com/game/live/1") {
	const w = makeWindow(url);
	cleanups.push(() => w.happyDOM.close());
	return w;
}

const boardSelectors = [...SELECTORS.board];

describe("registry", () => {
	it("lists the six §5.5 programs, the bridge as an entry with seed-derived entry args, and every program is clean", () => {
		expect(programs.map((p) => [p.name, p.entry])).toEqual([
			["chesscom-bridge", true],
			["highlight-overlay", false],
			// Fix D: the pointer mirror, embedded in the bridge and generated standalone like the overlay
			["virtual-cursor", false],
			["cursor-probe", false],
			["focus-probe", false],
			["verify-move-probe", false],
		]);
		for (const p of programs) {
			const { code } = emit(p, { seed: SEED });
			expect(forbiddenIn(code)).toEqual([]);
			if (!p.entry) continue;
			expect(typeof p.entryArgs).toBe("function");
			const a = typeof p.entryArgs === "function" ? p.entryArgs({ seed: SEED }) : {};
			const b = typeof p.entryArgs === "function" ? p.entryArgs({ seed: "other" }) : {};
			expect(a.token).not.toBe(b.token);
			expect(a.token).not.toBe(a.peer);
		}
	});
	it("probes are single IIFE expressions (no top-level return) so CDP Runtime.evaluate can take them", () => {
		const probes: AnyPageProgram[] = [cursorProbe, focusProbe, verifyMoveProbe];
		for (const p of probes) {
			const { code } = emit(p, { seed: SEED });
			expect(code.startsWith("(() => {")).toBe(true);
			expect(code.trimEnd().endsWith("})();")).toBe(true);
			expect(code.split("\n")).toHaveLength(1);
		}
	});
});

describe("focus-probe", () => {
	it("returns { hasFocus, visibility, boardRect, dpr, scrollX, scrollY }", () => {
		const w = win();
		w.document.body.innerHTML = '<wc-chess-board id="board-single"></wc-chess-board>';
		const e = emit(focusProbe, { seed: SEED });
		const out = runProgram(bindCode(e.code, e.params, { boardSelectors }), w, {}, true) as Record<
			string,
			unknown
		>;
		expect(Object.keys(out).sort()).toEqual([
			"boardRect",
			"dpr",
			"hasFocus",
			"scrollX",
			"scrollY",
			"visibility",
		]);
		expect(typeof out.hasFocus).toBe("boolean");
		expect(out.visibility).toBe("visible");
		expect(Object.keys(out.boardRect as object).sort()).toEqual(["height", "width", "x", "y"]);
		expect(out.dpr).toBe(1);
		w.document.body.innerHTML = "";
		const none = runProgram(bindCode(e.code, e.params, { boardSelectors }), w, {}, true) as Record<
			string,
			unknown
		>;
		expect(none.boardRect).toBeNull();
	});
});

describe("verify-move-probe", () => {
	it("reads lastMove / ply / position from board.game, and the null shape without an API", () => {
		const w = win();
		const e = emit(verifyMoveProbe, { seed: SEED });
		const bound = bindCode(e.code, e.params, { boardSelectors });
		expect(runProgram(bound, w, {}, true)).toEqual({ lastMove: null, ply: null, position: null });
		w.document.body.innerHTML = '<wc-chess-board id="board-single"></wc-chess-board>';
		const game = fakeGame();
		(w.document.querySelector("wc-chess-board") as unknown as { game: FakeGame }).game = game;
		expect(runProgram(bound, w, {}, true)).toEqual({
			lastMove: { from: "e2", to: "e4", san: "e4" },
			ply: 1,
			position: game.fen,
		});
	});
});

describe("cursor-probe (CDP fallback only)", () => {
	it("returns null immediately, installs no listener and never waits", async () => {
		const w = win();
		const e = emit(cursorProbe, { seed: SEED });
		expect(e.params).toEqual([]);
		expect(e.code).not.toContain("addEventListener");
		expect(e.code).not.toContain("setTimeout");
		expect(e.code).not.toContain("Promise");
		const keysBefore = Object.keys(w);
		const out = runProgram(e.code, w, {}, true);
		expect(out).toBeNull();
		expect(Object.keys(w)).toEqual(keysBefore);
	});
});
