// src/page/lichess-bridge.ts
/**
 * `lichess-bridge` (§5.5, Appendix C §2.6–2.8): MAIN-world content script
 * for lichess. Round pages expose no board API, so the bridge only
 * subscribes `window.lichess.events.on("ply")` when the public API appears
 * (retry with backoff, giving up after `TIMINGS.bridgeApiWaitMs`), answers
 * `getState` with `{ hasApi, apiPosition? }` (the chessground instance is
 * reachable on analysis pages only), draws / clears the highlight overlay,
 * and answers `cursor`. It installs nothing else.
 *
 * Presence (§13.3): no `window` property, no DOM insertion before `draw`,
 * single-letter wire fields, no literal selector / colour / token. Both
 * manifest bridges load on both sites; this one returns at once unless the
 * hostname is the bound lichess host.
 */

import { BRIDGE_WIRE as W } from "@core/constants/bridge";
import { defineProgram, js } from "@pagescript";
import {
	cursorStatements,
	defineHandle,
	definePost,
	defineSafe,
	focusStatements,
	KINDS,
	listen,
	min,
	NAMES,
	post,
	safe,
	setTimeout_,
} from "./bridge-common";
import { overlay, overlayStatements } from "./highlight-overlay";

const win = js.id("window");
const i = js.id("i");
const q = js.id("q");
const undef = js.undef();

export const lichessBridge = defineProgram({
	name: "lichess-bridge",
	params: {
		token: "string",
		peer: "string",
		host: "string",
		hosts: "json",
		overlayClass: "string",
		colors: "json",
		retryMs: "number",
		retryMaxMs: "number",
		apiWaitMs: "number",
	},
	entry: true,
	build: (p) =>
		js.program([
			js.const_("hn", js.member(js.id("location"), "hostname")),
			js.if_(
				js.and(
					js.op(js.id("hn"), "!==", p.host),
					js.not(js.call(js.member(js.id("hn"), "endsWith"), js.op(js.str("."), "+", p.host)))
				),
				[js.ret()]
			),
			definePost(p.token),
			defineSafe(),
			...cursorStatements(),
			...overlayStatements({ hosts: p.hosts, cls: p.overlayClass, colors: p.colors }),
			js.let_("wait", p.retryMs),
			js.let_("spent", js.num(0)),
			// the public API object, once its event bus exists
			js.const_(
				"api",
				js.arrow(
					[],
					[
						js.const_("l", js.member(win, "lichess")),
						js.ret(
							js.cond(
								js.and(
									js.and(js.id("l"), js.member(js.id("l"), "events")),
									js.op(js.typeof_(js.member(js.id("l"), "events", "on")), "===", js.str("function"))
								),
								js.id("l"),
								js.nil()
							)
						),
					]
				)
			),
			js.const_(
				"state",
				js.arrow(
					[],
					[
						js.const_("l", js.call(js.id("api"))),
						js.ret(
							js.obj({
								[W.hasApi]: js.op(js.id("l"), "!==", js.nil()),
								[W.apiPosition]: js.cond(
									js.and(
										js.id("l"),
										js.op(js.typeof_(js.member(js.id("l"), "chessground")), "===", js.str("function"))
									),
									safe(js.call(js.member(js.call(js.member(js.id("l"), "chessground")), "getFen"))),
									js.nil()
								),
							})
						),
					]
				)
			),
			js.const_(
				"subscribe",
				js.arrow(
					[],
					[
						js.const_("l", js.call(js.id("api"))),
						js.if_(js.id("l"), [
							js.expr(
								safe(
									js.call(
										js.member(js.id("l"), "events", "on"),
										js.str("ply"),
										js.arrow([], [post(KINDS.ply, undef, js.nil())])
									)
								)
							),
							post(KINDS.state, undef, js.call(js.id("state"))),
							js.ret(),
						]),
						js.if_(js.op(js.id("spent"), ">=", p.apiWaitMs), [js.ret()]),
						js.assign(js.id("spent"), js.op(js.id("spent"), "+", js.id("wait"))),
						setTimeout_(js.id("subscribe"), js.id("wait")),
						js.assign(js.id("wait"), min(js.op(js.id("wait"), "*", js.num(2)), p.retryMaxMs)),
					]
				)
			),
			defineHandle([
				{ kind: KINDS.getState, body: [post(KINDS.state, i, js.call(js.id("state")))] },
				{
					kind: KINDS.draw,
					body: [overlay.draw(q), post(KINDS.draw, i, js.obj({ [W.keys]: js.arr() }))],
				},
				{ kind: KINDS.clear, body: [overlay.clear(), post(KINDS.clear, i, js.nil())] },
				{ kind: KINDS.legalMoves, body: [post(KINDS.legalMoves, i, js.arr())] },
				{ kind: KINDS.cursor, body: [post(KINDS.cursor, i, js.id(NAMES.cursor))] },
			]),
			listen(p.peer),
			...focusStatements(),
			js.expr(js.call(js.id("subscribe"))),
			post(KINDS.ready, undef, js.call(js.id("state"))),
		]),
});
