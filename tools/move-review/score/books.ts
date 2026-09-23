/** tools/move-review/score/books.ts — the Book verdict, by the live review's own rule. */

import path from "node:path";
import { BOOKS, THEORY_BOOKS } from "@core/constants/books";
import { theoryMoves } from "@core/strength/book/book-policy";
import { loadBook, type PolyglotBook } from "@core/strength/book/polyglot";

/**
 * Whether `uci` from `fen` is theory in the books under `booksDir` (a missing book counts as
 * empty) — `BookPolicy.bookMoves` over `THEORY_BOOKS`.
 */
export async function theoryLookup(
	booksDir: string
): Promise<(fen: string, uci: string) => boolean> {
	const readBook = async (name: string): Promise<PolyglotBook | null> => {
		const file = Bun.file(path.join(booksDir, name));
		return (await file.exists()) ? loadBook(new Uint8Array(await file.arrayBuffer())) : null;
	};
	const books = await Promise.all(THEORY_BOOKS.map((name) => readBook(BOOKS[name])));
	return (fen, uci) => theoryMoves(...books.map((book) => book?.lookup(fen) ?? [])).includes(uci);
}
