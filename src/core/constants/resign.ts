/**
 * Resigning a lost game (owner's brief, 2026-09-12): when the engine's best line is a forced
 * mate *against* us in a few moves, the session waits a human-looking moment ("evaluating the
 * forced mate"), then the hand clicks the site's resign control and its confirmation — instead
 * of playing the mate out. C1 registry: every knob of that rule lives here, once.
 *
 * The trigger is decided in `GameSession` (`shouldResign`), the clicks by `ResignInput`
 * (`src/service/resign-input.ts`) and the control discovery by the content adapter
 * (`SiteAdapter.resignTarget`, selectors in `src/content/adapters/selectors.ts`).
 */

import type { MsRange } from "@core/motor/types";

export const RESIGN = {
	/**
	 * Resign when the best line is mate against us in at most this many *moves* (UCI `mate -N`,
	 * side-to-move POV). `mate -3` resigns; `mate -4` plays on.
	 */
	maxMateIn: 3,
	/**
	 * The mate must come from a search at least this deep (the best line's `depth`), so a
	 * shallow blip from a search that was cut short never resigns a game.
	 */
	minDepth: 8,
	/** The pause before the resign click — the human "evaluating the forced mate" moment (ms). */
	delayMs: [1000, 8000] as MsRange,
	/** Between the resign click and the confirm click (ms): reading the "Resign?" prompt. */
	confirmDelayMs: [350, 1100] as MsRange,
	/** Port request budget for one `resign` target read/revalidation (ms). */
	targetTimeoutMs: 2_000,
	/**
	 * After the resign click, how long the confirmation control is polled for before the attempt
	 * gives up (ms) — chess.com renders the "Resign?" prompt on the next frame, not synchronously.
	 */
	confirmWaitMs: 4_000,
	/** Interval between those confirmation polls (ms). */
	confirmPollMs: 150,
} as const;
