/**
 * The worker's engines: the playing engine (`UciEngine` over `RemoteEngine` over the offscreen
 * document) with its controller and analysis cache, and the separate full-network review engine
 * that board ratings run on.
 */

import { AnalysisCache } from "@core/engine/analysis-cache";
import type { OptionsEnv } from "@core/engine/options";
import { RemoteEngine } from "@core/engine/remote-engine";
import { UciEngine } from "@core/engine/uci-client";
import { getSettings, onSettingsChanged } from "@core/storage/settings-storage";
import { EngineController } from "@service/engine-controller";
import { ensureOffscreen } from "@service/offscreen-manager";
import { ReviewEngine, reviewThreads } from "@service/review-engine";

export interface EngineStack {
	transport: RemoteEngine;
	engine: UciEngine;
	reviewEngine: ReviewEngine;
	controller: EngineController;
}

export function defaultEnv(): OptionsEnv {
	const concurrency =
		typeof navigator === "object" && typeof navigator.hardwareConcurrency === "number"
			? navigator.hardwareConcurrency
			: 1;
	return { hardwareConcurrency: concurrency, sab: typeof SharedArrayBuffer === "function" };
}

export function createEngineStack(env: OptionsEnv): EngineStack {
	const transport = new RemoteEngine({
		ensureHost: ensureOffscreen,
		// §8.4b item 6 / Task 34: the ChessMimic head is the shipped timing head (V2.5), so the
		// offscreen document is asked to pre-load its default band with the first `configure`.
		// `setWarmTiming` after that first `configure` has no effect until a reconnect.
		warmTiming: true,
	});
	const engine = new UciEngine(transport);
	// 2026-09-14: board ratings run on their own full-network engine, never on `engine`.
	const reviewEngine = new ReviewEngine({
		ensureHost: ensureOffscreen,
		threads: reviewThreads(globalThis.navigator?.hardwareConcurrency),
	});
	const cache = new AnalysisCache();
	const controller = new EngineController(engine, {
		getSettings,
		onSettingsChanged,
		env,
		cache,
		getLoadedVariant: () => transport.status().variant,
		configureVariant: (variant, threads, signal) =>
			transport.configureAndWait(variant, threads, signal),
	});
	return { transport, engine, reviewEngine, controller };
}
