// src/page/chesscom-bridge/commands.ts
/**
 * The bridge's command table: every request the content script can send and what the page side
 * does about it. The table runs after `sync` has re-located the board (`defineHandle`'s
 * `before`), so every case sees the current game.
 */

import { BRIDGE_WIRE as W } from "@core/constants/bridge";
import { type Expression, js } from "@pagescript";
import { type DispatchCase, KINDS, NAMES, orEmpty, post, safe } from "../bridge-common";
import { effects } from "../effects-overlay";
import { overlay } from "../highlight-overlay";
import { cursor } from "../virtual-cursor";

const game = js.id("game");
const keys = js.id("keys");
const i = js.id("i");
const q = js.id("q");

const gameCall = (method: string, ...args: Parameters<typeof js.call>[1][]) =>
	js.call(js.member(game, method), ...args);

export function bridgeCommands(p: { colors: Expression }): DispatchCase[] {
	return [
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
		// The board-effect layer is its own element with its own lifetime: a `clear` of the
		// recommendation mark leaves it alone, and this leaves the mark alone.
		{
			kind: KINDS.moveListRatings,
			body: [js.expr(js.call(js.id("mlUpdate"), q)), post(KINDS.moveListRatings, i, js.nil())],
		},
		{ kind: KINDS.effects, body: [post(KINDS.effects, i, effects.draw(q))] },
		{
			kind: KINDS.effectsClear,
			body: [effects.clear(), post(KINDS.effectsClear, i, js.nil())],
		},
		{ kind: KINDS.cursor, body: [post(KINDS.cursor, i, js.id(NAMES.cursor))] },
		// Fix D, fire-and-forget (no reply): the mirror of the hand's own pointer. One
		// command per dispatched point, so a reply each would double the traffic.
		{ kind: KINDS.cursorTo, body: [cursor.to(q)] },
		{ kind: KINDS.cursorHide, body: [cursor.hide()] },
		{ kind: KINDS.cursorPrepare, body: [post(KINDS.cursorPrepare, i, cursor.prepare(q))] },
	];
}
