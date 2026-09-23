/**
 * Waiting out a `configure` that may trigger an on-demand network download: settles on the
 * requested variant's `ready`, fails on its `crashed` once it has started loading, on the
 * download budget, on `signal`, or when the transport cancels every wait (dispose).
 */

import type { EnginePortMessage } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import type { PortScheduler } from "@core/messaging/ports";
import type { EngineVariant } from "@typedefs/engine";

export interface ConfigurationWaitDeps {
	scheduler: PortScheduler;
	onMessage(cb: (m: EnginePortMessage) => void): () => void;
	/** The transport's outstanding waits; each registers its cancel here until it settles. */
	cancels: Set<() => void>;
}

export function waitForConfiguration(
	deps: ConfigurationWaitDeps,
	variant: EngineVariant,
	signal: AbortSignal | undefined,
	start: () => void
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let transitioned = false;
		let off = (): void => {};
		const finish = (error?: Error): void => {
			off();
			deps.cancels.delete(cancel);
			deps.scheduler.clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			if (error) reject(error);
			else resolve();
		};
		const cancel = (): void => finish(new Error("engine configuration cancelled"));
		deps.cancels.add(cancel);
		const timer = deps.scheduler.setTimeout(
			() => finish(new Error("network download did not finish")),
			TIMINGS.assetDownloadTotalMs
		);
		off = deps.onMessage((message) => {
			if (message.kind !== "status") return;
			// The host may answer a `full` request with the small-net build after the full build
			// crashed twice (`fallbackFrom`): that is the engine this configuration gets.
			const { variant: running, fallbackFrom } = message.status;
			if (running !== variant && fallbackFrom !== variant) return;
			const { state, error } = message.status;
			if (state === "booting" || state === "loading-nnue") transitioned = true;
			if (state === "ready") finish();
			else if (state === "crashed" && transitioned)
				finish(new Error(error ?? "engine network failed to load"));
		});
		signal?.addEventListener("abort", cancel, { once: true });
		start();
	});
}
