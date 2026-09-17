import { BRIDGE_KINDS, type PageBridge } from "@content/adapters/adapter";
import type { GamePortCommand } from "@core/constants/messages";
import type { MoveListRating } from "@core/constants/move-quality";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";

/** Retains a game's log through page rerenders, separate from transient board effects. */
export function createMoveListRatings(bridge: PageBridge) {
	let gameId: string | null = null;
	let enabled = false;
	let disposed = false;
	const rows = new Map<number, MoveListRating>();
	const sync = (): void => {
		void bridge
			.call(
				BRIDGE_KINDS.moveListRatings,
				enabled ? [...rows.values()] : [],
				TIMINGS.adapterBridgeTimeoutMs
			)
			.catch((error: unknown) => log.debug("move-list annotations: bridge unavailable", error));
	};
	const off = bridge.on(BRIDGE_KINDS.ready, () => {
		if (!disposed) sync();
	});
	return {
		setGame(id: string): void {
			if (id === gameId) return;
			gameId = id;
			rows.clear();
			sync();
		},
		setEnabled(on: boolean): void {
			if (on === enabled) return;
			enabled = on;
			sync();
		},
		apply(cmd: GamePortCommand): boolean {
			if (cmd.kind !== "moveListRating") return false;
			if (disposed || cmd.gameId !== gameId) return true;
			rows.set(cmd.rating.ply, cmd.rating);
			if (enabled) sync();
			return true;
		},
		dispose(): void {
			disposed = true;
			enabled = false;
			rows.clear();
			off();
			sync();
		},
	};
}
