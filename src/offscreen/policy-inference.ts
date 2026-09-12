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
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import { encodeMaiaInputs, type MaiaEncoded } from "@core/policy/maia-encoder";
import { decodeMaiaOutputs } from "@core/policy/maia-policy";
import type { PolicyInferenceInputs } from "@core/policy/types";
import { isMaiaSize, type MaiaSource } from "./maia-store";
import type { OrtRuntime, OrtSession, OrtTensor } from "./ort-loader";

export type PolicyCommand = Extract<EnginePortCommand, { kind: "policy" }>;
export type PolicyResultMessage = Extract<EnginePortMessage, { kind: "policy-result" }>;
export type PolicyStatusMessage = Extract<EnginePortMessage, { kind: "policy-status" }>;

export const POLICY_NOT_AVAILABLE = "not-available";
export const POLICY_BAD_INPUTS = "bad inputs";
export const POLICY_NO_SESSION = "no session available";
export const POLICY_DISPOSED = "disposed";

const TOKENS_LENGTH = MAIA_INPUT.squares * MAIA_INPUT.tokenDim;
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Threads for a Maia session: `min(LIMITS.policyInferenceThreadsMax, hardwareConcurrency)`, at least 1. */
export function policyThreads(hardwareConcurrency: number | undefined): number {
	const cores = Number.isFinite(hardwareConcurrency) ? (hardwareConcurrency ?? 1) : 1;
	return Math.max(1, Math.min(LIMITS.policyInferenceThreadsMax, Math.floor(cores)));
}

/** Why `inputs` cannot be fed to the model, or `undefined` when they can. */
export function inputsProblem(inputs: PolicyInferenceInputs): string | undefined {
	if (!inputs || typeof inputs !== "object") return "missing inputs";
	if (!isMaiaSize(inputs.size)) return "size";
	if (typeof inputs.fen !== "string" || inputs.fen.length === 0) return "fen";
	if (!Array.isArray(inputs.historyFens) || !inputs.historyFens.every((f) => typeof f === "string"))
		return "historyFens";
	for (const key of ["selfElo", "oppoElo"] as const) {
		const v = inputs[key];
		if (typeof v !== "number" || !Number.isFinite(v)) return key;
	}
	return undefined;
}

/**
 * The history the encoder sees: the last `MAIA_INPUT.history` FENs ending in `fen` — appended
 * when the caller's list does not already end there (an empty list is just `[fen]`).
 */
export function historyForQuery(
	inputs: Pick<PolicyInferenceInputs, "fen" | "historyFens">
): string[] {
	const fens = [...inputs.historyFens];
	if (fens[fens.length - 1] !== inputs.fen) fens.push(inputs.fen);
	return fens.slice(-MAIA_INPUT.history);
}

