/** License validation contract (§3.6). `PhantomLicenseClient` is the default implementation. */

export type LicenseVerdict = "valid" | "invalid" | "ip_limit" | "network_error";

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
