/**
 * H14.1 (2026-09-13, `docs/research/human-move-selection-ideas-2026-09-13.md`): a persistent
 * opening repertoire. The book samples by frequency with `γ(E)` flattening, and before this it
 * drew freshly per position per game — a different first move every game, which no human does
 * ("a human plays 1.e4 for a year", HvS §5.5 / §8.1). The fix is the cheapest one in the
 * document: the sampler's seed is derived from a **per-profile repertoire key** (one random
 * 32-bit value per colour, stored once in `chrome.storage.local`) mixed with the position's
 * Polyglot key, so the same position always draws the same book move for this profile while
 * every other position — and every game the opponent steers elsewhere — still varies.
 *
 * Pure: the storage half is `src/core/storage/repertoire-storage.ts`.
 */

import { sideToMove } from "@core/chess/fen";
import type { Color } from "@typedefs/game";
import { polyglotKey } from "./polyglot";

/** One 32-bit seed per colour we play, plus when the pair was created (diagnostics only). */
export interface RepertoireKeys {
	w: number;
	b: number;
	createdAt: number;
}

const U32 = 0x1_0000_0000;

/** Shape check for a stored value (a hand-edited or pre-H14.1 entry is regenerated). */
export function isRepertoireKeys(value: unknown): value is RepertoireKeys {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.w === "number" &&
		typeof v.b === "number" &&
		Number.isInteger(v.w) &&
		Number.isInteger(v.b) &&
		v.w >= 0 &&
		v.b >= 0 &&
		v.w < U32 &&
		v.b < U32 &&
		typeof v.createdAt === "number"
	);
}

/** The colour's key, by the side to move in `fen` (the book is only ever asked on our move). */
export function repertoireKeyFor(keys: RepertoireKeys, fen: string): number | null {
	const colour: Color | null = sideToMove(fen);
	if (colour === null) return null;
	return colour === "w" ? keys.w : keys.b;
}

/**
 * The seed the book sampler draws from for `fen`: `hash(repertoireKey, colour, positionKey)`,
 * spelled as a string for `createRng` (which FNV-1a-hashes it). The colour is folded in by which
 * key is used; the position by its Polyglot key (placement, side, castling, en passant — the
 * counters do not identify a position). `null` when the FEN states no side to move, in which case
 * the caller keeps its per-game draw.
 */
export function repertoireSeed(keys: RepertoireKeys, fen: string): string | null {
	const key = repertoireKeyFor(keys, fen);
	if (key === null) return null;
	return `repertoire:${key.toString(16)}:${polyglotKey(fen).toString(16)}`;
}

/** A fresh pair from `random` (two values in `[0, 2^32)`, `crypto.getRandomValues` in production). */
export function makeRepertoireKeys(random: readonly [number, number], now: number): RepertoireKeys {
	return { w: random[0] >>> 0, b: random[1] >>> 0, createdAt: now };
}
