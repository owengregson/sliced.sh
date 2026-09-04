/**
 * `data-icon` → Font Awesome classes (Part I §10.3). Templates write
 * `<i class=… data-icon="action.play">` with the `ICON_CLASS` base class; this resolves the name through
 * `ICONS` — the only place FA class names exist — and always adds `fa-fw` (Appendix F §2.6).
 */

import { log } from "@core/logger";
import { ICON_CLASS, ICON_STYLE_CLASSES, ICONS, type IconName } from "@design/icons";

const STYLE_CLASSES: ReadonlySet<string> = new Set(ICON_STYLE_CLASSES);

export function isIconName(name: unknown): name is IconName {
	return typeof name === "string" && Object.hasOwn(ICONS, name);
}

/** Replace any `fa-*` classes on `el` with the classes for `name` (keeps `sl-*` and others). */
export function applyIcon(el: Element, name: IconName, options: { spin?: boolean } = {}): void {
	const keep = [...el.classList].filter((c) => !c.startsWith("fa-"));
	const glyph = ICONS[name].split(/\s+/);
	const classes = [...keep, ...glyph, "fa-fw"];
	if (options.spin) classes.push("fa-spin");
	if (!classes.includes(ICON_CLASS)) classes.unshift(ICON_CLASS);
	el.className = classes.join(" ");
	el.setAttribute("data-icon", name);
	el.setAttribute("aria-hidden", "true");
}

/** Set (or change) an icon; unknown names are logged and leave the element untouched. */
export function setIcon(el: Element, name: string, options: { spin?: boolean } = {}): boolean {
	if (!isIconName(name)) {
		log.warn("icons: unknown icon name", { name });
		return false;
	}
	applyIcon(el, name, options);
	return true;
}

/** Resolve every `[data-icon]` under `root` (including `root` itself). Returns the count. */
export function mountIcons(root: ParentNode | Element): number {
	let n = 0;
	const targets: Element[] = [];
	if (root instanceof Element && root.hasAttribute("data-icon")) targets.push(root);
	targets.push(...root.querySelectorAll("[data-icon]"));
	for (const el of targets) {
		const name = el.getAttribute("data-icon") ?? "";
		const spin = el.classList.contains("fa-spin");
		if (setIcon(el, name, { spin })) n += 1;
	}
	return n;
}

/** Whether `cls` is a style/utility class rather than a glyph (used by tests and the linter). */
export function isIconStyleClass(cls: string): boolean {
	return STYLE_CLASSES.has(cls);
}
