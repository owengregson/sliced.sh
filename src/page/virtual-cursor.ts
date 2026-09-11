// src/page/virtual-cursor.ts
/**
 * `virtual-cursor` (Fix D): the MAIN-world mirror of the virtual hand's own
 * pointer. The owner's real OS cursor is on the same screen, so this element
 * tracks **only** what the service worker dispatched — the positions arrive as
 * `cursorTo` commands over the bridge, one per dispatched point, and nothing on
 * this side reads a pointer event. That is not a style choice: CDP-dispatched
 * events are *trusted*, so a page-side listener could not tell the hand's
 * pointer from the owner's.
 *
 * Nothing is inserted until the first `cursorTo`. The pointer artwork and native
 * hit-test shield use per-build classes and are removed together by `cursorHide`.
 * The artwork cannot receive input. The transparent shield occupies the top layer
 * where supported, intercepting native hover before page event handlers run.
 * `cursorPrepare` briefly opens a two-pixel aperture at the next announced point;
 * the acknowledged `cursorTo` seals it, with a timeout if dispatch fails. Page
 * shortcuts remain available. This also suppresses stationary native CSS hover;
 * admitted virtual pointer events still reach the site's handlers.
 *
 * Coordinates: `x` / `y` are viewport CSS px. `Input.dispatchMouseEvent` takes
 * its coordinates in exactly that space ("relative to the main frame's
 * viewport in CSS pixels"), which is also the space `clientX` / `clientY` and
 * `getBoundingClientRect()` report — and the executor's own geometry comes from
 * `getBoundingClientRect()` (`src/content/adapters/chesscom.ts`), so no
 * conversion happens anywhere in the chain. `position: fixed` resolves against
 * the same viewport, so the element needs none either.
 *
 * Graphic: the macOS pointer from MacTahoe-icon-theme
 * (`cursors/src/svg-shadow/default.svg`, GPL-3.0-or-later, (c) vinceliuice),
 * a 32x32 canvas whose hotspot is (5,5) per the theme's `config/default.cursor`.
 * It lives in `templates/virtual-cursor.html` and is imported `?raw`, so the
 * markup is inlined into the emitted program: the manifest declares no
 * `web_accessible_resources`, so an asset URL is not available (and would let
 * any page script detect the extension). The theme draws its shadow with an
 * SVG filter, which would need an `id` to be referenced; the equivalent CSS
 * `drop-shadow()` is used instead so the element carries no identifier at all.
 *
 * `cursorStatements` is the reusable builder the bridge embeds; the standalone
 * program below is the same mirror driven by its own message listener
 * (non-entry: generated as a module only).
 */

import { BRIDGE_WIRE as W } from "@core/constants/bridge";
import { POINTER_CONTROL } from "@core/constants/cdp";
import { CURSOR_EFFECTS } from "@core/constants/cursor";
import { HIGHLIGHT_MOTION } from "@core/constants/timings";
import { defineProgram, type Expression, js, type Statement } from "@pagescript";
import cursorCss from "../../css/page-cursor.css?raw";
import { defineHandle, KINDS, listen } from "./bridge-common";
import { CURSOR_FEEDBACK, cursorEffectStatements } from "./cursor-effects";
import markup from "./templates/virtual-cursor.html?raw";

const doc = js.id("document");

/** Function names shared by the bridge and standalone page program. */
export const CURSOR = {
	to: "curTo",
	hide: "curHide",
	prepare: "curPrepare",
	seal: "curSeal",
} as const;

/**
 * The graphic's own geometry — part of the artwork, not theme (the `--sl-*`
 * tokens do not resolve in the page realm, §13.3 / C3).
 */
export const CURSOR_ART = {
	/** Canvas size of the source SVG. */
	sizePx: 32,
	/** Arrow-tip hotspot inside that canvas; also the scale pivot. */
	hotX: 5,
	hotY: 5,
	/** Artwork compression; the input position stays fixed. */
	pressScale: CURSOR_EFFECTS.pressedScale,
	/** Above the site's own layers; the element has no layout effect of its own. */
	zIndex: 2_147_483_000,
	/** A CSS-pixel aperture, not a board-sized passthrough. */
	apertureRadiusPx: 1,
} as const;

