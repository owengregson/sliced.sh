/**
 * Focus discipline (§13.4) as the session reacts to it. The extension never takes focus back:
 * a blur inside the move window cancels the scheduled execution for this move (the move is
 * played only after a fresh position) and the timing model observes the elapsed time; a refocus
 * gives only the game's first move a second chance (the owner's 2026-09-10 ruling).
 */

import { log } from "@core/logger";
import type { MoveWindow } from "../telemetry";
import type { SessionCore } from "./core";
import { isGameFirstMove, positionIdentity } from "./position-rules";
import { timingContextFor } from "./replan";

export interface FocusDisciplineHooks {
	/** The §13.2 window of a premove drag in flight (Fix F), which wants the edges too. */
	premoveWindow(): MoveWindow | null;
	reconsider(reason: string): Promise<void>;
}

export class FocusDiscipline {
	/**
	 * The position a blur landed on while the session was holding it (§13.4). The companion guard
	 * to `isGameFirstMove`, and **not** `FocusGate`'s own `blurSeenThisMove`: that flag is per move
	 * *window*, and `positionArrived` reopens the window on every accepted position — including the
	 * republish of an unmoved ply-0 position that carries the colour or the time control, which
	 * `onPosition` documents as the normal case at move one. A §13.4 permission must not be cleared
	 * by the thing that always happens, so the blur is remembered against the position.
	 *
	 * What it records is every *transition* to unfocused that happens while this position is the one
	 * the session holds — which is the only kind of blur a human, or chess.com's own per-move window,
	 * would count against the move. It deliberately does not record a repeated "still not focused"
	 * report (a `visibilitychange` while already blurred sets `FocusGate.blurSeen` but fires no edge):
	 * that is the same blur, and if it predates the position then the owner was already in the side
	 * panel when the move came up, which is exactly the case the ruling releases.
	 */
	private blurredPositionKey: string | null = null;

	constructor(
		private readonly core: SessionCore,
		private readonly hooks: FocusDisciplineHooks
	) {}

	/**
	 * A blur inside the current move window cancels the scheduled execution for
	 * this move (the move is played only after a fresh position) and the timing
	 * model observes the elapsed time. The extension never takes focus back.
	 */
	onEdge(hasFocus: boolean, at: number): void {
		const core = this.core;
		core.window.edge(hasFocus, at);
		// Fix F: a premove's drag runs in a fork of the opponent-turn window, and §13.2 wants the
		// edges of the window the input was actually in.
		this.hooks.premoveWindow()?.edge(hasFocus, at);
		if (hasFocus) {
			this.onRegained();
			return;
		}
		// Remember which position the blur landed on, before anything else: §13.4's permission to
		// play the first move after a refocus hangs off this, and it has to outlive a republish of
		// the same ply (see `blurredPositionKey`).
		const blurred = core.snapshot;
		if (blurred) this.blurredPositionKey = positionIdentity(blurred);
		const executor = core.executor;
		const pending = executor?.pendingMove() ?? null;
		if (!executor || (!pending && !executor.isRunning())) {
			core.notify();
			return;
		}
		log.info("game-session: blur inside the move window — execution cancelled (§13.4)", {
			tabId: core.tabId,
			at,
		});
		executor.cancel();
		const rec = core.rec;
		const timing = core.timing;
		const ctx = rec && timing ? timingContextFor(core, rec) : null;
		if (rec && timing && ctx) timing.replan(rec.plan, ctx, "blur");
		core.notify();
	}

	/**
	 * The page got focus back (the owner clicked into the board). §13.4's rule is that a move which
	 * could not run because the page was not focused *waits for the next position* — and at the
	 * game's first move there is no next position, so it waits for ever (owner's report, 2026-09-10:
	 * "it sometimes doesnt make the first move (if youre on white)").
	 *
	 * The owner ruled on 2026-09-10 that the first move may be played when focus comes back, and
	 * **only** the first move: a real player's first move usually does carry a focus change, because
	 * they have just clicked to start the game, so spending the focus-discipline margin there is
	 * defensible in a way that spending it on every move is not. He explicitly did not take the
	 * every-move relaxation. `docs/qa/focus-discipline.md` §4 records the decision, its scope and the
	 * evidence that would change it.
	 *
	 * Two conditions, neither optional:
	 *   - `isGameFirstMove` — the whole scope of the ruling;
	 *   - no blur landed *inside* this move's window. That is `FocusGate`'s own per-window
	 *     bookkeeping (`blurSeen`, set on the blur and cleared only by `positionArrived`), and it is
	 *     exactly what chess.com counts against the move: a blur followed by a focus inside one
	 *     window is §13.2's `DidToggle`, the strongest client signal the corpus documents. Such a
	 *     move is spent, and its second chance is the next position, not this click.
	 *
	 * This is a reaction to the owner's own focus change, never a focus change of ours: §13.4's
	 * absolute rule — nothing here raises a notification, activates a tab or calls
	 * `Page.bringToFront` — is untouched. The hand still asks `FocusGate.canExecute` for itself when
	 * the re-delivered move is dispatched, so this only gives the move a second chance; it does not
	 * grant it permission.
	 */
	private onRegained(): void {
		const snapshot = this.core.snapshot;
		if (!snapshot || !isGameFirstMove(snapshot)) return;
		if (this.blurredPositionKey === positionIdentity(snapshot)) return;
		void this.hooks.reconsider("the page regained focus on the game's first move");
	}
}
