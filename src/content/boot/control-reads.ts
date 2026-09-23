/**
 * `startNewGame` / `resign` / `rematch`: passive reads of where a site control is, answered on
 * the game port — never a click; only the service worker performs native input. When the worker
 * names a point, the read waits for the mirror's hit-test shield to open there first.
 */

import type { SiteAdapter } from "@content/adapters/adapter";
import type { VirtualCursor } from "@content/virtual-cursor";
import type { GamePortCommand, GamePortMessage } from "@core/constants/messages";
import { log } from "@core/logger";
import type { Pt } from "@core/motor/types";

type Command<K extends GamePortCommand["kind"]> = Extract<GamePortCommand, { kind: K }>;

export interface ControlReads {
	startNewGame(cmd: Command<"startNewGame">): void;
	resign(cmd: Command<"resign">): void;
	rematch(cmd: Command<"rematch">): void;
}

export interface ControlReadsDeps {
	adapter: SiteAdapter;
	virtualCursor: VirtualCursor;
	post(msg: GamePortMessage): void;
	disposed(): boolean;
}

export function createControlReads(deps: ControlReadsDeps): ControlReads {
	const { adapter, virtualCursor, post, disposed } = deps;

	/**
	 * The virtual pointer shield otherwise wins elementFromPoint. Open only its normal small
	 * hit-test aperture for this read; native input still needs separate admission.
	 */
	const whenReachable = (point: Pt | undefined, answer: (reachable: boolean) => void): void => {
		if (point)
			void virtualCursor
				.prepare({ type: "mouseMoved", ...point, buttons: 0, timestampMs: Date.now() })
				.then(answer);
		else answer(true);
	};

	return {
		startNewGame(cmd) {
			whenReachable(cmd.point, (reachable) => {
				if (disposed()) return;
				post({
					kind: "startNewGameResult",
					id: cmd.id,
					...(reachable
						? adapter.newGameTarget("new", cmd.gameId, cmd.targetId, cmd.point)
						: { status: "not-ready" as const }),
				});
			});
		},
		resign(cmd) {
			// A discovery that finds nothing is logged so the Engine view's log shows which step's
			// ladder missed on the real page (the open QA item).
			whenReachable(cmd.point, (reachable) => {
				if (disposed()) return;
				const result = reachable
					? adapter.resignTarget(cmd.step, cmd.targetId, cmd.point)
					: { status: "not-ready" as const };
				if (result.status === "not-ready" && cmd.targetId === undefined)
					log.info("content: no resign control found for this step", { step: cmd.step });
				post({ kind: "resignResult", id: cmd.id, ...result });
			});
		},
		rematch(cmd) {
			// The same passive read as `startNewGame` (2026-09-13): where the rematch control of
			// `action` is, plus whether the opponent's own offer is showing.
			whenReachable(cmd.point, (reachable) => {
				if (disposed()) return;
				const result = reachable
					? adapter.rematchTarget(cmd.action, cmd.targetId, cmd.point)
					: { status: "not-ready" as const };
				if (result.status === "not-ready" && cmd.targetId === undefined)
					log.info("content: no rematch control found for this action", { action: cmd.action });
				post({
					kind: "rematchResult",
					id: cmd.id,
					incoming: adapter.incomingRematch(),
					...result,
				});
			});
		},
	};
}
