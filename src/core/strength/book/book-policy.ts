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
import { runtimeGetURL } from "@core/chrome/runtime";
import { BOOK, BOOKS, type BookName, THEORY_BOOKS } from "@core/constants/books";
import { log } from "@core/logger";
import { createRng, type Rng } from "@core/rng";
import { loadRepertoireKeys } from "@core/storage/repertoire-storage";
import { clamp } from "@core/util/clamp";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove } from "@typedefs/game";
import { cpEffective, winProb } from "../elo-map";
import { moveQuality, rankedLines } from "../quality";
import { type BookMove, loadBook, type PolyglotBook } from "./polyglot";
import { type RepertoireKeys, repertoireSeed } from "./repertoire";

/** `γ(E) = 0.75 + 0.25·clamp((E − 1200)/1200, 0, 1)`: weaker targets sample flatter. */
export function gammaFor(E: number): number {
	const { base, range, eloFloor, eloSpan } = BOOK.gamma;
	return base + range * clamp((E - eloFloor) / eloSpan, 0, 1);
}

/**
 * Sample one item with `p ∝ n^γ(E)` among those passing `keep`; `null` when
 * nothing survives (Appendix E §2.3).
 */
export function sampleByFrequency<T>(
	items: readonly T[],
	countOf: (item: T) => number,
	keep: (count: number, total: number) => boolean,
	E: number,
	rng: Rng
): T | null {
	let total = 0;
	for (const item of items) total += countOf(item);
	const gamma = gammaFor(E);
	const kept: T[] = [];
	const weights: number[] = [];
	for (const item of items) {
		const n = countOf(item);
		if (n <= 0 || !keep(n, total)) continue;
		kept.push(item);
		weights.push(n ** gamma);
	}
	if (kept.length === 0) return null;
	return rng.weighted(kept, weights);
}

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

async function fetchBundledBook(name: string): Promise<Uint8Array | null> {
	try {
		const res = await fetch(runtimeGetURL(BOOKS.dir + name));
		if (!res.ok) return null;
		return new Uint8Array(await res.arrayBuffer());
	} catch (err) {
		log.warn("book: failed to load", name, err);
		return null;
	}
}

/**
 * Opening theory at a position for the move review's Book rating: every move the given books hold
 * (weight > 0) — the `THEORY_BOOKS`.
 */
export function theoryMoves(...books: ReadonlyArray<readonly BookMove[]>): string[] {
	const moves = new Set<string>();
	for (const entries of books)
		for (const entry of entries) if (entry.weight > 0) moves.add(entry.uci);
	return [...moves];
}

/** `gm2600` from `BOOK.gmBookElo`, `club` below. */
export function bookNameFor(E: number): BookName {
	return E >= BOOK.gmBookElo ? "gm2600" : "club";
}

/** The books a target plays from, in order: its band's book, the other game book, the named theory. */
export function bookOrderFor(E: number): BookName[] {
	return E >= BOOK.gmBookElo ? ["gm2600", "club", "theory"] : ["club", "gm2600", "theory"];
}

export interface LineFacts {
	rank: number;
	cpLoss?: number;
	/** Win-fraction loss vs the best line; `null` when the move is not among the lines. */
	loss: number | null;
	/**
	 * Lower bound on the loss: exact when the move is in the lines, otherwise the loss of the
	 * worst reported line (a move outside MultiPV loses at least that much). 0 without lines.
	 */
	lossLowerBound: number;
}

/** Rank, cp loss and win-fraction loss of `uci` relative to the best of `lines`. */
export function lineFacts(uci: string, lines: readonly EvalLine[] | undefined): LineFacts {
	if (!lines || lines.length === 0) return { rank: 0, loss: null, lossLowerBound: 0 };
	let bestCp = Number.NEGATIVE_INFINITY;
	let worstCp = Number.POSITIVE_INFINITY;
	for (const line of lines) {
		const cp = cpEffective(line.score);
		bestCp = Math.max(bestCp, cp);
		worstCp = Math.min(worstCp, cp);
	}
	const ranked = rankedLines(lines);
	const index = ranked.findIndex((line) => line.pvUci[0] === uci);
	if (index < 0) {
		const bound = Math.max(0, winProb(bestCp) - winProb(worstCp));
		return { rank: 0, loss: null, lossLowerBound: bound };
	}
	const cp = cpEffective(ranked[index]?.score ?? {});
	const loss = Math.max(0, winProb(bestCp) - winProb(cp));
	const measured = moveQuality(lines, ranked[index]);
	return {
		rank: index + 1,
		...(measured.cpLoss === undefined ? {} : { cpLoss: measured.cpLoss }),
		loss,
		lossLowerBound: loss,
	};
}

/**
 * §7.3: from E ≥ 1800 a book move losing ≥ 0.15 win-fraction vs the engine's best is a trap.
 * A move absent from the MultiPV lines is judged by its lower bound (it loses at least as much
 * as the worst reported line); it is only allowed when that bound stays below the threshold.
 */
export function isTrap(E: number, facts: LineFacts): boolean {
	return E >= BOOK.trapCheckElo && facts.lossLowerBound >= BOOK.trapLoss;
}

function fmt(n: number): string {
	return Number(n.toFixed(3)).toString();
}

export function createBookPolicy(deps: BookPolicyDeps = {}): BookPolicy {
	const load = deps.loadBook ?? fetchBundledBook;
	const loadRepertoire = deps.repertoire ?? (() => loadRepertoireKeys());
	/** Loaded books (or `null` after a failed load, so it is not retried every move). */
	const books = new Map<BookName, Promise<PolyglotBook | null>>();
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

	function bookFor(name: BookName): Promise<PolyglotBook | null> {
		let pending = books.get(name);
		if (!pending) {
			pending = load(BOOKS[name])
				.then((bytes) => (bytes ? loadBook(bytes) : null))
				.catch((err: unknown) => {
					log.warn("book: load failed", name, err);
					return null;
				});
			books.set(name, pending);
		}
		return pending;
	}

	function finish(
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
		const [primary, keys] = await Promise.all([bookFor(first), repertoireKeys()]);
		if (disposed) return null;
		let name: BookName = first;
		let entries = primary?.lookup(ctx.fen) ?? [];
		// A position the band's book does not know may still be theory in another book.
		for (const next of fallbacks) {
			if (entries.length > 0) break;
			const book = await bookFor(next);
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
		return finish(pick.uci, ctx, facts, [
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
			const books = await Promise.all(THEORY_BOOKS.map((name) => bookFor(name)));
			return theoryMoves(...books.map((book) => book?.lookup(fen) ?? []));
		},
		dispose() {
			disposed = true;
			books.clear();
		},
	};
}
