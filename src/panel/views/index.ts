/**
 * View registry. Every `ViewName` maps to a `View`; Tasks 23–26 replace the stub entries with
 * the real views (login/expired/unsupported/waiting/update → 23, live → 24, settings → 25,
 * engine → 26). The stubs render the view heading from `copy.ts` so the shell and router are
 * testable end to end.
 */

import { viewTitle } from "../copy";
import { instantiate, part } from "../template";
import { VIEW_NAMES, type View, type ViewName, type ViewRegistry } from "../view";
import { engineView } from "./engine";
import { expiredView } from "./expired";
import { liveView } from "./live";
import { loginView } from "./login";
import { createSettingsView } from "./settings";
import stubHtml from "./templates/stub.html?raw";
import { unsupportedView } from "./unsupported";
import { updateView } from "./update";
import { waitingView } from "./waiting";

export function createStubView(name: ViewName): View {
	return {
		mount(ctx) {
			const el = instantiate(stubHtml);
			el.dataset.view = name;
			part(el, ".sl-view__title").textContent = viewTitle(name, __SL_VERSION__);
			ctx.container.append(el);
			return () => el.remove();
		},
	};
}

const STUBS: ViewRegistry = Object.fromEntries(
	VIEW_NAMES.map((name) => [name, createStubView(name)])
) as ViewRegistry;

export const VIEWS: ViewRegistry = {
	...STUBS,
	// Task 23
	login: loginView,
	expired: expiredView,
	unsupported: unsupportedView,
	waiting: waitingView,
	// TODO(Task 31 boot): inject `createUpdateView({ version, notes, onUpdate })` through
	// `bootShell({ views: { update } })`; this default knows only the build version.
	update: updateView,
};

// ── Task 24: the real Live view replaces its stub ────────────────────────────────────────────
VIEWS.live = liveView;

// ── Task 25: the real Settings view replaces its stub ────────────────────────────────────────
VIEWS.settings = createSettingsView();

// ── Task 26: the real Engine view replaces its stub ──────────────────────────────────────────
VIEWS.engine = engineView;
