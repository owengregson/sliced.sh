/**
 * The `MoveContext` every route to the executor hands over with a recommendation — `schedule`,
 * `playNow` and the premove / hold paths alike — so the hand's repertoire, candidates and guards
 * have one definition.
 */

import { loadPosition } from "@core/chess/fen";
import { phase as phaseOf } from "@core/chess/phase";
import { isSharp } from "@core/motor/opponent-candidates";
import type { MoveContext } from "@service/move-executor";
import { candidatesFromLines } from "@service/move-executor";
import type { Recommendation, Square } from "@typedefs/game";
import type { SessionCore } from "./core";
import { legalDestinations } from "./position-rules";

/** The per-recommendation facts the context carries that the core does not know. */
export interface MoveContextFlags {
	/** A premove is entered on the site or a piece is held (`repertoire.premovePending`). */
	premovePending: boolean;
	/** A recovery: the executor must re-check the position before dispatching. */
	requirePositionCheck: boolean;
	/** Fix F: `rec` is the premove entered on the site. */
	queuedPremove: boolean;
}

export function moveContextFor(
	core: SessionCore,
	rec: Recommendation,
	flags: MoveContextFlags
): MoveContext {
	const snapshot = core.snapshot;
	const position = loadPosition(rec.fen);
	const ctx: MoveContext = {
		repertoire: {
			targetElo: core.targetElo(),
			phase: phaseOf(rec.fen, snapshot?.ply ?? 0) ?? "middlegame",
			persona: core.settings().strength.persona,
			sharp: isSharp(rec.fen, rec.lines),
			inCheck: position?.isCheck() === true,
			forced: position?.moves().length === 1,
			premovePending: flags.premovePending,
		},
		nReasonable: core.recNReasonable,
		// The executor's own rank-weighted derivation (Task 18) — one definition, not two.
		candidates: candidatesFromLines(rec),
		legalDestinations: (sq: Square) => {
			const fen = core.snapshot?.fen;
			return fen ? legalDestinations(fen, sq) : [];
		},
	};
	if (snapshot?.myColor) ctx.myClockMs = core.remainingClockMs(snapshot, snapshot.myColor);
	if (snapshot?.lastMove) ctx.lastMove = { from: snapshot.lastMove.from, to: snapshot.lastMove.to };
	if (flags.requirePositionCheck) ctx.requirePositionCheck = true;
	// Fix F: the flag travels with the *recommendation*, not with the call, so every route to
	// the executor carries it — `schedule` and `playNow`'s re-built context alike.
	if (flags.queuedPremove) ctx.queuedPremove = true;
	return ctx;
}
