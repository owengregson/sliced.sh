// src/page/chesscom-bridge/game.ts
/**
 * The bridge's hold on the site's board: find the first board in the ladder that carries the
 * `game` API, read its state into a wire record, subscribe to its events (re-attaching when the
 * page swaps the game or the element), and start only once the board exists — the window
 * listeners go in after that and not before (§13.3).
 */

import { BRIDGE_WIRE as W } from "@core/constants/bridge";
import { type Expression, js, type Statement } from "@pagescript";
import {
	cursorListeners,
	KINDS,
	listen,
	min,
	post,
	postExpr,
	safe,
	setTimeout_,
} from "../bridge-common";

const doc = js.id("document");
const game = js.id("game");
const board = js.id("board");
const keys = js.id("keys");
const el = js.id("el");
const undef = js.undef();

const gameCall = (method: string, ...args: Parameters<typeof js.call>[1][]) =>
	js.call(js.member(game, method), ...args);

/** Closure slots: the attached board and game, our marking keys, the event unbinders, the retry wait. */
export function bridgeState(retryMs: Expression): Statement[] {
	return [
		js.let_("board", js.nil()),
		js.let_("game", js.nil()),
		js.let_("keys", js.arr()),
		js.let_("unbind", js.arr()),
		js.let_("listenerToken", js.nil()),
		js.let_("wait", retryMs),
	];
}

/** `find`, `lastMove`, `state`, `emit`, `attach` and `sync`, in that order. */
export function gameRoutines(p: { boardSelectors: Expression }): Statement[] {
	return [
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
					js.forOf("stop", js.id("unbind"), [js.expr(safe(js.call(js.id("stop"))))]),
					js.assign(js.id("unbind"), js.arr()),
					js.assign(board, el),
					js.assign(game, js.member(el, "game")),
					js.assign(keys, js.arr()),
					js.const_("attachedGame", game),
					js.const_("token", js.obj({})),
					js.assign(js.id("listenerToken"), js.id("token")),
					js.const_(
						"sub",
						js.arrow(
							["type", "k"],
							[
								js.const_(
									"listener",
									js.arrow(
										[],
										[
											js.if_(js.op(js.id("listenerToken"), "===", js.id("token")), [
												js.expr(js.call(js.id("emit"), js.id("k"))),
											]),
										]
									)
								),
								js.const_("stop", safe(gameCall("on", js.id("type"), js.id("listener")))),
								js.if_(
									js.op(js.typeof_(js.id("stop")), "===", js.str("function")),
									[js.expr(js.call(js.member(js.id("unbind"), "push"), js.id("stop")))],
									[
										js.if_(
											js.op(js.typeof_(js.member(js.id("attachedGame"), "off")), "===", js.str("function")),
											[
												js.expr(
													js.call(
														js.member(js.id("unbind"), "push"),
														js.arrow(
															[],
															safe(
																js.call(js.member(js.id("attachedGame"), "off"), js.id("type"), js.id("listener"))
															)
														)
													)
												),
											]
										),
									]
								),
							]
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
		js.const_(
			"sync",
			js.arrow(
				[],
				[
					js.const_(
						"el",
						js.cond(js.and(board, js.member(board, "isConnected")), board, js.call(js.id("find")))
					),
					js.if_(
						js.and(
							el,
							js.and(
								js.member(el, "game"),
								js.or(js.op(el, "!==", board), js.op(js.member(el, "game"), "!==", game))
							)
						),
						[js.expr(js.call(js.id("attach"), el)), js.ret(js.bool(true))]
					),
					js.ret(js.bool(false)),
				]
			)
		),
	];
}

/** `watch`, `start` and the `customElements.whenDefined` boot that runs `start`. */
export function startRoutines(p: {
	boardTag: Expression;
	peer: Expression;
	retryMaxMs: Expression;
}): Statement[] {
	return [
		js.const_(
			"watch",
			js.arrow(
				[],
				[js.if_(js.call(js.id("sync")), [js.expr(js.call(js.id("emit"), js.str(KINDS.load)))])]
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
	];
}
