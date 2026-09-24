/**
 * Rematching titled players (owner's brief, 2026-09-13): "if the user is a titled player
 * (candidate master, fm, gm, etc.) we automatically send a rematch request after the game ends
 * (only one time) — or, if they sent us a rematch request we automatically accept it … if the
 * rematch isnt accepted after 15 seconds we dismiss it and keep queueing regular games."
 *
 * Two halves. The **decision** is pure: `rematchEligible` says whether the finished game's
 * opponent earns the step (titled, the setting on, not yet rematched this playing session) and
 * `markRematched` records the once-only mark on the playing session the auto-queue persists. The
 * **step** (`RematchStep.run`) is the one bounded wait: read whether the opponent's offer is
 * showing, click Accept if so or Rematch if not — through the queue's own hand-driven click path,
 * never a content-script click — then wait up to `REMATCH.acceptTimeoutMs` for the next game,
 * accepting an offer of theirs that appears meanwhile, and withdraw ours when nobody took it.
 *
 * `AutoQueue` owns the timers, the entry and the fall-through to the ordinary queue click; it
 * calls `gameStarted` when the next game is observed, which is what ends the wait.
 *
 * Parts: `rematch/decision.ts` (the pure decision), `rematch/step.ts` (the step).
 */

export {
	isTitled,
	markRematched,
	type RematchOpponent,
	rematchEligible,
	rematchOffersLeft,
} from "@service/rematch/decision";
export {
	type RematchClickAction,
	type RematchClickStatus,
	type RematchOutcome,
	type RematchResult,
	type RematchRunHooks,
	RematchStep,
	type RematchStepOptions,
} from "@service/rematch/step";
