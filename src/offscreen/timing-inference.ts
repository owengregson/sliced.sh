/**
 * Timing-head inference host (§6.3 `timing-inference.ts`, §8.4b item 6; Task 34). Runs the
 * exported ChessMimic clock model through onnxruntime-web in the offscreen document:
 *
 *   - one `InferenceSession` per band, created on first use (or on `timing-warm`) from the
 *     `ModelStore`'s bytes and warmed with one dummy query so the first real move never pays
 *     the cold-start; at most `LIMITS.timingSessionsMax` sessions stay loaded (LRU);
 *   - `{kind:"timing", inputs}` → `{kind:"timing-result", probs, band, ms}`: the SW's token ids
 *     go in as int32 `[1, 90]`, the rating (clamped to the band) and the log clocks are
 *     standardised here with the scalers of the band that runs — when the requested band's
 *     bytes cannot be had, the nearest registered band that can be loaded answers instead and
 *     the reply names it;
 *   - failures never throw across the port: malformed inputs, a band that cannot load, a
 *     runtime that cannot start (retried once single-threaded when the pthread build fails) and
 *     a disposed host all answer `probs: null` + `error`, and the SW's head falls back to v1.
 */

import { LIMITS } from "@core/constants/limits";
import type { EnginePortCommand, EnginePortMessage } from "@core/constants/messages";
import { chessMimicBandFile } from "@core/constants/models";
import { log } from "@core/logger";
import { type BandScalers, bandCentre, CHESSMIMIC_SCALERS } from "@core/timing/chessmimic-scalers";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { FailureBackoff } from "./inference/failure-backoff";
import { createSessionWithFallback, lazyRuntime } from "./inference/ort-session";
import { SessionPool } from "./inference/session-pool";
import type { OrtRuntime, OrtSession } from "./ort-loader";
import { errorMessage } from "./shared/errors";
import { feedsFor, inputsProblem, warmInputs } from "./timing-inference/features";

export { inputsProblem } from "./timing-inference/features";

export type TimingCommand = Extract<EnginePortCommand, { kind: "timing" }>;
export type TimingResultMessage = Extract<EnginePortMessage, { kind: "timing-result" }>;

export const TIMING_NOT_AVAILABLE = "not-available";
export const TIMING_BAD_INPUTS = "bad inputs";
export const TIMING_NO_BAND = "no band available";
export const TIMING_DISPOSED = "disposed";

const CM = TIMING_CONSTANTS.chessmimic;
const OUTPUT_NAME = "probs";

export interface BandSource {
	get(name: string): Promise<Uint8Array>;
}

export interface TimingInferenceDeps {
	/** Loads and configures onnxruntime-web (lazy; a failure is remembered). */
	runtime: () => Promise<OrtRuntime>;
	store: BandSource;
	/** Registered bands and their scalers; default `CHESSMIMIC_SCALERS`. */
	scalers?: Readonly<Record<string, BandScalers>>;
	maxSessions?: number;
	now?: () => number;
	/** First cooldown after a failed load; default `TIMINGS.timingBandRetryMs`. Doubles per failure. */
	retryAfterMs?: number;
	/** Ceiling for the doubling cooldown; default `TIMINGS.timingBandRetryMaxMs`. */
	retryMaxMs?: number;
}

export interface TimingInference {
	handle(cmd: TimingCommand): Promise<TimingResultMessage>;
	/** Load and warm `band`'s session; unknown bands and failures are ignored. */
	warm(band: string): Promise<void>;
	/** Releases every session; later queries answer `TIMING_DISPOSED`. */
	dispose(): void;
}

