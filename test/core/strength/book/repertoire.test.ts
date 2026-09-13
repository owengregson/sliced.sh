// test/core/strength/book/repertoire.test.ts — H14.1 (2026-09-13): the book sampler's seed comes
// from a persisted per-profile repertoire key, so the same first moves recur across games (two
// sessions with the same key draw the same move) while another profile's key draws its own.
import { beforeEach, describe, expect, it } from "bun:test";
import { BOOKS, LOCAL_KEYS } from "@core/constants";
import { createRng } from "@core/rng";
import { loadRepertoireKeys, resetRepertoireKeys } from "@core/storage/repertoire-storage";
import { type BookContext, createBookPolicy } from "@core/strength/book/book-policy";
import { encodePolyglotMove, polyglotKey } from "@core/strength/book/polyglot";
import {
	isRepertoireKeys,
	makeRepertoireKeys,
	type RepertoireKeys,
	repertoireKeyFor,
	repertoireSeed,
} from "@core/strength/book/repertoire";
import { createSimulator } from "@test/sim";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
/** The same board as `AFTER_E4` with the bridge's en-passant spelling (not a different position). */
const AFTER_E4_EP = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";

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

/** Two near-equal first moves for each colour: a per-game draw picks either about half the time. */
const book = makeBook([
	{ fen: START, uci: "e2e4", weight: 500 },
	{ fen: START, uci: "d2d4", weight: 500 },
	{ fen: AFTER_E4, uci: "e7e5", weight: 500 },
	{ fen: AFTER_E4, uci: "c7c5", weight: 500 },
]);

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

const keys = (w: number, b: number): RepertoireKeys => ({ w, b, createdAt: 1 });

describe("repertoire seed (pure)", () => {
	it("picks the colour's key by the side to move and folds the Polyglot position key in", () => {
		const k = keys(0xaaaa, 0xbbbb);
		expect(repertoireKeyFor(k, START)).toBe(0xaaaa);
		expect(repertoireKeyFor(k, AFTER_E4)).toBe(0xbbbb);
		expect(repertoireSeed(k, START)).toBe(`repertoire:aaaa:${polyglotKey(START).toString(16)}`);
		// The position, not its counters or a non-usable en-passant spelling.
		expect(repertoireSeed(k, AFTER_E4)).toBe(repertoireSeed(k, AFTER_E4_EP));
		expect(repertoireSeed(k, START)).not.toBe(repertoireSeed(k, AFTER_E4));
		// A different key, a different seed; the other colour's key does not enter.
		expect(repertoireSeed(keys(0xaaab, 0xbbbb), START)).not.toBe(repertoireSeed(k, START));
		expect(repertoireSeed(keys(0xaaaa, 0x0001), START)).toBe(repertoireSeed(k, START));
	});

	it("validates the stored shape and builds a pair from two 32-bit values", () => {
		expect(isRepertoireKeys(keys(1, 2))).toBe(true);
		expect(isRepertoireKeys(null)).toBe(false);
		expect(isRepertoireKeys({ w: 1 })).toBe(false);
		expect(isRepertoireKeys({ w: 1.5, b: 2, createdAt: 1 })).toBe(false);
		expect(isRepertoireKeys({ w: -1, b: 2, createdAt: 1 })).toBe(false);
		expect(isRepertoireKeys({ w: 2 ** 32, b: 2, createdAt: 1 })).toBe(false);
		expect(makeRepertoireKeys([0xdeadbeef, 7], 99)).toEqual({ w: 0xdeadbeef, b: 7, createdAt: 99 });
	});
});

