/**
 * Banner (Appendix F §5.17, §6.5): full-width under the top bar, pushes content, up to two
 * ghost sm actions. Only one banner at a time — danger outranks warn outranks info; a lower
 * ranked request waits until the higher one is dismissed. Enter/exit: height + fade.
 */

import type { IconName } from "@design/icons";
import { ANIM } from "../animation-manager";
import { applyIcon } from "../icons-mount";
import { instantiate, part } from "../template";
import html from "../views/templates/components/banner.html?raw";
import { createButton } from "./button";

export type BannerKind = "info" | "warn" | "danger";

export interface BannerAction {
	label: string;
	onClick: () => void;
	/** Keep the banner after the action (default: the action dismisses). */
	keepOpen?: boolean;
}

export interface BannerOptions {
	/** Stable key: showing the same key again replaces the text/actions instead of queueing. */
	key?: string;
}

export interface BannerHandle {
	readonly el: HTMLElement;
	readonly visible: boolean;
	readonly kind: BannerKind;
	update(text: string, actions?: BannerAction[]): void;
	dismiss(): void;
}

const RANK: Readonly<Record<BannerKind, number>> = { info: 0, warn: 1, danger: 2 };
const ICON: Readonly<Record<BannerKind, IconName>> = {
	info: "feedback.info",
	warn: "feedback.warning",
	danger: "feedback.danger",
};

interface Entry {
	kind: BannerKind;
	key: string | null;
	text: string;
	actions: BannerAction[];
	handle: BannerHandle;
	el: HTMLElement | null;
	buttons: Array<ReturnType<typeof createButton>>;
	dismissed: boolean;
}

let slot: HTMLElement | null = null;
let showing: Entry | null = null;
const pending: Entry[] = [];

/** Register the shell's banner slot. */
export function mountBannerSlot(el: HTMLElement): () => void {
	slot = el;
	el.classList.add("sl-banner-slot");
	return () => {
		clearBanners();
		if (slot === el) slot = null;
	};
}

function target(): HTMLElement {
	if (slot) return slot;
	const fallback = document.createElement("div");
	fallback.className = "sl-banner-slot";
	document.body.prepend(fallback);
	slot = fallback;
	return fallback;
}

function render(entry: Entry): void {
	const el = entry.el ?? instantiate(html);
	if (!entry.el) {
		entry.el = el;
		el.classList.add(`sl-banner--${entry.kind}`);
		el.setAttribute("role", entry.kind === "danger" ? "alert" : "status");
		applyIcon(part(el, ".sl-banner__icon"), ICON[entry.kind]);
	}
	part(el, ".sl-banner__text").textContent = entry.text;
	const actionsHost = part(el, ".sl-banner__actions");
	for (const b of entry.buttons) b.dispose();
	entry.buttons = [];
	actionsHost.replaceChildren();
	for (const action of entry.actions.slice(0, 2)) {
		entry.buttons.push(
			createButton(actionsHost, {
				label: action.label,
				variant: "ghost",
				size: "sm",
				onClick: () => {
					action.onClick();
					if (!action.keepOpen) entry.handle.dismiss();
				},
			})
		);
	}
}

function mount(entry: Entry): void {
	showing = entry;
	render(entry);
	if (entry.el) {
		target().append(entry.el);
		void ANIM.popIn(entry.el);
	}
}

function unmount(entry: Entry): void {
	const el = entry.el;
	entry.el = null;
	for (const b of entry.buttons) b.dispose();
	entry.buttons = [];
	if (el) void ANIM.fade(el, "out").then(() => el.remove());
}

function next(): void {
	if (showing || pending.length === 0) return;
	pending.sort((a, b) => RANK[b.kind] - RANK[a.kind]);
	const entry = pending.shift();
	if (entry) mount(entry);
}

export function showBanner(
	kind: BannerKind,
	text: string,
	actions: BannerAction[] = [],
	options: BannerOptions = {}
): BannerHandle {
	const key = options.key ?? null;
	if (key) {
		const existing = showing?.key === key ? showing : pending.find((e) => e.key === key);
		if (existing && existing.kind === kind) {
			existing.handle.update(text, actions);
			return existing.handle;
		}
		existing?.handle.dismiss();
	}
	const entry: Entry = {
		kind,
		key,
		text,
		actions,
		el: null,
		buttons: [],
		dismissed: false,
		handle: undefined as unknown as BannerHandle,
	};
	entry.handle = {
		get el() {
			return entry.el ?? instantiate(html);
		},
		get visible() {
			return showing === entry;
		},
		kind,
		update(nextText, nextActions) {
			entry.text = nextText;
			if (nextActions) entry.actions = nextActions;
			if (showing === entry) render(entry);
		},
		dismiss() {
			if (entry.dismissed) return;
			entry.dismissed = true;
			const i = pending.indexOf(entry);
			if (i >= 0) pending.splice(i, 1);
			if (showing === entry) {
				showing = null;
				unmount(entry);
				next();
			}
		},
	};
	if (showing && RANK[showing.kind] >= RANK[kind]) {
		pending.push(entry);
		return entry.handle;
	}
	if (showing) {
		// Outranked: the current one waits.
		const current = showing;
		showing = null;
		unmount(current);
		pending.push(current);
	}
	mount(entry);
	return entry.handle;
}

/** Dismiss everything (shell dispose). */
export function clearBanners(): void {
	for (const e of [...pending]) e.handle.dismiss();
	showing?.handle.dismiss();
}

/** Kind of the banner currently showing, if any. */
export function currentBannerKind(): BannerKind | null {
	return showing?.kind ?? null;
}
