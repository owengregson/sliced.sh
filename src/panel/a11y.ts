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

export {
	accessibleName,
	findUnnamedInteractive,
	INTERACTIVE_SELECTOR,
	SHELL_TAB_REGIONS,
	type ShellTabRegion,
	tabRegionOf,
	tabSequence,
} from "./a11y/audit";
export {
	announce,
	disposeLiveRegions,
	mountLiveRegions,
	type Politeness,
} from "./a11y/live-regions";
export { sanToSpeech } from "./a11y/speech";
