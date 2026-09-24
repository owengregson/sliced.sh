/**
 * The Engine view's command buttons: Detach / Reattach (per game tab), Copy / Export / Clear for
 * the timing log, and Reset session. Every command is disabled while hands-off.
 *
 * Export builds a `data:application/json` URL and opens it through the shell's `open-url`
 * action (refused while hands-off, §13.4); `chrome.downloads` is not a permission.
 */

import { MSG } from "@core/constants/messages";
import { log } from "@core/logger";
import type { TimingLogEntry } from "@typedefs/timing";
import { JSON_DATA_URL_PREFIX } from "../../actions";
import { type ButtonHandle, createButton } from "../../components/button";
import { showToast } from "../../components/toast";
import { COPY } from "../../copy";
import type { PanelCommandType, PanelStore } from "../../store";
import { part } from "../../template";

export interface EngineCommandsDeps {
	store: PanelStore;
	/** The game tab the debugger commands target (the active tab of this window). */
	tabId(): number | null;
	/** The timing log entries Copy and Export hand over. */
	entries(): readonly TimingLogEntry[];
	/** Clear the shown log (before the service worker is told to clear its own). */
	clearLog(): void;
	clipboard(text: string): Promise<void>;
	disposed(): boolean;
}

export interface EngineCommands {
	/** Enable/disable for hands-off and the debugger's attachment. */
	apply(state: { handsOff: boolean; attached: boolean }): void;
	dispose(): void;
}

export function createEngineCommands(el: HTMLElement, deps: EngineCommandsDeps): EngineCommands {
	const { store } = deps;
	const dispatch = (type: PanelCommandType): void => {
		store
			.dispatch({ type })
			.catch((error: unknown) => log.warn("engine view: dispatch failed", { type, error }));
	};
	/** The debugger pair is per tab (Task 28): both act on the game tab's executor. */
	const dispatchDebugger = (
		type: typeof MSG.PANEL_DETACH_DEBUGGER | typeof MSG.PANEL_REATTACH_DEBUGGER
	): void => {
		const tabId = deps.tabId();
		if (tabId === null) {
			log.warn("engine view: no active tab for the command", { type });
			return;
		}
		store
			.dispatch({ type, tabId })
			.catch((error: unknown) => log.warn("engine view: dispatch failed", { type, error }));
	};
	const detach: ButtonHandle = createButton(part(el, '[data-part="detach"]'), {
		label: COPY.engineView.detach,
		variant: "ghost",
		size: "sm",
		icon: "status.detached",
		onClick: () => dispatchDebugger(MSG.PANEL_DETACH_DEBUGGER),
	});
	detach.el.dataset.cmd = "detach";
	const reattach: ButtonHandle = createButton(part(el, '[data-part="reattach"]'), {
		label: COPY.banner.reattach,
		variant: "ghost",
		size: "sm",
		icon: "action.reattach",
		onClick: () => dispatchDebugger(MSG.PANEL_REATTACH_DEBUGGER),
	});
	reattach.el.dataset.cmd = "reattach";
	const copy: ButtonHandle = createButton(part(el, '[data-part="copy"]'), {
		label: COPY.engineView.copy,
		variant: "ghost",
		size: "sm",
		icon: "action.copy",
		onClick: () => {
			deps.clipboard(JSON.stringify(deps.entries(), null, 2)).then(
				() => {
					if (!deps.disposed()) showToast("success", COPY.engineView.copied);
				},
				(error: unknown) => {
					log.warn("engine view: copy failed", error);
					if (!deps.disposed()) showToast("warn", COPY.engineView.copyFailed);
				}
			);
		},
	});
	copy.el.dataset.cmd = "copy";
	const exportButton: ButtonHandle = createButton(part(el, '[data-part="export"]'), {
		label: COPY.engineView.export,
		variant: "ghost",
		size: "sm",
		icon: "action.export",
		onClick: () => {
			// The shell's `open-url` action (bubbling after this) opens it in a new tab; the URL
			// is dropped once the click has bubbled so the (large) payload never lingers in the DOM.
			exportButton.el.dataset.url = `${JSON_DATA_URL_PREFIX};charset=utf-8,${encodeURIComponent(
				JSON.stringify(deps.entries())
			)}`;
			queueMicrotask(() => {
				delete exportButton.el.dataset.url;
			});
		},
	});
	exportButton.el.dataset.cmd = "export";
	exportButton.el.dataset.action = "open-url";
	const clear: ButtonHandle = createButton(part(el, '[data-part="clear"]'), {
		label: COPY.engineView.clear,
		variant: "ghost",
		dangerText: true,
		size: "sm",
		onClick: () => {
			deps.clearLog();
			dispatch(MSG.PANEL_CLEAR_TIMING_LOG);
		},
	});
	clear.el.dataset.cmd = "clear";
	const reset: ButtonHandle = createButton(part(el, '[data-part="reset"]'), {
		label: COPY.engineView.reset,
		variant: "ghost",
		dangerText: true,
		size: "sm",
		onClick: () => dispatch(MSG.PANEL_RESET_SESSION),
	});
	reset.el.dataset.cmd = "reset";
	const commands: ButtonHandle[] = [detach, reattach, copy, exportButton, clear, reset];

	return {
		apply({ handsOff, attached }) {
			for (const b of commands) b.update({ disabled: handsOff });
			detach.update({ disabled: handsOff || !attached });
			reattach.update({ disabled: handsOff || attached });
			reattach.update({ variant: attached ? "ghost" : "primary" });
		},
		dispose() {
			for (const b of commands) b.dispose();
		},
	};
}
