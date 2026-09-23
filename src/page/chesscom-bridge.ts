// src/page/chesscom-bridge.ts
/**
 * `chesscom-bridge` (§5.5, Appendix C §1.7–1.8): MAIN-world content script
 * that waits for `customElements.whenDefined(<board tag>)` and the board
 * element (retry with backoff), then relays `Move` / `Load` / `CreateGame` /
 * `ModeChanged` / `GameOver` from `board.game` to the ISOLATED world and
 * answers `getState`, `draw`, `clear`, `legalMoves`, `cursor`.
 *
 * Presence (§13.3): no `window` property (state in this closure), no DOM
 * insertion unless `draw` arrives and native markings are unavailable
 * (overlay fallback), no window listener before the board exists,
 * single-letter wire fields (`BRIDGE_WIRE`), no literal
 * selector / colour / token (all bound from `SELECTORS`, `TOKENS`,
 * `deriveToken` by the generator). The manifest injects this program on every
 * chess.com page; it stays silent until the board element exists.
 */

import { defineProgram, js } from "@pagescript";
import { cursorState, defineHandle, definePost, defineSafe } from "./bridge-common";
import { bridgeCommands } from "./chesscom-bridge/commands";
import { bridgeState, gameRoutines, startRoutines } from "./chesscom-bridge/game";
import { effectsStatements } from "./effects-overlay";
import { overlayStatements } from "./highlight-overlay";
import { moveListStatements } from "./move-list-ratings";
import { cursorStatements } from "./virtual-cursor";

export const chesscomBridge = defineProgram({
	name: "chesscom-bridge",
	params: {
		token: "string",
		peer: "string",
		boardTag: "string",
		boardSelectors: "json",
		overlayClass: "string",
		colors: "json",
		retryMs: "number",
		retryMaxMs: "number",
		cursorClass: "string",
		cursorFadeMs: "number",
		cursorAccent: "string",
		effectsClass: "string",
		effectPalette: "json",
		effectStyles: "json",
		qualityIcons: "json",
		moveListClass: "string",
		moveListConfig: "json",
	},
	entry: true,
	build: (p) =>
		js.program([
			definePost(p.token),
			defineSafe(),
			cursorState(),
			...bridgeState(p.retryMs),
			...overlayStatements({ hosts: p.boardSelectors, cls: p.overlayClass, colors: p.colors }),
			...effectsStatements({
				hosts: p.boardSelectors,
				cls: p.effectsClass,
				palette: p.effectPalette,
				styles: p.effectStyles,
				icons: p.qualityIcons,
			}),
			...moveListStatements(p.moveListConfig, p.moveListClass, p.qualityIcons),
			...cursorStatements({ cls: p.cursorClass, fadeMs: p.cursorFadeMs, accent: p.cursorAccent }),
			...gameRoutines(p),
			defineHandle(bridgeCommands(p), [
				// The computer page can replace the game while retaining the board element.
				js.expr(js.call(js.id("sync"))),
			]),
			...startRoutines(p),
		]),
});
