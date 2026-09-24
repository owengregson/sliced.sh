/** Cursor artwork feedback and a short ghost trail, driven by dispatched points only. */
import { BRIDGE_WIRE as W } from "@core/constants/bridge";
import { CURSOR_EFFECTS as E } from "@core/constants/cursor";
import { HIGHLIGHT_MOTION } from "@core/constants/timings";
import { js, type Statement } from "@pagescript";
import { artworkRoutine } from "./cursor-effects/artwork";
import { CURSOR_FEEDBACK, type CursorEffectParams } from "./cursor-effects/params";
import { distance, trailRoutines } from "./cursor-effects/trail";
import { callm as call, id, n, run, s } from "./parts/ast";

const doc = id("document");

export { CURSOR_FEEDBACK, type CursorEffectParams } from "./cursor-effects/params";

export function cursorEffectStatements(p: CursorEffectParams): Statement[] {
	const stop = js.const_(
		"curFxStop",
		js.arrow(
			["node"],
			[
				js.if_(
					js.and(
						id("node"),
						js.op(js.typeof_(js.member(id("node"), "getAnimations")), "===", s("function"))
					),
					[
						js.forOf("animation", call(id("node"), "getAnimations"), [
							js.expr(call(id("animation"), "cancel")),
						]),
					]
				),
			]
		)
	);
	const find = js.const_(
		"curFxFind",
		js.arrow([], call(doc, "querySelector", js.tpl([".", "e"], p.cls)))
	);
	const clearTrail = js.const_(
		"curFxClearTrail",
		js.arrow(
			[],
			[
				js.assign(id("curFxTrailAnimation"), js.nil()),
				js.const_("layer", run("curFxFind")),
				js.if_(id("layer"), [
					js.expr(run("curFxStop", id("layer"))),
					js.expr(call(id("layer"), "remove")),
				]),
				js.assign(id("curFxPoints"), js.arr()),
			]
		)
	);
	const clear = js.const_(
		CURSOR_FEEDBACK.clear,
		js.arrow(
			[],
			[
				js.expr(run("curFxClearTrail")),
				js.expr(run("curFxStop", id("curFxArt"))),
				js.expr(run("curFxStop", id("curFxGlow"))),
				js.assign(id("curFxArt"), js.nil()),
				js.assign(id("curFxGlow"), js.nil()),
				js.assign(id("curFxDown"), js.bool(false)),
			]
		)
	);
	const update = js.const_(
		CURSOR_FEEDBACK.update,
		js.arrow(
			["q", "cursor"],
			[
				js.const_("point", js.arr(js.member(id("q"), W.x), js.member(id("q"), W.y))),
				js.const_("down", js.not(js.not(js.member(id("q"), W.down)))),
				// Off when the owner turned the effects off, when the page prefers reduced motion, or
				// when the document cannot animate at all: the plain arrow is all that is drawn then.
				js.const_(
					"motion",
					js.and(
						js.and(
							js.op(js.member(id("q"), W.effects), "!==", js.bool(false)),
							js.op(js.typeof_(js.member(doc, "documentElement", "animate")), "===", s("function"))
						),
						js.not(
							js.and(
								js.member(id("window"), "matchMedia"),
								js.member(
									call(id("window"), "matchMedia", s(HIGHLIGHT_MOTION.reducedMotionQuery)),
									"matches"
								)
							)
						)
					)
				),
				js.expr(run("curFxArtwork", id("cursor"), id("down"), id("motion"))),
				js.assign(id("curFxDown"), id("down")),
				js.if_(js.not(id("motion")), [js.expr(run("curFxClearTrail")), js.ret()]),
				js.const_("previous", call(id("curFxPoints"), "at", n(-1))),
				js.if_(js.not(id("previous")), [
					js.expr(call(id("curFxPoints"), "push", id("point"))),
					js.ret(),
				]),
				js.const_("distance", distance(id("point"), id("previous"))),
				js.if_(js.op(id("distance"), ">", n(E.jumpDistancePx)), [
					js.expr(run("curFxClearTrail")),
					js.expr(call(id("curFxPoints"), "push", id("point"))),
					js.ret(),
				]),
				js.if_(js.op(id("distance"), "<", n(E.minDistancePx)), [js.ret()]),
				js.expr(call(id("curFxPoints"), "push", id("point"))),
				js.expr(run("curFxTrim")),
				js.expr(run("curFxDrawTrail", id("cursor"))),
			]
		)
	);
	return [
		js.let_("curFxPoints", js.arr()),
		js.let_("curFxDown", js.bool(false)),
		js.let_("curFxArt", js.nil()),
		js.let_("curFxGlow", js.nil()),
		js.let_("curFxTrailAnimation", js.nil()),
		stop,
		find,
		clearTrail,
		clear,
		...trailRoutines(p),
		artworkRoutine(p),
		update,
	];
}
