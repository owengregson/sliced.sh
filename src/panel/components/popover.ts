/**
 * Popover (Appendix F §5.12): anchored to its trigger, flips vertically when there is no room,
 * traps Tab inside while open (focus is only ever moved in response to the user's own Tab —
 * the panel never takes focus on its own, §10.4), Esc closes through the shared priority
 * registry (§8.3), click outside closes. `--tooltip` variant: label text, 300 ms hover delay,
 * instant on focus.
 */

import { UI_TIMINGS } from "@core/constants/ui";
import { TOKENS } from "@design/tokens.generated";
import { ANIM } from "../animation-manager";
import { mountIcons } from "../icons-mount";
import { registerEscape } from "../keys";
import { instantiate, part } from "../template";
import html from "../views/templates/components/popover.html?raw";
import tooltipHtml from "../views/templates/components/tooltip.html?raw";

export interface PopoverOptions {
	title?: string;
	footer?: string | HTMLElement;
	/** Where to append (default: the shell overlay layer or `document.body`). */
	container?: HTMLElement;
	onClose?: () => void;
}

export interface PopoverHandle {
	readonly el: HTMLElement;
	readonly open: boolean;
	close(): void;
	/** Re-run positioning (anchor moved, content resized). */
	reposition(): void;
}

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let overlayLayer: HTMLElement | null = null;
let currentPopover: PopoverHandle | null = null;
let seq = 0;

/** Register the shell's overlay layer for popovers and tooltips. */
export function mountOverlayLayer(el: HTMLElement): () => void {
	overlayLayer = el;
	el.classList.add("sl-overlay-layer");
	return () => {
		currentPopover?.close();
		if (overlayLayer === el) overlayLayer = null;
	};
}

function container(explicit?: HTMLElement): HTMLElement {
	return explicit ?? overlayLayer ?? document.body;
}

/** Place `el` under (or above, when there is no room) the anchor, clamped to the viewport. */
export function positionPopover(el: HTMLElement, anchor: HTMLElement): void {
	const a = anchor.getBoundingClientRect();
	const p = el.getBoundingClientRect();
	const viewportH = window.innerHeight || 0;
	const viewportW = window.innerWidth || 0;
	const gap = TOKENS.space[2];
	const below = a.bottom + gap;
	const flip = viewportH > 0 && below + p.height > viewportH && a.top - gap - p.height >= 0;
	const top = flip ? a.top - gap - p.height : below;
	let left = a.left + a.width / 2 - p.width / 2;
	if (viewportW > 0) left = Math.max(gap, Math.min(left, viewportW - p.width - gap));
	el.style.top = `${Math.max(0, top)}px`;
	el.style.left = `${Math.max(0, left)}px`;
	el.dataset.placement = flip ? "top" : "bottom";
	el.style.setProperty("--sl-arrow-left", `${a.left + a.width / 2 - left}px`);
}

function focusables(root: HTMLElement): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => !n.hidden);
}

