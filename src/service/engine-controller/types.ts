/** The engine controller's construction seam and its diagnostic status record. */

import type { AnalysisCache } from "@core/engine/analysis-cache";
import type { EngineOptions, OptionsEnv } from "@core/engine/options";
import type { EngineState } from "@core/engine/types";
import type { EngineVariant } from "@typedefs/engine";
import type { Settings } from "@typedefs/settings";

export interface EngineControllerDeps {
	getSettings(): Promise<Settings>;
	/** Returns unsubscribe. */
	onSettingsChanged(cb: (settings: Settings) => void): () => void;
	env: OptionsEnv;
	/** No cache → every request reaches the engine. */
	cache?: AnalysisCache | undefined;
	now?: () => number;
	/**
	 * Minimum `final.depth` for a cache hit on a depth-less, non-infinite request
	 * (default `FEATURE_DEPTH`, the timing model's `D_f`). Explicit depth ceilings
	 * remain authoritative even when lower than the feature depth.
	 */
	cacheMinDepth?: number;
	/** Resolves only when the requested variant and its verified networks are loaded. */
	configureVariant?: (variant: EngineVariant, threads: number, signal: AbortSignal) => Promise<void>;
	/** Actual host variant can differ after an acknowledged Full-to-Small crash fallback. */
	getLoadedVariant?: () => EngineVariant | undefined;
}

export interface EngineControllerStatus {
	state: EngineState;
	/** Options last confirmed by the engine (`null` until the first apply). */
	options: EngineOptions | null;
	/** A settings change is waiting for the engine to go idle (or to be initialised). */
	pendingOptions: boolean;
	optionsAppliedAt: number | null;
	/** Queued or running requests issued through this controller. */
	inFlight: number;
	cacheSize: number;
	gameId: string | null;
}
