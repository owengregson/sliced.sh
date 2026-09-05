/**
 * View 1 — Login (Appendix F §4.1, §7.2). A projection of `snapshot.license` plus local UI state
 * (loading, reveal, the last `PANEL_LOGIN` reply until the next snapshot reflects it). The key
 * input auto-formats `SL-XXXX-XXXX-XXXX`; a pasted full key submits after `duration.6`; Enter and
 * Continue submit; the button keeps its width while loading. With `LICENSE_FORCE_VALID` any key —
 * including none — is sent (the SW unlocks regardless; the Engine view shows the raw verdict).
 * The view never takes focus (§10.4).
 */

import { LICENSE_FORCE_VALID, LIMITS } from "@core/constants/limits";
import { MSG } from "@core/constants/messages";
import { log } from "@core/logger";
import { errorMessage } from "@core/util/errors";
import type { LicenseState } from "@typedefs/settings";
import type { UrlKey } from "../actions";
import { ANIM } from "../animation-manager";
import { type ButtonHandle, createButton } from "../components/button";
import { createInput } from "../components/input";
import { COPY } from "../copy";
import { formatDate } from "../format";
import { mountIcons } from "../icons-mount";
import { instantiate, part } from "../template";
import type { View } from "../view";
import { caretAfterFormat, formatLicenseKey, isCompleteLicenseKey } from "./license-key";
import { mountMark } from "./mark";
import html from "./templates/login.html?raw";

interface HintState {
	hint: string;
	invalid: string | null;
	button: string;
	extra: { label: string; url: UrlKey } | null;
}

const UNKNOWN: LicenseState = { status: "unknown", checkedAt: 0 };

/** §4.1 inline states / §7.2 copy for every `LicenseState.status`. */
export function loginHintFor(license: LicenseState): HintState {
	const base: HintState = {
		hint: COPY.login.hint,
		invalid: null,
		button: COPY.login.button,
		extra: null,
	};
	switch (license.status) {
		case "invalid":
			return { ...base, invalid: COPY.login.invalid };
		case "ip_limit":
			return {
				...base,
				hint: COPY.login.deviceLimit(LIMITS.licenseMaxDevices),
				extra: { label: COPY.loginView.manageDevices, url: "website" },
			};
		case "network_error":
			return { ...base, hint: COPY.login.offline, button: COPY.loginView.tryAgain };
		case "expired":
			return {
				...base,
				hint:
					license.expiresAt === undefined
						? COPY.loginView.expiredNoDate
						: COPY.login.expired(formatDate(license.expiresAt)),
				extra: { label: COPY.loginView.renew, url: "website" },
			};
		default:
			return base;
	}
}

