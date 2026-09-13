// test/core/policy/maia-encoder.test.ts
/**
 * The Maia-3 encoder against the reference fixture (bit-exact tokens and legal-move indices for
 * every position) and by hand: frame repetition, mirroring for black, promotions of both colours,
 * castling, en passant, and the vocabulary round-trip.
 */

import { describe, expect, it } from "bun:test";
import path from "node:path";
import { legalMoves } from "@core/chess/san";
import { MAIA_INPUT } from "@core/constants/maia";
import { encodeMaiaInputs, maiaIndexToUci, maiaMoveIndex } from "@core/policy/maia-encoder";
import { Chess } from "chess.js";

interface FixturePosition {
	fen: string;
	historyFens: string[];
	selfElo: number;
	oppoElo: number;
	/** Ascending indices `i` with `tokens[i] === 1`. */
	tokensSet: number[];
	legal: number[];
}
interface PositionsFixture {
	history: number;
	tokenDim: number;
	positions: FixturePosition[];
}

const FIXTURE = path.resolve(import.meta.dir, "../../fixtures/maia3/positions.json");
const fixture = (await Bun.file(FIXTURE).json()) as PositionsFixture;

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
const TOKEN_DIM = MAIA_INPUT.tokenDim;
const PLANES = MAIA_INPUT.planes;
const FRAMES = MAIA_INPUT.history;
const CURRENT = FRAMES - 1;

/** `file + 8 · rank` for a square name in the board frame. */
function sq(name: string): number {
	return name.charCodeAt(0) - 97 + 8 * (name.charCodeAt(1) - 49);
}
function feature(square: number, frame: number, plane: number): number {
	return square * TOKEN_DIM + frame * PLANES + plane;
}
function onesOf(tokens: Float32Array): number[] {
	const out: number[] = [];
	for (let i = 0; i < tokens.length; i++) if (tokens[i] === 1) out.push(i);
	return out;
}
function fromTo(from: string, to: string): number {
	return sq(from) * 64 + sq(to);
}

describe("encodeMaiaInputs against the fixture", () => {
	it("the fixture has the registry's shape", () => {
		expect(fixture.history).toBe(MAIA_INPUT.history);
		expect(fixture.tokenDim).toBe(MAIA_INPUT.tokenDim);
		expect(fixture.positions.length).toBeGreaterThan(0);
	});
	it("tokens and legal are bit-exact for every position", () => {
		for (const [i, p] of fixture.positions.entries()) {
			const encoded = encodeMaiaInputs(p.historyFens);
			expect(encoded.tokens.length).toBe(MAIA_INPUT.squares * TOKEN_DIM);
			expect(p.historyFens[p.historyFens.length - 1]).toBe(p.fen);
			expect(encoded.mirrored).toBe(p.fen.split(" ")[1] === "b");
			const ones = onesOf(encoded.tokens);
			if (ones.length !== p.tokensSet.length || ones.some((v, k) => v !== p.tokensSet[k]))
				throw new Error(`position ${i} (${p.fen}): tokens differ from the fixture`);
			// every non-one entry is exactly zero
			let nonBinary = 0;
			for (const v of encoded.tokens) if (v !== 0 && v !== 1) nonBinary++;
			expect(nonBinary).toBe(0);
			expect(Array.from(encoded.legal)).toEqual(p.legal);
		}
	});
});

