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

import { CHESS_START_FEN } from "@core/constants/chess";
import { LIMITS } from "@core/constants/limits";
import type { EnginePortCommand, EnginePortMessage } from "@core/constants/messages";
import { chessMimicBandFile } from "@core/constants/models";
import { log } from "@core/logger";
import {
	type BandScalers,
	bandCentre,
	CHESSMIMIC_SCALERS,
	standardiseInputs,
} from "@core/timing/chessmimic-scalers";
import {
	INPUT_VOCAB_SIZE,
	MOVE_VOCABULARY,
	PAD_TOKEN,
	tokenizeFen,
} from "@core/timing/chessmimic-tokeniser";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import type { OrtRuntime, OrtSession, OrtTensor } from "./ort-loader";

export type TimingCommand = Extract<EnginePortCommand, { kind: "timing" }>;
export type TimingResultMessage = Extract<EnginePortMessage, { kind: "timing-result" }>;
type TimingInputs = TimingCommand["inputs"];

export const TIMING_NOT_AVAILABLE = "not-available";
export const TIMING_BAD_INPUTS = "bad inputs";
export const TIMING_NO_BAND = "no band available";
export const TIMING_DISPOSED = "disposed";

const CM = TIMING_CONSTANTS.chessmimic;
const UNTIMED = TIMING_CONSTANTS.untimedVirtual;
const INPUT_NAMES = {
	ids: "input_ids",
	rating: "scaled_rating",
	clocks: "clock_features",
} as const;
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
}