export function openPopover(
	anchor: HTMLElement,
	content: HTMLElement | DocumentFragment,
	options: PopoverOptions = {}
): PopoverHandle {
	currentPopover?.close();
	const el = instantiate(html);
	const titleEl = part(el, ".sl-popover__title");
	const closeButton = part<HTMLButtonElement>(el, ".sl-popover__close");
	const body = part(el, ".sl-popover__body");
	const footer = part(el, ".sl-popover__footer");
	const header = part(el, ".sl-popover__header");
	el.id = `sl-popover-${++seq}`;
	if (options.title) titleEl.textContent = options.title;
	else header.classList.add("sl-popover__header--untitled");
	body.append(content);
	if (options.footer) {
		if (typeof options.footer === "string") footer.textContent = options.footer;
		else footer.append(options.footer);
		footer.hidden = false;
	}
	mountIcons(el);
	let open = true;

	const onKeyDown = (event: KeyboardEvent): void => {
		if (event.key !== "Tab") return;
		const items = focusables(el);
		if (items.length === 0) {
			event.preventDefault();
			return;
		}
		const first = items[0];
		const last = items[items.length - 1];
		const active = document.activeElement;
		if (!first || !last) return;
		if (event.shiftKey && (active === first || !el.contains(active))) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && (active === last || !el.contains(active))) {
			event.preventDefault();
			first.focus();
		}
	};
	const onPointerDown = (event: Event): void => {
		const t = event.target;
		if (t instanceof Node && (el.contains(t) || anchor.contains(t))) return;
		close();
	};
	const onClose = (event: MouseEvent): void => {
		event.preventDefault();
		close();
	};
	const unregisterEscape = registerEscape("popover", () => close());

	function close(): void {
		if (!open) return;
		open = false;
		el.dataset.state = "closing";
		el.removeEventListener("keydown", onKeyDown);
		document.removeEventListener("pointerdown", onPointerDown, true);
		closeButton.removeEventListener("click", onClose);
		unregisterEscape();
		anchor.setAttribute("aria-expanded", "false");
		anchor.removeAttribute("aria-controls");
		if (currentPopover === handle) currentPopover = null;
		void ANIM.scaleOut(el).then(() => el.remove());
		options.onClose?.();
	}

	const handle: PopoverHandle = {
		el,
		get open() {
			return open;
		},
		close,
		reposition: () => positionPopover(el, anchor),
	};

	el.addEventListener("keydown", onKeyDown);
	document.addEventListener("pointerdown", onPointerDown, true);
	closeButton.addEventListener("click", onClose);
	anchor.setAttribute("aria-expanded", "true");
	anchor.setAttribute("aria-controls", el.id);
	container(options.container).append(el);
	positionPopover(el, anchor);
	el.dataset.state = "open";
	void ANIM.scaleIn(el);
	currentPopover = handle;
	return handle;
}

export interface TooltipHandle {
	readonly el: HTMLElement;
	close(): void;
}

/** Show a tooltip immediately (no delay); used by `attachTooltip` and for focus. */
export function showTooltip(
	anchor: HTMLElement,
	text: string,
	containerEl?: HTMLElement
): TooltipHandle {
	const el = instantiate(tooltipHtml);
	el.id = `sl-tooltip-${++seq}`;
	el.textContent = text;
	anchor.setAttribute("aria-describedby", el.id);
	container(containerEl).append(el);
	positionPopover(el, anchor);
	el.dataset.state = "open";
	void ANIM.fade(el, "in");
	let open = true;
	return {
		el,
		close() {
			if (!open) return;
			open = false;
			if (anchor.getAttribute("aria-describedby") === el.id)
				anchor.removeAttribute("aria-describedby");
			void ANIM.fade(el, "out").then(() => el.remove());
		},
	};
}

/** Hover (300 ms delay) / focus (instant) tooltip on `anchor`; returns the detach. */
export function attachTooltip(anchor: HTMLElement, text: string): () => void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let tip: TooltipHandle | null = null;
	const show = (): void => {
		if (tip) return;
		tip = showTooltip(anchor, text);
	};
	const hide = (): void => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		tip?.close();
		tip = null;
	};
	const onEnter = (): void => {
		if (timer !== null || tip) return;
		timer = setTimeout(() => {
			timer = null;
			show();
		}, UI_TIMINGS.tooltipDelayMs);
	};
	anchor.addEventListener("pointerenter", onEnter);
	anchor.addEventListener("pointerleave", hide);
	anchor.addEventListener("focus", show);
	anchor.addEventListener("blur", hide);
	return () => {
		hide();
		anchor.removeEventListener("pointerenter", onEnter);
		anchor.removeEventListener("pointerleave", hide);
		anchor.removeEventListener("focus", show);
		anchor.removeEventListener("blur", hide);
	};
}

/** Close whatever popover is open (view change, shell dispose). */
export function closePopovers(): void {
	currentPopover?.close();
}
