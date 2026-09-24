/**
 * Maia-3 policy inference host (2026-09-11; the second instance of the Task 34 timing-head
 * pattern). Runs the exported Maia-3 sizes through onnxruntime-web in the offscreen document:
 *
 *   - at most `LIMITS.policySessionsMax` (= 1) session resident: `warm(size)` creates the size's
 *     session from the `MaiaStore`'s verified bytes, evicting whichever other size was resident
 *     first, runs one warm-up query on the start position so the first real move never pays the
 *     cold start, and answers with `policy-status {size, loadMs}` — or `{size: null, error}`;
 *   - `{kind:"policy", id, inputs}` → `{kind:"policy-result", id, moves, wdl, size, ms}`: the
 *     SW's FEN history is encoded here (`encodeMaiaInputs`), fed as float32 `tokens [1,64,96]`,
 *     `self_elo [1]` and `oppo_elo [1]`, and the logits are masked, soft-maxed and un-mirrored
 *     by `decodeMaiaOutputs`. A query for a size that is not resident loads it first, so that
 *     one query pays the load (the SW's per-query budget decides whether it waits);
 *   - failures never throw across the port: malformed inputs, an unreadable FEN, a size whose
 *     bytes cannot be had, a runtime that cannot start (retried once single-threaded when the
 *     pthread build fails) and a disposed host all answer `moves: null` + `error`, and the
 *     pipeline selects with the engine's own policy for that move. A size that failed to load
 *     is skipped for a doubling cooldown (`TIMINGS.timingBandRetryMs` … `timingBandRetryMaxMs`)
 *     rather than re-read on every move.
 */

import { CHESS_START_FEN } from "@core/constants/chess";
import { LIMITS } from "@core/constants/limits";
import { MAIA_INPUT, type MaiaSize } from "@core/constants/maia";
import type { EnginePortCommand, EnginePortMessage } from "@core/constants/messages";
import { log } from "@core/logger";
import { decodeMaiaOutputs } from "@core/policy/maia-policy";
import { FailureBackoff } from "./inference/failure-backoff";
import { cappedThreads, createSessionWithFallback, lazyRuntime } from "./inference/ort-session";
import { RunGuard } from "./inference/run-guard";
import { SessionPool } from "./inference/session-pool";
import { isMaiaSize, type MaiaSource } from "./maia-store";
import type { OrtRuntime, OrtSession } from "./ort-loader";
import { encode, feedsFor, historyForQuery, inputsProblem } from "./policy-inference/features";
import { errorMessage } from "./shared/errors";

export { historyForQuery, inputsProblem } from "./policy-inference/features";

export type PolicyCommand = Extract<EnginePortCommand, { kind: "policy" }>;
export type PolicyResultMessage = Extract<EnginePortMessage, { kind: "policy-result" }>;
export type PolicyStatusMessage = Extract<EnginePortMessage, { kind: "policy-status" }>;

export const POLICY_NOT_AVAILABLE = "not-available";
export const POLICY_BAD_INPUTS = "bad inputs";
export const POLICY_NO_SESSION = "no session available";
export const POLICY_DISPOSED = "disposed";

const WDL_LENGTH = 3;

export interface PolicyInferenceDeps {
	/** Loads and configures onnxruntime-web (lazy; a failure is remembered). */
	runtime: () => Promise<OrtRuntime>;
	store: MaiaSource;
	maxSessions?: number;
	now?: () => number;
	/** First cooldown after a failed load; default `TIMINGS.timingBandRetryMs`. Doubles per failure. */
	retryAfterMs?: number;
	/** Ceiling for the doubling cooldown; default `TIMINGS.timingBandRetryMaxMs`. */
	retryMaxMs?: number;
}

export interface PolicyInference {
	handle(cmd: PolicyCommand): Promise<PolicyResultMessage>;
	/** Load and warm `size`'s session (evicting any other); the status to post to the SW. */
	warm(size: MaiaSize): Promise<PolicyStatusMessage>;
	/** The size whose session is loaded (or loading), if any. */
	resident(): MaiaSize | null;
	/** Releases every session; later queries answer `POLICY_DISPOSED`. */
	dispose(): void;
}

/** Threads for a Maia session: `min(LIMITS.policyInferenceThreadsMax, hardwareConcurrency)`, at least 1. */
export function policyThreads(hardwareConcurrency: number | undefined): number {
	return cappedThreads(hardwareConcurrency, LIMITS.policyInferenceThreadsMax);
}

