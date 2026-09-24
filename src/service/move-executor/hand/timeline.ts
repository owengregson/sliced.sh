/** The execution's phase log (`ExecutionResult.timeline`), in ms since the run's start. */

interface Phase {
	phase: string;
	startMs: number;
	endMs: number;
}

export class Timeline {
	readonly entries: Phase[] = [];
	private open: { phase: string; startMs: number } | null = null;
	constructor(
		private readonly t0: number,
		private readonly now: () => number
	) {}
	begin(phase: string): void {
		this.end();
		this.open = { phase, startMs: this.now() - this.t0 };
	}
	/** A zero-length annotation that does not interrupt the open phase. */
	note(phase: string): void {
		const at = this.now() - this.t0;
		this.entries.push({ phase, startMs: at, endMs: at });
	}
	end(): void {
		if (!this.open) return;
		this.entries.push({ ...this.open, endMs: this.now() - this.t0 });
		this.open = null;
	}
}
