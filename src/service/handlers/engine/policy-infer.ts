/**
 * Service-worker side of the Maia-3 policy port (2026-09-11; the second instance of
 * `timing-infer.ts`). Turns the engine port into the `PolicyPort` the recommendation pipeline
 * takes: `infer(inputs)` posts `{kind:"policy", id, inputs}` and resolves with the matching
 * `policy-result`'s legal-move distribution, WDL, size and wall time — or `null` when the host
 * answered with an error (the pipeline then selects with the engine's own policy). `warm(size)`
 * posts `policy-warm` so the offscreen document has that size resident before the first move;
 * the host's `policy-status` replies are logged (an error at `warn`, since it means every
 * query for that size will fall back until the cooldown passes).
 *
 * Every query carries its own expiry (`MAIA.inferenceBudgetMs` unless the preparation says
 * otherwise) and honours the preparation's abort signal: a host that never answers — a
 * disposed offscreen document, a size whose load is wedged — must not leak one pending closure
 * per move for the life of the port.
 */

import { MAIA, type MaiaSize } from "@core/constants/maia";
import { log } from "@core/logger";
import type {
	PolicyInferenceInputs,
	PolicyPort,
	PolicyPreparation,
	PolicyResult,
} from "@core/policy/types";
import { DEFAULT_SCHEDULER, type TimerScheduler } from "@core/util/scheduler";
import type { EnginePortLike } from "./engine-port";
import { createQueryTable } from "./query-table";

/** The engine port as seen from the SW (`RemoteEngine` satisfies it). */
export type PolicyRelayPort = EnginePortLike;

export interface PolicyInferPort extends PolicyPort {
	/** Queries still waiting for the host (tests; the expiry keeps this bounded). */
	pendingCount(): number;
}

export interface PolicyInferPortOptions {
	/** Timers for the per-query expiry; tests pass a fake. */
	scheduler?: TimerScheduler;
	/** Expiry per query; default `MAIA.inferenceBudgetMs`. */
	budgetMs?: number;
}

const ID_PREFIX = "p";

export function createPolicyInferPort(
	port: PolicyRelayPort,
	options: PolicyInferPortOptions = {}
): PolicyInferPort {
	const budgetMs = options.budgetMs ?? MAIA.inferenceBudgetMs;
	const queries = createQueryTable<PolicyResult>(options.scheduler ?? DEFAULT_SCHEDULER);
	let seq = 0;
	let disposed = false;

	const off = port.onMessage((m) => {
		if (m.kind === "policy-status") {
			if (m.error !== undefined)
				log.warn("policy-infer: the host could not warm a Maia size", { error: m.error });
			else log.debug("policy-infer: Maia size resident", { size: m.size, loadMs: m.loadMs });
			return;
		}
		if (m.kind !== "policy-result") return;
		const resolve = queries.take(m.id);
		if (!resolve) return;
		if (m.moves === null) {
			log.debug("policy-infer: host answered without a distribution", {
				id: m.id,
				size: m.size,
				error: m.error,
			});
			resolve(null);
			return;
		}
		const result: PolicyResult = { moves: m.moves, wdl: m.wdl, size: m.size };
		if (m.ms !== undefined) result.ms = m.ms;
		resolve(result);
	});
	return {
		infer(
			inputs: PolicyInferenceInputs,
			preparation?: PolicyPreparation
		): Promise<PolicyResult | null> {
			if (disposed || preparation?.signal?.aborted) return Promise.resolve(null);
			const id = `${ID_PREFIX}${++seq}`;
			const expiresMs = preparation?.budgetMs ?? budgetMs;
			return queries.ask(
				id,
				expiresMs,
				preparation?.signal,
				() => log.debug("policy-infer: query expired unanswered", { id, budgetMs: expiresMs }),
				() => port.post({ kind: "policy", id, inputs })
			);
		},
		pendingCount: () => queries.size(),
		warm(size: MaiaSize) {
			if (disposed) return;
			port.post({ kind: "policy-warm", size });
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			off();
			queries.settleAll();
		},
	};
}
