/**
 * Chrome lifecycle wiring for the service worker: `runtime.onInstalled`
 * (first-install defaults, the §12.3 legacy migration on update from 1.x),
 * `runtime.onStartup`, the `alarms.onAlarm` dispatcher keyed by
 * `ALARM_NAMES`, and `commands.onCommand` forwarded to the active tab's
 * game session. Every listener is registered synchronously by
 * `wireServiceLifecycle`; the async work lives inside the handlers.
 *
 * The migration itself lives in `lifecycle/legacy-migration.ts`.
 */

import { onAlarm } from "@core/chrome/alarms";
import { onCommand } from "@core/chrome/commands";
import { onRuntimeInstalled, onRuntimeStartup } from "@core/chrome/runtime";
import { chromeLocalSet } from "@core/chrome/storage";
import { ALARM_NAMES, type AlarmName } from "@core/constants/alarms";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { log } from "@core/logger";
import { setSettings } from "@core/storage/settings-storage";
import type { ServiceSystems } from "@service/bootstrap";
import { migrateLegacySettings } from "@service/lifecycle/legacy-migration";
import { checkForUpdate } from "@service/update-check";

export {
	LEGACY_KEYS,
	legacyCodeToKeybind,
	legacyEloToTargetElo,
	legacyMaxWaitToBaseSpeed,
	type MigrationResult,
	migrateLegacySettings,
} from "@service/lifecycle/legacy-migration";

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