export const loginView: View = {
	mount(ctx) {
		const el = instantiate(html);
		const form = part<HTMLFormElement>(el, ".sl-login__form");
		const extraHost = part(el, ".sl-login__extra");
		part(el, ".sl-login__wordmark").textContent = COPY.login.title;
		part(el, ".sl-login__tagline").textContent = COPY.login.subtitle;
		part(el, ".sl-login__link-text").textContent = COPY.login.link;
		part(el, ".sl-login__link-button").setAttribute("aria-label", COPY.brand.product);
		part(el, ".sl-login__version").textContent = COPY.loginView.version(__SL_VERSION__);
		const unmountMark = mountMark(part<HTMLImageElement>(el, ".sl-login__mark"));

		let license: LicenseState = ctx.snapshot?.license ?? UNKNOWN;
		/** The `PANEL_LOGIN` reply, shown until the next snapshot carries it. */
		let reply: LicenseState | null = null;
		let loading = false;
		let masked = false;
		let pasted = false;
		let pasteFlagTimer: ReturnType<typeof setTimeout> | null = null;
		let pasteSubmitTimer: ReturnType<typeof setTimeout> | null = null;
		let extraButton: ButtonHandle | null = null;
		let extraKey: string | null = null;
		/** The field's value after the last format pass (shrinking edits never re-add separators). */
		let lastValue = "";

		const clearTimer = (timer: ReturnType<typeof setTimeout> | null): null => {
			if (timer !== null) clearTimeout(timer);
			return null;
		};

		const revealTrailing = (): { icon: "action.hide" | "action.reveal"; label: string } =>
			masked
				? { icon: "action.reveal", label: COPY.login.reveal }
				: { icon: "action.hide", label: COPY.login.hide };

		const input = createInput(part(el, ".sl-login__field"), {
			label: COPY.login.fieldLabel,
			placeholder: COPY.loginView.placeholder,
			size: "lg",
			mono: true,
			hint: COPY.login.hint,
			trailing: {
				...revealTrailing(),
				onClick: () => {
					masked = !masked;
					input.update({ type: masked ? "password" : "text", trailing: revealTrailing() });
				},
			},
			onInput: (value) => {
				const formatted = formatLicenseKey(value, lastValue);
				if (formatted !== value) {
					const caret = input.input.selectionStart;
					input.update({ value: formatted });
					if (caret !== null) {
						// A dropped edit (prefix typed into a prefixed field) leaves the caret where it was.
						const next =
							formatted === lastValue
								? Math.max(0, caret - (value.length - lastValue.length))
								: caretAfterFormat(value, caret, formatted);
						input.input.setSelectionRange(next, next);
					}
				}
				lastValue = formatted;
				pasteSubmitTimer = clearTimer(pasteSubmitTimer);
				if (!pasted) return;
				pasted = false;
				pasteFlagTimer = clearTimer(pasteFlagTimer);
				if (isCompleteLicenseKey(formatted))
					pasteSubmitTimer = setTimeout(() => {
						pasteSubmitTimer = null;
						submit();
					}, ANIM.duration[6]);
			},
			onSubmit: () => submit(),
		});
		const submitButton = createButton(part(el, ".sl-login__submit"), {
			label: COPY.login.button,
			variant: "primary",
			size: "lg",
			block: true,
			onClick: () => submit(),
		});

		// The paste itself arrives as the next `input` event; the flag is dropped if none follows.
		const onPaste = (): void => {
			pasted = true;
			pasteFlagTimer = clearTimer(pasteFlagTimer);
			pasteFlagTimer = setTimeout(() => {
				pasteFlagTimer = null;
				pasted = false;
			}, 0);
		};
		const onFormSubmit = (event: Event): void => {
			event.preventDefault();
			submit();
		};
		input.input.addEventListener("paste", onPaste);
		form.addEventListener("submit", onFormSubmit);

		function render(): void {
			const state = loginHintFor(reply ?? license);
			input.update(state.invalid ? { invalid: state.invalid } : { invalid: null, hint: state.hint });
			if (!loading) submitButton.update({ label: state.button });
			const key = state.extra ? `${state.extra.label}:${state.extra.url}` : null;
			if (key !== extraKey) {
				extraKey = key;
				extraButton?.dispose();
				extraButton = null;
				if (state.extra) {
					extraButton = createButton(extraHost, {
						label: state.extra.label,
						variant: "ghost",
						size: "sm",
						icon: "action.external",
					});
					extraButton.el.dataset.action = "open-url";
					extraButton.el.dataset.url = state.extra.url;
				}
			}
			extraHost.hidden = !state.extra;
		}

		function finish(next: LicenseState): void {
			if (ctx.signal.aborted) return;
			loading = false;
			reply = next;
			submitButton.update({ loading: null, disabled: false });
			render();
		}

		function submit(): void {
			if (loading) return;
			const key = input.value;
			if (!LICENSE_FORCE_VALID && !isCompleteLicenseKey(key)) {
				input.update({ invalid: COPY.login.invalid });
				return;
			}
			pasteSubmitTimer = clearTimer(pasteSubmitTimer);
			loading = true;
			submitButton.update({ loading: COPY.login.loading, disabled: true });
			ctx.store.dispatch({ type: MSG.PANEL_LOGIN, key }).then(
				(state) => finish(state),
				(error: unknown) => {
					log.warn("login: PANEL_LOGIN failed", { error });
					finish({ status: "network_error", checkedAt: Date.now(), message: errorMessage(error) });
				}
			);
		}

		const unsubscribe = ctx.store.subscribe((snapshot) => {
			license = snapshot.license;
			reply = null;
			render();
		});
		render();
		mountIcons(el);
		ctx.container.append(el);

		return () => {
			unsubscribe();
			pasteFlagTimer = clearTimer(pasteFlagTimer);
			pasteSubmitTimer = clearTimer(pasteSubmitTimer);
			input.input.removeEventListener("paste", onPaste);
			form.removeEventListener("submit", onFormSubmit);
			extraButton?.dispose();
			submitButton.dispose();
			input.dispose();
			unmountMark();
			el.remove();
		};
	},
};
