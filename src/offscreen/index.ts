/**
 * Offscreen document entry (§6.3). Hosts the Stockfish engine, the NNUE store,
 * the ChessMimic band store and the timing head (onnxruntime-web, Task 34), the
 * Maia-3 model store and the policy host (2026-09-11), and serves them to the
 * service worker on `PORT_NAMES.engine`: the SW connects (after
 * `ensureOffscreen`), this document accepts and immediately re-sends the current
 * engine status, so a service-worker restart re-syncs against the surviving engine.
 *
 * `chrome.storage` is not available in offscreen documents: every setting the
 * host needs (`configure`: variant + threads, `loadNnue`) arrives over the port.
 */

import { EngineHost, serveEnginePort } from "./engine-host";
import { MaiaStore } from "./maia-store";
import { ModelStore } from "./model-store";
import { serveMoveRatingSounds } from "./move-rating-sounds";
import { NnueStore } from "./nnue-store";
import { createOrtRuntime } from "./ort-loader";
import { createPolicyInference, policyThreads } from "./policy-inference";
import { bootEngineDetailed } from "./stockfish-loader";
import { createTimingInference } from "./timing-inference";

const served = serveEnginePort({
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
	createModelStore: (post) => new ModelStore({ post }),
	createTiming: (store) => createTimingInference({ runtime: () => createOrtRuntime(), store }),
	// One onnxruntime module serves both model families; the policy host only asks for its own
	// thread cap (`env.wasm.numThreads` is set per session creation).
	createPolicy: () =>
		createPolicyInference({
			runtime: () =>
				createOrtRuntime({ threads: policyThreads(globalThis.navigator?.hardwareConcurrency) }),
			store: new MaiaStore(),
		}),
});

const stopSounds = serveMoveRatingSounds();

// The document is closed by `chrome.offscreen.closeDocument()` (or an extension
// reload): quit the engine and stop routing so nothing outlives the page.
globalThis.addEventListener?.(
	"pagehide",
	() => {
		stopSounds();
		served.stop();
	},
	{ once: true }
);
