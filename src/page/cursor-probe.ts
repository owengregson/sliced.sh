// src/page/cursor-probe.ts
/**
 * `cursor-probe` (§5.5): a CDP `Runtime.evaluate` expression
 * (`awaitPromise: true`) the executor uses for a path start. It is a single
 * IIFE expression (no top-level `return`) that installs one capture-phase,
 * passive `pointermove` listener inside its own closure, resolves with the
 * next *trusted* pointer position `{ x, y, t }` and removes the listener; if
 * no pointer event arrives within `timeoutMs` it resolves `null`.
 *
 * §13.3 rule 3 forbids the `std.defineOnce` window marker of the original
 * plan, so a CDP evaluation cannot remember a position across calls; the
 * *last known* trusted position lives in the ISOLATED-world `CursorTracker`
 * (reported on the game port) and in each bridge's closure (`cursor`
 * command). This probe samples live.
 */

import { BRIDGE_WIRE as W } from "@core/constants/bridge";
import { defineProgram, js } from "@pagescript";

const win = js.id("window");
const ev = js.id("ev");

export const cursorProbe = defineProgram({
	name: "cursor-probe",
	params: { timeoutMs: "number" },
	build: (p) =>
		js.program([
			js.expr(
				js.iife([
					js.ret(
						js.new_(
							js.id("Promise"),
							js.arrow(
								["resolve"],
								[
									js.let_("timer", js.nil()),
									js.const_(
										"done",
										js.arrow(
											["v"],
											[
												js.expr(js.call(js.id("clearTimeout"), js.id("timer"))),
												js.expr(
													js.call(
														js.member(win, "removeEventListener"),
														js.str("pointermove"),
														js.id("onMove"),
														js.bool(true)
													)
												),
												js.expr(js.call(js.id("resolve"), js.id("v"))),
											]
										)
									),
									js.const_(
										"onMove",
										js.arrow(
											["ev"],
											[
												js.if_(js.not(js.member(ev, "isTrusted")), [js.ret()]),
												js.expr(
													js.call(
														js.id("done"),
														js.obj({
															[W.x]: js.member(ev, "clientX"),
															[W.y]: js.member(ev, "clientY"),
															[W.at]: js.call(js.member(js.id("Date"), "now")),
														})
													)
												),
											]
										)
									),
									js.expr(
										js.call(
											js.member(win, "addEventListener"),
											js.str("pointermove"),
											js.id("onMove"),
											js.obj({ capture: js.bool(true), passive: js.bool(true) })
										)
									),
									js.assign(
										js.id("timer"),
										js.call(js.id("setTimeout"), js.arrow([], js.call(js.id("done"), js.nil())), p.timeoutMs)
									),
								]
							)
						)
					),
				])
			),
		]),
});