export interface TimingInference {
	handle(cmd: TimingCommand): Promise<TimingResultMessage>;
	/** Load and warm `band`'s session; unknown bands and failures are ignored. */
	warm(band: string): Promise<void>;
	/** Releases every session; later queries answer `TIMING_DISPOSED`. */
	dispose(): void;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function validTokens(tokens: unknown, length: number, vocab: number): tokens is number[] {
	return (
		Array.isArray(tokens) &&
		tokens.length === length &&
		tokens.every((t) => Number.isInteger(t) && t >= 0 && t < vocab)
	);
}

/** Why `inputs` cannot be fed to the model, or `undefined` when it can. */
export function inputsProblem(inputs: TimingInputs): string | undefined {
	if (!inputs || typeof inputs !== "object") return "missing inputs";
	if (typeof inputs.band !== "string") return "band";
	if (!validTokens(inputs.moveTokens, CM.recentMoves, MOVE_VOCABULARY.length)) return "moveTokens";
	if (!validTokens(inputs.fenTokens, CM.fenTokens, INPUT_VOCAB_SIZE)) return "fenTokens";
	for (const key of ["rating", "playerClockS", "opponentClockS", "incrementS"] as const) {
		const v = inputs[key];
		if (typeof v !== "number" || !Number.isFinite(v)) return key;
	}
	if (inputs.playerClockS < 0 || inputs.opponentClockS < 0 || inputs.incrementS < 0)
		return "negative clock";
	return undefined;
}

export function createTimingInference(deps: TimingInferenceDeps): TimingInference {
	const scalers: Readonly<Record<string, BandScalers>> = deps.scalers ?? CHESSMIMIC_SCALERS;
	const bands = Object.keys(scalers);
	const maxSessions = Math.max(1, deps.maxSessions ?? LIMITS.timingSessionsMax);
	const now = deps.now ?? (() => performance.now());

	let runtimePromise: Promise<OrtRuntime> | undefined;
	const sessions = new Map<string, Promise<OrtSession>>();
	/** Sessions whose load has completed (released synchronously on eviction / dispose). */
	const ready = new Map<string, OrtSession>();
	/** Most recently used last. */
	const lru: string[] = [];
	const unavailable = new Set<string>();
	let disposed = false;

	function runtime(): Promise<OrtRuntime> {
		if (!runtimePromise) runtimePromise = deps.runtime();
		return runtimePromise;
	}

	function touch(band: string): void {
		const at = lru.indexOf(band);
		if (at >= 0) lru.splice(at, 1);
		lru.push(band);
	}

	function release(band: string, why: string): void {
		const p = sessions.get(band);
		sessions.delete(band);
		const s = ready.get(band);
		ready.delete(band);
		if (s) void s.release().catch(() => {});
		else p?.then((session) => session.release()).catch(() => {});
		log.debug("timing-inference: released band session", { band, why });
	}

	function evictBeyondLimit(): void {
		while (lru.length > maxSessions) {
			const victim = lru.shift();
			if (victim === undefined) break;
			release(victim, "lru");
		}
	}

	async function createSession(rt: OrtRuntime, bytes: Uint8Array): Promise<OrtSession> {
		try {
			return await rt.createSession(bytes);
		} catch (error) {
			if (rt.threads <= 1) throw error;
			log.warn("timing-inference: threaded session failed; retrying single-threaded", {
				threads: rt.threads,
				error: errorMessage(error),
			});
			rt.setThreads(1);
			return rt.createSession(bytes);
		}
	}

	function feedsFor(rt: OrtRuntime, band: string, inputs: TimingInputs): Record<string, OrtTensor> {
		const std = standardiseInputs({ ...inputs, band }, scalers[band]);
		const ids = Int32Array.from([...inputs.moveTokens, ...inputs.fenTokens]);
		return {
			[INPUT_NAMES.ids]: rt.tensor("int32", ids, [1, ids.length]),
			[INPUT_NAMES.rating]: rt.tensor("float32", Float32Array.of(std.scaledRating), [1]),
			[INPUT_NAMES.clocks]: rt.tensor("float32", Float32Array.from(std.clockFeatures), [1, 3]),
		};
	}

	function warmInputs(band: string): TimingInputs {
		return {
			band,
			moveTokens: new Array<number>(CM.recentMoves).fill(PAD_TOKEN),
			fenTokens: tokenizeFen(CHESS_START_FEN),
			rating: bandCentre(band),
			playerClockS: UNTIMED.clockS,
			opponentClockS: UNTIMED.clockS,
			incrementS: UNTIMED.incS,
		};
	}

	async function loadSession(band: string): Promise<OrtSession> {
		const rt = await runtime();
		const bytes = await deps.store.get(chessMimicBandFile(band));
		const t0 = now();
		const session = await createSession(rt, bytes);
		const t1 = now();
		await session.run(feedsFor(rt, band, warmInputs(band)));
		log.info("timing-inference: band session ready", {
			band,
			threads: rt.threads,
			createMs: Math.round(t1 - t0),
			warmMs: Math.round(now() - t1),
		});
		return session;
	}

	/** The session for `band`, shared while loading; a failure marks the band unavailable. */
	function sessionFor(band: string): Promise<OrtSession> {
		const existing = sessions.get(band);
		if (existing) {
			touch(band);
			return existing;
		}
		const p = loadSession(band);
		sessions.set(band, p);
		touch(band);
		evictBeyondLimit();
		p.then(
			(session) => {
				if (sessions.get(band) === p) ready.set(band, session);
				else void session.release().catch(() => {}); // evicted or disposed while loading
			},
			(error: unknown) => {
				if (sessions.get(band) === p) sessions.delete(band);
				const at = lru.indexOf(band);
				if (at >= 0) lru.splice(at, 1);
				unavailable.add(band);
				log.warn("timing-inference: band unavailable", { band, error: errorMessage(error) });
			}
		);
		return p;
	}

	/**
	 * `requested` first, then the registered bands nearest to `rating` (an already loaded band
	 * wins a tie, so a substitute never costs a second session); unavailable bands skipped.
	 */
	function candidates(requested: string, rating: number): string[] {
		const loaded = (b: string): number => (sessions.has(b) ? 0 : 1);
		return bands
			.filter((b) => !unavailable.has(b))
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
				const out = await session.run(feedsFor(rt, band, cmd.inputs));
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
			for (const band of [...sessions.keys()]) release(band, "dispose");
			lru.length = 0;
		},
	};
}
