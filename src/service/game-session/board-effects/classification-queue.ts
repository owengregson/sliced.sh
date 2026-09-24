/**
 * Costly classifications, admitted one per timer turn. Every turn rechecks admission (play,
 * input activity, the caller's lead boundary), so heavy classification yields between jobs.
 */

import type { Scheduler } from "@core/util/scheduler";

import type { VerdictJob } from "./verdict-job";

export interface ClassificationQueueHost {
	scheduler: Scheduler;
	/** Classification may run now. */
	admits(): boolean;
	/** The next job to classify among `pending`, if any. */
	pick(pending: ReadonlySet<VerdictJob>): VerdictJob | undefined;
	/** Classify `job` on the admitted (costly) path. */
	classify(job: VerdictJob): void;
}

/**
 * The next landed-or-planned job to classify: the most urgent open one waiting in `pending`.
 * A premove recapture shares its square with the preceding move: that predecessor is resolved
 * first so its chip is not overwritten before it can be delivered.
 */
export function nextClassification(
	open: readonly VerdictJob[],
	landed: readonly VerdictJob[],
	pending: ReadonlySet<VerdictJob>
): VerdictJob | undefined {
	const next = open.find((job) => pending.has(job));
	if (!next?.landed) return next;
	const at = landed.indexOf(next);
	const square = next.move.uci.slice(2, 4);
	const predecessor = landed
		.slice(0, Math.max(0, at))
		.find(
			(job) => !job.closed && !job.verdict && pending.has(job) && job.move.uci.slice(2, 4) === square
		);
	return predecessor ?? next;
}

export class ClassificationQueue {
	private readonly pending = new Set<VerdictJob>();
	private timer: unknown = null;

	constructor(private readonly host: ClassificationQueueHost) {}

	add(job: VerdictJob): void {
		this.pending.add(job);
		this.schedule();
	}

	delete(job: VerdictJob): void {
		this.pending.delete(job);
	}

	/** Drop every waiting job and the pending turn. */
	cancel(): void {
		if (this.timer !== null) this.host.scheduler.clearTimeout(this.timer);
		this.timer = null;
		this.pending.clear();
	}

	/** At most one costly verdict per timer turn; every turn rechecks input admission. */
	schedule(): void {
		if (this.timer !== null || !this.host.admits() || !this.pending.size) return;
		this.timer = this.host.scheduler.setTimeout(() => {
			this.timer = null;
			if (!this.host.admits()) return;
			const next = this.host.pick(this.pending);
			if (next) {
				this.pending.delete(next);
				this.host.classify(next);
			}
			this.schedule();
		}, 0);
	}
}
