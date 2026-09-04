/**
 * View 8 — License expired or invalid (Appendix F §4.9): lock icon, the expired / revoked /
 * device-limit copy variant from `snapshot.license`, Renew (shell `open-url`), Enter a different
 * key (`PANEL_LOGOUT`), Check again (`PANEL_RECHECK_LICENSE`) and the masked stored key.
 */

import { LIMITS } from "@core/constants/limits";
import { MSG } from "@core/constants/messages";
import { log } from "@core/logger";
import { getLicenseKey } from "@core/storage/license-storage";
import type { LicenseState } from "@typedefs/settings";
import { createButton } from "../components/button";
import { createEmptyState } from "../components/empty-state";
import { COPY } from "../copy";
import { formatDate, maskLicenseKey } from "../format";
import { instantiate, part } from "../template";
import type { View } from "../view";
import html from "./templates/expired.html?raw";

/** Title/body per `LicenseState` (invalid = revoked; anything else reads as revoked too). */
export function expiredCopyFor(license: LicenseState): { title: string; body: string } {
	switch (license.status) {
		case "expired":
			return {
				title: COPY.expired.title,
				body:
					license.expiresAt === undefined
						? COPY.expiredView.bodyNoDate
						: COPY.expired.body(formatDate(license.expiresAt)),
			};
		case "ip_limit":
			return {
				title: COPY.expired.ipLimitTitle,
				body: COPY.login.deviceLimit(LIMITS.licenseMaxDevices),
			};
		default:
			return { title: COPY.expired.revokedTitle, body: COPY.expired.revokedBody };
	}
}

export const expiredView: View = {
	mount(ctx) {
		const el = instantiate(html);
		const signedIn = part(el, ".sl-expired__signed-in");
		const dispatch = (type: typeof MSG.PANEL_LOGOUT | typeof MSG.PANEL_RECHECK_LICENSE): void => {
			ctx.store
				.dispatch({ type })
				.catch((error: unknown) => log.warn("expired: dispatch failed", { type, error }));
		};

		const empty = createEmptyState(part(el, ".sl-expired__card"), {
			icon: "feedback.locked",
			title: COPY.expired.revokedTitle,
			body: COPY.expired.revokedBody,
			actions: [
				{ label: COPY.expired.renew, variant: "primary", size: "lg", icon: "action.external" },
				{
					label: COPY.expired.differentKey,
					variant: "ghost",
					onClick: () => dispatch(MSG.PANEL_LOGOUT),
				},
			],
		});
		const renew = part(empty.el, ".sl-empty__actions .sl-button");
		renew.dataset.action = "open-url";
		renew.dataset.url = "website";
		const recheck = createButton(part(el, ".sl-expired__recheck"), {
			label: COPY.expiredView.recheck,
			variant: "ghost",
			size: "sm",
			icon: "action.refresh",
			onClick: () => dispatch(MSG.PANEL_RECHECK_LICENSE),
		});

		const unsubscribe = ctx.store.subscribe((snapshot) =>
			empty.update(expiredCopyFor(snapshot.license))
		);
		getLicenseKey().then(
			(key) => {
				if (ctx.signal.aborted || !key) return;
				signedIn.textContent = COPY.expiredView.signedIn(maskLicenseKey(key));
				signedIn.hidden = false;
			},
			(error: unknown) => log.debug("expired: license key read failed", { error })
		);
		ctx.container.append(el);

		return () => {
			unsubscribe();
			recheck.dispose();
			empty.dispose();
			el.remove();
		};
	},
};
