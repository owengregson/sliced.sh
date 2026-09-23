/**
 * Every game-port command, routed to the part that owns it. The settings-driven layers each
 * claim their own commands first (`apply` returns whether it was theirs):
 *   - `highlight` / `arrow` / `clearHighlight` apply only while `settings` has turned
 *     `highlightMoves` on (off until it arrives);
 *   - `effects` / `clearEffects` — the board-effect layer for the move that just landed — draw
 *     the rays only while `boardEffects` is on and the rating chip only while `moveRatings` is on,
 *     each independently (both off until `settings` arrives); a separate page element from the
 *     recommendation mark, and neither clear touches the other;
 *   - the move-list ratings and the pointer mirror (`cursorTo` / `cursorHide`).
 * `speak` is relayed to the service worker (TTS lives there, `tts-relay.ts`).
 */

import type { BoardEffects } from "@content/board-effects";
import type { FreeTitleBadges } from "@content/free-title";
import type { Highlights } from "@content/highlights";
import type { MoveListRatings } from "@content/move-list-ratings";
import { relaySpeak } from "@content/tts-relay";
import type { GamePortCommand, GamePortMessage } from "@core/constants/messages";
import type { ControlReads } from "./control-reads";
import type { CursorBinding } from "./cursor-binding";
import type { InputShield } from "./input-shield";
import type { Responders } from "./responders";

export interface CommandRouterDeps {
	binding: CursorBinding;
	shield: InputShield;
	highlights: Highlights;
	boardEffects: BoardEffects;
	moveListRatings: MoveListRatings;
	freeTitle: FreeTitleBadges;
	responders: Responders;
	controls: ControlReads;
	post(msg: GamePortMessage): void;
	disposed(): boolean;
}

export function createCommandRouter(deps: CommandRouterDeps): (cmd: GamePortCommand) => void {
	const { binding, shield, highlights, boardEffects, moveListRatings, responders, post } = deps;
	const virtualCursor = shield.virtualCursor;
	const cursor = binding.tracker;
	return (cmd) => {
		if (deps.disposed()) return;
		if (cmd.kind === "settings") {
			deps.freeTitle.set(cmd.freeTitle ?? null);
			shield.setQueueInput(cmd.queueInput === true);
			shield.releaseIfOffGamePage();
		}
		if (highlights.apply(cmd)) return;
		if (boardEffects.apply(cmd)) return;
		if (moveListRatings.apply(cmd)) return;
		if (virtualCursor.apply(cmd)) return;
		switch (cmd.kind) {
			case "inputOwnership":
				// Not a game page: answered as not owned, whatever the worker believes.
				shield.setOwned(cmd.owned);
				return;
			case "cursorDelivery":
				post({
					kind: "cursorDelivered",
					id: cmd.id,
					delivered: cursor.virtualPointerDelivered(cmd.pointer),
				});
				return;
			case "keybinds":
				binding.keybinds = cmd.keybinds;
				return;
			case "settings":
				highlights.setEnabled(cmd.highlightMoves);
				boardEffects.setEnabled(cmd.boardEffects === true);
				boardEffects.setRatingsEnabled(cmd.moveRatings === true);
				moveListRatings.setEnabled(cmd.moveRatings === true);
				boardEffects.setSoundsEnabled(cmd.moveRatingSounds === true);
				boardEffects.setForcedMateSoundsEnabled(cmd.forcedMateSounds === true);
				return;
			case "startNewGame":
				deps.controls.startNewGame(cmd);
				return;
			case "resign":
				deps.controls.resign(cmd);
				return;
			case "rematch":
				deps.controls.rematch(cmd);
				return;
			case "speak":
				relaySpeak(cmd);
				return;
			case "observeMove":
				responders.observeMove(cmd);
				return;
			case "geometry":
				responders.geometry(cmd);
				return;
			case "boardCheck":
				responders.boardCheck(cmd);
				return;
			case "cursorPrepare":
				void virtualCursor.prepare(cmd.pointer).then((ready) => {
					if (!ready || deps.disposed()) return;
					cursor.prepareVirtualPointer(cmd.pointer);
					post({ kind: "cursorPrepared", id: cmd.id });
				});
				return;
			case "cursorProbe":
				responders.cursorProbe(cmd.id);
				return;
			default:
				return;
		}
	};
}
