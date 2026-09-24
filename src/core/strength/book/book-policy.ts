/**
 * Opening-book policy (Task 15, §7.3, Appendix E §2.2–§2.3): while `ply ≤ 30`
 * and `Settings.strength.useOpeningBook`, play from the bundled Polyglot book
 * for the rating band (`gm2600` from E ≥ 1800, `club` below) — or, when that
 * book does not know the position, from the other game book and then the named
 * theory (2026-09-15), so a line one book is thin on still has book moves —
 * else `null` so §7.2 engine selection takes over. Moves are sampled `p ∝ weight^γ(E)`, so a
 * weaker target spreads its probability over the sidelines a strong one would
 * not touch. From E ≥ 1800 a book move that loses ≥ 0.15 win-fraction against
 * the engine's best line is refused (the "known trap" check); the engine lines
 * are optional input.
 *
 * The bundled books are the only book source: there is no network request on
 * this path (§13.3 — one fewer outbound signal).
 *
 * H14.1 (2026-09-13): the *sampler's* draw is seeded from the persisted per-profile repertoire
 * keys (`repertoire.ts`) rather than from the per-game `rng`, so the same position draws the
 * same book move game after game — a repertoire — while the weak-target early exit keeps its
 * per-game draw. Without keys (no storage, a failed read) the per-game `rng` decides as before.
 */

import { legalMoves, parseUci, uciToSan } from "@core/chess/san";
import { BOOK, BOOKS, type BookName, THEORY_BOOKS } from "@core/constants/books";
import { log } from "@core/logger";
import { createRng, type Rng } from "@core/rng";
import { loadRepertoireKeys } from "@core/storage/repertoire-storage";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove } from "@typedefs/game";
import { fmt } from "../format";
import { moveQuality } from "../quality";
import { isTrap, type LineFacts, lineFacts } from "./line-facts";
import { createBookCache, fetchBundledBook } from "./loader";
import type { BookMove } from "./polyglot";
import { type RepertoireKeys, repertoireSeed } from "./repertoire";
import { bookOrderFor, sampleByFrequency, theoryMoves } from "./sampling";

export { isTrap, type LineFacts, lineFacts } from "./line-facts";
export { bookNameFor, bookOrderFor, gammaFor, sampleByFrequency, theoryMoves } from "./sampling";

export interface BookContext {
	fen: string;
	ply: number;
	/** Effective Elo `E` (§7.2 step 1). */
	targetElo: number;
	/** `Settings.strength.useOpeningBook`. */
	useOpeningBook: boolean;
	rng: Rng;
	/** The engine's current MultiPV lines (side-to-move POV), when available, for the trap check. */
	lines?: readonly EvalLine[] | undefined;
}

export interface BookPolicyDeps {
	/** Bytes of the bundled book `name`; defaults to `fetch(runtimeGetURL(BOOKS.dir + name))`. */
	loadBook?: (name: string) => Promise<Uint8Array | null>;
	/**
	 * H14.1: the profile's repertoire keys; defaults to `loadRepertoireKeys` (created once in
	 * `chrome.storage.local`). `null` → the per-game `rng` seeds the sampler, as before H14.1.
	 */
	repertoire?: () => Promise<RepertoireKeys | null>;
}

export interface BookPolicy {
	bookMove(ctx: BookContext): Promise<ChosenMove | null>;
	/** H14.1: read (or create) the repertoire keys ahead of the first move; idempotent. */
	prepare?(): Promise<void>;
	/**
	 * Every move the master book or the named theory plays from `fen` (`THEORY_BOOKS`, weight > 0) —
	 * opening theory, for the move review's Book rating (2026-09-14). Never the club book: amateur
	 * traps are brilliants on chess.com, not book. Position-based, so a transposition counts.
	 */
	bookMoves?(fen: string): Promise<string[]>;
	dispose(): void;
}

