// test/panel/fixtures.ts — `PanelSnapshot` builders for panel tests.
import { DEFAULT_SETTINGS, type PanelSnapshot } from "@core/constants";
import type { GameSessionState, Site } from "@typedefs/game";
import type { LicenseState } from "@typedefs/settings";

export interface SnapshotOverrides {
	license?: LicenseState["status"];
	site?: Site | null;
	state?: GameSessionState;
	settings?: Partial<PanelSnapshot["settings"]>;
	armed?: boolean;
}

export function makeSnapshot(o: SnapshotOverrides = {}): PanelSnapshot {
	const site = o.site === undefined ? "lichess" : o.site;
	const state = o.state ?? "waiting-for-game";
	const live = state.startsWith("live:");
	return {
		license: { status: o.license ?? "valid", checkedAt: 1 },
		site,
		pageKind: site === null ? "other" : live ? "live-game" : "live-lobby",
		session: {
			state,
			gameId: live ? "g1" : null,
			site,
			pageKind: site === null ? "other" : live ? "live-game" : "live-lobby",
			myColor: live ? "w" : null,
			sideToMove: live ? "w" : null,
			ply: live ? 10 : 0,
			clocks: null,
			hand: "resting",
		},
		engine: { state: "ready", variant: "smallnet", threads: 1, nnue: [], version: "18" },
		executor: { debuggerAttached: false },
		settings: { ...DEFAULT_SETTINGS, ...o.settings },
		autoMove: { armed: o.armed ?? false },
		stats: { games: 0, moves: 0, avgThinkMs: 0 },
		focus: {
			pageHasFocus: true,
			blurSeenThisMove: false,
			handsOff: false,
			realPointerEventsDuringHand: 0,
		},
	};
}
