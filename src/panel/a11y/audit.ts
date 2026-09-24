/**
 * Audit helpers used by the tests (and by QA tooling): a simplified accessible-name computation,
 * the unnamed-control finder, and the Tab sequence / shell region of an element (§8.3).
 */

/** Everything the panel treats as interactive for the name audit. */
export const INTERACTIVE_SELECTOR = [
	"a[href]",
	"button",
	'input:not([type="hidden"])',
	"select",
	"textarea",
	"[role=button]",
	"[role=link]",
	"[role=switch]",
	"[role=checkbox]",
	"[role=radio]",
	"[role=slider]",
	"[role=spinbutton]",
	"[role=tab]",
	"[role=menuitem]",
	"[role=option]",
	"[role=textbox]",
	"[role=combobox]",
	'[tabindex]:not([tabindex="-1"])',
].join(", ");

/** Roles (and form controls) whose name never comes from their content. */
const NAME_FROM_AUTHOR_ONLY = new Set([
	"slider",
	"spinbutton",
	"textbox",
	"combobox",
	"searchbox",
	"progressbar",
	"meter",
]);
const FORM_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA"]);

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

function isHiddenForAt(el: Element): boolean {
	return el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden");
}

/** Text from `el`'s subtree the way an accessible-name computation would take it (simplified). */
function textFromContent(el: Element): string {
	let out = "";
	for (const node of el.childNodes) {
		if (node.nodeType === 3) out += `${node.textContent ?? ""} `;
		else if (node.nodeType === 1) {
			const child = node as Element;
			if (isHiddenForAt(child)) continue;
			const label = child.getAttribute("aria-label");
			if (label && collapse(label)) out += `${label} `;
			else if (child.tagName === "IMG") out += `${child.getAttribute("alt") ?? ""} `;
			else out += `${textFromContent(child)} `;
		}
	}
	return collapse(out);
}

function escapeSelector(id: string, doc: Document): string {
	const css = doc.defaultView?.CSS ?? (typeof CSS === "undefined" ? undefined : CSS);
	return css ? css.escape(id) : id.replace(/["\\]/g, "\\$&");
}

function labelFor(el: Element): string {
	const id = el.getAttribute("id");
	const doc = el.ownerDocument;
	if (id) {
		const label = doc.querySelector(`label[for="${escapeSelector(id, doc)}"]`);
		if (label) {
			const text = textFromContent(label);
			if (text) return text;
		}
	}
	const wrapping = el.closest("label");
	return wrapping ? textFromContent(wrapping) : "";
}

/**
 * Simplified accname: labelledby → aria-label → `<label>` → alt → content → title. `placeholder`
 * is deliberately not a source: an input labelled only by its placeholder fails the audit.
 */
export function accessibleName(el: Element): string {
	const labelledBy = el.getAttribute("aria-labelledby");
	if (labelledBy) {
		const doc = el.ownerDocument;
		const text = labelledBy
			.split(/\s+/)
			.map((id) => doc.getElementById(id))
			.map((ref) =>
				ref ? textFromContent(ref) || collapse(ref.getAttribute("aria-label") ?? "") : ""
			)
			.filter(Boolean)
			.join(" ");
		if (text) return text;
	}
	const ariaLabel = collapse(el.getAttribute("aria-label") ?? "");
	if (ariaLabel) return ariaLabel;
	if (FORM_TAGS.has(el.tagName)) {
		const fromLabel = labelFor(el);
		if (fromLabel) return fromLabel;
		if (el.tagName === "INPUT" && el.getAttribute("type") === "image")
			return collapse(el.getAttribute("alt") ?? "");
	}
	if (el.tagName === "IMG") return collapse(el.getAttribute("alt") ?? "");
	const role = el.getAttribute("role") ?? "";
	if (!FORM_TAGS.has(el.tagName) && !NAME_FROM_AUTHOR_ONLY.has(role)) {
		const content = textFromContent(el);
		if (content) return content;
	}
	return collapse(el.getAttribute("title") ?? "");
}

/** Interactive elements under `root` (inclusive) without an accessible name. */
export function findUnnamedInteractive(root: ParentNode): HTMLElement[] {
	const out: HTMLElement[] = [];
	const candidates = [...root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)];
	if (root instanceof HTMLElement && root.matches(INTERACTIVE_SELECTOR)) candidates.unshift(root);
	for (const el of candidates) if (accessibleName(el) === "") out.push(el);
	return out;
}

// ── tab order (§8.3) ────────────────────────────────────────────────────────────────────────

/** Shell regions in the order Tab visits them: top bar → banner → content → toast action. */
export const SHELL_TAB_REGIONS = ["topbar", "banner", "content", "toasts"] as const;

export type ShellTabRegion = (typeof SHELL_TAB_REGIONS)[number];

const REGION_SELECTORS: Readonly<Record<ShellTabRegion, string>> = {
	topbar: ".sl-topbar",
	banner: ".sl-app__banner",
	content: ".sl-app__content",
	toasts: ".sl-app__toasts",
};

const FOCUSABLE_SELECTOR = [
	"a[href]",
	"button:not([disabled])",
	'input:not([disabled]):not([type="hidden"])',
	"select:not([disabled])",
	"textarea:not([disabled])",
	'[tabindex]:not([tabindex="-1"])',
].join(", ");

function tabIndexOf(el: Element): number {
	const raw = el.getAttribute("tabindex");
	if (raw === null) return 0;
	const n = Number.parseInt(raw, 10);
	return Number.isNaN(n) ? 0 : n;
}

/**
 * Elements under `root` in the order Tab reaches them: positive `tabindex` first (ascending,
 * tree order within a value), then tree order. Hidden subtrees, disabled controls and
 * `tabindex="-1"` are skipped; `aria-disabled` alone is not (the hands-off lock also sets
 * `tabindex="-1"`, which is what removes a control from the sequence).
 */
export function tabSequence(root: ParentNode): HTMLElement[] {
	const all = [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
		(el) => tabIndexOf(el) >= 0 && el.closest("[hidden]") === null
	);
	const positive = all
		.filter((el) => tabIndexOf(el) > 0)
		.sort((a, b) => tabIndexOf(a) - tabIndexOf(b));
	const zero = all.filter((el) => tabIndexOf(el) === 0);
	return [...positive, ...zero];
}

/** Which shell region `el` belongs to, or null when it is outside the four (e.g. a popover). */
export function tabRegionOf(el: Element, root: ParentNode): ShellTabRegion | null {
	for (const region of SHELL_TAB_REGIONS) {
		const host = el.closest(REGION_SELECTORS[region]);
		if (host && root.contains(host)) return region;
	}
	return null;
}
