// src/page/effects-overlay/badge.ts
/**
 * The verdict chip on the destination square: the move-quality artwork (`MOVE_QUALITY_ART`,
 * per-category colours from `MOVE_QUALITY_ICONS`) drawn into its own group, scaled in with an
 * overshoot, held, then faded out — or drawn once at rest without motion.
 */

import { BOARD_EFFECT_LIMITS as L } from "@core/constants/board-effects";
import { BRIDGE_WIRE as W } from "@core/constants/bridge";
import { MOVE_QUALITY_ART as ART, MOVE_QUALITY as Q } from "@core/constants/move-quality";
import { js, type Statement } from "@pagescript";
import { orEmpty } from "../bridge-common";
import { add, callm, id, n, s } from "../parts/ast";
import { setAttr as attr, svgEl as svg } from "../parts/svg";
import { CHIPS as chips, forgetOnFinish } from "./bookkeeping";
import type { EffectsParams } from "./names";

/** Chip life, and the four stops of its scale/fade. */
const CHIP_LIFE = Q.chipInMs + Q.chipHoldMs + Q.chipOutMs;
const CHIP_OVERSHOOT = (Q.chipInMs * Q.chipOvershootAt) / CHIP_LIFE;
const CHIP_SETTLED = Q.chipInMs / CHIP_LIFE;
const CHIP_HELD = (Q.chipInMs + Q.chipHoldMs) / CHIP_LIFE;
const CHIP_ORIGIN = `transform-origin:${ART.originX}px ${ART.originY}px`;

/** `efBadge(el, chip, black, motion)`: true when a chip was inserted. */
export function badgeRoutine(p: Pick<EffectsParams, "icons">): Statement {
	const el = id("el");
	const black = id("black");
	const entry = id("entry");

	return js.const_(
		"efBadge",
		js.arrow(
			["el", "chip", "black", "motion"],
			[
				js.const_("art", js.member(p.icons, js.member(id("chip"), W.badgeIndex))),
				js.if_(js.not(id("art")), [js.ret(js.bool(false))]),
				js.const_("square", js.member(id("chip"), W.square)),
				// Two chips on one square would blend into one unreadable disc (a recapture): the
				// earlier one goes. Chips on other squares keep running.
				js.forOf("old", callm(chips, "slice"), [
					js.if_(js.op(js.member(id("old"), "sq"), "===", id("square")), [
						js.expr(js.call(id("efDrop"), id("old"))),
						js.expr(js.call(id("efForget"), chips, js.member(id("old"), "node"))),
					]),
				]),
				js.const_("c", js.call(id("efCell"), id("square"), black)),
				js.const_("group", svg("g")),
				attr(
					id("group"),
					"transform",
					js.tpl(
						["translate(", " ", `) scale(${Q.chipSize / ART.viewBoxWidth})`],
						add(js.member(id("c"), n(0)), n(Q.chipAnchorX - Q.chipSize / 2)),
						add(js.member(id("c"), n(1)), n(Q.chipAnchorY - Q.chipSize / 2))
					)
				),
				js.const_("inner", svg("g")),
				attr(id("inner"), "style", s(CHIP_ORIGIN)),
				js.expr(callm(id("group"), "appendChild", id("inner"))),
				js.const_("rim", svg("path")),
				attr(id("rim"), "d", s(ART.circleShadow)),
				attr(id("rim"), "fill", s(ART.shadowFill)),
				attr(id("rim"), "opacity", s(String(ART.circleShadowOpacity))),
				js.expr(callm(id("inner"), "appendChild", id("rim"))),
				js.const_("disc", svg("path")),
				attr(id("disc"), "d", s(ART.circleBackground)),
				attr(id("disc"), "fill", js.member(id("art"), "background")),
				js.expr(callm(id("inner"), "appendChild", id("disc"))),
				js.const_("under", svg("g")),
				attr(id("under"), "transform", s(`translate(0 ${ART.glyphShadowShift})`)),
				attr(id("under"), "fill", s(ART.shadowFill)),
				attr(id("under"), "opacity", s(String(ART.glyphShadowOpacity))),
				js.expr(callm(id("inner"), "appendChild", id("under"))),
				js.const_("face", svg("g")),
				attr(id("face"), "fill", s(ART.glyphFill)),
				js.expr(callm(id("inner"), "appendChild", id("face"))),
				js.forOf("d", orEmpty(js.member(id("art"), "glyph")), [
					js.const_("below", svg("path")),
					attr(id("below"), "d", id("d")),
					js.expr(callm(id("under"), "appendChild", id("below"))),
					js.const_("above", svg("path")),
					attr(id("above"), "d", id("d")),
					js.expr(callm(id("face"), "appendChild", id("above"))),
				]),
				js.if_(js.not(id("motion")), [attr(id("inner"), "opacity", s(String(Q.chipOpacity)))]),
				js.expr(callm(el, "appendChild", id("group"))),
				js.const_("entry", js.obj({ node: id("group"), sq: id("square"), anims: js.arr() })),
				js.expr(callm(chips, "push", entry)),
				js.expr(js.call(id("efTrim"), chips, n(L.maxLiveChips))),
				js.if_(id("motion"), [
					js.const_(
						"run",
						js.call(
							id("efAnimate"),
							id("inner"),
							js.arr(
								js.obj({
									opacity: n(0),
									transform: s(`scale(${Q.chipScaleFrom})`),
									offset: n(0),
									easing: s(Q.chipEasing),
								}),
								js.obj({
									opacity: n(Q.chipOpacity),
									transform: s(`scale(${Q.chipScalePeak})`),
									offset: n(CHIP_OVERSHOOT),
								}),
								js.obj({
									opacity: n(Q.chipOpacity),
									transform: s("scale(1)"),
									offset: n(CHIP_SETTLED),
								}),
								js.obj({ opacity: n(Q.chipOpacity), transform: s("scale(1)"), offset: n(CHIP_HELD) }),
								js.obj({ opacity: n(0), transform: s(`scale(${Q.chipScaleOut})`), offset: n(1) })
							),
							js.obj({ duration: n(CHIP_LIFE), fill: s("forwards") }),
							js.member(entry, "anims")
						)
					),
					forgetOnFinish(id("run"), chips, id("group")),
				]),
				js.ret(js.bool(true)),
			]
		)
	);
}