export function createTimingInference(deps: TimingInferenceDeps): TimingInference {
	const scalers: Readonly<Record<string, BandScalers>> = deps.scalers ?? CHESSMIMIC_SCALERS;
	const bands = Object.keys(scalers);
	const now = deps.now ?? (() => performance.now());
	const runtime = lazyRuntime(deps.runtime);
	const pool = new SessionPool<string>({
		max: Math.max(1, deps.maxSessions ?? LIMITS.timingSessionsMax),
		releaseSession: (s) => void s.release().catch(() => {}),
		onRelease: (band, why) => log.debug("timing-inference: released band session", { band, why }),
		evictReason: "lru",
	});
	/** Bands that failed to load wait out a doubling cooldown before the next attempt. */
	const failures = new FailureBackoff<string>(now, deps);
	let disposed = false;

	async function loadSession(band: string): Promise<OrtSession> {
		const rt = await runtime();
		const bytes = await deps.store.get(chessMimicBandFile(band));
		const t0 = now();
		const session = await createSessionWithFallback(rt, bytes, "timing-inference");
		const t1 = now();
		await session.run(feedsFor(rt, scalers[band], band, warmInputs(band)));
		log.info("timing-inference: band session ready", {
			band,
			threads: rt.threads,
			createMs: Math.round(t1 - t0),
			warmMs: Math.round(now() - t1),
		});
		return session;
	}

	/** The session for `band`, shared while loading; a failure starts the retry cooldown. */
	function sessionFor(band: string): Promise<OrtSession> {
		const existing = pool.get(band);
		if (existing) {
			pool.touch(band);
			return existing;
		}
		const p = loadSession(band);
		pool.adopt(band, p, {
			onLoaded: () => failures.clear(band),
			onFailed: (error) => {
				const count = failures.fail(band);
				log.warn("timing-inference: band unavailable; retrying after the cooldown", {
					band,
					attempt: count,
					cooldownMs: failures.cooldownFor(count),
					error: errorMessage(error),
				});
			},
		});
		pool.touch(band);
		pool.evictBeyondLimit();
		return p;
	}

	/**
	 * `requested` first, then the registered bands nearest to `rating`, an already loaded band
	 * breaking an exact distance tie; bands still inside their retry cooldown are skipped. If every
	 * band is in cooldown the list is empty and `resolve` reports `TIMING_NO_BAND` rather than
	 * hammering a runtime that is failing.
	 *
	 * Distance wins over residency deliberately: a loaded band that is 1 000 Elo away would answer
	 * with the wrong player's pace to save a ~100 ms session load, which is the wrong trade. Since
	 * `bandCentre` became each band's training-population mean (2026-09-13) exact ties are rare, so
	 * the residency term is close to dead — that is the intended behaviour, not an oversight.
	 */
	function candidates(requested: string, rating: number): string[] {
		const loaded = (b: string): number => (pool.has(b) ? 0 : 1);
		return bands
			.filter((b) => !failures.inCooldown(b))
			.sort((a, b) => {
				if (a === requested) return -1;
				if (b === requested) return 1;
				const byDistance = Math.abs(bandCentre(a) - rating) - Math.abs(bandCentre(b) - rating);
				return byDistance !== 0 ? byDistance : loaded(a) - loaded(b);
			});
	}

	async function resolve(
		requested: string,
		rating: number
	): Promise<{ band: string; session: OrtSession }> {
		let lastError: unknown;
		for (const band of candidates(requested, rating)) {
			try {
				return { band, session: await sessionFor(band) };
			} catch (error) {
				lastError = error;
			}
		}
		throw new Error(lastError ? `${TIMING_NO_BAND}: ${errorMessage(lastError)}` : TIMING_NO_BAND);
	}

	return {
		async handle(cmd) {
			const reply = (
				probs: number[] | null,
				extra: Partial<TimingResultMessage>
			): TimingResultMessage =>
				({ kind: "timing-result", id: cmd.id, probs, ...extra }) as TimingResultMessage;
			if (disposed) return reply(null, { error: TIMING_DISPOSED });
			const problem = inputsProblem(cmd.inputs);
			if (problem) return reply(null, { error: `${TIMING_BAD_INPUTS}: ${problem}` });
			try {
				const { band, session } = await resolve(cmd.inputs.band, cmd.inputs.rating);
				const rt = await runtime();
				const t0 = now();
				const out = await session.run(feedsFor(rt, scalers[band], band, cmd.inputs));
				const ms = now() - t0;
				const probs = Array.from(out[OUTPUT_NAME]?.data ?? []);
				if (probs.length !== CM.nBuckets)
					return reply(null, { band, error: `bad output shape ${probs.length}` });
				return reply(probs, { band, ms });
			} catch (error) {
				return reply(null, { error: errorMessage(error) });
			}
		},
		async warm(band) {
			if (disposed || !Object.hasOwn(scalers, band)) return;
			try {
				await sessionFor(band);
			} catch {
				// reported by sessionFor
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			pool.releaseAll("dispose");
		},
	};
}
