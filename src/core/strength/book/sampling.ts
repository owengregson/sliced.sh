/** Which books a target plays from, and the `p ∝ weight^γ(E)` sampler over their moves. */

import { BOOK, type BookName } from "@core/constants/books";
import type { Rng } from "@core/rng";
import { clamp } from "@core/util/clamp";
import type { BookMove } from "./polyglot";

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
