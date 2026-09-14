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
import type { EnginePortCommand, EnginePortMessage } from "@core/constants/messages";
import { log } from "@core/logger";
import type {
	PolicyInferenceInputs,
	PolicyPort,
	PolicyPreparation,
	PolicyResult,
} from "@core/policy/types";
import { DEFAULT_SCHEDULER, type TimerScheduler } from "@core/util/scheduler";

/** The engine port as seen from the SW (`RemoteEngine` satisfies it). */
export interface PolicyRelayPort {
	onMessage(cb: (m: EnginePortMessage) => void): () => void;
	post(cmd: EnginePortCommand): void;
}

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

interface PendingQuery {
	resolve: (r: PolicyResult | null) => void;
	timer: unknown;
	cleanup: () => void;
}

export function createPolicyInferPort(
	port: PolicyRelayPort,
	options: PolicyInferPortOptions = {}
): PolicyInferPort {
	const sched = options.scheduler ?? DEFAULT_SCHEDULER;
	const budgetMs = options.budgetMs ?? MAIA.inferenceBudgetMs;
	const pending = new Map<string, PendingQuery>();
	let seq = 0;
	let disposed = false;

	/** Remove `id` from the map and stop its expiry; returns the waiter if it was still there. */
	function take(id: string): PendingQuery | undefined {
		const q = pending.get(id);
		if (!q) return undefined;
		pending.delete(id);
		sched.clearTimeout(q.timer);
		q.cleanup();
		return q;
	}

	const off = port.onMessage((m) => {
		if (m.kind === "policy-status") {
			if (m.error !== undefined)
				log.warn("policy-infer: the host could not warm a Maia size", { error: m.error });
			else log.debug("policy-infer: Maia size resident", { size: m.size, loadMs: m.loadMs });
			return;
		}
		if (m.kind !== "policy-result") return;
		const q = take(m.id);
		if (!q) return;
		if (m.moves === null) {
			log.debug("policy-infer: host answered without a distribution", {
				id: m.id,
				size: m.size,
				error: m.error,
			});
			q.resolve(null);
			return;
		}
		const result: PolicyResult = { moves: m.moves, wdl: m.wdl, size: m.size };
		if (m.ms !== undefined) result.ms = m.ms;
		q.resolve(result);
	});
	return {
		infer(
			inputs: PolicyInferenceInputs,
			preparation?: PolicyPreparation
		): Promise<PolicyResult | null> {
			if (disposed || preparation?.signal?.aborted) return Promise.resolve(null);
			const id = `${ID_PREFIX}${++seq}`;
			const expiresMs = preparation?.budgetMs ?? budgetMs;
			return new Promise((resolve) => {
				const abort = () => take(id)?.resolve(null);
				const timer = sched.setTimeout(() => {
					if (!take(id)) return;
					log.debug("policy-infer: query expired unanswered", { id, budgetMs: expiresMs });
					resolve(null);
				}, expiresMs);
				pending.set(id, {
					resolve,
					timer,
					cleanup: () => preparation?.signal?.removeEventListener("abort", abort),
				});
				preparation?.signal?.addEventListener("abort", abort, { once: true });
				port.post({ kind: "policy", id, inputs });
			});
		},
		pendingCount: () => pending.size,
		warm(size: MaiaSize) {
			if (disposed) return;
			port.post({ kind: "policy-warm", size });
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			off();
			const waiting = [...pending.values()];
			pending.clear();
			for (const q of waiting) {
				sched.clearTimeout(q.timer);
				q.cleanup();
				q.resolve(null);
			}
		},
	};
}
