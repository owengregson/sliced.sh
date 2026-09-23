// src/page/verify-move-probe.ts
/**
 * `verify-move-probe` (§5.5): reads the last move from site state for the
 * executor's verification when the game port is slow. CDP `Runtime.evaluate`
 * (`returnByValue: true`), a single IIFE expression (no top-level `return`)
 * returning `{ lastMove: { from, to, san } | null, ply: number | null,
 * position: string | null }`.
 *
 * `board.game.getLastMove()` / `getHistorySANs().length` / `getFEN()` from the
 * first board in the bound ladder that carries the API; when no board does,
 * the probe returns the null shape and the executor falls back to the port.
 */

import { defineProgram, js } from "@pagescript";
import { defineSafe, safe } from "./bridge-common";

const doc = js.id("document");
const el = js.id("el");
const game = js.id("game");
const lm = js.id("lm");

export const verifyMoveProbe = defineProgram({
	name: "verify-move-probe",
	params: { boardSelectors: "json" },
	build: (p) =>
		js.program([
			js.expr(
				js.iife([
					defineSafe(),
					js.const_("empty", js.obj({ lastMove: js.nil(), ply: js.nil(), position: js.nil() })),
					js.let_("game", js.nil()),
					js.forOf("s", p.boardSelectors, [
						js.const_("el", js.call(js.member(doc, "querySelector"), js.id("s"))),
						js.if_(js.and(el, js.member(el, "game")), [
							js.assign(game, js.member(el, "game")),
							js.const_("lm", safe(js.call(js.member(game, "getLastMove")))),
							js.const_("sans", safe(js.call(js.member(game, "getHistorySANs")))),
							js.ret(
								js.obj({
									lastMove: js.cond(
										lm,
										js.obj({
											from: js.member(lm, "from"),
											to: js.member(lm, "to"),
											san: js.member(lm, "san"),
										}),
										js.nil()
									),
									ply: js.cond(js.id("sans"), js.member(js.id("sans"), "length"), js.nil()),
									position: safe(js.call(js.member(game, "getFEN"))),
								})
							),
						]),
					]),
					js.ret(js.id("empty")),
				])
			),
		]),
});