export function createPolicyInference(deps: PolicyInferenceDeps): PolicyInference {
	const maxSessions = Math.max(1, deps.maxSessions ?? LIMITS.policySessionsMax);
	const now = deps.now ?? (() => performance.now());
	const retryAfterMs = deps.retryAfterMs ?? TIMINGS.timingBandRetryMs;
	const retryMaxMs = Math.max(retryAfterMs, deps.retryMaxMs ?? TIMINGS.timingBandRetryMaxMs);

	let runtimePromise: Promise<OrtRuntime> | undefined;
	const sessions = new Map<MaiaSize, Promise<OrtSession>>();
	/** Sessions whose load has completed (released synchronously on eviction / dispose). */
	const ready = new Map<MaiaSize, OrtSession>();
	/** Most recently used last. */
	const lru: MaiaSize[] = [];
	/** Size → when it last failed to load and how many consecutive failures (doubling cooldown). */
	const failures = new Map<MaiaSize, { at: number; count: number }>();
	/**
	 * Sessions with a `run` in flight, and those whose release was asked for meanwhile. A size
	 * switch during a move (the target crossing a band mid-query) evicts the old session while its
	 * query is still running; releasing a wasm session under a running `run` is undefined, so the
	 * release waits until the last run on it settles.
	 */
	const running = new Map<OrtSession, number>();
	const releaseWhenIdle = new Set<OrtSession>();
	let disposed = false;

	function releaseSession(s: OrtSession): void {
		if ((running.get(s) ?? 0) > 0) {
			releaseWhenIdle.add(s);
			return;
		}
		void s.release().catch(() => {});
	}

	async function runOn<T>(s: OrtSession, work: () => Promise<T>): Promise<T> {
		running.set(s, (running.get(s) ?? 0) + 1);
		try {
			return await work();
		} finally {
			const left = (running.get(s) ?? 1) - 1;
			if (left > 0) running.set(s, left);
			else {
				running.delete(s);
				if (releaseWhenIdle.delete(s)) void s.release().catch(() => {});
			}
		}
	}

	function cooldownFor(count: number): number {
		return Math.min(retryMaxMs, retryAfterMs * 2 ** Math.max(0, count - 1));
	}

	function inCooldown(size: MaiaSize): boolean {
		const f = failures.get(size);
		return f !== undefined && now() - f.at < cooldownFor(f.count);
	}

	function runtime(): Promise<OrtRuntime> {
		if (!runtimePromise) runtimePromise = deps.runtime();
		return runtimePromise;
	}

	function touch(size: MaiaSize): void {
		const at = lru.indexOf(size);
		if (at >= 0) lru.splice(at, 1);
		lru.push(size);
	}

	/**
	 * Drop `size`'s session. A finished load is released here; one still loading is released by
	 * `sessionFor`'s settle handler when it sees `sessions` no longer holds its promise — exactly
	 * one of the two runs, so `release()` is never called twice on one session.
	 */
	function release(size: MaiaSize, why: string): void {
		sessions.delete(size);
		const s = ready.get(size);
		ready.delete(size);
		if (s) releaseSession(s);
		log.debug("policy-inference: released session", { size, why });
	}

	/** Evict *before* a new load starts: two resident Maia sessions is the memory case the limit exists for. */
	function evictBeyondLimit(): void {
		while (lru.length > maxSessions) {
			const victim = lru.shift();
			if (victim === undefined) break;
			release(victim, "evicted");
		}
	}

	async function createSession(rt: OrtRuntime, bytes: Uint8Array): Promise<OrtSession> {
		try {
			return await rt.createSession(bytes);
		} catch (error) {
			if (rt.threads <= 1) throw error;
			log.warn("policy-inference: threaded session failed; retrying single-threaded", {
				threads: rt.threads,
				error: errorMessage(error),
			});
			rt.setThreads(1);
			return rt.createSession(bytes);
		}
	}

	function feedsFor(
		rt: OrtRuntime,
		encoded: MaiaEncoded,
		selfElo: number,
		oppoElo: number
	): Record<string, OrtTensor> {
		return {
			[MAIA_INPUT.inputs.tokens]: rt.tensor("float32", encoded.tokens, [
				1,
				MAIA_INPUT.squares,
				MAIA_INPUT.tokenDim,
			]),
			[MAIA_INPUT.inputs.selfElo]: rt.tensor("float32", Float32Array.of(selfElo), [1]),
			[MAIA_INPUT.inputs.oppoElo]: rt.tensor("float32", Float32Array.of(oppoElo), [1]),
		};
	}

	function encode(historyFens: readonly string[]): MaiaEncoded {
		const encoded = encodeMaiaInputs(historyFens);
		if (encoded.tokens.length !== TOKENS_LENGTH)
			throw new Error(`encoder produced ${encoded.tokens.length} features, expected ${TOKENS_LENGTH}`);
		return encoded;
	}

	async function loadSession(size: MaiaSize): Promise<{ session: OrtSession; loadMs: number }> {
		const rt = await runtime();
		const bytes = await deps.store.get(size);
		const t0 = now();
		const session = await createSession(rt, bytes);
		const t1 = now();
		// The warm-up: the start position, a mirror match at the middle of the human range.
		const warm = encode([CHESS_START_FEN]);
		const elo = (MAIA_INPUT.eloMin + MAIA_INPUT.eloMax) / 2;
		await runOn(session, () => session.run(feedsFor(rt, warm, elo, elo)));
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
		const existing = sessions.get(size);
		if (existing) {
			touch(size);
			return existing.then((session) => ({ session, loadMs: 0 }));
		}
		if (inCooldown(size)) {
			const f = failures.get(size);
			return Promise.reject(
				new Error(`${POLICY_NO_SESSION}: ${size} failed ${f?.count ?? 0}× and is cooling down`)
			);
		}
		touch(size);
		evictBeyondLimit();
		const loaded = loadSession(size);
		const p = loaded.then((r) => r.session);
		sessions.set(size, p);
		p.then(
			(session) => {
				if (sessions.get(size) === p) {
					ready.set(size, session);
					failures.delete(size);
				} else releaseSession(session); // evicted or disposed while loading
			},
			(error: unknown) => {
				if (sessions.get(size) === p) sessions.delete(size);
				const at = lru.indexOf(size);
				if (at >= 0) lru.splice(at, 1);
				const count = (failures.get(size)?.count ?? 0) + 1;
				failures.set(size, { at: now(), count });
				log.warn("policy-inference: size unavailable; retrying after the cooldown", {
					size,
					attempt: count,
					cooldownMs: cooldownFor(count),
					error: errorMessage(error),
				});
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
				const out = await runOn(session, () => session.run(feedsFor(rt, encoded, selfElo, oppoElo)));
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
			return lru.length > 0 ? (lru[lru.length - 1] ?? null) : null;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const size of [...sessions.keys()]) release(size, "dispose");
			lru.length = 0;
		},
	};
}