const A = CURSOR_ART;

/**
 * The style attribute, written **once** at insert time; after that only
 * `style.transform` and `style.opacity` move, which is what the reference does
 * and keeps the per-point work (and the `style` mutation record a page-side
 * `MutationObserver` would see) as small as it can be. No `--sl-*` token can
 * appear here: this CSS is applied inside the page, where they do not resolve.
 * `opacity:0` is the fade's start value — see `curEnsure`.
 */
const STYLE_HEAD =
	`position:fixed;left:0;top:0;width:${A.sizePx}px;height:${A.sizePx}px;` +
	`pointer-events:none;z-index:${A.zIndex};transform-origin:${A.hotX}px ${A.hotY}px;` +
	"will-change:transform;filter:drop-shadow(1.5px 1.5px 2px rgba(0,0,0,0.3));transition:opacity ";
const STYLE_TAIL = "ms ease;opacity:0";

const add = (a: Expression, b: Expression): Expression => js.op(a, "+", b);
const text = (v: Expression): Expression => js.call(js.id("String"), v);
/** `a + b + c…`; an empty list is the empty string rather than a throw. */
const joined = (parts: Expression[]): Expression => {
	const [first, ...rest] = parts;
	return first === undefined ? js.str("") : rest.reduce(add, first);
};

export interface CursorParams {
	/** The per-build class name of the mirror's `<div>`. */
	cls: Expression;
	/** Fade-in duration in ms (`TIMINGS.virtualCursorFadeMs`). */
	fadeMs: Expression;
	/** Resolved theme accent from the design tokens (page CSS cannot read panel variables). */
	accent: Expression;
}

/**
 * Declares, inside the enclosing closure:
 *   `curBase`       — the style attribute the element is inserted with
 *   `curFind()`     — the existing element (DOM lookup by class), or null
 *   `curEnsure()`   — that element, inserting it the first time
 *   `curTo(q)`      — move to a wire payload `{ x, y, d }`
 *   `curPrepare(q)` — briefly open the announced native hit-test coordinate
 *   `curSeal()`     — close the input aperture
 *   `curHide()`     — remove the artwork, stylesheet and shield
 */
