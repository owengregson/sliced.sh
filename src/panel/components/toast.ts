/**
 * Toast (Appendix F §5.11): one visible at a time, a newer one replaces the older. Success and
 * info last `UI_TIMINGS.toastShortMs`, warn and danger `toastLongMs` (with an optional action).
 * `role="status"` for success/info, `role="alert"` for warn/danger. The layer is mounted by the
 * shell (`mountToastLayer`); the queue is cleared on every view change (§3.3).
 */

import { UI_TIMINGS } from "@core/constants/ui";
import type { IconName } from "@design/icons";
import { ANIM } from "../animation-manager";
import { applyIcon } from "../icons-mount";
import { instantiate, part } from "../template";
import html from "../views/templates/components/toast.html?raw";
import { createButton } from "./button";

export type ToastKind = "success" | "info" | "warn" | "danger";

export interface ToastAction {
	label: string;
	onClick: () => void;
}

export interface ToastHandle {
	readonly el: HTMLElement;
	readonly visible: boolean;
	dismiss(): void;
}

const ICON: Readonly<Record<ToastKind, IconName>> = {
	success: "feedback.success",
	info: "feedback.info",
	warn: "feedback.warning",
	danger: "feedback.danger",
};

let layer: HTMLElement | null = null;
let current: { handle: ToastHandle; hide: () => void } | null = null;

/** Register the element toasts render into (the shell's `.sl-app__toasts`). */
export function mountToastLayer(el: HTMLElement): () => void {
	layer = el;
	el.classList.add("sl-toast-layer");
	return () => {
		clearToasts();
		if (layer === el) layer = null;
	};
}

function target(): HTMLElement {
	if (layer) return layer;
	const fallback = document.createElement("div");
	fallback.className = "sl-toast-layer";
	document.body.append(fallback);
	layer = fallback;
	return fallback;
}

export function durationFor(kind: ToastKind): number {
	return kind === "success" || kind === "info" ? UI_TIMINGS.toastShortMs : UI_TIMINGS.toastLongMs;
}

export function showToast(kind: ToastKind, text: string, action?: ToastAction): ToastHandle {
	current?.hide();
	const el = instantiate(html);
	el.classList.add(`sl-toast--${kind}`);
	el.setAttribute("role", kind === "warn" || kind === "danger" ? "alert" : "status");
	applyIcon(part(el, ".sl-toast__icon"), ICON[kind]);
	part(el, ".sl-toast__text").textContent = text;
	const actionHost = part(el, ".sl-toast__action");
	let visible = true;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let button: ReturnType<typeof createButton> | null = null;

	function hide(): void {
		if (!visible) return;
		visible = false;
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		if (current?.handle === handle) current = null;
		void ANIM.fade(el, "out").then(() => {
			button?.dispose();
			el.remove();
		});
	}

	const handle: ToastHandle = {
		el,
		get visible() {
			return visible;
		},
		dismiss: hide,
	};

	if (action) {
		button = createButton(actionHost, {
			label: action.label,
			variant: "ghost",
			size: "sm",
			onClick: () => {
				action.onClick();
				hide();
			},
		});
		actionHost.hidden = false;
	}

	target().append(el);
	void ANIM.popIn(el);
	timer = setTimeout(hide, durationFor(kind));
	current = { handle, hide };
	return handle;
}

/** Dismiss whatever is showing (view change). */
export function clearToasts(): void {
	current?.hide();
	current = null;
}
