/**
 * Service-worker side of the ChessMimic inference port (Task 34; §8.4b item 6). Turns the
 * engine port into the `InferPort` the `ChessMimicHead` takes: `infer(inputs)` posts
 * `{kind:"timing", id, inputs}` and resolves with the matching `timing-result`'s probabilities,
 * band and wall time — or `null` when the host answered with an error (the head then falls back
 * to v1; its own 100 ms budget covers a host that never answers). `warm(band)` posts
 * `timing-warm` so the offscreen document loads the band's session before the first move.
 *
 * Wiring `new ChessMimicHead({ infer: createTimingInferPort(remoteEngine).infer, fallback })`
 * into the SW's `TimingModel` is the integration task's (the head selection Task 16 left there).
 */

import type { EnginePortCommand, EnginePortMessage } from "@core/constants/messages";
import { log } from "@core/logger";
import type { ChessMimicInputs, InferPort, InferResult } from "@core/timing/chessmimic-head";

/** The engine port as seen from the SW (`RemoteEngine` satisfies it). */
export interface TimingRelayPort {
	onMessage(cb: (m: EnginePortMessage) => void): () => void;
	post(cmd: EnginePortCommand): void;
}

export interface TimingInferPort {
	infer: InferPort;
	warm(band: string): void;
	/** Settles every pending query with `null` and stops listening. */
	dispose(): void;
}

const ID_PREFIX = "t";

export function createTimingInferPort(port: TimingRelayPort): TimingInferPort {
	const pending = new Map<string, (r: InferResult | null) => void>();
	let seq = 0;
	let disposed = false;
	const off = port.onMessage((m) => {
		if (m.kind !== "timing-result") return;
		const resolve = pending.get(m.id);
		if (!resolve) return;
		pending.delete(m.id);
		if (!m.probs) {
			log.debug("timing-infer: host answered without probabilities", { id: m.id, error: m.error });
			resolve(null);
			return;
		}
		const result: InferResult = { probs: m.probs, band: m.band ?? "" };
		if (m.ms !== undefined) result.ms = m.ms;
		resolve(result);
	});
	return {
		infer(inputs: ChessMimicInputs): Promise<InferResult | null> {
			if (disposed) return Promise.resolve(null);
			const id = `${ID_PREFIX}${++seq}`;
			return new Promise((resolve) => {
				pending.set(id, resolve);
				port.post({ kind: "timing", id, inputs });
			});
		},
		warm(band) {
			if (disposed) return;
			port.post({ kind: "timing-warm", band });
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			off();
			const waiting = [...pending.values()];
			pending.clear();
			for (const resolve of waiting) resolve(null);
		},
	};
}
