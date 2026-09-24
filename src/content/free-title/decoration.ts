/**
 * One badge on the page: built for its placement, kept in step with the chosen title, and taken
 * down again with the page's own title marks (which it hides while it stands) restored exactly
 * as they were.
 */

import {
	FREE_TITLE_ART,
	FREE_TITLE_PROFILE_PATH,
	FREE_TITLES,
	type FreeTitle,
} from "@core/constants/free-title";
import { SELECTORS } from "../adapters/selectors";
import type { Placement } from "./placements";

const S = SELECTORS.freeTitle;
const C = S.classes;

/** A hidden native mark's inline `display` value, its priority, and whether it had a style. */
type SavedDisplay = [string, string, boolean];

export interface Decoration {
	placement: Placement;
	root: HTMLElement;
	badge: HTMLElement;
	label: HTMLElement;
	hidden: Map<HTMLElement, SavedDisplay>;
}

function element(doc: Document, tag: string, className: string, text?: string): HTMLElement {
	const node = doc.createElement(tag);
	node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function crown(doc: Document, size: number): SVGSVGElement {
	const node = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
	node.setAttribute("data-glyph", "game-crown-2");
	node.setAttribute("aria-hidden", "true");
	node.setAttribute("viewBox", "0 0 24 24");
	node.setAttribute("width", String(size));
	node.setAttribute("height", String(size));
	node.setAttribute("fill", "currentColor");
	const path = doc.createElementNS(node.namespaceURI, "path");
	path.setAttribute("d", FREE_TITLE_ART.crown);
	node.append(path);
	return node;
}

function restore(node: HTMLElement, [display, priority, hadStyle]: SavedDisplay): void {
	if (node.style.getPropertyValue("display") !== "none") return;
	if (display) node.style.setProperty("display", display, priority);
	else node.style.removeProperty("display");
	if (!hadStyle && !node.getAttribute("style")) node.removeAttribute("style");
}

/** Build the badge for `placement`; a wrapper it creates is recorded in `wrappers`. */
export function createDecoration(
	doc: Document,
	win: Window,
	placement: Placement,
	wrappers: WeakSet<Element>
): Decoration {
	let root: HTMLElement;
	let label: HTMLElement;
	let badge: HTMLElement | undefined;
	if (placement.kind === "small" || placement.kind === "large") {
		root = label = element(doc, "a", C[placement.kind]);
		root.setAttribute("href", new URL(FREE_TITLE_PROFILE_PATH, win.location.href).href);
	} else if (placement.kind === "profile") {
		root = element(doc, "a", C.profile);
		root.setAttribute("href", new URL(FREE_TITLE_PROFILE_PATH, win.location.href).href);
		const icon = element(doc, "div", C.profileIcon);
		icon.append(crown(doc, 24));
		const about = element(doc, "div", C.profileAbout);
		label = element(doc, "span", C.profileExtra);
		about.append(element(doc, "span", C.profileName, "Titled Player"), label);
		root.append(icon, about);
	} else {
		root = element(doc, "div", C.popoverBadge);
		label = element(doc, "span", C.popoverLabel);
		root.append(crown(doc, 12), label);
		if (placement.wrap) {
			badge = root;
			const wrapper = element(doc, "div", C.popoverBadges);
			wrapper.append(root);
			wrappers.add(wrapper);
			root = wrapper;
		}
	}
	return { placement, root, badge: badge ?? root, label, hidden: new Map() };
}

/** Take the badge down and give back every native mark it hid. */
export function removeDecoration(saved: Decoration, wrappers: WeakSet<Element>): void {
	saved.badge.remove();
	if (saved.root !== saved.badge) {
		if (!saved.root.hasChildNodes()) saved.root.remove();
		else wrappers.delete(saved.root);
	}
	for (const [node, style] of saved.hidden) restore(node, style);
	saved.hidden.clear();
}

/** Whether `saved` was built for a different shape of `placement` (and must be rebuilt). */
export function decorationStale(saved: Decoration, placement: Placement): boolean {
	return (
		saved.placement.parent !== placement.parent ||
		saved.placement.kind !== placement.kind ||
		saved.placement.wrap !== placement.wrap
	);
}

/** Bring the badge in line with `title`, put it in its place, and hide the page's own marks. */
export function syncDecoration(saved: Decoration, placement: Placement, title: FreeTitle): void {
	const text = placement.kind === "small" || placement.kind === "large" ? title : FREE_TITLES[title];
	if (saved.label.textContent !== text) saved.label.textContent = text;
	saved.root.title = FREE_TITLES[title];
	if (saved.badge !== saved.root && saved.badge.parentElement !== saved.root)
		saved.root.prepend(saved.badge);
	const before =
		placement.after?.parentElement === placement.parent
			? placement.after.nextSibling
			: placement.parent.firstChild;
	if (before !== saved.root) placement.parent.insertBefore(saved.root, before);
	const selector =
		placement.kind === "profile"
			? S.profileNative
			: placement.kind === "popover"
				? S.popoverNative
				: S.title;
	const native = [...placement.parent.children].filter(
		(node) => node !== saved.root && node.matches(selector)
	) as HTMLElement[];
	for (const [node, style] of saved.hidden) {
		if (!native.includes(node)) {
			restore(node, style);
			saved.hidden.delete(node);
		}
	}
	for (const node of native) {
		if (!saved.hidden.has(node))
			saved.hidden.set(node, [
				node.style.getPropertyValue("display"),
				node.style.getPropertyPriority("display"),
				node.hasAttribute("style"),
			]);
		node.style.setProperty("display", "none", "important");
	}
}
