/** The licence verdict as stored and shown (§3.6). */

export interface LicenseState {
	status: "unknown" | "valid" | "invalid" | "ip_limit" | "expired" | "network_error";
	/** V2: the endpoint's real verdict when LICENSE_FORCE_VALID. */
	rawStatus?: LicenseState["status"];
	checkedAt: number;
	expiresAt?: number;
	message?: string;
}
