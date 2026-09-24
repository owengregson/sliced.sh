/** What one execution dispatched, which is what its `ExecutionResult` reports (§13.2). */

import type { Square } from "@typedefs/game";

export class ExecutionRecord {
	/** The committed press went out (a release may land the move even on abort/skip). */
	pressedCommitted = false;
	/** Any press went out, preview selections included (§13.2 / the retry policy's board re-check). */
	pressedAny = false;
	/** Squares pressed in this execution besides the committed from-square (§13.2). */
	previewed: Square[] = [];
	/** Right-button drags (line-preview arrows) dispatched in this execution — never a §13.2 press. */
	annotations = 0;
	/** Clock time of the drop (second click / release); `null` until then. */
	dropAt: number | null = null;
	submittedAt: number | null = null;
	/**
	 * A scramble hold: when the hold was told to let go. The result's `startedAt` / `elapsedMs` are
	 * measured from here rather than from the run's start — the page measures its own hold time from
	 * the position's arrival, and that is the moment the release was decided on.
	 */
	holdReleasedAt: number | null = null;

	reset(): void {
		this.pressedCommitted = false;
		this.pressedAny = false;
		this.dropAt = null;
		this.submittedAt = null;
		this.holdReleasedAt = null;
		this.previewed = [];
		this.annotations = 0;
	}

	/** The piece was let go over its destination at `at`: the move is the site's from here. */
	dropped(at: number): void {
		this.dropAt = at;
		this.submittedAt = at;
	}
}