describe("book policy with a repertoire", () => {
	const policyWith = (repertoire: RepertoireKeys | null) =>
		createBookPolicy({ loadBook: async () => book, repertoire: async () => repertoire });

	it("two sessions with the same key draw the same first move, whatever their per-game rng", async () => {
		const k = keys(0x1234_5678, 0x9abc_def0);
		for (const fen of [START, AFTER_E4]) {
			const picks = new Set<string>();
			for (let game = 0; game < 12; game++) {
				const policy = policyWith(k);
				const chosen = await policy.bookMove(ctx({ fen, rng: createRng(`game-${game}`) }));
				picks.add(chosen?.uci ?? "none");
				expect(chosen?.rationale.join(" ")).toContain("repertoire");
				policy.dispose();
			}
			expect(picks.size).toBe(1);
		}
	});

	it("different keys draw different repertoires (across a handful of profiles both moves appear)", async () => {
		const picks = new Set<string>();
		for (let profile = 0; profile < 16; profile++) {
			const policy = policyWith(keys(profile * 7919 + 1, profile * 104_729 + 3));
			picks.add((await policy.bookMove(ctx()))?.uci ?? "none");
			policy.dispose();
		}
		expect(picks).toEqual(new Set(["e2e4", "d2d4"]));
	});

	it("without keys the per-game rng decides, as before H14.1", async () => {
		const policy = policyWith(null);
		const a = await policy.bookMove(ctx({ rng: createRng(1) }));
		expect(a?.rationale.join(" ")).not.toContain("repertoire");
		// The same per-game seed gives the same draw; the sampler is still the seeded rng.
		const b = await policy.bookMove(ctx({ rng: createRng(1) }));
		expect(b?.uci).toBe(a?.uci ?? "");
		policy.dispose();
	});

	it("prepare() reads the keys once and a failing loader falls back to the per-game rng", async () => {
		let loads = 0;
		const policy = createBookPolicy({
			loadBook: async () => book,
			repertoire: async () => {
				loads += 1;
				throw new Error("storage down");
			},
		});
		await policy.prepare?.();
		await policy.prepare?.();
		expect((await policy.bookMove(ctx()))?.uci).toMatch(/^(e2e4|d2d4)$/);
		expect(loads).toBe(1);
		policy.dispose();
	});
});

describe("repertoire storage", () => {
	beforeEach(() => {
		(globalThis as Record<string, unknown>).chrome = createSimulator().chrome;
	});

	it("creates the keys once under LOCAL_KEYS.repertoire and reads the same pair back", async () => {
		const first = await loadRepertoireKeys(() => 42);
		expect(first).not.toBeNull();
		expect(isRepertoireKeys(first)).toBe(true);
		expect(first?.createdAt).toBe(42);
		const second = await loadRepertoireKeys(() => 43);
		expect(second).toEqual(first as RepertoireKeys);
		// A fresh policy over the real loader draws the same repertoire as another one.
		const a = createBookPolicy({ loadBook: async () => book });
		const b = createBookPolicy({ loadBook: async () => book });
		expect((await a.bookMove(ctx({ rng: createRng(1) })))?.uci).toBe(
			(await b.bookMove(ctx({ rng: createRng(2) })))?.uci ?? ""
		);
		a.dispose();
		b.dispose();
	});

	it("replaces a malformed stored value and reset forgets the pair", async () => {
		await new Promise<void>((resolve) =>
			chrome.storage.local.set({ [LOCAL_KEYS.repertoire]: { w: "x" } }, () => resolve())
		);
		const created = await loadRepertoireKeys(() => 1);
		expect(isRepertoireKeys(created)).toBe(true);
		await resetRepertoireKeys();
		const stored = await new Promise<Record<string, unknown>>((resolve) =>
			chrome.storage.local.get(LOCAL_KEYS.repertoire, (items) => resolve(items))
		);
		expect(stored[LOCAL_KEYS.repertoire]).toBeUndefined();
	});

	it("the bundled book name is what the policy loads (the repertoire changes the draw, not the source)", async () => {
		const loads: string[] = [];
		const policy = createBookPolicy({
			loadBook: async (name) => {
				loads.push(name);
				return book;
			},
		});
		await policy.bookMove(ctx());
		expect(loads).toEqual([BOOKS.club]);
		policy.dispose();
	});
});
