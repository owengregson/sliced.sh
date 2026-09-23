/** The Diagnostics section's actions: export the timing log as a JSON file, reset all settings. */

import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { MSG } from "@core/constants/messages";
import { log } from "@core/logger";
import type { SettingsPatch } from "@core/storage/settings-storage";
import type { TimingLogEntry } from "@typedefs/timing";
import { createButton } from "../../components/button";
import { showToast } from "../../components/toast";
import { COPY, SETTINGS_COPY } from "../../copy";
import type { PanelStore } from "../../store";
import type { Confirm } from "./confirm";
import type { SectionParts } from "./section-parts";

export interface AdvancedDeps {
	store: PanelStore;
	signal: AbortSignal;
	write(patch: SettingsPatch): void;
	confirm: Confirm;
}

export function buildAdvanced(rows: HTMLElement, deps: AdvancedDeps, parts: SectionParts): void {
	const actions = document.createElement("div");
	actions.className = "sl-stack sl-settings-advanced__actions";
	const exportButton = createButton(actions, {
		label: SETTINGS_COPY.advanced.exportTimingLog,
		variant: "ghost",
		size: "sm",
		icon: "action.export",
		onClick: () => {
			deps.store
				.dispatch({ type: MSG.PANEL_EXPORT_TIMING_LOG })
				.then((entries) => {
					if (deps.signal.aborted) return;
					exportTimingLog(entries);
					showToast("success", SETTINGS_COPY.advanced.exported(entries.length));
				})
				.catch((error: unknown) => {
					log.warn("settings: export failed", error);
					showToast("danger", SETTINGS_COPY.advanced.exportFailed);
				});
		},
	});
	exportButton.el.classList.add("sl-settings-advanced__export");
	const reset = createButton(actions, {
		label: SETTINGS_COPY.advanced.resetAll,
		variant: "ghost",
		dangerText: true,
		size: "sm",
		onClick: () =>
			deps.confirm(reset.el, COPY.account.resetConfirm, COPY.account.reset, () =>
				deps.write(DEFAULT_SETTINGS)
			),
	});
	reset.el.classList.add("sl-settings-advanced__reset");
	parts.buttons.push(exportButton, reset);
	rows.append(actions);
}

/** Hand the timing log to the user as a JSON file (no-op where object URLs are unavailable). */
function exportTimingLog(entries: TimingLogEntry[]): void {
	if (typeof Blob !== "function" || typeof URL.createObjectURL !== "function") return;
	try {
		const blob = new Blob([JSON.stringify(entries, null, "\t")], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `sliced-timing-log-${new Date().toISOString().slice(0, 10)}.json`;
		a.hidden = true;
		document.body.append(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	} catch (error) {
		log.warn("settings: timing log download failed", error);
	}
}
