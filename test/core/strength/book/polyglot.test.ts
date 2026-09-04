// test/core/strength/book/polyglot.test.ts

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BOOKS } from "@core/constants/books";
import {
	decodePolyglotMove,
	encodePolyglotMove,
	loadBook,
	lookup,
	polyglotKey,
} from "@core/strength/book/polyglot";
import { RANDOM64, RANDOM64_LENGTH } from "@core/strength/book/random64";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const ROOT = path.resolve(import.meta.dir, "../../../..");

function bookBytes(name: string): Uint8Array {
	return new Uint8Array(readFileSync(path.join(ROOT, BOOKS.dir, name)));
}

/** A tiny in-memory book: entries are sorted by key as the format requires. */
function makeBook(entries: Array<{ key: bigint; move: number; weight: number; learn?: number }>) {
	const sorted = [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const bytes = new Uint8Array(sorted.length * 16);
	const view = new DataView(bytes.buffer);
	sorted.forEach((e, i) => {
		view.setBigUint64(i * 16, e.key, false);
		view.setUint16(i * 16 + 8, e.move, false);
		view.setUint16(i * 16 + 10, e.weight, false);
		view.setUint32(i * 16 + 12, e.learn ?? 0, false);
	});
	return bytes;
}

describe("Random64", () => {
	it("has 781 entries with the documented first and last values", () => {
		expect(RANDOM64.length).toBe(RANDOM64_LENGTH);
		expect(RANDOM64[0]).toBe(0x9d39247e33776d41n);
		expect(RANDOM64[780]).toBe(0xf8d626aaaf278509n);
	});
});

describe("polyglotKey", () => {
	it("matches the reference values from the format specification", () => {
		expect(polyglotKey(START)).toBe(0x463b96181691fc9cn);
		expect(polyglotKey("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1")).toBe(
			0x823c9b50fd114196n
		);
		expect(polyglotKey("rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2")).toBe(
			0x0756b94461c50fb0n
		);
		expect(polyglotKey("rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2")).toBe(
			0x662fafb965db29d4n
		);
		expect(polyglotKey("rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3")).toBe(
			0x22a48b5a8e47ff78n
		);
		expect(polyglotKey("rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPPKPPP/RNBQ1BNR b kq - 0 3")).toBe(
			0x652a607ca3f242c1n
		);
		expect(polyglotKey("rnbq1bnr/ppp1pkpp/8/3pPp2/8/8/PPPPKPPP/RNBQ1BNR w - - 0 4")).toBe(
			0x00fdd303c946bdd9n
		);
		expect(polyglotKey("rnbqkbnr/p1pppppp/8/8/PpP4P/8/1P1PPPP1/RNBQKBNR b KQkq c3 0 3")).toBe(
			0x3c8123ea7b067637n
		);
		expect(polyglotKey("rnbqkbnr/p1pppppp/8/8/P6P/R1p5/1P1PPPP1/1NBQKBNR b Kkq - 0 4")).toBe(
			0x5c3f9b829b279560n
		);
	});

	it("includes the en-passant file only when a pawn of the side to move can capture", () => {
		// e3 target, no black pawn on d4/f4: same key as with no target square.
		const noCapture = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
		const noTarget = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
		expect(polyglotKey(noCapture)).toBe(polyglotKey(noTarget));
		// e3 target with a black pawn on d4: the file key applies.
		const capture = "rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 3";
		const captureNoTarget = "rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3";
		expect(polyglotKey(capture)).not.toBe(polyglotKey(captureNoTarget));
		expect(polyglotKey(capture) ^ polyglotKey(captureNoTarget)).toBe(RANDOM64[772 + 4] ?? 0n);
	});

	it("throws on an invalid FEN", () => {
		expect(() => polyglotKey("not a fen")).toThrow();
	});
});

describe("decodePolyglotMove / encodePolyglotMove", () => {
	const KING_E1 = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
	const KING_E8 = "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1";

	it("remaps king-takes-rook castling to the UCI king move", () => {
		expect(decodePolyglotMove(encodePolyglotMove("e1h1"), KING_E1)).toBe("e1g1");
		expect(decodePolyglotMove(encodePolyglotMove("e1a1"), KING_E1)).toBe("e1c1");
		expect(decodePolyglotMove(encodePolyglotMove("e8h8"), KING_E8)).toBe("e8g8");
		expect(decodePolyglotMove(encodePolyglotMove("e8a8"), KING_E8)).toBe("e8c8");
	});

	it("leaves e1h1 alone when the piece on e1 is not a king", () => {
		const rookE1 = "4k3/8/8/8/8/8/8/4R2K w - - 0 1";
		expect(decodePolyglotMove(encodePolyglotMove("e1h1"), rookE1)).toBe("e1h1");
	});

	it("decodes promotion bits (1 = n, 2 = b, 3 = r, 4 = q)", () => {
		const fen = "8/4P3/8/8/8/8/8/k6K w - - 0 1";
		for (const promo of ["n", "b", "r", "q"]) {
			expect(decodePolyglotMove(encodePolyglotMove(`e7e8${promo}`), fen)).toBe(`e7e8${promo}`);
		}
		expect(encodePolyglotMove("e7e8q") >> 12).toBe(4);
	});

	it("round-trips a plain move", () => {
		expect(decodePolyglotMove(encodePolyglotMove("g1f3"), START)).toBe("g1f3");
	});
});

describe("lookup (synthetic book)", () => {
	const startKey = polyglotKey(START);
	const bytes = makeBook([
		{ key: startKey + 1n, move: encodePolyglotMove("a2a3"), weight: 9 },
		{ key: startKey, move: encodePolyglotMove("e2e4"), weight: 100, learn: 7 },
		{ key: startKey, move: encodePolyglotMove("d2d4"), weight: 80 },
		{ key: startKey - 1n, move: encodePolyglotMove("h2h3"), weight: 1 },
	]);

	it("returns every entry for the position with uci, weight and learn", () => {
		const moves = lookup(bytes, START);
		expect(moves.map((m) => m.uci).sort()).toEqual(["d2d4", "e2e4"]);
		expect(moves.find((m) => m.uci === "e2e4")).toEqual({ uci: "e2e4", weight: 100, learn: 7 });
	});

	it("returns [] for an unknown position and rejects a malformed book", () => {
		expect(lookup(bytes, "8/8/8/8/8/8/8/k6K w - - 0 1")).toEqual([]);
		expect(() => loadBook(new Uint8Array(17))).toThrow();
	});

	it("loadBook exposes the entry count and a lookup bound to the bytes", () => {
		const book = loadBook(bytes);
		expect(book.size).toBe(4);
		expect(book.lookup(START).length).toBe(2);
	});
});

describe("bundled books", () => {
	it("gm2600 has ≥ 5 first moves including e2e4 and d2d4", () => {
		const moves = lookup(bookBytes(BOOKS.gm2600), START);
		expect(moves.length).toBeGreaterThanOrEqual(5);
		const ucis = moves.map((m) => m.uci);
		expect(ucis).toContain("e2e4");
		expect(ucis).toContain("d2d4");
		for (const m of moves) expect(m.weight).toBeGreaterThan(0);
	});

	it("club has ≥ 5 first moves including e2e4 and d2d4 and is ≤ 3 MB", () => {
		const bytes = bookBytes(BOOKS.club);
		expect(bytes.byteLength).toBeLessThanOrEqual(3 * 1024 * 1024);
		const ucis = lookup(bytes, START).map((m) => m.uci);
		expect(ucis.length).toBeGreaterThanOrEqual(5);
		expect(ucis).toContain("e2e4");
		expect(ucis).toContain("d2d4");
	});

	it("both books are sorted by key (binary search precondition)", () => {
		for (const name of [BOOKS.gm2600, BOOKS.club]) {
			const bytes = bookBytes(name);
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			let prev = 0n;
			for (let i = 0; i < bytes.byteLength; i += 16) {
				const key = view.getBigUint64(i, false);
				expect(key >= prev).toBe(true);
				prev = key;
			}
		}
	});
});
