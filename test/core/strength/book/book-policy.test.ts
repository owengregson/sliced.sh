// test/core/strength/book/book-policy.test.ts
import { describe, expect, it } from "bun:test";
import { BOOK, BOOKS } from "@core/constants/books";
import { createRng } from "@core/rng";
import {
	type BookContext,
	createBookPolicy,
	gammaFor,
	isTrap,
	lineFacts,
	sampleByFrequency,
} from "@core/strength/book/book-policy";
import { encodePolyglotMove, polyglotKey } from "@core/strength/book/polyglot";
import type { EvalLine } from "@typedefs/engine";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

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

describe("bookMove", () => {
	it("returns a ChosenMove with source 'book' from the bundled book", async () => {
		const loader = fakeLoader({ [BOOKS.club]: clubBook, [BOOKS.gm2600]: gmBook });
		const policy = createBookPolicy({ loadBook: loader.loadBook });
		const chosen = await policy.bookMove(ctx());
		expect(chosen).not.toBeNull();
		expect(chosen?.source).toBe("book");
		expect(["e2e4", "b1c3"]).toContain(chosen?.uci ?? "");
		expect(chosen?.san).toBe(chosen?.uci === "e2e4" ? "e4" : "Nc3");
		expect(String(chosen?.from)).toBe(chosen?.uci.slice(0, 2) ?? "");
		expect(String(chosen?.to)).toBe(chosen?.uci.slice(2, 4) ?? "");
		expect(chosen?.rationale.join(" ")).toContain(BOOKS.club);
		expect(loader.loads).toEqual([BOOKS.club]);
		policy.dispose();
	});

	it("uses gm2600 from E ≥ 1800 and club below, loading each book once", async () => {
		const loader = fakeLoader({ [BOOKS.club]: clubBook, [BOOKS.gm2600]: gmBook });
		const policy = createBookPolicy({ loadBook: loader.loadBook });
		const strong = await policy.bookMove(ctx({ targetElo: 2000 }));
		expect(["e2e4", "d2d4"]).toContain(strong?.uci ?? "");
		expect(strong?.rationale.join(" ")).toContain(BOOKS.gm2600);
		await policy.bookMove(ctx({ targetElo: 2200 }));
		const weak = await policy.bookMove(ctx({ targetElo: 1500 }));
		expect(["e2e4", "b1c3"]).toContain(weak?.uci ?? "");
		expect(loader.loads).toEqual([BOOKS.gm2600, BOOKS.club]);
		policy.dispose();
	});

	it("drops moves below 1 % of the total weight", async () => {
		const loader = fakeLoader({ [BOOKS.gm2600]: gmBook });
		const policy = createBookPolicy({ loadBook: loader.loadBook });
		const rng = createRng(3);
		for (let i = 0; i < 200; i++) {
			const chosen = await policy.bookMove(ctx({ targetElo: 2400, rng }));
			expect(chosen?.uci).not.toBe("h2h4");
		}
		policy.dispose();
	});

	it("may leave the book early (5 %) below E = 1400", async () => {
		const loader = fakeLoader({ [BOOKS.club]: clubBook });
		const policy = createBookPolicy({ loadBook: loader.loadBook });
		const rng = createRng(11);
		let left = 0;
		for (let i = 0; i < 400; i++)
			if ((await policy.bookMove(ctx({ targetElo: 1000, rng }))) === null) left++;
		expect(left).toBeGreaterThan(5);
		expect(left).toBeLessThan(50);
		policy.dispose();
	});

	it("returns null when the book does not know the position", async () => {
		const loader = fakeLoader({ [BOOKS.club]: clubBook, [BOOKS.gm2600]: gmBook });
		const policy = createBookPolicy({ loadBook: loader.loadBook });
		expect(await policy.bookMove(ctx({ fen: "8/8/8/8/8/8/8/k6K w - - 0 1", ply: 10 }))).toBeNull();
		policy.dispose();
	});

	it("returns null when a book fails to load and does not retry the load on every call", async () => {
		const loader = fakeLoader({});
		const policy = createBookPolicy({ loadBook: loader.loadBook });
		expect(await policy.bookMove(ctx({ targetElo: 1500 }))).toBeNull();
		expect(await policy.bookMove(ctx({ targetElo: 1500 }))).toBeNull();
		expect(loader.loads).toEqual([BOOKS.club]);
		policy.dispose();
	});
});

describe("bookMove exit conditions", () => {
	it("is skipped when useOpeningBook is false", async () => {
		const loader = fakeLoader({ [BOOKS.club]: clubBook });
		const policy = createBookPolicy({ loadBook: loader.loadBook });
		expect(await policy.bookMove(ctx({ useOpeningBook: false }))).toBeNull();
		expect(loader.loads).toEqual([]);
		policy.dispose();
	});

	it("is skipped after ply 30", async () => {
		const policy = createBookPolicy({ loadBook: async () => clubBook });
		expect(await policy.bookMove(ctx({ ply: BOOK.maxPly }))).not.toBeNull();
		expect(await policy.bookMove(ctx({ ply: BOOK.maxPly + 1 }))).toBeNull();
		policy.dispose();
	});

	it("refuses a sampled move that loses ≥ 0.15 vs the engine's best when E ≥ 1800", async () => {
		const trapBook = makeBook([{ fen: START, uci: "f2f3", weight: 100 }]);
		const policy = createBookPolicy({ loadBook: async () => trapBook });
		const lines = [line("e2e4", 30, 1), line("d2d4", 25, 2), line("f2f3", -150, 3)];
		expect(await policy.bookMove(ctx({ targetElo: 2000, lines }))).toBeNull();
		// Below 1800 the crowd is followed.
		const weak = await policy.bookMove(ctx({ targetElo: 1600, lines }));
		expect(weak?.uci).toBe("f2f3");
		policy.dispose();
	});

	it("fills rankInLines and cpLoss from the engine lines when available", async () => {
		const policy = createBookPolicy({
			loadBook: async () => makeBook([{ fen: START, uci: "d2d4", weight: 900 }]),
		});
		const lines = [line("e2e4", 30, 1), line("d2d4", 20, 2)];
		const chosen = await policy.bookMove(ctx({ targetElo: 2000, lines }));
		expect(chosen?.uci).toBe("d2d4");
		expect(chosen?.rankInLines).toBe(2);
		expect(chosen?.cpLoss).toBe(10);
		policy.dispose();
	});

	it("returns null for an illegal book move", async () => {
		const policy = createBookPolicy({
			loadBook: async () => makeBook([{ fen: START, uci: "e2e5", weight: 900 }]),
		});
		expect(await policy.bookMove(ctx())).toBeNull();
		policy.dispose();
	});
});

