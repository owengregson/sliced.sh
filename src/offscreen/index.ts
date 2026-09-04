/**
 * Offscreen document entry (§6.3). Hosts the Stockfish engine, the NNUE store
 * and the (scaffolded) timing head, and serves them to the service worker on
 * `PORT_NAMES.engine`: the SW connects (after `ensureOffscreen`), this
 * document accepts and immediately re-sends the current engine status, so a
 * service-worker restart re-syncs against the surviving engine.
 *
 * `chrome.storage` is not available in offscreen documents: every setting the
 * host needs (`configure`: variant + threads, `loadNnue`) arrives over the port.
 */

import { EngineHost, serveEnginePort } from "./engine-host";
import { NnueStore } from "./nnue-store";
import { bootEngineDetailed } from "./stockfish-loader";
import { createTimingInference } from "./timing-inference";

serveEnginePort({
	createStore: (post) =>
		new NnueStore({
			post,
			onProgress: (name, progress) => post({ kind: "nnue-progress", name, progress }),
		}),
	createHost: (post, store) =>
		new EngineHost({
			boot: (variant, hooks) => bootEngineDetailed(variant, { nnueStore: store, ...hooks }),
			nnueStore: store,
			post,
		}),
	timing: createTimingInference(),
});