export function cursorStatements(p: CursorParams): Statement[] {
	const el = js.id("el");
	const host = js.id("host");
	const q = js.id("q");
	const shield = js.id("curShield");
	const shieldState = js.let_("curShield", js.nil());
	const shieldFind = js.const_(
		"curFindShield",
		js.arrow([], js.call(js.member(doc, "querySelector"), joined([js.str("."), p.cls, js.str("h")])))
	);
	const shieldTimer = js.let_("curShieldTimer", js.nil());
	const shieldSeal = js.const_(
		CURSOR.seal,
		js.arrow(
			[],
			[
				js.expr(js.call(js.id("clearTimeout"), js.id("curShieldTimer"))),
				js.assign(js.id("curShieldTimer"), js.nil()),
				js.assign(shield, js.call(js.id("curFindShield"))),
				js.if_(shield, [js.assign(js.member(shield, "style", "clipPath"), js.str("none"))]),
			]
		)
	);
	const curPrepare = js.const_(
		CURSOR.prepare,
		js.arrow(
			["q"],
			[
				js.if_(js.or(js.not(q), js.not(js.call(js.id("curFind")))), [js.ret(js.bool(false))]),
				js.if_(
					js.not(
						js.and(
							js.call(js.member(js.id("Number"), "isFinite"), js.member(q, W.x)),
							js.call(js.member(js.id("Number"), "isFinite"), js.member(q, W.y))
						)
					),
					[js.ret(js.bool(false))]
				),
				js.expr(js.call(js.id(CURSOR.seal))),
				js.if_(js.not(shield), [
					js.assign(shield, js.call(js.member(doc, "createElement"), js.str("div"))),
					js.expr(js.call(js.member(shield, "setAttribute"), js.str("class"), add(p.cls, js.str("h")))),
					js.expr(
						js.call(
							js.member(shield, "setAttribute"),
							js.str("style"),
							js.str(
								`position:fixed;inset:0;width:auto;height:auto;margin:0;padding:0;border:0;pointer-events:auto;cursor:not-allowed;z-index:${A.zIndex - 1};background:transparent;`
							)
						)
					),
					js.expr(js.call(js.member(doc, "body", "appendChild"), shield)),
					js.if_(js.op(js.typeof_(js.member(shield, "showPopover")), "===", js.str("function")), [
						js.expr(js.call(js.member(shield, "setAttribute"), js.str("popover"), js.str("manual"))),
						js.try_([js.expr(js.call(js.member(shield, "showPopover")))], "error", [
							js.expr(js.call(js.member(shield, "removeAttribute"), js.str("popover"))),
						]),
					]),
				]),
				js.const_("x0", js.op(js.member(q, W.x), "-", js.num(A.apertureRadiusPx))),
				js.const_("x1", js.op(js.member(q, W.x), "+", js.num(A.apertureRadiusPx))),
				js.const_("y0", js.op(js.member(q, W.y), "-", js.num(A.apertureRadiusPx))),
				js.const_("y1", js.op(js.member(q, W.y), "+", js.num(A.apertureRadiusPx))),
				js.assign(
					js.member(shield, "style", "clipPath"),
					joined([
						js.str("polygon(evenodd,0 0,100% 0,100% 100%,0 100%,0 0,"),
						text(js.id("x0")),
						js.str("px "),
						text(js.id("y0")),
						js.str("px,"),
						text(js.id("x1")),
						js.str("px "),
						text(js.id("y0")),
						js.str("px,"),
						text(js.id("x1")),
						js.str("px "),
						text(js.id("y1")),
						js.str("px,"),
						text(js.id("x0")),
						js.str("px "),
						text(js.id("y1")),
						js.str("px,"),
						text(js.id("x0")),
						js.str("px "),
						text(js.id("y0")),
						js.str("px)"),
					])
				),
				js.assign(
					js.id("curShieldTimer"),
					js.call(js.id("setTimeout"), js.id(CURSOR.seal), js.num(POINTER_CONTROL.expiresMs))
				),
				js.ret(js.bool(true)),
			]
		)
	);
	const curBase = js.const_(
		"curBase",
		joined([js.str(STYLE_HEAD), text(p.fadeMs), js.str(STYLE_TAIL)])
	);
	const curFind = js.const_(
		"curFind",
		js.arrow([], js.call(js.member(doc, "querySelector"), add(js.str("."), p.cls)))
	);
	const curEnsure = js.const_(
		"curEnsure",
		js.arrow(
			[],
			[
				js.let_("el", js.call(js.id("curFind"))),
				js.if_(el, [js.ret(el)]),
				js.const_("host", js.member(doc, "body")),
				js.if_(js.not(host), [js.ret(js.nil())]),
				js.assign(el, js.call(js.member(doc, "createElement"), js.str("div"))),
				js.expr(js.call(js.member(el, "setAttribute"), js.str("class"), p.cls)),
				js.expr(js.call(js.member(el, "setAttribute"), js.str("style"), js.id("curBase"))),
				js.if_(
					js.and(
						js.member(js.id("window"), "matchMedia"),
						js.member(
							js.call(
								js.member(js.id("window"), "matchMedia"),
								js.str(HIGHLIGHT_MOTION.reducedMotionQuery)
							),
							"matches"
						)
					),
					[js.assign(js.member(el, "style", "transition"), js.str("none"))]
				),
				js.assign(js.member(el, "innerHTML"), js.str(markup.trim())),
				js.const_("sheet", js.call(js.member(doc, "createElement"), js.str("style"))),
				js.assign(js.member(js.id("sheet"), "textContent"), js.str(cursorCss.trim())),
				js.expr(js.call(js.member(el, "appendChild"), js.id("sheet"))),
				js.expr(js.call(js.member(host, "appendChild"), el)),
				// DO NOT REMOVE. The element is inserted at `opacity:0` and `curTo` raises it to 1 in
				// the same task, so without a forced style flush between the two the computed value
				// never holds 0 and the transition does not run — the arrow pops instead of fading.
				// happy-dom has no style recalculation, so no offline test can catch its loss; the
				// emitted program is asserted to still contain this call
				// (`test/page/virtual-cursor.test.ts`) and `docs/qa-checklist.md` §B5.5 is the
				// browser check.
				js.expr(js.call(js.member(el, "getBoundingClientRect"))),
				js.ret(el),
			]
		)
	);
	const curTo = js.const_(
		CURSOR.to,
		js.arrow(
			["q"],
			[
				js.if_(js.not(q), [js.ret()]),
				js.if_(
					js.not(
						js.and(
							js.call(js.member(js.id("Number"), "isFinite"), js.member(q, W.x)),
							js.call(js.member(js.id("Number"), "isFinite"), js.member(q, W.y))
						)
					),
					[js.ret()]
				),
				js.const_("el", js.call(js.id("curEnsure"))),
				js.if_(js.not(el), [js.ret()]),
				js.assign(
					js.member(el, "style", "transform"),
					joined([
						js.str("translate3d("),
						text(js.op(js.member(q, W.x), "-", js.num(A.hotX))),
						js.str("px,"),
						text(js.op(js.member(q, W.y), "-", js.num(A.hotY))),
						js.str("px,0)"),
					])
				),
				js.assign(js.member(el, "style", "opacity"), js.str("1")),
				js.expr(js.call(js.id(CURSOR_FEEDBACK.update), q, el)),
				js.expr(js.call(js.id(CURSOR.prepare), q)),
				js.expr(js.call(js.id(CURSOR.seal))),
			]
		)
	);
	const curHide = js.const_(
		CURSOR.hide,
		js.arrow(
			[],
			[
				js.const_("el", js.call(js.id("curFind"))),
				js.expr(js.call(js.id(CURSOR_FEEDBACK.clear))),
				js.expr(js.call(js.id(CURSOR.seal))),
				js.if_(el, [js.expr(js.call(js.member(el, "remove")))]),
				js.if_(shield, [js.expr(js.call(js.member(shield, "remove")))]),
				js.assign(shield, js.nil()),
			]
		)
	);
	return [
		...cursorEffectStatements({
			cls: p.cls,
			accent: p.accent,
			zIndex: A.zIndex - 1,
			hotX: A.hotX,
			hotY: A.hotY,
		}),
		shieldState,
		shieldTimer,
		shieldFind,
		shieldSeal,
		curBase,
		curFind,
		curEnsure,
		curPrepare,
		curTo,
		curHide,
	];
}

