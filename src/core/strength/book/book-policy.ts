/**
 * Opening-book policy (Task 15, §7.3, Appendix E §2.2–§2.3): while `ply ≤ 30`
 * and `Settings.strength.useOpeningBook`, play from the bundled Polyglot book
 * for the rating band (`gm2600` from E ≥ 1800, `club` below), else `null` so
 * §7.2 engine selection takes over. Moves are sampled `p ∝ weight^γ(E)`, so a
 * weaker target spreads its probability over the sidelines a strong one would
 * not touch. From E ≥ 1800 a book move that loses ≥ 0.15 win-fraction against
 * the engine's best line is refused (the "known trap" check); the engine lines
 * are optional input.
 *
 * The bundled books are the only book source: there is no network request on
 * this path (§13.3 — one fewer outbound signal).
 */

import { legalMoves, parseUci, uciToSan } from "@core/chess/san";
import { runtimeGetURL } from "@core/chrome/runtime";
import { BOOK, BOOKS, type BookName } from "@core/constants/books";
import { log } from "@core/logger";
import type { Rng } from "@core/rng";
import { clamp } from "@core/util/clamp";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove } from "@typedefs/game";
import { cpEffective, winProb } from "../elo-map";
import { type BookMove, loadBook, type PolyglotBook } from "./polyglot";

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
}

export interface BookPolicy {
	bookMove(ctx: BookContext): Promise<ChosenMove | null>;
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

/** `gm2600` from `BOOK.gmBookElo`, `club` below. */
export function bookNameFor(E: number): BookName {
	return E >= BOOK.gmBookElo ? "gm2600" : "club";
}

export interface LineFacts {
	rank: number;
	cpLoss: number;
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
	if (!lines || lines.length === 0) return { rank: 0, cpLoss: 0, loss: null, lossLowerBound: 0 };
	let bestCp = Number.NEGATIVE_INFINITY;
	let worstCp = Number.POSITIVE_INFINITY;
	for (const line of lines) {
		const cp = cpEffective(line.score);
		bestCp = Math.max(bestCp, cp);
		worstCp = Math.min(worstCp, cp);
	}
	const index = lines.findIndex((line) => line.pvUci[0] === uci);
	if (index < 0) {
		const bound = Math.max(0, winProb(bestCp) - winProb(worstCp));
		return { rank: 0, cpLoss: 0, loss: null, lossLowerBound: bound };
	}
	const cp = cpEffective(lines[index]?.score ?? {});
	const loss = Math.max(0, winProb(bestCp) - winProb(cp));
	return { rank: index + 1, cpLoss: Math.max(0, bestCp - cp), loss, lossLowerBound: loss };
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
	/** Loaded books (or `null` after a failed load, so it is not retried every move). */
	const books = new Map<BookName, Promise<PolyglotBook | null>>();
	let disposed = false;

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
			cpLoss: facts.cpLoss,
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
		const name = bookNameFor(E);
		const book = await bookFor(name);
		if (!book || disposed) return null;
		const entries = book.lookup(ctx.fen);
		if (entries.length === 0) return null;
		const pick = sampleByFrequency<BookMove>(
			entries,
			(m) => m.weight,
			(w, total) => w >= BOOK.minWeightShare * total,
			E,
			ctx.rng
		);
		if (!pick) return null;
		const facts = lineFacts(pick.uci, ctx.lines);
		if (isTrap(E, facts)) {
			log.debug("book: refused a trap", pick.uci, fmt(facts.lossLowerBound));
			return null;
		}
		const total = entries.reduce((sum, m) => sum + m.weight, 0);
		return finish(pick.uci, ctx, facts, [`polyglot ${BOOKS[name]}: weight ${pick.weight}/${total}`]);
	}

	return {
		async bookMove(ctx) {
			if (disposed || !ctx.useOpeningBook || ctx.ply > BOOK.maxPly) return null;
			return fromPolyglot(ctx);
		},
		dispose() {
			disposed = true;
			books.clear();
		},
	};
}
