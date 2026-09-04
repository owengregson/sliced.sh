/** `LicenseState` and license-key persistence over `LOCAL_KEYS` (§3.6). */

import { chromeLocalGet, chromeLocalRemove, chromeLocalSet } from "@core/chrome/storage";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import type { LicenseState } from "@typedefs/settings";

export const UNKNOWN_LICENSE_STATE: Readonly<LicenseState> = Object.freeze({
	status: "unknown",
	checkedAt: 0,
});

export async function getLicenseState(): Promise<LicenseState> {
	return (await chromeLocalGet(LOCAL_KEYS.licenseState)) ?? { ...UNKNOWN_LICENSE_STATE };
}

export function setLicenseState(state: LicenseState): Promise<void> {
	return chromeLocalSet(LOCAL_KEYS.licenseState, state);
}

export function getLicenseKey(): Promise<string | null> {
	return chromeLocalGet(LOCAL_KEYS.licenseKey);
}

export function setLicenseKey(key: string): Promise<void> {
	return chromeLocalSet(LOCAL_KEYS.licenseKey, key);
}

export function clearLicenseKey(): Promise<void> {
	return chromeLocalRemove(LOCAL_KEYS.licenseKey);
}
