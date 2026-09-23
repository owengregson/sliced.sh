/**
 * Move section (Appendix F §4.4 items 4–5, §5.6, §6.2, §6.3): the move card as a projection of
 * the snapshot (your-move / opponent-to-move with the expected reply / thinking / armed /
 * disabled / engine-stopped), the play button's label transitions (`Play move` →
 * `Play now` (ring counting down) → `Playing…`), the countdown driven from
 * `autoMove.scheduledAt` (the absolute execution time) against `plan.thinkMs`, and the §6.3
 * "played" flash when `session.lastExecution` reports an executed move (the "Played …"
 * notification is intentionally suppressed).
 *
 * The countdown ticks on a `setInterval` at the ring's own transition cadence
 * (`motion.duration.1`, the linear real-time curve of §5.10); it is cleared on disarm,
 * unmount and whenever the snapshot stops carrying a schedule.
 */

import type { PanelSnapshot } from "@core/constants/messages";
import { TOKENS } from "@design/tokens.generated";
import { formatKeybind } from "../../components/keybind";
import { createMoveCard, type MoveCardData, type MoveCardHandle } from "../../components/move-card";
import {
	executionKey,
	expectedReply,
	moveCardState,
	moveProgressPhase,
	noteFor,
	planText,
} from "./move-projection";

export {
	executionKey,
	expectedReply,
	moveCardState,
	moveProgressPhase,
	planText,
} from "./move-projection";

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

export function createMoveSection(options: MoveSectionOptions): MoveSectionHandle {
	const card = createMoveCard(options.host, {
		onPlay: () => options.onPlay(),
		onCancel: () => options.onCancel(),
	});
	let timer: ReturnType<typeof setInterval> | null = null;
	let endAt: number | null = null;
	let totalMs = 0;
	let san: string | null = null;
	/** Key of the last execution result seen (`at`, else a structural identity). */
	let lastExecutionKey: string | null = null;
	let lastPly: number | null = null;
	let seenSnapshot = false;

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
		const running =
			armed &&
			state === "your-move" &&
			scheduledAt !== undefined &&
			plan !== undefined &&
			(snapshot.session.state !== "live:my-turn:executing" || snapshot.session.canPlayNow === true);
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
			phase: moveProgressPhase(snap),
			executing: snap.session.state === "live:my-turn:executing" && snap.session.canPlayNow !== true,
			...(snap.session.canPlayNow !== undefined ? { canPlayNow: snap.session.canPlayNow } : {}),
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

		// A new execution result (not the one the view mounted with) → §6.3 "played". Snapshots
		// are fresh objects every push, so results are keyed. An `at` stamp is a unique identity
		// and survives ply changes; only the structural fallback is cleared by a new ply (the same
		// shape could legitimately recur on a later move).
		const exec = snap.session.lastExecution;
		if (snap.session.ply !== lastPly) {
			lastPly = snap.session.ply;
			if (seenSnapshot && exec?.at === undefined) lastExecutionKey = null;
		}
		const key = exec ? executionKey(exec) : null;
		if (exec && key !== lastExecutionKey && seenSnapshot) onExecution(exec);
		lastExecutionKey = key;
		seenSnapshot = true;
	}

	function onExecution(exec: NonNullable<PanelSnapshot["session"]["lastExecution"]>): void {
		// Keep the existing subtle card acknowledgement; successful moves make no sound or toast.
		if (exec.outcome !== "executed") return;
		card.played();
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
