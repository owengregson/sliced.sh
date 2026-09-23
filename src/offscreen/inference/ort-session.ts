// src/offscreen/inference/ort-session.ts
/** onnxruntime plumbing both inference hosts share: the lazy runtime, session creation, threads. */

import { log } from "@core/logger";
import type { OrtRuntime, OrtSession } from "../ort-loader";
import { errorMessage } from "../shared/errors";

/** `factory()` on the first call, the same promise after (a failure is remembered). */
export function lazyRuntime(factory: () => Promise<OrtRuntime>): () => Promise<OrtRuntime> {
	let runtimePromise: Promise<OrtRuntime> | undefined;
	return () => {
		if (!runtimePromise) runtimePromise = factory();
		return runtimePromise;
	};
}

/**
 * A session from `bytes`; when the pthread build cannot start one, the runtime drops to one
 * thread and tries once more. `label` prefixes the log line.
 */
export async function createSessionWithFallback(
	rt: OrtRuntime,
	bytes: Uint8Array,
	label: string
): Promise<OrtSession> {
	try {
		return await rt.createSession(bytes);
	} catch (error) {
		if (rt.threads <= 1) throw error;
		log.warn(`${label}: threaded session failed; retrying single-threaded`, {
			threads: rt.threads,
			error: errorMessage(error),
		});
		rt.setThreads(1);
		return rt.createSession(bytes);
	}
}

/** `min(max, hardwareConcurrency)` threads, at least 1; an unknown core count counts as 1. */
export function cappedThreads(hardwareConcurrency: number | undefined, max: number): number {
	const cores = Number.isFinite(hardwareConcurrency) ? (hardwareConcurrency ?? 1) : 1;
	return Math.max(1, Math.min(max, Math.floor(cores)));
}
