// src/offscreen/engine-host/serve.ts
/**
 * The port side of the engine host: the service worker initiates (`RemoteEngine` →
 * `runtime.connect`), the document *accepts* — §6.3's "connects / re-connects" prose is
 * implemented as "accept the SW's connection and re-send the current status on each new one",
 * which is how the engine state survives a service-worker restart. Only the newest accepted port
 * is routed; its disconnect aborts pending NNUE downloads.
 */

import type { EnginePortCommand, EnginePortMessage } from "@core/constants/messages";
import { PORT_NAMES } from "@core/constants/ports";
import { log } from "@core/logger";
import { type AcceptedPort, acceptPorts } from "@core/messaging/ports";
import type { PolicyInference } from "../policy-inference";
import type { TimingInference } from "../timing-inference";
import type { EngineHost } from "./host";
import { createCommandRouter, type ModelStoreLike, type NnueStoreLike } from "./router";

export interface ServeEngineDeps<
	S extends NnueStoreLike,
	M extends ModelStoreLike = ModelStoreLike,
> {
	portName?: typeof PORT_NAMES.engine | typeof PORT_NAMES.reviewEngine;
	/** Release background engine memory when its service-worker owner disconnects. */
	disposeOnDisconnect?: boolean;
	createStore(post: (msg: EnginePortMessage) => void): S;
	createHost(post: (msg: EnginePortMessage) => void, store: S): EngineHost;
	/** Task 34: the band store the timing head reads; `model-chunk`s route here. */
	createModelStore?(post: (msg: EnginePortMessage) => void): M;
	/** Task 34: the timing head, built over the model store; absent → `timing` answers not-available. */
	createTiming?(store: M): TimingInference;
	/**
	 * 2026-09-11: the Maia-3 policy host (it owns its own bundled-only store, so nothing routes
	 * to it but the queries); absent → `policy` / `policy-warm` answer not-available.
	 */
	createPolicy?(): PolicyInference;
}

export interface ServedEngine {
	host: EngineHost;
	/** Stop accepting connections, dispose the host, the timing head and the policy host. */
	stop(): void;
}

const NO_PORT_DROP_REASON = "port disconnected";

export function serveEnginePort<S extends NnueStoreLike, M extends ModelStoreLike = ModelStoreLike>(
	deps: ServeEngineDeps<S, M>
): ServedEngine {
	let current: AcceptedPort<EnginePortMessage, EnginePortCommand> | null = null;
	const post = (msg: EnginePortMessage): void => {
		if (current) current.post(msg);
		else log.debug("engine-host: no service-worker port; message dropped", { kind: msg.kind });
	};
	const store = deps.createStore(post);
	let host = deps.createHost(post, store);
	const modelStore = deps.createModelStore?.(post);
	const timing = modelStore && deps.createTiming ? deps.createTiming(modelStore) : undefined;
	const policy = deps.createPolicy?.();
	const route = createCommandRouter({
		post,
		store,
		host: () => host,
		modelStore,
		timing,
		policy,
	});

	let unsubscribeCurrent: () => void = () => {};
	const stopAccepting = acceptPorts<EnginePortMessage, EnginePortCommand>(
		deps.portName ?? PORT_NAMES.engine,
		(port) => {
			unsubscribeCurrent();
			current = port;
			const offMessage = port.onMessage((cmd) => {
				if (current === port) route(cmd);
			});
			const offDisconnect = port.onDisconnect(() => {
				offMessage();
				if (current !== port) return;
				current = null;
				store.abortAll(NO_PORT_DROP_REASON);
				modelStore?.abortAll(NO_PORT_DROP_REASON);
				if (deps.disposeOnDisconnect) {
					host.dispose();
					host = deps.createHost(post, store);
				}
			});
			unsubscribeCurrent = () => {
				offMessage();
				offDisconnect();
			};
			log.info("engine-host: service worker connected");
			port.post({ kind: "status", status: host.status() });
		}
	);

	return {
		get host() {
			return host;
		},
		stop() {
			stopAccepting();
			unsubscribeCurrent(); // an `AcceptedPort` cannot be closed from this side; stop routing it
			current = null;
			store.abortAll(NO_PORT_DROP_REASON);
			modelStore?.abortAll(NO_PORT_DROP_REASON);
			timing?.dispose();
			policy?.dispose();
			host.dispose();
		},
	};
}
