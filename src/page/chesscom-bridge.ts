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

import { BRIDGE_WIRE as W } from "@core/constants/bridge";
import { defineProgram, js } from "@pagescript";
import {
	cursorListeners,
	cursorState,
	defineHandle,
	definePost,
	defineSafe,
	KINDS,
	listen,
	min,
	NAMES,
	orEmpty,
	post,
	postExpr,
	safe,
	setTimeout_,
} from "./bridge-common";
import { overlay, overlayStatements } from "./highlight-overlay";
import { cursor, cursorStatements } from "./virtual-cursor";

const doc = js.id("document");
const game = js.id("game");
const board = js.id("board");
const keys = js.id("keys");
const i = js.id("i");
const q = js.id("q");
const el = js.id("el");
const undef = js.undef();

const gameCall = (method: string, ...args: Parameters<typeof js.call>[1][]) =>
	js.call(js.member(game, method), ...args);

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
	},
	entry: true,
	build: (p) =>
		js.program([
			definePost(p.token),
			defineSafe(),
			cursorState(),
			js.let_("board", js.nil()),
			js.let_("game", js.nil()),
			js.let_("keys", js.arr()),
			js.let_("wait", p.retryMs),
			...overlayStatements({ hosts: p.boardSelectors, cls: p.overlayClass, colors: p.colors }),
			...cursorStatements({ cls: p.cursorClass, fadeMs: p.cursorFadeMs }),
			// first board element (in ladder order) that carries the `game` API
			js.const_(
				"find",
				js.arrow(
					[],
					[
						js.forOf("s", p.boardSelectors, [
							js.const_("el", js.call(js.member(doc, "querySelector"), js.id("s"))),
							js.if_(js.and(el, js.member(el, "game")), [js.ret(el)]),
						]),
						js.ret(js.nil()),
					]
				)
			),
			js.const_(
				"lastMove",
				js.arrow(
					[],
					[
						js.const_("lm", safe(gameCall("getLastMove"))),
						js.if_(js.not(js.id("lm")), [js.ret(js.nil())]),
						js.ret(
							js.obj({
								[W.from]: js.member(js.id("lm"), "from"),
								[W.to]: js.member(js.id("lm"), "to"),
								[W.san]: js.member(js.id("lm"), "san"),
							})
						),
					]
				)
			),
			js.const_(
				"state",
				js.arrow(
					[],
					[
						js.if_(js.not(game), [js.ret(js.nil())]),
						js.const_("res", safe(gameCall("getResult"))),
						js.ret(
							js.obj({
								[W.position]: safe(gameCall("getFEN")),
								[W.turn]: safe(gameCall("getTurn")),
								[W.playingAs]: safe(gameCall("getPlayingAs")),
								[W.mode]: safe(js.member(gameCall("getMode"), "name")),
								[W.flipped]: safe(js.member(gameCall("getOptions"), "flipped")),
								[W.lastMove]: js.call(js.id("lastMove")),
								[W.timeControl]: safe(js.call(js.member(game, "timeControl", "get"))),
								[W.timestamps]: safe(js.call(js.member(game, "timestamps", "get"))),
								[W.gameOver]: safe(gameCall("isGameOver")),
								[W.result]: js.cond(
									js.op(js.typeof_(js.id("res")), "===", js.str("string")),
									js.id("res"),
									js.nil()
								),
							})
						),
					]
				)
			),
			js.const_(
				"emit",
				js.arrow(
					["k"],
					[
						js.const_("st", js.call(js.id("state"))),
						postExpr(js.id("k"), undef, js.id("st")),
						js.if_(js.and(js.id("st"), js.member(js.id("st"), W.gameOver)), [
							post(KINDS.gameover, undef, js.id("st")),
						]),
					]
				)
			),
			js.const_(
				"attach",
				js.arrow(
					["el"],
					[
						js.assign(board, el),
						js.assign(game, js.member(el, "game")),
						js.assign(keys, js.arr()),
						js.const_(
							"sub",
							js.arrow(
								["type", "k"],
								safe(gameCall("on", js.id("type"), js.arrow([], js.call(js.id("emit"), js.id("k")))))
							)
						),
						js.expr(js.call(js.id("sub"), js.str("Move"), js.str(KINDS.move))),
						js.expr(js.call(js.id("sub"), js.str("Load"), js.str(KINDS.load))),
						js.expr(js.call(js.id("sub"), js.str("CreateGame"), js.str(KINDS.load))),
						js.expr(js.call(js.id("sub"), js.str("ModeChanged"), js.str(KINDS.state))),
						js.expr(js.call(js.id("sub"), js.str("GameOver"), js.str(KINDS.gameover))),
					]
				)
			),
			defineHandle(
				[
					{ kind: KINDS.getState, body: [post(KINDS.state, i, js.call(js.id("state")))] },
					{
						kind: KINDS.draw,
						body: [
							js.const_("out", js.arr()),
							// Native markings are the default; `forceOverlay` takes the overlay branch even
							// when they exist, because a mark the site owns does not survive the board's own
							// left press and the hand's action is nothing but presses.
							js.if_(
								js.and(
									game,
									js.and(js.member(game, "markings"), js.and(q, js.not(js.member(q, W.forceOverlay))))
								),
								[
									js.let_("n", js.num(0)),
									js.forOf("h", orEmpty(js.member(q, W.highlights)), [
										js.const_(
											"key",
											safe(
												js.call(
													js.member(game, "markings", "addOne"),
													js.obj({
														type: js.str("highlight"),
														data: js.obj({
															square: js.member(js.id("h"), W.square),
															color: js.or(
																js.member(js.id("h"), W.color),
																js.cond(
																	js.op(js.id("n"), "===", js.num(0)),
																	js.member(p.colors, "from"),
																	js.member(p.colors, "to")
																)
															),
														}),
													})
												)
											)
										),
										js.assign(js.id("n"), js.op(js.id("n"), "+", js.num(1))),
										js.if_(js.id("key"), [js.expr(js.call(js.member(js.id("out"), "push"), js.id("key")))]),
									]),
									js.forOf("a", orEmpty(js.member(q, W.arrows)), [
										js.const_(
											"key",
											safe(
												js.call(
													js.member(game, "markings", "addOne"),
													js.obj({
														type: js.str("arrow"),
														data: js.obj({
															from: js.member(js.id("a"), W.from),
															to: js.member(js.id("a"), W.to),
															color: js.or(js.member(js.id("a"), W.color), js.member(p.colors, "arrow")),
														}),
													})
												)
											)
										),
										js.if_(js.id("key"), [js.expr(js.call(js.member(js.id("out"), "push"), js.id("key")))]),
									]),
									js.expr(js.call(js.member(keys, "push"), js.spread(js.id("out")))),
								],
								[
									// The overlay replaces, in this one call: a mark of ours drawn natively is
									// removed here rather than by a separate `clear` request, so the board is
									// never unmarked for a frame — which is the one moment the owner is
									// watching (the hand is already acting by the time this arrives).
									js.if_(js.and(game, js.member(game, "markings")), [
										js.forOf("key", keys, [
											js.expr(safe(js.call(js.member(game, "markings", "removeOne"), js.id("key")))),
										]),
										js.assign(keys, js.arr()),
									]),
									overlay.draw(q),
								]
							),
							post(KINDS.draw, i, js.obj({ [W.keys]: js.id("out") })),
						],
					},
					{
						kind: KINDS.clear,
						body: [
							// only keys we added: the request may name a subset, else everything of ours
							js.const_("want", js.or(js.and(q, js.member(q, W.keys)), keys)),
							js.forOf("key", js.id("want"), [
								js.if_(js.op(js.call(js.member(keys, "indexOf"), js.id("key")), ">=", js.num(0)), [
									js.expr(safe(js.call(js.member(game, "markings", "removeOne"), js.id("key")))),
								]),
							]),
							js.assign(
								keys,
								js.call(
									js.member(keys, "filter"),
									js.arrow(
										["key"],
										js.op(js.call(js.member(js.id("want"), "indexOf"), js.id("key")), "<", js.num(0))
									)
								)
							),
							overlay.clear(),
							post(KINDS.clear, i, js.nil()),
						],
					},
					{
						kind: KINDS.legalMoves,
						body: [
							js.const_("list", orEmpty(safe(gameCall("getLegalMoves")))),
							post(
								KINDS.legalMoves,
								i,
								js.call(
									js.member(js.id("list"), "map"),
									js.arrow(
										["mv"],
										js.obj({
											[W.from]: js.member(js.id("mv"), "from"),
											[W.to]: js.member(js.id("mv"), "to"),
											[W.promotion]: js.member(js.id("mv"), "promotion"),
											[W.san]: js.member(js.id("mv"), "san"),
										})
									)
								)
							),
						],
					},
					{ kind: KINDS.cursor, body: [post(KINDS.cursor, i, js.id(NAMES.cursor))] },
					// Fix D, fire-and-forget (no reply): the mirror of the hand's own pointer. One
					// command per dispatched point, so a reply each would double the traffic.
					{ kind: KINDS.cursorTo, body: [cursor.to(q)] },
					{ kind: KINDS.cursorHide, body: [cursor.hide()] },
				],
				[
					// the SPA may have replaced the board since we attached
					js.if_(js.or(js.not(board), js.not(js.member(board, "isConnected"))), [
						js.const_("el", js.call(js.id("find"))),
						js.if_(js.and(el, js.op(el, "!==", board)), [js.expr(js.call(js.id("attach"), el))]),
					]),
				]
			),
			js.const_(
				"watch",
				js.arrow(
					[],
					[
						js.if_(js.and(board, js.member(board, "isConnected")), [js.ret()]),
						js.const_("el", js.call(js.id("find"))),
						js.if_(js.and(el, js.op(el, "!==", board)), [
							js.expr(js.call(js.id("attach"), el)),
							js.expr(js.call(js.id("emit"), js.str(KINDS.load))),
						]),
					]
				)
			),
			js.const_(
				"start",
				js.arrow(
					[],
					[
						js.const_("el", js.call(js.id("find"))),
						js.if_(js.not(el), [
							setTimeout_(js.id("start"), js.id("wait")),
							js.assign(js.id("wait"), min(js.op(js.id("wait"), "*", js.num(2)), p.retryMaxMs)),
							js.ret(),
						]),
						js.expr(js.call(js.id("attach"), el)),
						// the site is confirmed: only now touch window listeners
						...cursorListeners(),
						listen(p.peer),
						js.expr(
							js.call(
								js.member(js.new_(js.id("MutationObserver"), js.id("watch")), "observe"),
								js.member(doc, "documentElement"),
								js.obj({ childList: js.bool(true), subtree: js.bool(true) })
							)
						),
						post(KINDS.ready, undef, js.call(js.id("state"))),
					]
				)
			),
			js.if_(js.op(js.typeof_(js.id("customElements")), "===", js.str("undefined")), [js.ret()]),
			js.expr(
				js.call(
					js.member(js.call(js.member(js.id("customElements"), "whenDefined"), p.boardTag), "then"),
					js.id("start"),
					js.arrow([], [])
				)
			),
		]),
});
