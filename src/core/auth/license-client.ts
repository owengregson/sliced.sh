/** License validation contract (§3.6). `PhantomLicenseClient` is the default implementation. */

import type { LicenseState } from "@typedefs/settings";

/** What the endpoint can say — `LicenseState` adds the gate-only `unknown` / `expired`. */
export type LicenseVerdict = Exclude<LicenseState["status"], "unknown" | "expired">;

export interface LicenseResult {
	status: LicenseVerdict;
	/** ms epoch, when the endpoint reports one. */
	expiresAt?: number;
	/** Diagnostic detail (error text, unexpected verdict); surfaced in `LicenseState.message`. */
	message?: string;
}

export interface LicenseClient {
	validate(key: string): Promise<LicenseResult>;
}
