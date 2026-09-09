/**
 * Chrome lifecycle wiring for the service worker: `runtime.onInstalled`
 * (first-install defaults, the §12.3 legacy migration on update from 1.x),
 * `runtime.onStartup`, the `alarms.onAlarm` dispatcher keyed by
 * `ALARM_NAMES`, and `commands.onCommand` forwarded to the active tab's
 * game session. Every listener is registered synchronously by
 * `wireServiceLifecycle`; the async work lives inside the handlers.
 */

import { onAlarm } from "@core/chrome/alarms";
import { onCommand } from "@core/chrome/commands";
import { onRuntimeInstalled, onRuntimeStartup } from "@core/chrome/runtime";
import { chromeLocalGetRaw, chromeLocalRemoveRaw, chromeLocalSet } from "@core/chrome/storage";
import { ALARM_NAMES, type AlarmName } from "@core/constants/alarms";
import { LIMITS } from "@core/constants/limits";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { log } from "@core/logger";
import { setLicenseKey } from "@core/storage/license-storage";
import { type SettingsPatch, setSettings } from "@core/storage/settings-storage";
import { clamp } from "@core/util/clamp";
import type { ServiceSystems } from "@service/bootstrap";
import { checkForUpdate } from "@service/update-check";
import type { Keybind, Settings } from "@typedefs/settings";

// ---------------------------------------------------------------------------
// §12.3 legacy (1.x) settings migration
// ---------------------------------------------------------------------------

/** The flat `chrome.storage.local` keys the 1.x extension wrote. */
export const LEGACY_KEYS = [
	"extensionActive",
	"highlightMoves",
	"elo",
	"depthValue",
	"maxWaitTime",
	"automove",
	"autoPlayNewGame",
	"key",
	"moveKeybind",
	"exitKeybind",
	"ttsKeybind",
] as const;

/** Legacy `elo` was a Stockfish skill level 1–20. */
const LEGACY_ELO_MIN = 1;
const LEGACY_ELO_MAX = 20;
/** Legacy `maxWaitTime` default (seconds) — maps to `speedScale = 1`. */
const LEGACY_DEFAULT_MAX_WAIT_S = 4;
/** Log-unit clamp of the speed offset (Task 16's `s_offset` range). */
const SPEED_LOG_CLAMP = 0.5;
const MIN_LEGACY_WAIT_S = 0.5;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The 1.x popup stored its range sliders as strings (`event.target.value`)
 * while `background.js` seeded numeric defaults, so both shapes exist in the
 * wild. Returns a finite number or `null`.
 */
