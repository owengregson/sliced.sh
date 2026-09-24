// src/page/cursor-effects/artwork.ts
/**
 * `curFxArtwork(cursor, down, motion)`: the arrow's press feedback — the artwork dips and
 * settles on press and release, and an accent contour (a clone of the inner shape) glows while
 * the button is held.
 */

import { CURSOR_EFFECTS as E } from "@core/constants/cursor";
import { js, type Statement } from "@pagescript";
import { callm as call, id, n, run, s } from "../parts/ast";
import { setAttr as attr } from "../parts/svg";
import type { CursorEffectParams } from "./params";

const scale = (value: number) => s(`scale(${value})`);

export function artworkRoutine(p: Pick<CursorEffectParams, "accent" | "hotX" | "hotY">): Statement {
	return js.const_(
		"curFxArtwork",
		js.arrow(
			["cursor", "down", "motion"],
			[
				js.const_("art", call(id("cursor"), "querySelector", s("svg"))),
				js.if_(js.not(id("art")), [js.ret()]),
				js.const_("initial", js.op(id("art"), "!==", id("curFxArt"))),
				js.const_("changed", js.op(id("down"), "!==", id("curFxDown"))),
				js.assign(id("curFxArt"), id("art")),
				js.assign(js.member(id("art"), "style", "transformOrigin"), s(`${p.hotX}px ${p.hotY}px`)),
				js.assign(
					js.member(id("art"), "style", "transform"),
					js.cond(id("down"), scale(E.pressedScale), scale(1))
				),
				js.if_(js.not(id("motion")), [
					js.expr(run("curFxStop", id("art"))),
					js.expr(run("curFxStop", id("curFxGlow"))),
					js.if_(id("curFxGlow"), [js.assign(js.member(id("curFxGlow"), "style", "opacity"), s("0"))]),
					js.ret(),
				]),
				js.if_(js.or(js.not(id("changed")), js.and(id("initial"), js.not(id("down")))), [js.ret()]),
				js.expr(run("curFxStop", id("art"))),
				js.if_(js.op(js.member(id("art"), "childElementCount"), "===", n(2)), [
					js.const_("glow", call(js.member(id("art"), "lastElementChild"), "cloneNode", js.bool(true))),
					attr(id("glow"), "fill", p.accent),
					attr(id("glow"), "fill-opacity", s(String(E.contourFillOpacity))),
					attr(id("glow"), "stroke", p.accent),
					attr(id("glow"), "stroke-width", s(String(E.contourWidthPx))),
					attr(id("glow"), "stroke-linejoin", s("round")),
					js.assign(js.member(id("glow"), "style", "opacity"), s("0")),
					js.expr(call(id("art"), "appendChild", id("glow"))),
				]),
				js.assign(id("curFxGlow"), js.member(id("art"), "lastElementChild")),
				js.expr(run("curFxStop", id("curFxGlow"))),
				js.assign(
					js.member(id("curFxGlow"), "style", "opacity"),
					js.cond(id("down"), s(String(E.heldContourOpacity)), s("0"))
				),
				js.if_(
					id("down"),
					[
						js.expr(
							call(
								id("art"),
								"animate",
								js.arr(
									js.obj({ transform: scale(1) }),
									js.obj({ transform: scale(E.pressDipScale), offset: n(0.55) }),
									js.obj({ transform: scale(E.pressedScale) })
								),
								js.obj({ duration: n(E.pressMs), easing: s(E.pressEasing) })
							)
						),
						js.expr(
							call(
								id("curFxGlow"),
								"animate",
								js.arr(
									js.obj({ opacity: n(0) }),
									js.obj({ opacity: n(E.pressContourOpacity), offset: n(0.4) }),
									js.obj({ opacity: n(E.heldContourOpacity) })
								),
								js.obj({ duration: n(E.pressMs), easing: s("ease-out") })
							)
						),
					],
					[
						js.expr(
							call(
								id("art"),
								"animate",
								js.arr(
									js.obj({ transform: scale(E.pressedScale) }),
									js.obj({ transform: scale(E.releaseSettleScale), offset: n(0.45) }),
									js.obj({ transform: scale(1) })
								),
								js.obj({ duration: n(E.releaseMs), easing: s(E.releaseEasing) })
							)
						),
						js.expr(
							call(
								id("curFxGlow"),
								"animate",
								js.arr(
									js.obj({ opacity: n(E.heldContourOpacity) }),
									js.obj({ opacity: n(E.releaseContourOpacity), offset: n(0.2) }),
									js.obj({ opacity: n(0) })
								),
								js.obj({ duration: n(E.contourReleaseMs), easing: s("ease-out") })
							)
						),
					]
				),
			]
		)
	);
}