describe("encodeMaiaInputs by hand", () => {
	it("the start position: white frame, every frame the same, 32 pieces each", () => {
		const { tokens, legal, mirrored } = encodeMaiaInputs([START]);
		expect(mirrored).toBe(false);
		expect(onesOf(tokens).length).toBe(32 * FRAMES);
		for (let frame = 0; frame < FRAMES; frame++) {
			expect(tokens[feature(sq("a1"), frame, 3)]).toBe(1); // own rook
			expect(tokens[feature(sq("e1"), frame, 5)]).toBe(1); // own king
			expect(tokens[feature(sq("d1"), frame, 4)]).toBe(1); // own queen
			expect(tokens[feature(sq("e2"), frame, 0)]).toBe(1); // own pawn
			expect(tokens[feature(sq("e8"), frame, 11)]).toBe(1); // their king
			expect(tokens[feature(sq("b8"), frame, 7)]).toBe(1); // their knight
			expect(tokens[feature(sq("e7"), frame, 6)]).toBe(1); // their pawn
			expect(tokens[feature(sq("e4"), frame, 0)]).toBe(0);
		}
		expect(Array.from(legal)).toEqual(
			legalMoves(START)
				.map((uci) => maiaMoveIndex(uci, false))
				.sort((a, b) => a - b)
		);
		expect(legal.length).toBe(20);
		expect(legal[0]).toBe(fromTo("b1", "a3"));
		expect(legal[legal.length - 1]).toBe(fromTo("h2", "h4"));
	});
	it("black to move mirrors the current frame and pads the earlier frames with the earliest", () => {
		const { tokens, legal, mirrored } = encodeMaiaInputs([START, AFTER_E4]);
		expect(mirrored).toBe(true);
		// frames 0–6 are the (unmirrored) start position
		for (let frame = 0; frame < CURRENT; frame++) {
			expect(tokens[feature(sq("a1"), frame, 3)]).toBe(1);
			expect(tokens[feature(sq("e2"), frame, 0)]).toBe(1);
			expect(tokens[feature(sq("e8"), frame, 11)]).toBe(1);
		}
		// frame 7: black's pieces are "own" on ranks 1–2, white's are "theirs" on ranks 7–8, e4 → e5
		expect(tokens[feature(sq("e1"), CURRENT, 5)]).toBe(1); // black king (e8 → e1), own
		expect(tokens[feature(sq("d1"), CURRENT, 4)]).toBe(1); // black queen
		expect(tokens[feature(sq("e2"), CURRENT, 0)]).toBe(1); // black e7 pawn → e2, own
		expect(tokens[feature(sq("e5"), CURRENT, 6)]).toBe(1); // white e4 pawn → e5, theirs
		expect(tokens[feature(sq("e7"), CURRENT, 6)]).toBe(0); // e2 is empty after e4
		expect(tokens[feature(sq("e8"), CURRENT, 11)]).toBe(1); // white king (e1 → e8), theirs
		expect(tokens[feature(sq("a8"), CURRENT, 9)]).toBe(1); // white a1 rook → a8, theirs
		expect(onesOf(tokens).length).toBe(32 * FRAMES);
		// e7e5 mirrored is e2e4
		expect(Array.from(legal)).toContain(fromTo("e2", "e4"));
		expect(Array.from(legal)).not.toContain(fromTo("e7", "e5"));
		expect(legal.length).toBe(20);
		for (let i = 1; i < legal.length; i++) expect(legal[i]).toBeGreaterThan(legal[i - 1] ?? -1);
	});
	it("a lone position is repeated across all 8 frames; a full history is used as given", () => {
		const single = encodeMaiaInputs([AFTER_E4]);
		for (let frame = 0; frame < FRAMES; frame++)
			expect(single.tokens[feature(sq("e5"), frame, 6)]).toBe(1);
		const history = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7"];
		const fens = [START];
		const chess = new Chess();
		for (const uci of history) {
			chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
			fens.push(chess.fen());
		}
		expect(fens.length).toBe(11);
		const all = encodeMaiaInputs(fens);
		const last8 = encodeMaiaInputs(fens.slice(-FRAMES));
		expect(Array.from(all.tokens)).toEqual(Array.from(last8.tokens));
		expect(Array.from(all.legal)).toEqual(Array.from(last8.legal));
		expect(all.mirrored).toBe(false);
		// frame 0 is fens[3] (after 2.Nf3, black to move → mirrored), not the start position
		const frame0 = encodeMaiaInputs([fens[3] ?? ""]);
		for (let i = 0; i < PLANES; i++)
			for (let s = 0; s < MAIA_INPUT.squares; s++)
				expect(all.tokens[feature(s, 0, i)]).toBe(frame0.tokens[feature(s, 0, i)] ?? -1);
	});
	it("promotions use the promotion block for both colours", () => {
		const white = encodeMaiaInputs(["7k/1P6/8/8/8/8/8/7K w - - 0 1"]);
		const whiteLegal = Array.from(white.legal);
		// b7b8 only (a8 and c8 are empty)
		for (const [piece, offset] of [
			["q", 0],
			["r", 1],
			["b", 2],
			["n", 3],
		] as const) {
			const index = MAIA_INPUT.fromTo + (1 * 8 + 1) * 4 + offset;
			expect(maiaMoveIndex(`b7b8${piece}`, false)).toBe(index);
			expect(whiteLegal).toContain(index);
			expect(maiaIndexToUci(index, false)).toBe(`b7b8${piece}`);
		}
		expect(whiteLegal).not.toContain(fromTo("b7", "b8"));
		expect(whiteLegal.filter((i) => i >= MAIA_INPUT.fromTo).length).toBe(4);

		const black = encodeMaiaInputs(["7k/8/8/8/8/8/1p6/R6K b - - 0 1"]);
		const blackLegal = Array.from(black.legal);
		expect(black.mirrored).toBe(true);
		// b2b1 and b2xa1 mirror to b7b8 and b7a8
		for (const [piece, offset] of [
			["q", 0],
			["r", 1],
			["b", 2],
			["n", 3],
		] as const) {
			const push = MAIA_INPUT.fromTo + (1 * 8 + 1) * 4 + offset;
			const capture = MAIA_INPUT.fromTo + (1 * 8 + 0) * 4 + offset;
			expect(maiaMoveIndex(`b2b1${piece}`, true)).toBe(push);
			expect(maiaMoveIndex(`b2a1${piece}`, true)).toBe(capture);
			expect(blackLegal).toContain(push);
			expect(blackLegal).toContain(capture);
			expect(maiaIndexToUci(push, true)).toBe(`b2b1${piece}`);
			expect(maiaIndexToUci(capture, true)).toBe(`b2a1${piece}`);
		}
		expect(blackLegal.filter((i) => i >= MAIA_INPUT.fromTo).length).toBe(8);
		expect(blackLegal).not.toContain(fromTo("b7", "b8"));
	});
	it("castling is the king's from→to in the mirrored frame", () => {
		const white = Array.from(encodeMaiaInputs(["r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"]).legal);
		expect(white).toContain(fromTo("e1", "g1"));
		expect(white).toContain(fromTo("e1", "c1"));
		const black = Array.from(encodeMaiaInputs(["r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1"]).legal);
		expect(black).toContain(fromTo("e1", "g1")); // e8g8 mirrored
		expect(black).toContain(fromTo("e1", "c1")); // e8c8 mirrored
		expect(maiaMoveIndex("e8g8", true)).toBe(fromTo("e1", "g1"));
		expect(maiaIndexToUci(fromTo("e1", "g1"), true)).toBe("e8g8");
	});
	it("en passant is the pawn's from→to", () => {
		const fen = "rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3";
		expect(Array.from(encodeMaiaInputs([fen]).legal)).toContain(fromTo("e5", "d6"));
		const blackFen = "rnbqkbnr/pppp1ppp/8/8/3Pp3/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 3";
		expect(Array.from(encodeMaiaInputs([blackFen]).legal)).toContain(fromTo("e5", "d6")); // e4d3 mirrored
	});
	it("an unreadable FEN throws, wherever it sits in the history", () => {
		expect(() => encodeMaiaInputs(["not a fen"])).toThrow();
		expect(() => encodeMaiaInputs([START, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"])).toThrow();
		expect(() => encodeMaiaInputs(["8/8/8/8/8/8/8/8 w - - 0 1", START])).toThrow();
		expect(() => encodeMaiaInputs([])).toThrow();
	});
});

describe("move vocabulary", () => {
	const positions = [
		START,
		AFTER_E4,
		"r3k2r/pp1n1ppp/2p1pq2/3p4/1bPP4/2N1PN2/PP2BPPP/R2QK2R w KQkq - 0 9",
		"r3k2r/pp1n1ppp/2p1pq2/3p4/1bPP4/2N1PN2/PP2BPPP/R2QK2R b KQkq - 0 9",
		"7k/1P6/8/8/8/8/8/7K w - - 0 1",
		"7k/8/8/8/8/8/1p6/R6K b - - 0 1",
		"rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3",
	];
	it("round-trips every legal move of several positions of both colours", () => {
		for (const fen of positions) {
			const mirrored = fen.split(" ")[1] === "b";
			const moves = legalMoves(fen);
			expect(moves.length).toBeGreaterThan(0);
			const seen = new Set<number>();
			for (const uci of moves) {
				const index = maiaMoveIndex(uci, mirrored);
				expect(index).toBeGreaterThanOrEqual(0);
				expect(index).toBeLessThan(MAIA_INPUT.moveVocab);
				if (uci.length === 5) expect(index).toBeGreaterThanOrEqual(MAIA_INPUT.fromTo);
				else expect(index).toBeLessThan(MAIA_INPUT.fromTo);
				expect(maiaIndexToUci(index, mirrored)).toBe(uci);
				seen.add(index);
			}
			expect(seen.size).toBe(moves.length);
			const encoded = encodeMaiaInputs([fen]);
			expect(Array.from(encoded.legal)).toEqual([...seen].sort((a, b) => a - b));
		}
	});
	it("mirroring flips ranks only", () => {
		expect(maiaMoveIndex("a1h8", false)).toBe(0 * 64 + 63);
		expect(maiaMoveIndex("a1h8", true)).toBe(sq("a8") * 64 + sq("h1"));
		expect(maiaMoveIndex("e2e4", false)).toBe(fromTo("e2", "e4"));
		expect(maiaMoveIndex("e7e5", true)).toBe(fromTo("e2", "e4"));
		expect(maiaIndexToUci(fromTo("e2", "e4"), true)).toBe("e7e5");
		expect(maiaIndexToUci(fromTo("e2", "e4"), false)).toBe("e2e4");
		expect(maiaIndexToUci(MAIA_INPUT.moveVocab - 1, false)).toBe("h7h8n");
		expect(maiaIndexToUci(MAIA_INPUT.moveVocab - 1, true)).toBe("h2h1n");
		expect(maiaIndexToUci(MAIA_INPUT.fromTo, false)).toBe("a7a8q");
	});
	it("rejects what the vocabulary cannot hold", () => {
		expect(maiaMoveIndex("", false)).toBe(-1);
		expect(maiaMoveIndex("e2", false)).toBe(-1);
		expect(maiaMoveIndex("i2i4", false)).toBe(-1);
		expect(maiaMoveIndex("e2e4k", false)).toBe(-1);
		expect(maiaMoveIndex("e2e4q", false)).toBe(-1); // not rank 7 → 8
		expect(maiaMoveIndex("e7e8q", true)).toBe(-1); // mirrored: e2e1
		expect(maiaMoveIndex("e2e1q", false)).toBe(-1);
		expect(maiaMoveIndex("e7e5q", false)).toBe(-1);
		expect(() => maiaIndexToUci(-1, false)).toThrow(RangeError);
		expect(() => maiaIndexToUci(MAIA_INPUT.moveVocab, false)).toThrow(RangeError);
		expect(() => maiaIndexToUci(1.5, false)).toThrow(RangeError);
	});
});
