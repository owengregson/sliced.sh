/** The Account section: the (masked, briefly revealable) license key, plan, device and actions. */

import { MSG } from "@core/constants/messages";
import { UI_TIMINGS } from "@core/constants/ui";
import { log } from "@core/logger";
import type { LicenseState } from "@typedefs/settings";
import { createButton } from "../../components/button";
import { COPY, SETTINGS_COPY } from "../../copy";
import { maskLicenseKey } from "../../format";
import type { PanelStore } from "../../store";
import { instantiate, part } from "../../template";
import licenseHtml from "../templates/settings/license.html?raw";
import valueHtml from "../templates/settings/value.html?raw";
import type { Confirm } from "./confirm";
import { newRow } from "./row-control";
import type { SectionParts } from "./section-parts";

/** The plan's renewal date, in the viewer's own time zone. */
function formatDate(ms: number): string {
	return new Date(ms).toLocaleDateString("en-GB", {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

export function planText(license: LicenseState): string {
	if (license.status !== "valid") return SETTINGS_COPY.account.planInactive;
	return license.expiresAt
		? SETTINGS_COPY.account.plan(formatDate(license.expiresAt))
		: SETTINGS_COPY.account.planNoExpiry;
}

export function deviceText(): string {
	const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
	const chrome = /Chrome\/(\d+)/.exec(ua);
	const platform = /\(([^;)]+)/.exec(ua);
	return SETTINGS_COPY.account.device(
		platform?.[1]?.trim() || SETTINGS_COPY.account.platformUnknown,
		chrome?.[1] ? SETTINGS_COPY.account.browser(chrome[1]) : SETTINGS_COPY.account.browserUnknown
	);
}

export interface AccountDeps {
	store: PanelStore;
	signal: AbortSignal;
	getLicenseKey(): Promise<string | null>;
	license(): LicenseState;
	confirm: Confirm;
}

export function buildAccount(rows: HTMLElement, deps: AccountDeps, parts: SectionParts): void {
	const { buttons, disposers, refreshers } = parts;
	const licenseRow = newRow({ label: COPY.account.license });
	licenseRow.el.dataset.row = "license";
	const licenseEl = instantiate(licenseHtml);
	const keyEl = part(licenseEl, ".sl-settings-license__key");
	keyEl.textContent = SETTINGS_COPY.account.noKey;
	licenseRow.control.append(licenseEl);
	let key: string | null = null;
	let revealed = false;
	let revealTimer: ReturnType<typeof setTimeout> | null = null;
	const clearReveal = (): void => {
		if (revealTimer !== null) {
			clearTimeout(revealTimer);
			revealTimer = null;
		}
	};
	const renderKey = (): void => {
		keyEl.textContent = key ? (revealed ? key : maskLicenseKey(key)) : SETTINGS_COPY.account.noKey;
		reveal.update({
			icon: revealed ? "action.hide" : "action.reveal",
			ariaLabel: revealed ? COPY.login.hide : COPY.login.reveal,
		});
	};
	const reveal = createButton(licenseEl, {
		label: "",
		variant: "ghost",
		size: "sm",
		icon: "action.reveal",
		ariaLabel: COPY.login.reveal,
		onClick: () => {
			if (!key) return;
			clearReveal();
			revealed = !revealed;
			if (revealed)
				revealTimer = setTimeout(() => {
					revealTimer = null;
					revealed = false;
					renderKey();
				}, UI_TIMINGS.licenseRevealMs);
			renderKey();
		},
	});
	reveal.el.classList.add("sl-settings-license__reveal");
	buttons.push(reveal);
	disposers.push(clearReveal);
	deps
		.getLicenseKey()
		.then((k) => {
			if (deps.signal.aborted) return;
			key = k;
			renderKey();
		})
		.catch((error: unknown) => log.debug("settings: license key read failed", error));
	rows.append(licenseRow.el);

	const planRow = newRow({ label: COPY.account.plan });
	planRow.el.dataset.row = "plan";
	const planValue = instantiate(valueHtml);
	planRow.control.append(planValue);
	rows.append(planRow.el);
	refreshers.push(() => {
		planValue.textContent = planText(deps.license());
	});

	const deviceRow = newRow({ label: COPY.account.device });
	deviceRow.el.dataset.row = "device";
	const deviceValue = instantiate(valueHtml);
	deviceValue.textContent = deviceText();
	deviceRow.control.append(deviceValue);
	rows.append(deviceRow.el);

	const actions = document.createElement("div");
	actions.className = "sl-row sl-settings-account__actions";
	const manage = createButton(actions, {
		label: SETTINGS_COPY.account.manageDevices,
		variant: "ghost",
		size: "sm",
		icon: "action.external",
	});
	manage.el.classList.add("sl-settings-account__manage");
	manage.el.dataset.action = "open-url";
	manage.el.dataset.url = "website";
	const signOut = createButton(actions, {
		label: COPY.account.signOut,
		variant: "ghost",
		dangerText: true,
		size: "sm",
		onClick: () =>
			deps.confirm(signOut.el, COPY.account.signOutConfirm, COPY.account.signOut, () => {
				deps.store
					.dispatch({ type: MSG.PANEL_LOGOUT })
					.catch((error: unknown) => log.warn("settings: sign out failed", error));
			}),
	});
	signOut.el.classList.add("sl-settings-account__signout");
	buttons.push(manage, signOut);
	rows.append(actions);
}
