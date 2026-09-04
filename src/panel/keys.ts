/**
 * Panel keyboard plumbing (Appendix F §8.3): `Esc` cancels a countdown, closes a popover, or
 * cancels a keybind capture — in that priority. Owners register a handler for their scope; one
 * lazily installed `keydown` listener on `document` dispatches to the highest-priority active
 * scope. `Alt+1/2/3` for the view switch is handled by the shell (`shell.ts`).
 */

export type EscapeScope = "countdown" | "popover" | "capture";

const PRIORITY: Readonly<Record<EscapeScope, number>> = { countdown: 0, popover: 1, capture: 2 };

interface Registration {
	scope: EscapeScope;
	handler: () => void;
	seq: number;
}

const registrations = new Set<Registration>();
let seq = 0;
let listener: ((event: KeyboardEvent) => void) | null = null;

function active(): Registration | null {
	let best: Registration | null = null;
	for (const r of registrations) {
		if (!best) best = r;
		else if (PRIORITY[r.scope] < PRIORITY[best.scope]) best = r;
		else if (PRIORITY[r.scope] === PRIORITY[best.scope] && r.seq > best.seq) best = r; // newest wins
	}
	return best;
}

/** Run the highest-priority Escape handler; returns whether one handled it. */
export function handleEscape(): boolean {
	const r = active();
	if (!r) return false;
	r.handler();
	return true;
}

function ensureListener(): void {
	if (listener || typeof document === "undefined") return;
	listener = (event: KeyboardEvent): void => {
		if (event.key !== "Escape" || event.defaultPrevented) return;
		if (handleEscape()) event.preventDefault();
	};
	document.addEventListener("keydown", listener);
}

function maybeRemoveListener(): void {
	if (!listener || registrations.size > 0 || typeof document === "undefined") return;
	document.removeEventListener("keydown", listener);
	listener = null;
}

/** Register an Escape handler for `scope`; returns the unregister. */
export function registerEscape(scope: EscapeScope, handler: () => void): () => void {
	const r: Registration = { scope, handler, seq: seq++ };
	registrations.add(r);
	ensureListener();
	let done = false;
	return () => {
		if (done) return;
		done = true;
		registrations.delete(r);
		maybeRemoveListener();
	};
}

/** Currently active Escape scope (tests / shell diagnostics). */
export function activeEscapeScope(): EscapeScope | null {
	return active()?.scope ?? null;
}

/** Drop every registration (tests, shell dispose). */
export function resetEscapeHandlers(): void {
	registrations.clear();
	maybeRemoveListener();
}

/** Digit for `Alt+1/2/3` view switching, or null. */
export function viewSwitchIndex(event: KeyboardEvent): number | null {
	if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
	const m = /^Digit([1-3])$/.exec(event.code) ?? /^([1-3])$/.exec(event.key);
	return m?.[1] ? Number(m[1]) - 1 : null;
}
