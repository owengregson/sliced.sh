/** What the panel command handlers read and act through, and the §4.4 gate they share. */

import type { GamePortCommand } from "@core/constants/messages";
import type { PanelBroadcaster, SnapshotSources } from "@service/panel-broadcaster";
import type { Settings } from "@typedefs/settings";

/** The slice of `ContentLink` the preview command needs. */
export interface HighlightLink {
	post(tabId: number, cmd: GamePortCommand): boolean;
}

export interface PanelHandlerDeps {
	broadcaster: PanelBroadcaster;
	sources: SnapshotSources;
	/** `null` until Task 30 constructs the content link (previews are then no-ops). */
	link: HighlightLink | null;
	/**
	 * The latest settings. `Settings.enabled` (§4.4) is the master switch: the commands that make
	 * the extension *act* on the page — arm, attach, play — refuse while it is off, so the panel
	 * (and anything else on this router) cannot route around the session's own gate.
	 */
	getSettings(): Settings;
	/**
	 * Whether those settings are the stored ones yet (§4.4 / the MV3 cold start). While they are
	 * not, the acting commands hold: `DEFAULT_SETTINGS` is a placeholder, not the user's answer.
	 * Omitted by a caller whose settings are already real.
	 */
	settingsKnown?: (() => boolean) | undefined;
}

/**
 * §4.4: may the worker act on the page right now? The master switch, and `false` while the stored
 * settings are still unknown — the same rule `GameSession.mayAct` applies, so the panel's own
 * route to the executor cannot disagree with the session's.
 */
export function mayAct(deps: Pick<PanelHandlerDeps, "getSettings" | "settingsKnown">): boolean {
	return deps.settingsKnown?.() !== false && deps.getSettings().enabled;
}
