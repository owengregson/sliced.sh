// src/offscreen/inference/run-guard.ts
/**
 * Sessions with a `run` in flight, and those whose release was asked for meanwhile. A size
 * switch during a move (the target crossing a band mid-query) evicts the old session while its
 * query is still running; releasing a wasm session under a running `run` is undefined, so the
 * release waits until the last run on it settles.
 */

import type { OrtSession } from "../ort-loader";

export class RunGuard {
	private readonly running = new Map<OrtSession, number>();
	private readonly releaseWhenIdle = new Set<OrtSession>();

	/** Release `s` now, or as soon as its last running query settles. */
	release(s: OrtSession): void {
		if ((this.running.get(s) ?? 0) > 0) {
			this.releaseWhenIdle.add(s);
			return;
		}
		void s.release().catch(() => {});
	}

	/** Run `work` on `s`, counted as in flight until it settles. */
	async run<T>(s: OrtSession, work: () => Promise<T>): Promise<T> {
		this.running.set(s, (this.running.get(s) ?? 0) + 1);
		try {
			return await work();
		} finally {
			const left = (this.running.get(s) ?? 1) - 1;
			if (left > 0) this.running.set(s, left);
			else {
				this.running.delete(s);
				if (this.releaseWhenIdle.delete(s)) void s.release().catch(() => {});
			}
		}
	}
}