/** The book pick as a `ChosenMove`, or `null` (logged) when the book's move is not legal here. */
function bookChosenMove(
	uci: string,
	ctx: BookContext,
	facts: LineFacts,
	rationale: string[]
): ChosenMove | null {
	const parts = parseUci(uci);
	if (!parts || !legalMoves(ctx.fen).includes(uci)) {
		log.warn("book: illegal move from book", uci);
		return null;
	}
	const chosen: ChosenMove = {
		uci,
		san: uciToSan(ctx.fen, uci) ?? uci,
		from: parts.from,
		to: parts.to,
		source: "book",
		rankInLines: facts.rank,
		...(facts.cpLoss === undefined ? {} : { cpLoss: facts.cpLoss }),
		quality: {
			...moveQuality(
				ctx.lines ?? [],
				ctx.lines?.find((line) => line.pvUci[0] === uci)
			).quality,
			kind: "book",
			eligible: false,
			reason: "book",
		},
		rationale,
	};
	if (parts.promotion !== undefined) chosen.promotion = parts.promotion;
	return chosen;
}

export function createBookPolicy(deps: BookPolicyDeps = {}): BookPolicy {
	const loadRepertoire = deps.repertoire ?? (() => loadRepertoireKeys());
	const books = createBookCache(deps.loadBook ?? fetchBundledBook);
	/** The repertoire keys, read once per policy (a failed read is `null` and not retried). */
	let repertoire: Promise<RepertoireKeys | null> | null = null;
	let disposed = false;

	function repertoireKeys(): Promise<RepertoireKeys | null> {
		if (!repertoire) {
			repertoire = loadRepertoire().catch((err: unknown) => {
				log.warn("book: repertoire keys unavailable", err);
				return null;
			});
		}
		return repertoire;
	}

	/**
	 * H14.1: the sampler's rng — seeded from the repertoire key and the position when the keys
	 * exist and the FEN names a side to move, else the caller's per-game `rng`.
	 */
	function samplerRng(ctx: BookContext, keys: RepertoireKeys | null): Rng {
		const seed = keys ? repertoireSeed(keys, ctx.fen) : null;
		return seed === null ? ctx.rng : createRng(seed);
	}

	/**
	 * A refusal (leaving the book early, or the §7.3 trap check) ends the book path and returns
	 * `null`, so its reason cannot ride along on a `ChosenMove.rationale` the way the accepted
	 * pick's does — it is logged instead of being dropped.
	 */
	async function fromPolyglot(ctx: BookContext): Promise<ChosenMove | null> {
		const E = ctx.targetElo;
		if (E < BOOK.weakElo && ctx.rng.chance(BOOK.weakLeaveProb)) {
			log.debug("book: left book early (weak target)", E);
			return null;
		}
		const [first, ...fallbacks] = bookOrderFor(E);
		if (!first) return null;
		const [primary, keys] = await Promise.all([books.get(first), repertoireKeys()]);
		if (disposed) return null;
		let name: BookName = first;
		let entries = primary?.lookup(ctx.fen) ?? [];
		// A position the band's book does not know may still be theory in another book.
		for (const next of fallbacks) {
			if (entries.length > 0) break;
			const book = await books.get(next);
			if (disposed) return null;
			name = next;
			entries = book?.lookup(ctx.fen) ?? [];
		}
		if (entries.length === 0) return null;
		const rng = samplerRng(ctx, keys);
		const pick = sampleByFrequency<BookMove>(
			entries,
			(m) => m.weight,
			(w, total) => w >= BOOK.minWeightShare * total,
			E,
			rng
		);
		if (!pick) return null;
		const facts = lineFacts(pick.uci, ctx.lines);
		if (isTrap(E, facts)) {
			log.debug("book: refused a trap", pick.uci, fmt(facts.lossLowerBound));
			return null;
		}
		const total = entries.reduce((sum, m) => sum + m.weight, 0);
		const source = rng === ctx.rng ? "" : " · repertoire";
		return bookChosenMove(pick.uci, ctx, facts, [
			`polyglot ${BOOKS[name]}: weight ${pick.weight}/${total}${source}`,
		]);
	}

	return {
		async bookMove(ctx) {
			if (disposed || !ctx.useOpeningBook || ctx.ply > BOOK.maxPly) return null;
			return fromPolyglot(ctx);
		},
		async prepare() {
			if (disposed) return;
			await repertoireKeys();
		},
		async bookMoves(fen) {
			if (disposed) return [];
			const theory = await Promise.all(THEORY_BOOKS.map((name) => books.get(name)));
			return theoryMoves(...theory.map((book) => book?.lookup(fen) ?? []));
		},
		dispose() {
			disposed = true;
			books.clear();
		},
	};
}