export function createPolicyInference(deps: PolicyInferenceDeps): PolicyInference {
	const now = deps.now ?? (() => performance.now());
	const runtime = lazyRuntime(deps.runtime);
	const guard = new RunGuard();
	/** Evict *before* a new load starts: two resident Maia sessions is the memory case the limit exists for. */
	const pool = new SessionPool<MaiaSize>({
		max: Math.max(1, deps.maxSessions ?? LIMITS.policySessionsMax),
		releaseSession: (s) => guard.release(s),
		onRelease: (size, why) => log.debug("policy-inference: released session", { size, why }),
		evictReason: "evicted",
	});
	/** Sizes that failed to load wait out a doubling cooldown before the next attempt. */
	const failures = new FailureBackoff<MaiaSize>(now, deps);
	let disposed = false;

	async function loadSession(size: MaiaSize): Promise<{ session: OrtSession; loadMs: number }> {
		const rt = await runtime();
		const bytes = await deps.store.get(size);
		const t0 = now();
		const session = await createSessionWithFallback(rt, bytes, "policy-inference");
		const t1 = now();
		// The warm-up: the start position, a mirror match at the middle of the human range.
		const warm = encode([CHESS_START_FEN]);
		const elo = (MAIA_INPUT.eloMin + MAIA_INPUT.eloMax) / 2;
		await guard.run(session, () => session.run(feedsFor(rt, warm, elo, elo)));
		const loadMs = now() - t0;
		log.info("policy-inference: session ready", {
			size,
			threads: rt.threads,
			createMs: Math.round(t1 - t0),
			warmMs: Math.round(now() - t1),
		});
		return { session, loadMs };
	}

	/** The session for `size`, shared while loading; a failure starts the retry cooldown. */
	function sessionFor(size: MaiaSize): Promise<{ session: OrtSession; loadMs: number }> {
		const existing = pool.get(size);
		if (existing) {
			pool.touch(size);
			return existing.then((session) => ({ session, loadMs: 0 }));
		}
		if (failures.inCooldown(size)) {
			return Promise.reject(
				new Error(`${POLICY_NO_SESSION}: ${size} failed ${failures.count(size)}× and is cooling down`)
			);
		}
		pool.touch(size);
		pool.evictBeyondLimit();
		const loaded = loadSession(size);
		pool.adopt(
			size,
			loaded.then((r) => r.session),
			{
				onLoaded: () => failures.clear(size),
				onFailed: (error) => {
					const count = failures.fail(size);
					log.warn("policy-inference: size unavailable; retrying after the cooldown", {
						size,
						attempt: count,
						cooldownMs: failures.cooldownFor(count),
						error: errorMessage(error),
					});
				},
			}
		);
		return loaded;
	}

	return {
		async handle(cmd) {
			const id = cmd.id;
			const fail = (error: string, size?: MaiaSize): PolicyResultMessage =>
				size === undefined
					? { kind: "policy-result", id, moves: null, error }
					: { kind: "policy-result", id, moves: null, size, error };
			if (disposed) return fail(POLICY_DISPOSED);
			const problem = inputsProblem(cmd.inputs);
			if (problem) return fail(`${POLICY_BAD_INPUTS}: ${problem}`);
			const { size, selfElo, oppoElo } = cmd.inputs;
			try {
				const encoded = encode(historyForQuery(cmd.inputs));
				const { session } = await sessionFor(size);
				const rt = await runtime();
				const t0 = now();
				const out = await guard.run(session, () =>
					session.run(feedsFor(rt, encoded, selfElo, oppoElo))
				);
				const ms = now() - t0;
				const moveLogits = out[MAIA_INPUT.outputs.move]?.data;
				const valueLogits = out[MAIA_INPUT.outputs.value]?.data;
				if (!moveLogits || moveLogits.length !== MAIA_INPUT.moveVocab)
					return fail(`bad move output shape ${moveLogits?.length ?? "none"}`, size);
				if (!valueLogits || valueLogits.length !== WDL_LENGTH)
					return fail(`bad value output shape ${valueLogits?.length ?? "none"}`, size);
				const decoded = decodeMaiaOutputs(moveLogits, valueLogits, encoded);
				return { kind: "policy-result", id, moves: decoded.moves, wdl: decoded.wdl, size, ms };
			} catch (error) {
				return fail(errorMessage(error), size);
			}
		},
		async warm(size) {
			if (disposed) return { kind: "policy-status", size: null, error: POLICY_DISPOSED };
			if (!isMaiaSize(size))
				return { kind: "policy-status", size: null, error: `${POLICY_BAD_INPUTS}: size` };
			try {
				const { loadMs } = await sessionFor(size);
				return { kind: "policy-status", size, loadMs: Math.round(loadMs) };
			} catch (error) {
				return { kind: "policy-status", size: null, error: errorMessage(error) };
			}
		},
		resident() {
			return pool.mostRecent();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			pool.releaseAll("dispose");
		},
	};
}
