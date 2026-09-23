/**
 * The scramble hold's decision (`MoveContext.holdUntilReply`): one per hold, from the session's
 * verdict on the opponent's move (`releaseHold()` / `abandonHold()`), the timeout, or a cancel
 * (the hand answers an abort as `abandon` itself). Decided once: a retry attempt after a released
 * hold finds the directive already answered and drops at once.
 */

import { log } from "@core/logger";
import type { HoldDirective } from "@core/motor/types";
import type { Scheduler } from "@core/util/scheduler";

export type HoldDecision = "release" | "abandon";

/** The handle the executor keeps on its running move while the hold is undecided. */
export interface HoldHandle {
	resolve(decision: HoldDecision): void;
	decided: boolean;
}

export class ScrambleHold {
	readonly handle: HoldHandle;
	/** What the hand waits on (`ExecutionPlan.hold`). */
	readonly directive: HoldDirective;
	private timer: unknown = null;

	constructor(
		private readonly scheduler: Scheduler,
		maxMs: number,
		context: { tabId: number; uci: string }
	) {
		let settle: (decision: HoldDecision) => void = () => {};
		const decision = new Promise<HoldDecision>((resolve) => {
			settle = resolve;
		});
		const hold: HoldHandle = {
			decided: false,
			resolve: (verdict: HoldDecision): void => {
				if (hold.decided) return;
				hold.decided = true;
				if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
				this.timer = null;
				settle(verdict);
			},
		};
		this.timer = this.scheduler.setTimeout(() => {
			log.info("executor: the scramble hold timed out; giving the piece back", context);
			hold.resolve("abandon");
		}, maxMs);
		this.handle = hold;
		this.directive = { decide: () => decision };
	}

	/** The execution is over: the timeout must not outlive it. */
	dispose(): void {
		if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
	}
}
