/**
 * Panel accessibility helpers (Appendix F §7.4, §8.3; Task 27).
 *
 * - `sanToSpeech`: SAN spelled out for `aria-live` / TTS ("Nf3" → "knight f3"). The single
 *   implementation; the move card and the Live view's speak-move action use it.
 * - Live regions: `mountLiveRegions` puts a polite (`role="status"`) and an assertive
 *   (`role="alert"`) visually-hidden region into the shell; `announce` writes into them,
 *   debounced per politeness (`UI_TIMINGS.announceDebounceMs`) so bursts collapse to the last
 *   text, and re-announces identical text by clearing first.
 * - Audit helpers used by the tests (and by QA tooling): `accessibleName`,
 *   `findUnnamedInteractive`, `tabSequence`, `tabRegionOf`.
 *
 * Tab order (§8.3) is structural: the shell template lays the regions out in
 * `SHELL_TAB_REGIONS` order, nothing in the panel sets a positive `tabindex`, and views render
 * their controls top-to-bottom in DOM order. `Alt+1/2/3` and `Esc` live in `keys.ts`.
 * Nothing here ever calls `focus()`.
 */

import { UI_TIMINGS } from "@core/constants/ui";
import { COPY } from "./copy";

// ── SAN → speech ────────────────────────────────────────────────────────────────────────────

type PieceLetter = keyof typeof COPY.a11y.pieces;

const SAN_RE = /^([KQRBN])?([a-h]?[1-8]?)(x?)([a-h][1-8])(?:=?([QRBN]))?$/;
const CASTLE_QUEEN_RE = /^[O0]-[O0]-[O0]$/;
const CASTLE_KING_RE = /^[O0]-[O0]$/;

function pieceWord(letter: string): string {
	return COPY.a11y.pieces[letter as PieceLetter];
}

/**
 * "Nf3" → "knight f3", "O-O" → "castles kingside", "exd5+" → "e takes d5 check",
 * "e8=Q#" → "e8 promotes to queen checkmate". Annotations (`!?`) are dropped; anything that is
 * not SAN (null moves, "e.p.") yields "".
 */
export function sanToSpeech(san: string): string {
	const raw = san.trim().replace(/[!?]+$/, "");
	if (!raw) return "";
	const suffix = /[+#]$/.exec(raw)?.[0] ?? "";
	const core = raw.replace(/[+#]+$/, "");
	const words: string[] = [];
	if (CASTLE_QUEEN_RE.test(core)) words.push(COPY.a11y.castleQueen);
	else if (CASTLE_KING_RE.test(core)) words.push(COPY.a11y.castleKing);
	else {
		const m = SAN_RE.exec(core);
		if (!m) return "";
		const [, piece, disambiguation, capture, target, promotion] = m;
		if (piece) words.push(pieceWord(piece));
		if (disambiguation) words.push(disambiguation);
		if (capture) words.push(COPY.a11y.takes);
		if (target) words.push(target);
		if (promotion) words.push(COPY.a11y.promotes, pieceWord(promotion));
	}
	if (suffix === "#") words.push(COPY.a11y.checkmate);
	else if (suffix === "+") words.push(COPY.a11y.check);
	return words.join(" ");
}

// ── live regions ────────────────────────────────────────────────────────────────────────────

export type Politeness = "polite" | "assertive";

const POLITENESS: readonly Politeness[] = ["polite", "assertive"];

interface LiveRegions {
	host: HTMLElement;
	regions: Record<Politeness, HTMLElement>;
	timers: Partial<Record<Politeness, ReturnType<typeof setTimeout>>>;
	pending: Partial<Record<Politeness, string>>;
}

let live: LiveRegions | null = null;

function clearTimers(state: LiveRegions): void {
	for (const p of POLITENESS) {
		const t = state.timers[p];
		if (t !== undefined) clearTimeout(t);
		delete state.timers[p];
		delete state.pending[p];
	}
}

/** Create the two visually-hidden live regions inside `host`; returns the unmount. */
export function mountLiveRegions(host: HTMLElement): () => void {
	if (live) disposeLiveRegions();
	const doc = host.ownerDocument;
	const make = (politeness: Politeness): HTMLElement => {
		const el = doc.createElement("div");
		el.className = "sl-visually-hidden";
		el.setAttribute("aria-live", politeness);
		el.setAttribute("role", politeness === "assertive" ? "alert" : "status");
		el.setAttribute("aria-atomic", "true");
		host.append(el);
		return el;
	};
	const state: LiveRegions = {
		host,
		regions: { polite: make("polite"), assertive: make("assertive") },
		timers: {},
		pending: {},
	};
	live = state;
	return () => {
		if (live !== state) return;
		disposeLiveRegions();
	};
}

/** Remove the regions and drop pending announcements (shell dispose, tests). */
export function disposeLiveRegions(): void {
	if (!live) return;
	clearTimers(live);
	for (const p of POLITENESS) live.regions[p].remove();
	live = null;
}

function flush(state: LiveRegions, politeness: Politeness): void {
	delete state.timers[politeness];
	const text = state.pending[politeness] ?? "";
	delete state.pending[politeness];
	const region = state.regions[politeness];
	if (text !== "" && region.textContent === text) {
		// Same text twice: clear first so assistive tech treats the refill as a new message.
		region.textContent = "";
		state.timers[politeness] = setTimeout(() => {
			delete state.timers[politeness];
			if (live === state && state.pending[politeness] === undefined) region.textContent = text;
		}, 0);
		return;
	}
	region.textContent = text;
}

/**
 * Announce `text` through the live region of the given politeness. Calls within
 * `UI_TIMINGS.announceDebounceMs` collapse to the last text; "" clears the region. A no-op when
 * no regions are mounted.
 */
export function announce(text: string, politeness: Politeness = "polite"): void {
	const state = live;
	if (!state) return;
	state.pending[politeness] = text;
	const existing = state.timers[politeness];
	if (existing !== undefined) clearTimeout(existing);
	state.timers[politeness] = setTimeout(
		() => flush(state, politeness),
		UI_TIMINGS.announceDebounceMs
	);
}

// ── accessible names ────────────────────────────────────────────────────────────────────────

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
