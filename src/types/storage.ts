/**
 * Storage-side value shapes (§4.4) keyed by the `LOCAL_KEYS` / `SESSION_KEYS`
 * registry, so `chromeLocalGet(LOCAL_KEYS.settings)` resolves to `Settings`.
 * Domain types are imported from their owning files, never redeclared.
 */

import { LOCAL_KEYS, SESSION_KEYS } from "@core/constants/storage-keys";
import type { ExplorerCacheStore } from "@core/strength/book/explorer";
import type { SessionStats } from "@typedefs/game";
import type { LicenseState, PersonaId, Settings } from "@typedefs/settings";
import type { TimingLogEntry } from "@typedefs/timing";

export type { SessionStats, TimingLogEntry };

/** `LOCAL_KEYS.engineNnueMeta` — the NNUE file cached in IndexedDB. */
export interface NnueMeta {
	name: string;
	sha256: string;
	bytes: number;
	storedAt: number;
}

/**
 * `SESSION_KEYS.personaByGame` values: the persona sampled for a game plus
 * its latent traits. Task 14/16 own the sampling; the storage shape is fixed here.
 */
export interface PersonaLatents {
	persona: PersonaId;
	latents: Record<string, number>;
	sampledAt: number;
}

/** `Record<tabId, boolean>` — chrome.storage keys are strings, so tab ids are stringified. */
export type TabFlags = Record<string, boolean>;

export interface LocalStorageSchema {
	[LOCAL_KEYS.settings]: Settings;
	[LOCAL_KEYS.licenseState]: LicenseState;
	[LOCAL_KEYS.licenseKey]: string;
	[LOCAL_KEYS.updateAvailable]: boolean;
	/** The version `update-check` saw on the site; read by the panel for the §4.8 copy. */
	[LOCAL_KEYS.updateVersion]: string;
	[LOCAL_KEYS.engineNnueMeta]: NnueMeta;
	[LOCAL_KEYS.sessionStats]: SessionStats;
	[LOCAL_KEYS.timingLog]: TimingLogEntry[];
	[LOCAL_KEYS.installedAt]: number;
	/** Task 19 defines `MotorTrace`; stored as opaque chunks until then. */
	[LOCAL_KEYS.motorTraces]: unknown[];
	/** Task 19 defines `MotorProfile`. */
	[LOCAL_KEYS.motorProfile]: unknown;
	/** Opening-explorer responses keyed by `(fen, ratings, speeds)` (Task 15). */
	[LOCAL_KEYS.explorerCache]: ExplorerCacheStore;
}

export interface SessionStorageSchema {
	[SESSION_KEYS.autoMoveArmed]: TabFlags;
	[SESSION_KEYS.debuggerAttached]: TabFlags;
	[SESSION_KEYS.personaByGame]: Record<string, PersonaLatents>;
}
