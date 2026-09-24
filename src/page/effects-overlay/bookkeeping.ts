// src/page/effects-overlay/bookkeeping.ts
/**
 * The live lists behind the effect layer (2026-09-13 revision): every effect group and every
 * chip is an entry `{ node, anims }` in `efLive` / `efChips` that animates in, holds, fades and
 * removes itself. The lists exist for two things — the caps (`BOARD_EFFECT_LIMITS.maxLiveGroups`
 * / `maxLiveChips`, oldest evicted first) and the static path (no motion: nothing removes itself,
 * so the next batch replaces the layer as it always did).
 */

import { type Expression, js, type Statement } from "@pagescript";
import { callm, id, n } from "../parts/ast";

export const LIVE = id("efLive");
export const CHIPS = id("efChips");

/** `let`/`const` slots of the layer's closure state, in declaration order. */
export function bookkeepingState(): Statement[] {
	return [
		js.const_("efLive", js.arr()),
		js.const_("efChips", js.arr()),
		js.let_("efMark", js.nil()),
		js.let_("efChipMark", js.nil()),
		js.let_("efElement", js.nil()),
	];
}

/**
 * `efDrop(entry)` cancels an entry's animations and takes its node off the layer; `efForget(list,
 * node)` forgets a node that removed itself; `efTrim(list, max)` evicts the oldest entries beyond
 * `max`; `efAnimate(node, frames, options, into)` starts an animation and records it in `into`.
 */
export function bookkeepingRoutines(): Statement[] {
	const entry = id("entry");
	const efDrop = js.const_(
		"efDrop",
		js.arrow(
			["entry"],
			[
				js.forOf("animation", js.member(entry, "anims"), [js.expr(callm(id("animation"), "cancel"))]),
				js.assign(js.member(entry, "anims", "length"), n(0)),
				js.expr(callm(js.member(entry, "node"), "remove")),
			]
		)
	);
	const efForget = js.const_(
		"efForget",
		js.arrow(
			["list", "node"],
			[
				js.const_(
					"at",
					callm(
						id("list"),
						"findIndex",
						js.arrow(["entry"], [js.ret(js.op(js.member(entry, "node"), "===", id("node")))])
					)
				),
				js.if_(js.op(id("at"), ">=", n(0)), [js.expr(callm(id("list"), "splice", id("at"), n(1)))]),
			]
		)
	);
	const efTrim = js.const_(
		"efTrim",
		js.arrow(
			["list", "max"],
			[
				js.while_(js.op(js.member(id("list"), "length"), ">", id("max")), [
					js.expr(js.call(id("efDrop"), callm(id("list"), "shift"))),
				]),
			]
		)
	);
	const efAnimate = js.const_(
		"efAnimate",
		js.arrow(
			["node", "frames", "options", "into"],
			[
				js.const_("animation", callm(id("node"), "animate", id("frames"), id("options"))),
				js.expr(callm(id("into"), "push", id("animation"))),
				js.ret(id("animation")),
			]
		)
	);
	return [efDrop, efForget, efTrim, efAnimate];
}

/** `for (const entry of list.splice(0)) efDrop(entry);` */
export const flush = (list: Expression): Statement =>
	js.forOf("entry", callm(list, "splice", n(0)), [js.expr(js.call(id("efDrop"), id("entry")))]);

/** When `animation` finishes, the node removes itself and leaves `list`. */
export const forgetOnFinish = (
	animation: Expression,
	list: Expression,
	node: Expression
): Statement =>
	js.expr(
		callm(
			js.member(animation, "finished"),
			"then",
			js.arrow([], [js.expr(callm(node, "remove")), js.expr(js.call(id("efForget"), list, node))]),
			js.arrow([], [])
		)
	);
