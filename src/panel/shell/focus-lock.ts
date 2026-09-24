/**
 * Hands-off (§13.4) for keyboard and assistive tech: while engaged, a capture-phase guard on the
 * content swallows activation keys, and every focusable in the content gets
 * `aria-disabled="true"` + `tabindex="-1"` (restored on release; a MutationObserver covers views
 * mounted meanwhile, and a control focused before the observer delivers is locked on focus).
 * Pointer input is CSS's job (`.sl-hands-off`). Nothing here ever calls `focus()`.
 */

/** Everything a keyboard could activate inside the content while hands-off (§13.4). */
const FOCUSABLE_SELECTOR =
	'a[href], button, input, select, textarea, [tabindex], [role="switch"], [role="slider"], [role="tab"]';
const ACTIVATION_KEYS: ReadonlySet<string> = new Set([
	"Enter",
	" ",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Home",
	"End",
	"PageUp",
	"PageDown",
]);

interface SavedFocusable {
	ariaDisabled: string | null;
	tabindex: string | null;
}

export interface FocusLock {
	readonly engaged: boolean;
	engage(): void;
	release(): void;
	/** Lock focusables added since the last pass (no-op while released). */
	lockNew(): void;
	dispose(): void;
}

export function createFocusLock(content: HTMLElement): FocusLock {
	let engaged = false;
	const lockedFocusables = new Map<Element, SavedFocusable>();
	let focusObserver: MutationObserver | null = null;

	function lockFocusables(): void {
		if (!engaged) return;
		for (const el of content.querySelectorAll(FOCUSABLE_SELECTOR)) {
			if (lockedFocusables.has(el)) continue;
			lockedFocusables.set(el, {
				ariaDisabled: el.getAttribute("aria-disabled"),
				tabindex: el.getAttribute("tabindex"),
			});
			el.setAttribute("aria-disabled", "true");
			el.setAttribute("tabindex", "-1");
		}
	}

	function unlockFocusables(): void {
		for (const [el, saved] of lockedFocusables) {
			if (saved.ariaDisabled === null) el.removeAttribute("aria-disabled");
			else el.setAttribute("aria-disabled", saved.ariaDisabled);
			if (saved.tabindex === null) el.removeAttribute("tabindex");
			else el.setAttribute("tabindex", saved.tabindex);
		}
		lockedFocusables.clear();
	}

	const keyboardGuard = (event: KeyboardEvent): void => {
		if (!engaged || !ACTIVATION_KEYS.has(event.key)) return;
		event.preventDefault();
		event.stopImmediatePropagation();
	};
	content.addEventListener("keydown", keyboardGuard, true);
	content.addEventListener("keyup", keyboardGuard, true);
	// A control added after the lock (before the observer delivers) is locked the moment it is
	// focused, so Tab + Enter can never activate it.
	const focusGuard = (): void => lockFocusables();
	content.addEventListener("focusin", focusGuard, true);

	return {
		get engaged() {
			return engaged;
		},
		engage() {
			engaged = true;
			content.setAttribute("aria-disabled", "true");
			lockFocusables();
			if (typeof MutationObserver === "function") {
				focusObserver = new MutationObserver(() => lockFocusables());
				focusObserver.observe(content, { childList: true, subtree: true });
			}
		},
		release() {
			engaged = false;
			content.removeAttribute("aria-disabled");
			focusObserver?.disconnect();
			focusObserver = null;
			unlockFocusables();
		},
		lockNew: lockFocusables,
		dispose() {
			content.removeEventListener("keydown", keyboardGuard, true);
			content.removeEventListener("keyup", keyboardGuard, true);
			content.removeEventListener("focusin", focusGuard, true);
			focusObserver?.disconnect();
			focusObserver = null;
			lockedFocusables.clear();
		},
	};
}
