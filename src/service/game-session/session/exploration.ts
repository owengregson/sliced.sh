/**
 * The hand's idle attention during the opponent's turn: fresh candidate bouts that share the hand
 * with moves and are invalidated with the position. The executor asks for its inputs each time it
 * wants a bout, so every answer is read at that moment.
 */

import { loadPosition } from "@core/chess/fen";
import { isLoneKing } from "@core/chess/material";
import { phase as phaseOf } from "@core/chess/phase";
import { parseUci } from "@core/chess/san";
import {
	isSharp,
	type OpponentAttentionContext,
	opponentExplorationCandidates,
} from "@core/motor/opponent-candidates";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { tcClass } from "@core/timing/features";
import type { PonderController } from "../ponder";
import type { SessionCore } from "./core";
import { MS_PER_S, motorTcClass } from "./position-rules";
import type { PremoveArm } from "./premove";

/** What the exploration asks of the premove and hold state, at the moment it asks. */
export interface ExplorationView {
	armedPremove(): PremoveArm | null;
	/** A premove is entered on the site (Fix F). */
	entered(): boolean;
	/** The hand is carrying a held piece (`SCRAMBLE_HOLD`). */
	holding(): boolean;
}

/** Fresh candidate bouts share the hand with moves, and are invalidated with the position. */
export function startOpponentExploration(core: SessionCore, view: ExplorationView): void {
	const snapshot = core.snapshot;
	const executor = core.executor;
	if (!snapshot || !executor?.isArmed()) return;
	const eligible = () =>
		!core.disposed &&
		core.snapshot === snapshot &&
		core.state === "live:opponent-turn" &&
		core.mayActOn(snapshot) &&
		snapshot.myColor !== snapshot.sideToMove &&
		core.selfConsistent(snapshot) &&
		executor.isArmed();
	if (!eligible()) return;
	const loneKing = snapshot.myColor !== null && isLoneKing(snapshot.fen, snapshot.myColor);
	const position = loadPosition(snapshot.fen);
	const forcedReply = position?.isCheck() === true || position?.moves().length === 1;
	let lastLines: ReturnType<PonderController["latestLines"]> | undefined;
	let cached: ReturnType<typeof opponentExplorationCandidates> | undefined;
	const tc = core.currentTimeControl();
	const tcClassOf = motorTcClass(
		tc ? tcClass(tc.baseMs / MS_PER_S, tc.incMs / MS_PER_S) : "untimed"
	);
	const phase = phaseOf(snapshot.fen, snapshot.ply) ?? "middlegame";
	// Their piece that just moved: on the opponent's turn `snapshot.lastMove` is *our* move, so
	// their last one is the ply before it in the history.
	const theirs = parseUci(core.historyFor(snapshot.fen).moves.at(-2) ?? "");
	const lastMove = theirs ? { from: theirs.from, to: theirs.to } : undefined;
	executor.exploreOpponent(() => {
		if (!eligible() || snapshot.myColor === null) return null;
		const lines = core.ponderer?.latestLines(snapshot.fen);
		if (!cached || lines !== lastLines) {
			cached = opponentExplorationCandidates(snapshot.fen, snapshot.myColor, lines, lastMove);
			lastLines = lines;
		}
		const myClock = core.remainingClockMs(snapshot, snapshot.myColor);
		const opponentClock = core.remainingClockMs(snapshot, snapshot.myColor === "w" ? "b" : "w");
		const lowTime = [myClock, opponentClock].some(
			(clock) => clock > 0 && clock < TIMING_CONSTANTS.clockRace.explorationLowClockMs
		);
		const armed = view.armedPremove();
		// The square we intend to move to next is never a rest spot: the armed premove's, else
		// the ponder's own answer to its top line.
		const intended = armed?.chosen.to ?? parseUci(lines?.[0]?.pvUci[1] ?? "")?.to;
		const attention: OpponentAttentionContext = {
			repertoire: {
				targetElo: core.targetElo(),
				phase,
				persona: core.settings().strength.persona,
				sharp: isSharp(snapshot.fen, lines ?? []),
				forced: forcedReply,
				premovePending: armed !== null || view.entered() || view.holding(),
			},
			tcClass: tcClassOf,
			opponentThinkMs: Math.max(0, core.now() - snapshot.capturedAt),
			myClockMs: myClock,
			opponentClockMs: opponentClock,
			phase,
			sharp: isSharp(snapshot.fen, lines ?? []),
			armed: armed !== null || view.entered() || view.holding(),
			...(intended ? { intendedTo: intended } : {}),
		};
		return {
			...cached,
			attention,
			policy: {
				lowTime,
				ownOnly:
					lowTime ||
					loneKing ||
					forcedReply ||
					armed !== null ||
					view.entered() ||
					(lines?.some((line) => line.score.mate !== undefined) ?? false),
			},
		};
	});
}
