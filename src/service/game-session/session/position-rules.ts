/**
 * Pure questions the session asks about a position, a move or a page — no session state, so each
 * one is testable on its own and cannot drift between the collaborators that share it.
 */

import { type FenParts, parseFen, plyOf } from "@core/chess/fen";
import { applyMoves, legalMoves } from "@core/chess/san";
import { isSquare } from "@core/chess/squares";
import { CHESS_START_FEN } from "@core/constants/chess";
import type { TimeControlClass } from "@core/motor/types";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import type { TcClass } from "@core/timing/types";
import type { ChosenMove, GameMeta, PageKind, PositionSnapshot, Square } from "@typedefs/game";

export const MS_PER_S = 1000;

/**
 * `ChosenMove.rankInLines` is 1-based (`selectMove` numbers the best line `1`); `0` means the
 * move was not among the engine's lines at all — what the opening book and a premove report.
 */
export const TOP_LINE_RANK = 1;

/** Pages where a game is played: the review engine is worth booting as soon as one says `hello`. */
export const PLAYED_PAGES: ReadonlySet<PageKind> = new Set<PageKind>([
	"live-game",
	"live-lobby",
	"vs-computer",
	"daily",
]);

/** `t_premove ~ U(0, maxS)` — §7.4 / Appendix D §3a.5 (120 ms). */
export const PREMOVE_WINDOW_MS = TIMING_CONSTANTS.premove.maxS * MS_PER_S;

/**
 * §13.6: a move the quality pair may be computed over. A premove is decided before the position
 * it is played in exists, and a book move the engine's lines never ranked has neither a rank nor a
 * loss — both report `rankInLines: 0` and `cpLoss: 0`, which would score as a zero-loss non-top-1
 * move and pull `top1Pct` *and* `acpl` down in exactly the speed classes §7.4 premoves in.
 */
export function isScoredMove(chosen: ChosenMove): boolean {
	return (
		chosen.quality?.eligible === true &&
		chosen.source !== "premove" &&
		chosen.rankInLines >= TOP_LINE_RANK &&
		Number.isFinite(chosen.cpLoss) &&
		(chosen.cpLoss ?? -1) >= 0
	);
}

/**
 * The game's first move: ply 0 playing white, ply 1 playing black. The scope of the owner's
 * 2026-09-10 §13.4 ruling (`docs/qa/focus-discipline.md` §4) and the only move where no later
 * position can arrive to carry a second chance — as white the board cannot change until we play.
 *
 * Counted from the **FEN's own move counters** (`plyOf`), never from `PositionSnapshot.ply`. That
 * field is `plyOf(readMoveList(document))`, a read of chess.com's move-list DOM, and it is **0**
 * whenever the list element cannot be found — which on `/play/online` (no URL game id) also bumps
 * the adapter's game serial, so the session starts a "new game" holding a *mid-game* position that
 * claims `ply: 0`. Scoping the ruling on that would hand every remaining move of such a game the
 * first-move relaxation the owner explicitly declined. The FEN comes from the MAIN-world bridge and
 * cannot claim fullmove 1 on a mid-game board; the adapter guards the FEN against exactly this
 * confusion (`chesscom.ts`, "an empty list must not 'prove' the start position") and `ply` never got
 * the same cross-check.
 */
export const FIRST_MOVE_LAST_PLY = 1;

/** Placement field of the start position — the only one a fullmove-1 white-to-move FEN can carry. */
const START_PLACEMENT = CHESS_START_FEN.split(" ")[0];

/**
 * Does this FEN's **placement** agree with its claim to be the game's first move? The counters say
 * fullmove 1; the pieces have to say so too.
 *
 * This is deliberately independent of where the FEN came from. `PositionSnapshot.approximate` is a
 * *provenance* claim — "the page gave us this" — and the predicate's safety would otherwise be the
 * conjunction of three adapter code paths staying honest, one of which is already weaker than it
 * reads: the SAN-replay source is uncorroborated on a canvas board (its only test there is
 * `ply > 0`), so one parseable move-list node on a mid-game board can publish fullmove 1 with
 * `approximate: false`. A placement check cannot be fooled by any of that: at fullmove 1 the board is
 * either untouched (white to move) or one legal white move from untouched (black to move).
 */
export function isFirstMovePlacement(parts: FenParts): boolean {
	if (parts.turn === "w") return parts.placement === START_PLACEMENT;
	for (const uci of legalMoves(CHESS_START_FEN)) {
		const after = applyMoves(CHESS_START_FEN, [uci]);
		if (after !== null && after.split(" ")[0] === parts.placement) return true;
	}
	return false;
}

/**
 * The game's first move by the FEN's own counters and placement, whatever the reading's
 * provenance — the first-position time-control hold's scope (`isGameFirstMove` adds provenance).
 */
export function claimsFirstMove(fen: string): boolean {
	const parts = parseFen(fen);
	return parts !== null && plyOf(parts) <= FIRST_MOVE_LAST_PLY && isFirstMovePlacement(parts);
}

/**
 * Is this the game's first move? The scope of the §13.4 first-move relaxation, named rather than
 * compared inline so that the ruling's boundary is visible at the call site and cannot quietly
 * widen to every move — which is the version the owner explicitly did not choose.
 */
