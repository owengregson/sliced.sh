/**
 * The review engine's backend: the full Stockfish 19 instance behind `PORT_NAMES.reviewEngine`,
 * booted without a strength limit, and the checks that the network it actually loaded is the
 * full one.
 */

import { ENGINE_FILES } from "@core/constants/engine-files";
import { PORT_NAMES } from "@core/constants/ports";
import { REVIEW } from "@core/constants/review";
import { RemoteEngine } from "@core/engine/remote-engine";
import type { AnalysisHandle, AnalysisRequest } from "@core/engine/types";
import { UciEngine } from "@core/engine/uci-client";
import type { EngineStatus } from "@typedefs/engine";

export interface ReviewBackend {
	warm(signal: AbortSignal): Promise<void>;
	analyse(request: AnalysisRequest): AnalysisHandle;
	status(): EngineStatus;
	dispose(): void;
}

/** Review's independent thread cap; this does not reserve cores for the playing engine. */
export function reviewThreads(hardwareConcurrency: number | undefined): number {
	const cores =
		hardwareConcurrency !== undefined && Number.isFinite(hardwareConcurrency)
			? hardwareConcurrency
			: REVIEW.threadsMin;
	return Math.max(REVIEW.threadsMin, Math.min(REVIEW.threadsMax, Math.floor(cores / 2)));
}

/** Verify the actual loaded network, not merely the requested variant. */
export function fullReviewReady(status: EngineStatus | null | undefined): boolean {
	return (
		!!status &&
		status.variant === "full" &&
		status.fallbackFrom === undefined &&
		status.error === undefined &&
		(status.state === "ready" || status.state === "searching") &&
		status.nnue.length === ENGINE_FILES.full.nnue.length &&
		ENGINE_FILES.full.nnue.every((name) => status.nnue.includes(name))
	);
}

export function remoteBackend(ensureHost: () => Promise<void>, threads: number): ReviewBackend {
	const transport = new RemoteEngine({
		ensureHost,
		portName: PORT_NAMES.reviewEngine,
		variant: "full",
		threads,
	});
	const engine = new UciEngine(transport);
	return {
		async warm(signal) {
			await transport.configureAndWait("full", threads, signal);
			if (signal.aborted) throw new Error("review engine loading cancelled");
			const status = transport.status();
			if (status.variant !== "full" || status.fallbackFrom || status.error)
				throw new Error(status.error ?? "Full review engine unavailable");
			await engine.init();
			if (signal.aborted) throw new Error("review engine loading cancelled");
			await engine.setOptions({
				Threads: threads,
				Hash: REVIEW.hashMb,
				UCI_LimitStrength: false,
				"Skill Level": 20,
				UCI_ShowWDL: true,
				Ponder: false,
			});
			if (!fullReviewReady(transport.status())) throw new Error("Full review network not ready");
		},
		analyse: (request) => engine.analyse(request),
		status: () => transport.status(),
		dispose() {
			engine.dispose();
			// The review port's disconnect handler quits its host and frees its WASM memory.
			transport.dispose();
		},
	};
}
