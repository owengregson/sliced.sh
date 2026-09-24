/**
 * Post-drop rest (§9.4, owner 2026-09-11): a moment on the dropped piece, then a quick decision.
 * Either the hand goes straight to pondering — the execution ends and the opponent-turn
 * exploration takes over — or it first walks to a random piece, either colour, drawn toward the
 * centre of the board, and rests there briefly. The move is complete by now, so a gate veto or an
 * abort here merely ends the walk where it is. Without occupancy there is no piece to rest on and
 * the decision is "ponder".
 */

import { ALL_SQUARES, fileOf, rankOf } from "@core/chess/squares";
import { EXECUTOR } from "@core/constants/cdp";
import type { BoardGeometryReply } from "@core/constants/messages";
import { log } from "@core/logger";
import { SAMPLING } from "@core/motor/constants";
import { sampleRange } from "@core/motor/geometry";
import { generatePath, idleTremor } from "@core/motor/path-generator";
import { samplePointInRect } from "@core/motor/sampling";
import type { ExecutionPlan, MotorProfile, Rect } from "@core/motor/types";
import type { Rng } from "@core/rng";
import { errorMessage } from "@core/util/errors";
import { isAbortedError } from "@core/util/scheduler";
import type { Square } from "@typedefs/game";
import { SkipError } from "../errors";
import { boardGeometryOf } from "../geometry";
import type { HandMotor } from "../motor";
import type { Timeline } from "../timeline";

/**
 * The square of a random piece — ours or theirs, never the one just moved — weighted toward the
 * centre (`EXECUTOR.postDropCentreBias`), in the geometry the page reported. `null` without
 * occupancy or with no other piece on the board.
 */
export function restPiece(reply: BoardGeometryReply, avoid: Square, rng: Rng): Rect | null {
	const occupancy = reply.occupancy;
	if (!occupancy) return null;
	const squares: Square[] = [];
	const weights: number[] = [];
	for (const sq of ALL_SQUARES) {
		const occ = occupancy[sq];
		if (sq === avoid || (occ !== "own" && occ !== "enemy")) continue;
		// Chebyshev distance from the board's centre: 0.5 for the four middle squares, 3.5 at the rim.
		const fromCentre = Math.max(Math.abs(fileOf(sq) - 3.5), Math.abs(rankOf(sq) - 3.5));
		squares.push(sq);
		weights.push((4 - fromCentre) ** EXECUTOR.postDropCentreBias);
	}
	if (squares.length === 0) return null;
	return boardGeometryOf(reply).squareRect(rng.weighted(squares, weights));
}

export async function postDropRest(
	hand: HandMotor,
	plan: ExecutionPlan,
	reply: BoardGeometryReply | null,
	m: MotorProfile,
	tl: Timeline
): Promise<void> {
	tl.begin("rest");
	hand.setState("rest");
	try {
		await hand.pause(sampleRange(EXECUTOR.postDropLingerMs, hand.rng));
		if (!hand.rng.chance(EXECUTOR.postDropRestProb)) return;
		const rest = reply ? restPiece(reply, plan.to.square, hand.rng) : null;
		if (!rest) return;
		const target = samplePointInRect(
			rest,
			SAMPLING.press.sigmaFrac,
			SAMPLING.press.innerFrac,
			hand.rng
		);
		await hand.travel(generatePath(hand.position(), target, rest, m, hand.rng));
		const restMs = sampleRange(EXECUTOR.postDropRestMs, hand.rng);
		const untilAt = hand.now() + restMs;
		const drift = idleTremor(hand.position(), restMs, m, hand.rng);
		await hand.travel(drift);
		await hand.sleepUntil(untilAt);
	} catch (error) {
		// Whatever was dispatched before the cut is where the hand is now.
		hand.syncPosition();
		if (error instanceof SkipError || isAbortedError(error)) {
			log.debug("hand: post-drop rest cut short", { reason: errorMessage(error) });
			return;
		}
		throw error;
	}
}