export function isGameFirstMove(snapshot: PositionSnapshot): boolean {
	// Provenance, and it fails **closed**: only an explicit `false` counts. An approximate FEN is
	// the adapter's own reconstruction from the DOM placement, and its fullmove counter is
	// `Math.floor(ply / 2) + 1` — the very field this predicate stopped trusting — so a mid-game
	// placement with an unreadable move list can be published as fullmove 1. A snapshot that does
	// not state its provenance at all is not evidence either: absent must not mean trusted on a
	// §13.4 permission, or a future producer inherits the relaxation by omission.
	if (snapshot.approximate !== false) return false;
	const parts = parseFen(snapshot.fen);
	// A FEN we cannot parse is not evidence of anything: refuse rather than widen.
	if (parts === null || plyOf(parts) > FIRST_MOVE_LAST_PLY) return false;
	// And the counters have to be corroborated by the pieces (`isFirstMovePlacement`): provenance
	// is a claim about the source, not a consistency check on the position.
	return isFirstMovePlacement(parts);
}

/**
 * Placement plus side to move — the part of a FEN that says which position is on the board. The
 * halfmove and fullmove counters (and an en-passant square the adapter had to approximate) are not
 * identity, so comparing whole FENs would reject a position that *is* the one we expect.
 */
export function boardKeyOf(fen: string): string {
	return fen.split(" ").slice(0, 2).join(" ");
}

/** The motor's four-way class (it has no untimed profile; an untimed game moves like classical). */
export function motorTcClass(tc: TcClass): TimeControlClass {
	return tc === "untimed" ? "classical" : tc;
}

/** A game's time control in seconds, `[0, 0]` when none is known. */
export function timeControlSeconds(meta: GameMeta): [number, number] {
	const tc = meta.timeControl;
	if (!tc) return [0, 0];
	return [tc.baseMs / MS_PER_S, tc.incMs / MS_PER_S];
}

/** The legal UCI move `from → to` in `fen` (a promotion's first legal piece), or `null`. */
export function uciOf(fen: string, from: Square, to: Square): string | null {
	const base = `${from}${to}`;
	const legal = legalMoves(fen);
	if (legal.includes(base)) return base;
	const promotion = legal.find((m) => m.startsWith(base));
	return promotion ?? null;
}

/** Every square the piece on `from` may legally move to in `fen`. */
export function legalDestinations(fen: string, from: Square): Square[] {
	const out: Square[] = [];
	for (const uci of legalMoves(fen)) {
		if (!uci.startsWith(from)) continue;
		const to = uci.slice(2, 4);
		if (isSquare(to)) out.push(to);
	}
	return out;
}

/**
 * The feed's dedupe key for one reading (Task 21 replays `lastPosition` and the outbox on
 * reconnect, so the same ply can arrive twice).
 *
 * `myColor` belongs in the key, not just in the position: the colour of a live game arrives
 * *after* its first reading, the position has not moved by then, and the real content script
 * posts `gameStarted` before that first `position` — so `startGame()` has already reset
 * `lastPositionKey` and the republished ply is the first this key has seen. Without the colour
 * the republish is indistinguishable from the reconnect replay and is dropped, and nothing else
 * can release the hold: as white the position cannot change until the owner moves by hand
 * (owner's live test, 2026-09-09).
 *
 * The time control belongs in the key for exactly the same reason as the colour, and it is the
 * same live game that proved it: the site answers `timeControl.get()` only once the game has
 * actually *started*, on a position that has not moved (as white it cannot move until the owner
 * plays). Without it the republish carrying the clock is indistinguishable from the reconnect
 * replay, is dropped, and the whole first move is planned `untimed` — classical motor, no
 * premoves, a 7.5 s think in a 1+0 game.
 *
 * `approximate` belongs in the key for the same reason the colour and the time control do: it is
 * information about the position that can arrive *after* the first reading of it (the bridge
 * answers and the adapter republishes an exact FEN for the same ply), and it now gates a §13.4
 * permission. Without it the republish is indistinguishable from the reconnect replay, is dropped,
 * and the first reading's provenance sticks for the whole position.
 */
export function positionFeedKey(snapshot: PositionSnapshot): string {
	const tc = snapshot.timeControl;
	return `${snapshot.gameId}|${snapshot.ply}|${snapshot.fen}|${snapshot.myColor ?? "?"}|${
		tc ? `${tc.baseMs}+${tc.incMs}` : "?"
	}|${snapshot.approximate === true ? "~" : "="}`;
}

/**
 * The identity a blur is remembered against: the game and the **FEN**, never `snapshot.ply`. The
 * ply is the adapter's move-list read and can be 0 — or simply wrong — on a board that has moved
 * (the same reason `isGameFirstMove` reads the FEN), and a lying ply on a republished position
 * would make the remembered blur stop matching and release a move it should hold. The FEN comes
 * from the bridge and is identical across the republish that carries the colour or the clock.
 * A repeated position later in the game cannot collide with this: the only release this gates is
 * the game's first move, whose FEN cannot recur. Including the `gameId` is what makes a reset on
 * `startGame` unnecessary — a key from the previous game can never match this one's.
 */
export function positionIdentity(snapshot: PositionSnapshot): string {
	return `${snapshot.gameId}|${snapshot.fen}`;
}