/** `curTo(payload)` / `curHide()` as statements. */
export const cursor = {
	to: (payload: Expression): Statement => js.expr(js.call(js.id(CURSOR.to), payload)),
	hide: (): Statement => js.expr(js.call(js.id(CURSOR.hide))),
	prepare: (payload: Expression): Expression => js.call(js.id(CURSOR.prepare), payload),
};

/**
 * Standalone mirror program: listens for the pointer commands from the
 * content script and answers neither — the stream is fire-and-forget, so a
 * reply per point would double the traffic for nothing. It therefore declares
 * no `post` at all; production request acknowledgments live in the chess.com
 * bridge. `peer` is the seed-derived content-side direction token.
 */
export const virtualCursor = defineProgram({
	name: "virtual-cursor",
	params: {
		peer: "string",
		cls: "string",
		fadeMs: "number",
		accent: "string",
	},
	build: (p) =>
		js.program([
			...cursorStatements({ cls: p.cls, fadeMs: p.fadeMs, accent: p.accent }),
			defineHandle([
				{ kind: KINDS.cursorTo, body: [cursor.to(js.id("q"))] },
				{ kind: KINDS.cursorHide, body: [cursor.hide()] },
				{ kind: KINDS.cursorPrepare, body: [js.expr(cursor.prepare(js.id("q")))] },
			]),
			listen(p.peer),
		]),
});
