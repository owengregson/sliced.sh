/**
 * Every user-visible string of the panel, transcribed once from Appendix F §7 (tone: crisp,
 * sentence case, no emojis, no exclamation marks). Parameterised strings are functions so the
 * numbers stay specific ("4.2s", "d18"). Views and components import from here; no string
 * literal shown to the user may live anywhere under `src/panel/` except this file and the
 * per-domain parts it assembles from `src/panel/copy/` (each string is defined exactly once).
 */

import {
	A11Y_COPY,
	BRAND_COPY,
	COMMON_COPY,
	FOOTER_COPY,
	NAV_COPY,
	NOTICES_COPY,
	WORKSPACE_COPY,
} from "./copy/app";
import { ACCOUNT_COPY, EXECUTION_COPY, KEYBIND_COPY } from "./copy/controls";
import { ENGINE_COPY, ENGINE_VIEW_COPY } from "./copy/engine";
import {
	CAT_FACTS_COPY,
	EXPIRED_COPY,
	EXPIRED_VIEW_COPY,
	LOGIN_COPY,
	LOGIN_VIEW_COPY,
	NON_GAME_COPY,
	UNSUPPORTED_COPY,
	UNSUPPORTED_VIEW_COPY,
	UPDATE_COPY,
	WAITING_COPY,
	WAITING_VIEW_COPY,
} from "./copy/entry";
import { BANNER_COPY, TOAST_COPY } from "./copy/feedback";
import {
	ADVANTAGE_COPY,
	CLOCK_COPY,
	EVAL_COPY,
	EXECUTOR_COPY,
	LINES_COPY,
	MOVE_COPY,
	PERSONA_NAME_COPY,
	RING_COPY,
	SESSION_COPY,
	STRENGTH_COPY,
	TELEMETRY_COPY,
	TOGGLE_COPY,
} from "./copy/game";

export { COPY_LIVE } from "./copy/live";
export { KEYBIND_SCOPE_FORCED, RESPECT_BUDGET_FORCED, SETTINGS_COPY } from "./copy/settings";

export const COPY = {
	brand: BRAND_COPY,
	nav: NAV_COPY,
	workspace: WORKSPACE_COPY,
	login: LOGIN_COPY,
	unsupported: UNSUPPORTED_COPY,
	nonGame: NON_GAME_COPY,
	waiting: WAITING_COPY,
	move: MOVE_COPY,
	lines: LINES_COPY,
	strength: STRENGTH_COPY,
	personaName: PERSONA_NAME_COPY,
	toggle: TOGGLE_COPY,
	session: SESSION_COPY,
	telemetry: TELEMETRY_COPY,
	executor: EXECUTOR_COPY,
	engine: ENGINE_COPY,
	toast: TOAST_COPY,
	banner: BANNER_COPY,
	update: UPDATE_COPY,
	expired: EXPIRED_COPY,
	keybind: KEYBIND_COPY,
	execution: EXECUTION_COPY,
	account: ACCOUNT_COPY,
	clock: CLOCK_COPY,
	eval: EVAL_COPY,
	advantage: ADVANTAGE_COPY,
	ring: RING_COPY,
	footer: FOOTER_COPY,
	notices: NOTICES_COPY,
	common: COMMON_COPY,
	a11y: A11Y_COPY,
	engineView: ENGINE_VIEW_COPY,
	loginView: LOGIN_VIEW_COPY,
	expiredView: EXPIRED_VIEW_COPY,
	unsupportedView: UNSUPPORTED_VIEW_COPY,
	waitingView: WAITING_VIEW_COPY,
	catFacts: CAT_FACTS_COPY,
} as const;

/** Heading shown by the placeholder view registry until Tasks 23–26 land the real views. */
export function viewTitle(
	name: "login" | "expired" | "unsupported" | "waiting" | "live" | "settings" | "engine" | "update",
	version: string
): string {
	switch (name) {
		case "login":
			return COPY.login.title;
		case "expired":
			return COPY.expired.title;
		case "unsupported":
			return COPY.unsupported.title;
		case "waiting":
			return COPY.waiting.title;
		case "live":
			return COPY.nav.game;
		case "settings":
			return COPY.nav.settings;
		case "engine":
			return COPY.nav.engine;
		case "update":
			return COPY.update.title(version);
	}
}
