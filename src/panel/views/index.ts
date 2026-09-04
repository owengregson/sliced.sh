/**
 * View registry. Every `ViewName` maps to a `View`; Tasks 23–26 replace the stub entries with
 * the real views (login/expired/unsupported/waiting/update → 23, live → 24, settings → 25,
 * engine → 26). The stubs render the view heading from `copy.ts` so the shell and router are
 * testable end to end.
 */

import { viewTitle } from "../copy";
import { instantiate, part } from "../template";
import { VIEW_NAMES, type View, type ViewName, type ViewRegistry } from "../view";
import stubHtml from "./templates/stub.html?raw";

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

export const VIEWS: ViewRegistry = Object.fromEntries(
	VIEW_NAMES.map((name) => [name, createStubView(name)])
) as ViewRegistry;
