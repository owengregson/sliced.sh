/** The shell's top bar controls: the engine status pill and the Game / Settings / Engine switch. */

import type { PanelSnapshot } from "@core/constants/messages";
import { createPill, type PillHandle } from "../components/pill";
import { createSegment, type SegmentHandle } from "../components/segment";
import { COPY } from "../copy";
import { enginePill, statusIcon } from "../engine-status";
import type { PanelTab } from "../view";

export interface Topbar {
	readonly viewSwitch: SegmentHandle<PanelTab>;
	/** Re-project the engine pill from a snapshot. */
	renderEngine(snapshot: PanelSnapshot): void;
	dispose(): void;
}

export function createTopbar(
	statusHost: HTMLElement,
	switchHost: HTMLElement,
	options: { tab: PanelTab; onSelect: (tab: PanelTab) => void }
): Topbar {
	const pill: PillHandle = createPill(statusHost, {
		variant: "idle",
		icon: "status.idle",
		text: COPY.engine.loading,
	});
	const viewSwitch: SegmentHandle<PanelTab> = createSegment<PanelTab>(switchHost, {
		items: [
			{ id: "game", label: COPY.nav.game, icon: "nav.game" },
			{ id: "settings", label: COPY.nav.settings, icon: "nav.settings" },
			{ id: "engine", label: COPY.nav.engine, icon: "nav.engine" },
		],
		value: options.tab,
		ariaLabel: COPY.nav.viewSwitch,
		onChange: options.onSelect,
	});
	return {
		viewSwitch,
		renderEngine(snapshot) {
			const p = enginePill(snapshot, "idle");
			pill.update({ variant: p.variant, icon: statusIcon(p.variant), text: p.text });
		},
		dispose() {
			viewSwitch.dispose();
			pill.dispose();
		},
	};
}