function toNumber(v: unknown): number | null {
	if (finite(v)) return v;
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

/** Toggles were stored as booleans (`event.target.checked`); accept "true"/"false" defensively. */
function toBool(v: unknown): boolean | undefined {
	if (typeof v === "boolean") return v;
	if (v === "true") return true;
	if (v === "false") return false;
	return undefined;
}

/** `targetElo = 1320 + (elo-1) * (3190-1320)/19`, rounded to 10; `null` for a non-number. */
export function legacyEloToTargetElo(elo: unknown): number | null {
	const value = toNumber(elo);
	if (value === null) return null;
	const level = clamp(value, LEGACY_ELO_MIN, LEGACY_ELO_MAX);
	const span = LIMITS.engineEloMax - LIMITS.engineEloMin;
	const raw =
		LIMITS.engineEloMin + ((level - LEGACY_ELO_MIN) * span) / (LEGACY_ELO_MAX - LEGACY_ELO_MIN);
	return Math.round(raw / 10) * 10;
}

/**
 * `maxWaitTime` (s) → `timing.speedScale`: the ratio to the legacy default,
 * clamped to ±0.5 log units so users keep roughly their previous pace
 * (Task 16's migration rule), rounded to 2 decimals. `null` for a non-number.
 */
export function legacyMaxWaitToSpeedScale(maxWaitTime: unknown): number | null {
	const value = toNumber(maxWaitTime);
	if (value === null) return null;
	const ratio = Math.max(value, MIN_LEGACY_WAIT_S) / LEGACY_DEFAULT_MAX_WAIT_S;
	const offset = clamp(Math.log(ratio), -SPEED_LOG_CLAMP, SPEED_LOG_CLAMP);
	return Math.round(Math.exp(offset) * 100) / 100;
}

/**
 * Legacy keybinds were stored as `KeyboardEvent.code` (popup capture), but
 * `background.js` seeded the bare defaults `"A"` / `"W"`, so a single letter
 * or digit is normalised to its `Key*` / `Digit*` code. `key` is derived, no
 * modifiers.
 */
export function legacyCodeToKeybind(raw: unknown): Keybind | null {
	if (typeof raw !== "string" || raw === "") return null;
	let code = raw;
	if (/^[A-Za-z]$/.test(raw)) code = `Key${raw.toUpperCase()}`;
	else if (/^\d$/.test(raw)) code = `Digit${raw}`;
	let key = code;
	if (code === "Space") key = " ";
	else if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase();
	else if (/^Digit\d$/.test(code)) key = code.slice(5);
	return { key, code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
}

function buildLegacyPatch(legacy: Record<string, unknown>): SettingsPatch {
	const patch: SettingsPatch = {};
	const enabled = toBool(legacy.extensionActive);
	if (enabled !== undefined) patch.enabled = enabled;

	const targetElo = legacyEloToTargetElo(legacy.elo);
	if (targetElo !== null) patch.strength = { targetElo };

	const depthCap = toNumber(legacy.depthValue);
	if (depthCap !== null) patch.engine = { depthCap };

	const speedScale = legacyMaxWaitToSpeedScale(legacy.maxWaitTime);
	if (speedScale !== null) patch.timing = { speedScale };

	const automation: SettingsPatch["automation"] = {};
	const highlight = toBool(legacy.highlightMoves);
	if (highlight !== undefined) automation.highlightMoves = highlight;
	const autoMove = toBool(legacy.automove);
	if (autoMove !== undefined) automation.autoMove = autoMove;
	const autoQueue = toBool(legacy.autoPlayNewGame);
	if (autoQueue !== undefined) automation.autoQueue = autoQueue;
	if (Object.keys(automation).length > 0) patch.automation = automation;

	const keybinds: SettingsPatch["keybinds"] = {};
	const playMove = legacyCodeToKeybind(legacy.moveKeybind);
	if (playMove) keybinds.playMove = playMove;
	const disable = legacyCodeToKeybind(legacy.exitKeybind);
	if (disable) keybinds.disable = disable;
	const speakMove = legacyCodeToKeybind(legacy.ttsKeybind);
	if (speakMove) keybinds.speakMove = speakMove;
	if (Object.keys(keybinds).length > 0) patch.keybinds = keybinds;

	return patch;
}

export interface MigrationResult {
	/** `true` when at least one legacy key was present (and has now been removed). */
	migrated: boolean;
	/** `true` when a non-empty legacy `key` was written to `LOCAL_KEYS.licenseKey`. */
	keyImported: boolean;
	settings: Settings | null;
}

/** Read the 1.x keys once, merge them into `Settings` / the license key, remove them. */
export async function migrateLegacySettings(): Promise<MigrationResult> {
	const legacy = await chromeLocalGetRaw(LEGACY_KEYS);
	const present = LEGACY_KEYS.filter((k) => legacy[k] !== undefined);
	if (present.length === 0) return { migrated: false, keyImported: false, settings: null };

	const settings = await setSettings(buildLegacyPatch(legacy));
	const importedKey = typeof legacy.key === "string" ? legacy.key.trim() : "";
	const keyImported = importedKey !== "";
	if (keyImported) await setLicenseKey(importedKey);
	await chromeLocalRemoveRaw(present);
	log.info("lifecycle: migrated legacy settings", { keys: present, keyImported });
	return { migrated: true, keyImported, settings };
}

// ---------------------------------------------------------------------------
// Lifecycle wiring
// ---------------------------------------------------------------------------

export type AlarmHandler = () => void | Promise<void>;

export interface ServiceLifecycle {
	/** Replace the handler for one `ALARM_NAMES` entry (later tasks register theirs). */
	setAlarmHandler(name: AlarmName, handler: AlarmHandler): void;
	dispose(): void;
}

export interface LifecycleOptions {
	systems: ServiceSystems;
	now?: () => number;
	/**
	 * §12.2 site version poll, carried by the licence alarm. Injectable so a test can drive
	 * that alarm without a network call; production uses `checkForUpdate`.
	 */
	updateCheck?: () => Promise<unknown>;
}

const isLegacyVersion = (version: string | undefined): boolean =>
	typeof version === "string" && /^1\./.test(version);

export function wireServiceLifecycle(options: LifecycleOptions): ServiceLifecycle {
	const { systems } = options;
	const now = options.now ?? (() => Date.now());
	const updateCheck = options.updateCheck ?? (() => checkForUpdate());
	const alarmHandlers = new Map<AlarmName, AlarmHandler>([
		[
			ALARM_NAMES.licenseRevalidate,
			async () => {
				// §12.2: one 6 h alarm carries both network checks. They are independent, so
				// neither may hide the other's failure — the update check is reported here and
				// the licence rejection is re-thrown for the dispatcher, as before.
				const [license, update] = await Promise.allSettled([
					systems.license.revalidate(),
					updateCheck(),
				]);
				if (update.status === "rejected") log.warn("lifecycle: update check failed", update.reason);
				if (license.status === "rejected") throw license.reason;
			},
		],
		[ALARM_NAMES.keepalive, () => systems.keepalive.onAlarm()],
		[ALARM_NAMES.timingLogFlush, () => log.debug("lifecycle: timing-log flush (no handler yet)")],
	]);

	async function handleInstalled(details: chrome.runtime.InstalledDetails): Promise<void> {
		log.info("lifecycle: onInstalled", {
			reason: details.reason,
			previousVersion: details.previousVersion ?? null,
		});
		let keyImported = false;
		if (details.reason === "install") {
			await chromeLocalSet(LOCAL_KEYS.installedAt, now());
			await setSettings({});
		} else if (details.reason === "update" && isLegacyVersion(details.previousVersion)) {
			keyImported = (await migrateLegacySettings()).keyImported;
		}
		// `ensure()` may already be in flight from SW boot with the pre-migration (empty)
		// key: wait for it, then validate the imported key so the user is not shown
		// `rawStatus: "invalid"` (or locked out when enforcing) until the 6 h alarm.
		await systems.license.ensure();
		if (keyImported) await systems.license.revalidate();
	}

	async function handleCommand(command: string): Promise<void> {
		const registry = systems.sessions;
		if (!registry) {
			log.info("lifecycle: command ignored (no session registry yet)", { command });
			return;
		}
		const session = await registry.forActiveTab();
		if (!session) {
			log.debug("lifecycle: command with no session on the active tab", { command });
			return;
		}
		await session.onCommand(command);
	}

	const unsubscribes = [
		onRuntimeInstalled((details) => {
			void handleInstalled(details).catch((error: unknown) =>
				log.warn("lifecycle: onInstalled failed", error)
			);
		}),
		onRuntimeStartup(() => {
			log.info("lifecycle: onStartup");
			void systems.license
				.ensure()
				.catch((error: unknown) => log.warn("lifecycle: startup license check failed", error));
		}),
		onAlarm((alarm) => {
			const handler = alarmHandlers.get(alarm.name as AlarmName);
			if (!handler) {
				log.debug("lifecycle: unknown alarm", { name: alarm.name });
				return;
			}
			void Promise.resolve()
				.then(handler)
				.catch((error: unknown) =>
					log.warn("lifecycle: alarm handler failed", { name: alarm.name, error })
				);
		}),
		onCommand((command) => {
			void handleCommand(command).catch((error: unknown) =>
				log.warn("lifecycle: command failed", { command, error })
			);
		}),
	];

	return {
		setAlarmHandler(name, handler) {
			alarmHandlers.set(name, handler);
		},
		dispose() {
			for (const off of unsubscribes) off();
			unsubscribes.length = 0;
		},
	};
}
