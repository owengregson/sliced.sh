// test/core/strength/book/book-policy.test.ts
import { describe, expect, it } from "bun:test";
import { BOOKS, EXPLORER } from "@core/constants/books";
import { createRng } from "@core/rng";
import { type BookContext, createBookPolicy } from "@core/strength/book/book-policy";
import type { ExplorerMove, ExplorerQuery } from "@core/strength/book/explorer";
import { encodePolyglotMove, polyglotKey } from "@core/strength/book/polyglot";
import type { EvalLine } from "@typedefs/engine";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function move(uci: string, n: number): ExplorerMove {
	return { uci, san: uci, white: n, draws: 0, black: 0, averageRating: 1500 };
}

function makeBook(entries: Array<{ fen: string; uci: string; weight: number }>): Uint8Array {
	const rows = entries.map((e) => ({
		key: polyglotKey(e.fen),
		move: encodePolyglotMove(e.uci),
		w: e.weight,
	}));
	rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const bytes = new Uint8Array(rows.length * 16);
	const view = new DataView(bytes.buffer);
	rows.forEach((r, i) => {
		view.setBigUint64(i * 16, r.key, false);
		view.setUint16(i * 16 + 8, r.move, false);
		view.setUint16(i * 16 + 10, r.w, false);
	});
	return bytes;
}

function line(uci: string, cp: number, multipv: number): EvalLine {
	return { multipv, score: { cp }, depth: 18, pvUci: [uci], pvSan: [] };
}

interface FakeExplorer extends ExplorerQuery {
	calls: number;
}

function fakeExplorer(moves: ExplorerMove[] | null): FakeExplorer {
	const ex: FakeExplorer = {
		calls: 0,
		query: async () => {
			ex.calls++;
			if (moves === null) return null;
			let white = 0;
			for (const m of moves) white += m.white;
			return { white, draws: 0, black: 0, moves, opening: null };
		},
	};
	return ex;
}

function fakeLoader(books: Partial<Record<string, Uint8Array>>) {
	const loads: string[] = [];
	return {
		loads,
		loadBook: async (name: string) => {
			loads.push(name);
			return books[name] ?? null;
		},
	};
}

function ctx(overrides: Partial<BookContext> = {}): BookContext {
	return {
		fen: START,
		ply: 0,
		targetElo: 1500,
		timeControl: { baseMs: 180_000, incMs: 0 },
		useOpeningBook: true,
		rng: createRng(7),
		...overrides,
	};
}

const gmBook = makeBook([
	{ fen: START, uci: "e2e4", weight: 500 },
	{ fen: START, uci: "d2d4", weight: 400 },
	{ fen: START, uci: "h2h4", weight: 3 },
]);
const clubBook = makeBook([
	{ fen: START, uci: "e2e4", weight: 900 },
	{ fen: START, uci: "b1c3", weight: 100 },
]);

describe("bookMove ordering", () => {
	it("prefers the explorer and returns a ChosenMove with source 'book'", async () => {
		const explorer = fakeExplorer([move("e2e4", 700), move("d2d4", 300)]);
		const loader = fakeLoader({ [BOOKS.club]: clubBook, [BOOKS.gm2600]: gmBook });
		const policy = createBookPolicy({ explorer, loadBook: loader.loadBook });
		const chosen = await policy.bookMove(ctx());
		expect(chosen).not.toBeNull();
		expect(chosen?.source).toBe("book");
		expect(["e2e4", "d2d4"]).toContain(chosen?.uci ?? "");
		expect(chosen?.san).toBe(chosen?.uci === "e2e4" ? "e4" : "d4");
		expect(String(chosen?.from)).toBe(chosen?.uci.slice(0, 2) ?? "");
		expect(String(chosen?.to)).toBe(chosen?.uci.slice(2, 4) ?? "");
		expect(chosen?.rationale.join(" ")).toContain("explorer");
		expect(explorer.calls).toBe(1);
		expect(loader.loads).toEqual([]);
		policy.dispose();
	});

	it("falls back to the polyglot book when the explorer has nothing (N < 200)", async () => {
		const explorer = fakeExplorer([move("e2e4", 100), move("d2d4", 50)]);
		const loader = fakeLoader({ [BOOKS.club]: clubBook, [BOOKS.gm2600]: gmBook });
		const policy = createBookPolicy({ explorer, loadBook: loader.loadBook });
		const chosen = await policy.bookMove(ctx({ targetElo: 1500 }));
		expect(chosen?.source).toBe("book");
		expect(["e2e4", "b1c3"]).toContain(chosen?.uci ?? "");
		expect(chosen?.rationale.join(" ")).toContain(BOOKS.club);
		expect(loader.loads).toEqual([BOOKS.club]);
		policy.dispose();
	});

	it("uses gm2600 from E ≥ 1800 and club below, loading each book once", async () => {
		const loader = fakeLoader({ [BOOKS.club]: clubBook, [BOOKS.gm2600]: gmBook });
		const policy = createBookPolicy({ explorer: fakeExplorer(null), loadBook: loader.loadBook });
		const strong = await policy.bookMove(ctx({ targetElo: 2000 }));
		expect(["e2e4", "d2d4"]).toContain(strong?.uci ?? "");
		expect(strong?.rationale.join(" ")).toContain(BOOKS.gm2600);
		await policy.bookMove(ctx({ targetElo: 2200 }));
		const weak = await policy.bookMove(ctx({ targetElo: 1500 }));
		expect(["e2e4", "b1c3"]).toContain(weak?.uci ?? "");
		expect(loader.loads).toEqual([BOOKS.gm2600, BOOKS.club]);
		policy.dispose();
	});

	it("drops polyglot moves below 1 % of the total weight", async () => {
		const loader = fakeLoader({ [BOOKS.gm2600]: gmBook });
		const policy = createBookPolicy({ explorer: null, loadBook: loader.loadBook });
		const rng = createRng(3);
		for (let i = 0; i < 200; i++) {
			const chosen = await policy.bookMove(ctx({ targetElo: 2400, rng }));
			expect(chosen?.uci).not.toBe("h2h4");
		}
		policy.dispose();
	});

	it("may leave the book early (5 %) below E = 1400", async () => {
		const loader = fakeLoader({ [BOOKS.club]: clubBook });
		const policy = createBookPolicy({ explorer: null, loadBook: loader.loadBook });
		const rng = createRng(11);
		let left = 0;
		for (let i = 0; i < 400; i++)
			if ((await policy.bookMove(ctx({ targetElo: 1000, rng }))) === null) left++;
		expect(left).toBeGreaterThan(5);
		expect(left).toBeLessThan(50);
		policy.dispose();
	});

	it("returns null when neither source knows the position", async () => {
		const loader = fakeLoader({ [BOOKS.club]: clubBook, [BOOKS.gm2600]: gmBook });
		const policy = createBookPolicy({ explorer: fakeExplorer(null), loadBook: loader.loadBook });
		expect(await policy.bookMove(ctx({ fen: "8/8/8/8/8/8/8/k6K w - - 0 1", ply: 10 }))).toBeNull();
		policy.dispose();
	});

	it("returns null when a book fails to load and does not retry the load on every call", async () => {
		const loader = fakeLoader({});
		const policy = createBookPolicy({ explorer: null, loadBook: loader.loadBook });
		expect(await policy.bookMove(ctx({ targetElo: 1500 }))).toBeNull();
		expect(await policy.bookMove(ctx({ targetElo: 1500 }))).toBeNull();
		expect(loader.loads).toEqual([BOOKS.club]);
		policy.dispose();
	});
});

