/**
 * §13.4: arming attaches the debugger, Chrome shows its "is debugging this browser" infobar and
 * the page reflows — which moves and resizes the board. The spec's intent is that arming happens
 * in the waiting view, before a game, precisely so that shift lands outside every move window;
 * arming mid-game is allowed, so the first execution after an attach waits for the board's rect
 * to have been unchanged for `EXECUTOR.attachSettleStableMs` before reading geometry.
 *
 * Evidence-driven and bounded: with no reported movement there is nothing to settle and the wait
 * is zero, and a page that never stops moving is given up on after
 * `EXECUTOR.attachSettleMaxMs` (the hand's own reflow guard covers what is left).
 */

import { EXECUTOR } from "@core/constants/cdp";
import { log } from "@core/logger";
import { isAbortedError, type Scheduler, sleep } from "@core/util/scheduler";
import type { BoardRectSource } from "@service/board-watch";

export class AttachSettle {
	/**
	 * When `arm()` actually attached the debugger, until the first execution after it has waited for
	 * the layout to settle; `null` the rest of the time. §13.4: the attach makes Chrome show its
	 * infobar, which reflows the page and moves the board, so the first execution must plan on
	 * geometry that has stopped moving.
	 */
	private attachedAt: number | null = null;

	constructor(
		private readonly tabId: number,
		private readonly board: BoardRectSource | null,
		private readonly now: () => number,
		private readonly scheduler: Scheduler
	) {}

	/** A fresh attach happened now: the next execution settles first. */
	attached(at: number): void {
		this.attachedAt = at;
	}

	async settle(signal: AbortSignal): Promise<void> {
		const since = this.attachedAt;
		const board = this.board;
		if (since === null) return;
		if (!board) {
			this.attachedAt = null;
			return;
		}
		const giveUpAt = since + EXECUTOR.attachSettleMaxMs;
		let waited = 0;
		while (this.now() < giveUpAt) {
			// A cancelled execution never ran, so it must not consume the settle: `attachedAt` is
			// cleared only once a wait has actually finished, and the next execution waits instead.
			if (signal.aborted) return;
			const changedAt = board.changedAt(this.tabId);
			if (changedAt === null || this.now() - changedAt >= EXECUTOR.attachSettleStableMs) break;
			const step = Math.min(
				EXECUTOR.attachSettlePollMs,
				Math.max(1, giveUpAt - this.now()),
				Math.max(1, changedAt + EXECUTOR.attachSettleStableMs - this.now())
			);
			try {
				await sleep(step, this.scheduler, signal);
			} catch (error) {
				if (isAbortedError(error)) return;
				throw error;
			}
			waited += step;
		}
		this.attachedAt = null;
		if (waited > 0)
			log.debug("executor: waited for the layout to settle after the attach", {
				tabId: this.tabId,
				waitedMs: waited,
			});
	}
}
