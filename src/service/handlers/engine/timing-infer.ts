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

import { log } from "@core/logger";
import type { ChessMimicInputs, InferPort, InferResult } from "@core/timing/chessmimic-head";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import type { TimingPreparation } from "@core/timing/types";
import { DEFAULT_SCHEDULER, type TimerScheduler } from "@core/util/scheduler";
import type { EnginePortLike } from "./engine-port";
import { createQueryTable } from "./query-table";

/** The engine port as seen from the SW (`RemoteEngine` satisfies it). */
export type TimingRelayPort = EnginePortLike;

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

export function createTimingInferPort(
	port: TimingRelayPort,
	options: TimingInferPortOptions = {}
): TimingInferPort {
	const budgetMs = options.budgetMs ?? TIMING_CONSTANTS.chessmimic.inferenceBudgetMs;
	const queries = createQueryTable<InferResult>(options.scheduler ?? DEFAULT_SCHEDULER);
	let seq = 0;
	let disposed = false;

	const off = port.onMessage((m) => {
		if (m.kind !== "timing-result") return;
		const resolve = queries.take(m.id);
		if (!resolve) return;
		if (!m.probs) {
			log.debug("timing-infer: host answered without probabilities", { id: m.id, error: m.error });
			resolve(null);
			return;
		}
		const result: InferResult = { probs: m.probs, band: m.band ?? "" };
		if (m.ms !== undefined) result.ms = m.ms;
		resolve(result);
	});
	return {
		infer(inputs: ChessMimicInputs, preparation?: TimingPreparation): Promise<InferResult | null> {
			if (disposed || preparation?.signal?.aborted) return Promise.resolve(null);
			const id = `${ID_PREFIX}${++seq}`;
			const expiresMs = preparation?.budgetMs ?? budgetMs;
			return queries.ask(
				id,
				expiresMs,
				preparation?.signal,
				() => log.debug("timing-infer: query expired unanswered", { id, budgetMs: expiresMs }),
				() => port.post({ kind: "timing", id, inputs })
			);
		},
		pendingCount: () => queries.size(),
		warm(band) {
			if (disposed) return;
			port.post({ kind: "timing-warm", band });
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			off();
			queries.settleAll();
		},
	};
}