describe("bookMove exit conditions", () => {
	it("is skipped when useOpeningBook is false", async () => {
		const explorer = fakeExplorer([move("e2e4", 700)]);
		const loader = fakeLoader({ [BOOKS.club]: clubBook });
		const policy = createBookPolicy({ explorer, loadBook: loader.loadBook });
		expect(await policy.bookMove(ctx({ useOpeningBook: false }))).toBeNull();
		expect(explorer.calls).toBe(0);
		expect(loader.loads).toEqual([]);
		policy.dispose();
	});

	it("is skipped after ply 30", async () => {
		const explorer = fakeExplorer([move("e2e4", 700)]);
		const policy = createBookPolicy({ explorer, loadBook: async () => clubBook });
		expect(await policy.bookMove(ctx({ ply: EXPLORER.maxPly }))).not.toBeNull();
		expect(await policy.bookMove(ctx({ ply: EXPLORER.maxPly + 1 }))).toBeNull();
		expect(explorer.calls).toBe(1);
		policy.dispose();
	});

	it("refuses a sampled move that loses ≥ 0.15 vs the engine's best when E ≥ 1800", async () => {
		// Explorer only knows f2f3 (a big loss per the engine lines); gm book knows e2e4.
		const explorer = fakeExplorer([move("f2f3", 900)]);
		const loader = fakeLoader({ [BOOKS.gm2600]: gmBook });
		const policy = createBookPolicy({ explorer, loadBook: loader.loadBook });
		const lines = [line("e2e4", 30, 1), line("d2d4", 25, 2), line("f2f3", -150, 3)];
		const chosen = await policy.bookMove(ctx({ targetElo: 2000, lines }));
		expect(["e2e4", "d2d4"]).toContain(chosen?.uci ?? "");
		expect(chosen?.rationale.join(" ")).toContain("trap");
		// Below 1800 the crowd is followed.
		const weak = await policy.bookMove(ctx({ targetElo: 1600, lines }));
		expect(weak?.uci).toBe("f2f3");
		policy.dispose();
	});

	it("returns null when the polyglot move is the trap too", async () => {
		const trapBook = makeBook([{ fen: START, uci: "f2f3", weight: 100 }]);
		const policy = createBookPolicy({ explorer: null, loadBook: async () => trapBook });
		const lines = [line("e2e4", 30, 1), line("f2f3", -150, 2)];
		expect(await policy.bookMove(ctx({ targetElo: 2000, lines }))).toBeNull();
		policy.dispose();
	});

	it("fills rankInLines and cpLoss from the engine lines when available", async () => {
		const explorer = fakeExplorer([move("d2d4", 900)]);
		const policy = createBookPolicy({ explorer, loadBook: async () => null });
		const lines = [line("e2e4", 30, 1), line("d2d4", 20, 2)];
		const chosen = await policy.bookMove(ctx({ targetElo: 2000, lines }));
		expect(chosen?.uci).toBe("d2d4");
		expect(chosen?.rankInLines).toBe(2);
		expect(chosen?.cpLoss).toBe(10);
		policy.dispose();
	});

	it("returns null for an illegal book move", async () => {
		const explorer = fakeExplorer([move("e2e5", 900)]);
		const policy = createBookPolicy({ explorer, loadBook: async () => null });
		expect(await policy.bookMove(ctx())).toBeNull();
		policy.dispose();
	});
});
