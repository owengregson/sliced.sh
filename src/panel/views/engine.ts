/**
 * View 6 — Engine and diagnostics (Appendix F §4.7, §9.7, V2 §3.6).
 *
 * A projection of `PanelSnapshot`: engine rows (version · NNUE names, threads/hash, the nps
 * numeral and depth) with a 60 s nps sparkline sampled once per `UI_TIMINGS.sparklineSampleMs`
 * from successive snapshots (an inline `<svg>` built with DOM APIs, ≤ `LIMITS.npsSparklineSamples`
 * points, colours from the theme tokens in `engine.css`); executor rows (debugger, target, input mode, last
 * action with the `ExecutionResult.timeline` phase durations) with Detach / Reattach; the raw
 * license verdict; the timing rationale log (`TimingLogEntry` → `plan/exec/verify/warn` rows in
 * `mono-xs`, newest at the bottom) with Copy / Export / Clear; the session line with Reset; and
 * the live log pane fed by `logging-bridge.ts` with a level control (initial value
 * `settings.advanced.logLevel`). Every listener, port and component is released by the cleanup.
 *
 * This file composes the sections in `engine/`; while a game is live every command here is
 * disabled (hands-off).
 */

import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { MSG } from "@core/constants/messages";
import { log } from "@core/logger";
import type { LogLevel } from "@typedefs/settings";
import { COPY } from "../copy";
import { mountIcons } from "../icons-mount";
import { createLoggingBridge, type LoggingBridge } from "../logging-bridge";
import { isHandsOff } from "../router";
import { instantiate, part } from "../template";
import type { Cleanup, View, ViewContext } from "../view";
import { type ActiveTab, trackActiveTab } from "./active-tab";
import { createEngineCommands } from "./engine/commands";
import { mountConsolePane } from "./engine/console-pane";
import { createExecutorSection } from "./engine/executor-section";
import { createPolicySection } from "./engine/policy-section";
import { createEngineStatusSection } from "./engine/status-section";
import { createTimingLog } from "./engine/timing-log";
import html from "./templates/engine.html?raw";

export { formatNps } from "./engine/format";
export {
	type PolicyBlock,
	type PolicyMeterRow,
	policyBlock,
	policyHistoryWarning,
	policyMeters,
	selectionModel,
} from "./engine/policy";
export { type RationaleKind, type RationaleRow, rationaleRows } from "./engine/rationale";

export interface EngineViewDeps {
	/** Log-stream bridge factory (tests inject a fake); receives the initial level. */
	logging?: (level: LogLevel) => LoggingBridge;
	/** Clipboard writer for "Copy log" (defaults to `navigator.clipboard.writeText`). */
	clipboard?: (text: string) => Promise<void>;
}

async function defaultClipboard(text: string): Promise<void> {
	const clipboard = globalThis.navigator?.clipboard;
	if (!clipboard || typeof clipboard.writeText !== "function")
		throw new Error("clipboard unavailable");
	await clipboard.writeText(text);
}

/** Section titles, row keys and empty-state lines — static copy written once at mount. */
function labelSections(el: HTMLElement): void {
	part(el, ".sl-engine__title").textContent = COPY.workspace.engineTitle;
	part(el, ".sl-engine__intro").textContent = COPY.workspace.engineBody;
	part(el, '[data-part="title-engine"]').textContent = COPY.engineView.sections.engine;
	part(el, '[data-part="title-policy"]').textContent = COPY.engineView.sections.policy;
	part(el, '[data-part="title-executor"]').textContent = COPY.engineView.sections.executor;
	part(el, '[data-part="title-timing"]').textContent = COPY.engineView.sections.timing;
	part(el, '[data-part="title-session"]').textContent = COPY.engineView.sections.session;
	part(el, '[data-part="title-log"]').textContent = COPY.engineView.sections.log;
	part(el, '[data-part="level-label"]').textContent = COPY.engineView.level;
	for (const row of Object.keys(COPY.engineView.rows) as Array<keyof typeof COPY.engineView.rows>) {
		part(el, `[data-row="${row}"] .sl-engine__key`).textContent = COPY.engineView.rows[row];
	}
	part(el, ".sl-engine__log-empty").textContent = COPY.engineView.logEmpty;
	part(el, ".sl-engine__console-empty").textContent = COPY.engineView.consoleEmpty;
}

export function createEngineView(deps: EngineViewDeps = {}): View {
	const makeLogging = deps.logging ?? ((level: LogLevel) => createLoggingBridge({ level }));
	const clipboard = deps.clipboard ?? defaultClipboard;

	return {
		mount(ctx: ViewContext): Cleanup {
			const { store } = ctx;
			const el = instantiate(html);
			const initialLevel =
				ctx.snapshot?.settings.advanced.logLevel ?? DEFAULT_SETTINGS.advanced.logLevel;
			let disposed = false;
			labelSections(el);

			const status = createEngineStatusSection(el);
			const policy = createPolicySection(el);
			const executor = createExecutorSection(el);
			const timingLog = createTimingLog({
				rows: part(el, ".sl-engine__log-rows"),
				pane: part(el, ".sl-engine__log"),
				empty: part(el, ".sl-engine__log-empty"),
			});
			/** Resolved last, as the view finishes mounting. */
			let activeTab: ActiveTab | null = null;
			const commands = createEngineCommands(el, {
				store,
				tabId: () => activeTab?.id ?? null,
				entries: () => timingLog.entries,
				clearLog: () => timingLog.clear(),
				clipboard,
				disposed: () => disposed,
			});

			store
				.dispatch({ type: MSG.PANEL_EXPORT_TIMING_LOG })
				.then((entries) => {
					if (disposed) return;
					timingLog.loadBacklog(entries);
				})
				.catch((error: unknown) => log.debug("engine view: timing log unavailable", error));
			const unsubscribePort = store.onPortMessage((message) => {
				if (message.kind === "timingLog") timingLog.push(message.entry);
			});

			const unmountConsole = mountConsolePane(
				{
					rows: part(el, ".sl-engine__console-rows"),
					pane: part(el, ".sl-engine__console"),
					empty: part(el, ".sl-engine__console-empty"),
					level: part<HTMLSelectElement>(el, ".sl-engine__level"),
				},
				makeLogging(initialLevel),
				initialLevel
			);

			mountIcons(el);
			ctx.container.append(el);
			const unsubscribeStore = store.subscribe((snapshot) => {
				if (disposed) return;
				status.render(snapshot);
				policy.render(snapshot);
				executor.render(snapshot);
				commands.apply({
					handsOff: isHandsOff(snapshot),
					attached: snapshot.executor.debuggerAttached,
				});
			});
			activeTab = trackActiveTab("engine view", () => disposed);

			return () => {
				if (disposed) return;
				disposed = true;
				unsubscribeStore();
				unsubscribePort();
				unmountConsole();
				status.dispose();
				policy.dispose();
				commands.dispose();
				el.remove();
			};
		},
	};
}

export const engineView: View = createEngineView();
