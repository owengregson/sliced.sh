/**
 * License gate (§3.6). `ensure()` loads `LOCAL_KEYS.licenseState`, validates
 * the stored key (empty string when none) through a `LicenseClient`, and
 * persists `{ status, rawStatus, checkedAt, expiresAt?, message? }` where
 * `status = forceValid ? "valid" : rawStatus`. `rawStatus` always carries the
 * endpoint's real verdict for diagnostics. When enforcing, a network error
 * never overwrites a previously valid state (network errors never lock the
 * user out). The 6 h revalidation alarm is armed here; the lifecycle's alarm
 * dispatcher calls `revalidate()` when it fires.
 */

import type { LicenseClient, LicenseResult } from "@core/auth/license-client";
import { PhantomLicenseClient } from "@core/auth/phantom-license-client";
import { alarmCreate, alarmGet } from "@core/chrome/alarms";
import { ALARM_CADENCE_MINUTES, ALARM_NAMES } from "@core/constants/alarms";
import { LICENSE_FORCE_VALID } from "@core/constants/limits";
import { log } from "@core/logger";
import {
	clearLicenseKey,
	getLicenseKey,
	getLicenseState,
	setLicenseKey,
	setLicenseState,
	UNKNOWN_LICENSE_STATE,
} from "@core/storage/license-storage";
import { dedupeAsync } from "@core/util/dedupe-async";
import { errorMessage } from "@core/util/errors";
import type { LicenseState } from "@typedefs/settings";

export interface LicenseGateOptions {
	client?: LicenseClient;
	/** Defaults to `LICENSE_FORCE_VALID`; injectable so tests can exercise real gating. */
	forceValid?: boolean;
	now?: () => number;
}

export class LicenseGate {
	private readonly client: LicenseClient;
	private readonly forceValid: boolean;
	private readonly now: () => number;
	private state: LicenseState = { ...UNKNOWN_LICENSE_STATE };
	private ensured: Promise<LicenseState> | null = null;
	private readonly revalidateDeduped: () => Promise<LicenseState>;

	constructor(options: LicenseGateOptions = {}) {
		this.client = options.client ?? new PhantomLicenseClient();
		this.forceValid = options.forceValid ?? LICENSE_FORCE_VALID;
		this.now = options.now ?? (() => Date.now());
		this.revalidateDeduped = dedupeAsync(() => this.validateAndStore());
	}

	/** Load the persisted state and validate once per gate instance (concurrent callers share). */
	ensure(): Promise<LicenseState> {
		if (!this.ensured) {
			this.ensured = this.revalidate().catch((error: unknown) => {
				this.ensured = null; // let a later call retry
				throw error;
			});
		}
		return this.ensured;
	}

	/** Validate now (deduped while in flight) and persist the result. */
	revalidate(): Promise<LicenseState> {
		return this.revalidateDeduped();
	}

	async login(key: string): Promise<LicenseState> {
		await setLicenseKey(key);
		return this.revalidate();
	}

	async logout(): Promise<LicenseState> {
		await clearLicenseKey();
		return this.revalidate();
	}

	isUnlocked(): boolean {
		return this.state.status === "valid";
	}

	getState(): LicenseState {
		return { ...this.state };
	}

	dispose(): void {
		this.ensured = null;
	}

	private async validateAndStore(): Promise<LicenseState> {
		const previous = await getLicenseState();
		this.state = previous;
		const key = (await getLicenseKey()) ?? "";
		let result: LicenseResult;
		try {
			result = await this.client.validate(key);
		} catch (error) {
			result = { status: "network_error", message: errorMessage(error) };
		}
		const next = this.nextState(previous, result);
		await setLicenseState(next);
		this.state = next;
		await this.ensureAlarm();
		log.info("license: validated", { status: next.status, rawStatus: next.rawStatus });
		return next;
	}

	private nextState(previous: LicenseState, result: LicenseResult): LicenseState {
		const rawStatus = result.status;
		if (!this.forceValid && rawStatus === "network_error" && previous.status === "valid") {
			// Keep the last good verdict; only annotate the failed check.
			const kept: LicenseState = { ...previous, rawStatus };
			if (result.message !== undefined) kept.message = result.message;
			else delete kept.message;
			return kept;
		}
		const next: LicenseState = {
			status: this.forceValid ? "valid" : rawStatus,
			rawStatus,
			checkedAt: this.now(),
		};
		if (result.expiresAt !== undefined) next.expiresAt = result.expiresAt;
		if (result.message !== undefined) next.message = result.message;
		return next;
	}

	private async ensureAlarm(): Promise<void> {
		try {
			if (await alarmGet(ALARM_NAMES.licenseRevalidate)) return;
			await alarmCreate(ALARM_NAMES.licenseRevalidate, {
				periodInMinutes: ALARM_CADENCE_MINUTES.licenseRevalidate,
			});
		} catch (error) {
			log.warn("license: could not arm the revalidation alarm", error);
		}
	}
}
