/**
 * Move section (Appendix F §4.4 items 4–5, §5.6, §6.2, §6.3): the move card as a projection of
 * the snapshot (your-move / opponent-to-move with the expected reply / thinking / armed /
 * disabled / engine-stopped), the play button's label transitions (`Play move` →
 * `Auto-playing in 4.2s` → hover `Cancel this move` → `Playing…`), the countdown driven from
 * `autoMove.scheduledAt` (the absolute execution time) against `plan.thinkMs`, and the
 * "played" toast + flash when `session.lastExecution` reports an executed move.
 *
 * The countdown ticks on a `setInterval` at the ring's own transition cadence
 * (`motion.duration.1`, the linear real-time curve of §5.10); it is cleared on disarm,
 * unmount and whenever the snapshot stops carrying a schedule.
 */

import { sideToMove } from "@core/chess/fen";
import type { PanelSnapshot } from "@core/constants/messages";
import { TOKENS } from "@design/tokens.generated";
import type { Color } from "@typedefs/game";
import { formatKeybind } from "../../components/keybind";
import { createMoveCard, type MoveCardData, type MoveCardHandle } from "../../components/move-card";
import { showToast } from "../../components/toast";
import { COPY } from "../../copy";
import { playUiSound } from "../../sounds";

const MS = 1000;
const TICK_MS = TOKENS.motion.durationMs[1];

export interface MoveSectionOptions {
	host: HTMLElement;
	onPlay: () => void;
	onCancel: () => void;
}

export interface MoveSectionState {
	snapshot: PanelSnapshot;
	compact: boolean;
	handsOff: boolean;
}

export interface MoveSectionHandle {
	readonly card: MoveCardHandle;
	/** SAN of the move currently recommended (for toasts), or null. */
	readonly san: string | null;
	update(state: MoveSectionState): void;
	dispose(): void;
}

/** Card state from the snapshot (§5.6 states). */
export function moveCardState(snapshot: PanelSnapshot): MoveCardData["state"] {
	if (!snapshot.settings.enabled) return "disabled";
	if (snapshot.engine.state === "crashed") return "engine-stopped";
	const { session, recommendation } = snapshot;
	const myColor = session.myColor;
	if (myColor && session.sideToMove && session.sideToMove !== myColor) return "opponent";
	if (session.state === "live:my-turn:analysing" || !recommendation) return "thinking";
	return "your-move";
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
	const style = snapshot.settings.execution.style;
	const method = style === "click" ? COPY.execution.click : COPY.execution.drag;
	return COPY.move.plan((plan.thinkMs / MS).toFixed(1), method, plan.mode === "premove");
}

export function createMoveSection(options: MoveSectionOptions): MoveSectionHandle {
	const card = createMoveCard(options.host, {
		onPlay: () => options.onPlay(),
		onCancel: () => options.onCancel(),
	});
	let timer: ReturnType<typeof setInterval> | null = null;
	let endAt: number | null = null;
	let totalMs = 0;
	let san: string | null = null;
	let lastExecution: PanelSnapshot["session"]["lastExecution"] | undefined;
	let seenSnapshot = false;
	let executing = false;

	function stopTimer(): void {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
		endAt = null;
	}

	function tick(): void {
		if (endAt === null) return;
		card.countdown(Math.max(0, endAt - Date.now()), totalMs);
	}

	function syncCountdown(snapshot: PanelSnapshot, state: MoveCardData["state"]): void {
		const { armed, scheduledAt, plan } = snapshot.autoMove;
		const running = armed && state === "your-move" && scheduledAt !== undefined && plan !== undefined;
		if (!running) {
			stopTimer();
			return;
		}
		totalMs = plan.thinkMs;
		if (endAt !== scheduledAt) {
			endAt = scheduledAt;
			tick();
		}
		if (timer === null) timer = setInterval(tick, TICK_MS);
	}

	function update(state: MoveSectionState): void {
		const snap = state.snapshot;
		const cardState = moveCardState(snap);
		const rec = snap.recommendation;
		if (cardState === "your-move" && rec) san = rec.chosen.san;
		const reply = cardState === "opponent" ? expectedReply(snap) : null;
		const plan = planText(snap);
		const data: MoveCardData = {
			state: cardState,
			color: snap.session.myColor,
			san: cardState === "opponent" ? reply : (rec?.chosen.san ?? null),
			uci: cardState === "opponent" || !rec ? null : `${rec.chosen.from} → ${rec.chosen.to}`,
			note: noteFor(snap, cardState),
			plan: plan ? { text: plan, totalMs: snap.autoMove.plan?.thinkMs ?? 0 } : null,
			armed: snap.autoMove.armed,
			compact: state.compact,
			kbd: formatKeybind(snap.settings.keybinds.playMove),
			handsOff: state.handsOff,
		};
		card.update(data);
		card.el.classList.toggle("sl-move--hands-off", state.handsOff);
		syncCountdown(snap, cardState);

		const nowExecuting = snap.session.state === "live:my-turn:executing";
		if (nowExecuting && !executing) card.executing();
		executing = nowExecuting;

		// A new execution result (not the one the view mounted with) → §6.3 "played".
		const exec = snap.session.lastExecution;
		if (exec && exec !== lastExecution && seenSnapshot) onExecution(exec, snap);
		lastExecution = exec;
		seenSnapshot = true;
	}

	function onExecution(
		exec: NonNullable<PanelSnapshot["session"]["lastExecution"]>,
		snap: PanelSnapshot
	): void {
		if (exec.outcome !== "executed") return;
		const method = exec.tier === "click" ? COPY.execution.click : COPY.execution.drag;
		card.played();
		showToast("success", COPY.toast.played(san ?? "", (exec.elapsedMs / MS).toFixed(1), method));
		if (snap.settings.display.uiSounds) playUiSound("movePlayed");
	}

	return {
		card,
		get san() {
			return san;
		},
		update,
		dispose() {
			stopTimer();
			card.dispose();
		},
	};
}

function noteFor(snapshot: PanelSnapshot, state: MoveCardData["state"]): string | null {
	if (state !== "your-move" || !snapshot.recommendation) return null;
	const { chosen, eval: score } = snapshot.recommendation;
	if (chosen.source === "book") return COPY.move.noteBook;
	if (score.mate !== undefined && score.mate > 0) return COPY.move.noteMate(score.mate);
	if (snapshot.recommendation.lines.length === 1) return COPY.move.noteOnly;
	return null;
}
