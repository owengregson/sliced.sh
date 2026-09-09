/**
 * Service-worker side of the ChessMimic inference port (Task 34; §8.4b item 6). Turns the
 * engine port into the `InferPort` the `ChessMimicHead` takes: `infer(inputs)` posts
 * `{kind:"timing", id, inputs}` and resolves with the matching `timing-result`'s probabilities,
 * band and wall time — or `null` when the host answered with an error (the head then falls back
 * to v1). `warm(band)` posts `timing-warm` so the offscreen document loads the band's session
 * before the first move.
 *
 * Every query carries its own expiry (`inferenceBudgetMs`, the same budget the head applies):
 * the head's `withBudget` resolves its caller after the budget but cannot reach into this map,
 * so without an expiry a host that never answers — a disposed offscreen document, a band whose
 * load is wedged — would leak one pending closure per move for the life of the port.
 *
 * Wiring `new ChessMimicHead({ infer: createTimingInferPort(remoteEngine).infer, fallback })`
 * into the SW's `TimingModel` is the integration task's (the head selection Task 16 left there).
 */

import type { EnginePortCommand, EnginePortMessage } from "@core/constants/messages";
import { log } from "@core/logger";
import type { ChessMimicInputs, InferPort, InferResult } from "@core/timing/chessmimic-head";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { DEFAULT_SCHEDULER, type TimerScheduler } from "@core/util/scheduler";

/** The engine port as seen from the SW (`RemoteEngine` satisfies it). */
export interface TimingRelayPort {
	onMessage(cb: (m: EnginePortMessage) => void): () => void;
	post(cmd: EnginePortCommand): void;
}

export interface TimingInferPort {
	infer: InferPort;
	warm(band: string): void;
	/** Settles every pending query with `null` and stops listening. */
	dispose(): void;
	/** Queries still waiting for the host (tests; the leak guard keeps this bounded). */
	pendingCount(): number;
}

export interface TimingInferPortOptions {
	/** Timers for the per-query expiry; tests pass a fake. */
	scheduler?: TimerScheduler;
	/** Expiry per query; default `TIMING_CONSTANTS.chessmimic.inferenceBudgetMs`. */
	budgetMs?: number;
}

const ID_PREFIX = "t";

interface PendingQuery {
	resolve: (r: InferResult | null) => void;
	timer: unknown;
}

export function createTimingInferPort(
	port: TimingRelayPort,
	options: TimingInferPortOptions = {}
): TimingInferPort {
	const sched = options.scheduler ?? DEFAULT_SCHEDULER;
	const budgetMs = options.budgetMs ?? TIMING_CONSTANTS.chessmimic.inferenceBudgetMs;
	const pending = new Map<string, PendingQuery>();
	let seq = 0;
	let disposed = false;

	/** Remove `id` from the map and stop its expiry; returns the waiter if it was still there. */
	function take(id: string): PendingQuery | undefined {
		const q = pending.get(id);
		if (!q) return undefined;
		pending.delete(id);
		sched.clearTimeout(q.timer);
		return q;
	}

	const off = port.onMessage((m) => {
		if (m.kind !== "timing-result") return;
		const q = take(m.id);
		if (!q) return;
		if (!m.probs) {
			log.debug("timing-infer: host answered without probabilities", { id: m.id, error: m.error });
			q.resolve(null);
			return;
		}
		const result: InferResult = { probs: m.probs, band: m.band ?? "" };
		if (m.ms !== undefined) result.ms = m.ms;
		q.resolve(result);
	});
	return {
		infer(inputs: ChessMimicInputs): Promise<InferResult | null> {
			if (disposed) return Promise.resolve(null);
			const id = `${ID_PREFIX}${++seq}`;
			return new Promise((resolve) => {
				const timer = sched.setTimeout(() => {
					if (!take(id)) return;
					log.debug("timing-infer: query expired unanswered", { id, budgetMs });
					resolve(null);
				}, budgetMs);
				pending.set(id, { resolve, timer });
				port.post({ kind: "timing", id, inputs });
			});
		},
		pendingCount: () => pending.size,
		warm(band) {
			if (disposed) return;
			port.post({ kind: "timing-warm", band });
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			off();
			const waiting = [...pending.values()];
			pending.clear();
			for (const q of waiting) {
				sched.clearTimeout(q.timer);
				q.resolve(null);
			}
		},
	};
}