describe("trap check for moves outside the engine lines", () => {
	// Best line +30 cp; the worst reported line at −250 cp already loses ≈ 0.25 win-fraction.
	const deepLines = [line("e2e4", 30, 1), line("d2d4", 20, 2), line("a2a4", -250, 3)];
	// Worst reported line at −40 cp: a move outside the lines is only known to lose ≥ 0.06.
	const shallowLines = [line("e2e4", 30, 1), line("d2d4", 20, 2), line("c2c4", -40, 3)];

	it("lineFacts reports a lower bound from the worst line when the move is absent", () => {
		const absent = lineFacts("g1f3", deepLines);
		expect(absent.loss).toBeNull();
		expect(absent.rank).toBe(0);
		expect(absent.lossLowerBound).toBeGreaterThan(BOOK.trapLoss);
		const present = lineFacts("d2d4", deepLines);
		expect(present.loss).toBe(present.lossLowerBound);
		expect(lineFacts("g1f3", shallowLines).lossLowerBound).toBeLessThan(BOOK.trapLoss);
		expect(lineFacts("g1f3", undefined).lossLowerBound).toBe(0);
	});

	it("isTrap refuses an absent move whose bound reaches 0.15 from E ≥ 1800", () => {
		expect(isTrap(2000, lineFacts("g1f3", deepLines))).toBe(true);
		expect(isTrap(2000, lineFacts("g1f3", shallowLines))).toBe(false);
		expect(isTrap(1600, lineFacts("g1f3", deepLines))).toBe(false);
	});

	it("bookMove refuses a book move outside deep lines but allows it outside shallow ones", async () => {
		const policy = createBookPolicy({
			loadBook: async () => makeBook([{ fen: START, uci: "g1f3", weight: 900 }]),
		});
		expect(await policy.bookMove(ctx({ targetElo: 2000, lines: deepLines }))).toBeNull();
		const allowed = await policy.bookMove(ctx({ targetElo: 2000, lines: shallowLines }));
		expect(allowed?.uci).toBe("g1f3");
		expect(allowed?.rankInLines).toBe(0);
		policy.dispose();
	});
});

describe("gammaFor / sampleByFrequency (Appendix E §2.3)", () => {
	const weighted = (uci: string, weight: number) => ({ uci, weight });
	const keepOnePercent = (w: number, total: number) => w >= BOOK.minWeightShare * total;
	it("γ(E) = 0.75 + 0.25·clamp((E − 1200)/1200, 0, 1)", () => {
		expect(gammaFor(800)).toBeCloseTo(0.75);
		expect(gammaFor(1200)).toBeCloseTo(0.75);
		expect(gammaFor(1800)).toBeCloseTo(0.875);
		expect(gammaFor(2400)).toBeCloseTo(1);
		expect(gammaFor(3000)).toBeCloseTo(1);
	});
	it("drops items that fail `keep`", () => {
		const items = [weighted("e2e4", 900), weighted("d2d4", 80), weighted("h2h4", 4)];
		const rng = createRng(1);
		const seen = new Set<string>();
		for (let i = 0; i < 400; i++) {
			const m = sampleByFrequency(items, (x) => x.weight, keepOnePercent, 1500, rng);
			if (m) seen.add(m.uci);
		}
		expect(seen.has("e2e4")).toBe(true);
		expect(seen.has("d2d4")).toBe(true);
		expect(seen.has("h2h4")).toBe(false); // 4 < 0.01·984
	});
	it("samples p ∝ n^γ: flatter for weak E, near-proportional for strong E", () => {
		const items = [weighted("e2e4", 800), weighted("d2d4", 200)];
		const share = (E: number) => {
			const rng = createRng(42);
			let e4 = 0;
			const trials = 4000;
			for (let i = 0; i < trials; i++)
				if (sampleByFrequency(items, (x) => x.weight, keepOnePercent, E, rng)?.uci === "e2e4") e4++;
			return e4 / trials;
		};
		// γ = 1 → 0.8; γ = 0.75 → 800^.75/(800^.75+200^.75) ≈ 0.738.
		expect(share(2400)).toBeGreaterThan(0.77);
		expect(share(2400)).toBeLessThan(0.83);
		expect(share(800)).toBeGreaterThan(0.71);
		expect(share(800)).toBeLessThan(0.77);
	});
	it("returns null when nothing survives the filter", () => {
		expect(
			sampleByFrequency([], (x: { weight: number }) => x.weight, keepOnePercent, 1500, createRng(1))
		).toBeNull();
		expect(
			sampleByFrequency([weighted("e2e4", 0)], (x) => x.weight, keepOnePercent, 1500, createRng(1))
		).toBeNull();
	});
});
