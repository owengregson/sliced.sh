/**
 * The move card's content as pure functions of the snapshot: its state (§5.6), the operational
 * phase, the expected reply, the plan line, the note under the move, and an execution's identity.
 */

import { sideToMove } from "@core/chess/fen";
import type { PanelSnapshot } from "@core/constants/messages";
import type { Color } from "@typedefs/game";
import { formatKeybind } from "../../components/keybind";
import type { MoveCardData, MoveProgressPhase } from "../../components/move-card";
import { COPY } from "../../copy";

const MS = 1000;

/** Card state from the snapshot (§5.6 states). */
export function moveCardState(snapshot: PanelSnapshot): MoveCardData["state"] {
	if (!snapshot.settings.enabled) return "disabled";
	if (snapshot.engine.state === "crashed") return "engine-stopped";
	const { session, recommendation } = snapshot;
	const myColor = session.myColor;
	// The colour is three-valued (§4.4's hold applied to it), and its third value is not "thinking":
	// with no colour the session plans nothing at all, so a spinner would promise something that is not
	// coming. It covers both the live page's first second and a colour the adapter has withdrawn after
	// the site contradicted the one it gave (review R2-1).
	if (myColor === null) return "colour-unknown";
	if (session.sideToMove && session.sideToMove !== myColor) return "opponent";
	if (session.state === "live:my-turn:analysing" || !recommendation) return "thinking";
	return "your-move";
}

/** One operational phase drives the live heading and the progress card. */
export function moveProgressPhase(snapshot: PanelSnapshot): MoveProgressPhase {
	if (!snapshot.settings.enabled) return "paused";
	if (snapshot.engine.state === "crashed") return "error";
	if (snapshot.session.myColor === null) return "reading";
	if (snapshot.session.state === "live:my-turn:executing" && snapshot.session.canPlayNow !== true)
		return "executing";
	const state = moveCardState(snapshot);
	if (state === "opponent") return "waiting";
	if (state === "thinking") return "analysing";
	return snapshot.autoMove.armed &&
		snapshot.autoMove.scheduledAt !== undefined &&
		snapshot.autoMove.plan !== undefined
		? "thinking"
		: "ready";
}

/** Opponent to move: the reply the top line expects (§5.6 opponent-to-move). */
export function expectedReply(snapshot: PanelSnapshot): string | null {
	const rec = snapshot.recommendation;
	const top = rec?.lines[0];
	if (!rec || !top) return null;
	const stm: Color = sideToMove(rec.fen) ?? "w";
	const analysedMyPosition = snapshot.session.myColor === null || stm === snapshot.session.myColor;
	return (analysedMyPosition ? top.pvSan[1] : top.pvSan[0]) ?? null;
}

/** Plan line text (§6.2 step 1): "thinking 4.2s · drag" (+ " · premove"). */
export function planText(snapshot: PanelSnapshot): string | null {
	const plan = snapshot.autoMove.plan ?? snapshot.recommendation?.plan;
	if (!plan) return null;
	return COPY.move.plan(
		(plan.thinkMs / MS).toFixed(1),
		COPY.execution.drag,
		plan.mode === "premove"
	);
}

/** `at` when the controller stamps it; otherwise the result's structural identity. */
export function executionKey(exec: NonNullable<PanelSnapshot["session"]["lastExecution"]>): string {
	if (exec.at !== undefined) return `at:${exec.at}`;
	const timeline = exec.timeline.map((t) => `${t.phase}:${t.startMs}-${t.endMs}`).join(",");
	return `${exec.outcome}|${exec.tier}|${exec.attempts}|${exec.elapsedMs}|${timeline}`;
}

/** The note under the move (§5.6): what the card is waiting for, or where the move came from. */
export function noteFor(snapshot: PanelSnapshot, state: MoveCardData["state"]): string | null {
	if (state === "engine-stopped")
		return COPY.move.engineStoppedHint(formatKeybind(snapshot.settings.keybinds.disable));
	if (state === "opponent" && expectedReply(snapshot)) return COPY.move.notePrediction;
	if (state !== "your-move" || !snapshot.recommendation) return null;
	// The play button is disabled until the hand is armed (§13.4, and auto-play ships off), so the
	// card would otherwise sit there with a move on it and nothing happening. Say what to press.
	if (!snapshot.autoMove.armed)
		return COPY.move.noteUnarmed(formatKeybind(snapshot.settings.keybinds.toggleAutoMove));
	const { chosen, eval: score } = snapshot.recommendation;
	if (chosen.source === "book") return COPY.move.noteBook;
	if (score.mate !== undefined && score.mate > 0) return COPY.move.noteMate(score.mate);
	if (snapshot.recommendation.lines.length === 1) return COPY.move.noteOnly;
	return COPY.move.noteSearch(snapshot.recommendation.depth);
}
