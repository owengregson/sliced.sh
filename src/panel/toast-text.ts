/**
 * Port toasts → copy (Task 28): the service worker names a toast by `TOAST_KEYS` key; the
 * text — and the input-method wording, which is always a drag — is resolved here, on the panel
 * side only.
 */

import type { PanelToast } from "@core/constants/messages";
import { TOAST_KEYS } from "@core/constants/toasts";
import { COPY } from "./copy";

const MS = 1000;

export function portToastText(toast: PanelToast): string {
	switch (toast.key) {
		case TOAST_KEYS.played: {
			const { san, elapsedMs } = toast.args;
			return COPY.toast.played(san, (elapsedMs / MS).toFixed(1), COPY.execution.drag);
		}
		case TOAST_KEYS.notVerified:
			return COPY.toast.notVerified;
		case TOAST_KEYS.reattached:
			return COPY.toast.reattached;
	}
}
