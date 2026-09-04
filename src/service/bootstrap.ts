/**
 * Service-systems bootstrap (Appendix H.5 pattern). Constructs the singleton
 * stack the SW depends on and caches it at module level so event, alarm and
 * message handlers all see the same instances. Nothing here touches
 * `chrome.*`: listeners are registered by `wireServiceLifecycle`,
 * `router.install()` and `sidePanel.install()` from `service-worker.ts`.
 *
 * `sessions`, `engine` and `executor` are `null` placeholders typed by the
 * interfaces below; Tasks 12 (engine), 18 (executor) and 30 (session
 * registry) assign the real implementations.
 */

import type { LicenseClient } from "@core/auth/license-client";
import { log } from "@core/logger";
import { installMessageRouter, type MessageRouter } from "@core/messaging/router";
import { Keepalive } from "@service/keepalive";
import { LicenseGate } from "@service/license-gate";
import { closeOffscreen, ensureOffscreen } from "@service/offscreen-manager";
import { SidePanelPolicy } from "@service/side-panel-policy";

/** A game session bound to one tab (Task 30 refines). */
export interface GameSessionHandle {
	/** A `chrome.commands` shortcut (manifest command name) aimed at this session. */
	onCommand(command: string): void | Promise<void>;
}

/** Registry of live game sessions keyed by tab (Task 30). */
export interface GameSessionRegistry {
	forActiveTab(): GameSessionHandle | null | Promise<GameSessionHandle | null>;
	dispose(): void;
}

/** SW-side UCI engine handle (Task 12's `RemoteEngine` implements the full `UciEngine`). */
export interface UciEngineHandle {
	dispose(): void | Promise<void>;
}

/** Move executor over the debugger backend (Task 18). */
export interface MoveExecutor {
	dispose(): void | Promise<void>;
}

export interface OffscreenManager {
	ensure(): Promise<void>;
	close(): Promise<void>;
}

export interface ServiceSystems {
	router: MessageRouter;
	sessions: GameSessionRegistry | null;
	engine: UciEngineHandle | null;
	executor: MoveExecutor | null;
	license: LicenseGate;
	keepalive: Keepalive;
	offscreen: OffscreenManager;
	sidePanel: SidePanelPolicy;
}

export interface BootstrapOptions {
	/** Overrides the default `PhantomLicenseClient` (tests). Only the first call's options apply. */
	licenseClient?: LicenseClient;
	forceValid?: boolean;
}

let cached: ServiceSystems | null = null;

export function bootstrapServiceSystems(options: BootstrapOptions = {}): ServiceSystems {
	if (cached) return cached;
	const gateOptions: ConstructorParameters<typeof LicenseGate>[0] = {};
	if (options.licenseClient) gateOptions.client = options.licenseClient;
	if (options.forceValid !== undefined) gateOptions.forceValid = options.forceValid;
	cached = {
		router: installMessageRouter(),
		sessions: null,
		engine: null,
		executor: null,
		license: new LicenseGate(gateOptions),
		keepalive: new Keepalive(),
		offscreen: { ensure: ensureOffscreen, close: closeOffscreen },
		sidePanel: new SidePanelPolicy(),
	};
	log.debug("service systems bootstrapped");
	return cached;
}

/**
 * Test-only: dispose the cached systems so the next `bootstrapServiceSystems()`
 * builds a fresh set against the current `globalThis.chrome`.
 */
export function __resetServiceSystemsCache(): void {
	const systems = cached;
	cached = null;
	if (!systems) return;
	systems.router.dispose();
	systems.sidePanel.dispose();
	systems.license.dispose();
	void systems.keepalive.dispose();
	systems.sessions?.dispose();
	void systems.engine?.dispose();
	void systems.executor?.dispose();
}
