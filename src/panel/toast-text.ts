/**
 * Port toasts → copy (Task 28): the service worker names a toast by `TOAST_KEYS` key; the
 * text — and the drag/click wording — is resolved here, on the panel side only.
 */

import type { PanelToast } from "@core/constants/messages";
import { TOAST_KEYS } from "@core/constants/toasts";
import { COPY } from "./copy";

const MS = 1000;

export function portToastText(toast: PanelToast): string {
	switch (toast.key) {
		case TOAST_KEYS.played: {
			const { san, elapsedMs, tier } = toast.args;
			const method = tier === "click" ? COPY.execution.click : COPY.execution.drag;
			return COPY.toast.played(san, (elapsedMs / MS).toFixed(1), method);
		}
		case TOAST_KEYS.notVerified:
			return COPY.toast.notVerified;
		case TOAST_KEYS.reattached:
			return COPY.toast.reattached;
	}
}
