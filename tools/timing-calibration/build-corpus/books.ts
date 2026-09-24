/**
 * tools/timing-calibration/build-corpus/books.ts — the shipped Polyglot books and the two book
 * questions a label asks: the moves the bot's own book would play for a player of this rating
 * (`bookOrderFor(E)`: the first book that knows the position, moves with weight share ≥
 * `BOOK.minWeightShare`, at ply ≤ `BOOK.maxPly`, E ≤ `MAIA.eloMax`), and the theory moves
 * (`THEORY_BOOKS`, the review's Book).
 */

import path from "node:path";
import { BOOK, BOOKS, type BookName, THEORY_BOOKS } from "@core/constants/books";
import { MAIA } from "@core/constants/maia";
import { loadBook, type PolyglotBook } from "@core/strength/book/polyglot";
import { bookOrderFor } from "@core/strength/book/sampling";
import { ROOT } from "../../lib/paths";

export type BookSet = Record<BookName, PolyglotBook>;

export async function loadBooks(): Promise<BookSet> {
	const read = async (name: BookName) =>
		loadBook(new Uint8Array(await Bun.file(path.join(ROOT, BOOKS.dir, BOOKS[name])).arrayBuffer()));
	return { gm2600: await read("gm2600"), club: await read("club"), theory: await read("theory") };
}

/** The moves the bot's own book would play from `fen` for a player rated `elo`. */
export function botBookMoves(books: BookSet, fen: string, ply: number, elo: number): string[] {
	if (ply > BOOK.maxPly || elo > MAIA.eloMax) return [];
	for (const name of bookOrderFor(elo)) {
		const entries = books[name].lookup(fen);
		if (entries.length === 0) continue;
		const total = entries.reduce((s, e) => s + e.weight, 0);
		return entries
			.filter((e) => e.weight > 0 && e.weight >= BOOK.minWeightShare * total)
			.map((e) => e.uci);
	}
	return [];
}

export function theoryMovesAt(books: BookSet, fen: string): string[] {
	const out = new Set<string>();
	for (const name of THEORY_BOOKS)
		for (const e of books[name].lookup(fen)) if (e.weight > 0) out.add(e.uci);
	return [...out];
}
