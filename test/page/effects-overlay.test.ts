// test/page/effects-overlay.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import {
	BOARD_EFFECT_GEOMETRY,
	BOARD_EFFECT_LIMITS,
	BOARD_EFFECT_MOTION,
	BOARD_EFFECT_SEIZE,
	BOARD_EFFECT_STYLES,
	BOARD_EFFECT_KINDS as K,
} from "@core/constants/board-effects";
import {
	MOVE_QUALITY,
	MOVE_QUALITY_ART,
	MOVE_QUALITY_ICONS,
	MOVE_QUALITY_ORDER,
} from "@core/constants/move-quality";
import { bindCode, emit } from "@pagescript";
import { alpha, palette } from "../../src/design/tokens";
import { TOKENS } from "../../src/design/tokens.generated";
import { arrowGeometry, arrowStubLength } from "../../src/page/arrow-shape";
import { effectsOverlay } from "../../src/page/effects-overlay";
import { EFFECT_COLORS } from "../../src/page/index";
import {
	command,
	forbiddenIn,
	makeWindow,
	type Posted,
	recordPosts,
	runProgram,
	SEED,
	sendToPage,
	TOKENS_FOR_SEED,
} from "./helpers";

const emitted = emit(effectsOverlay, { seed: SEED });
const { key, page, effectsClass } = TOKENS_FOR_SEED;
const bound = bindCode(emitted.code, emitted.params, {
	token: page,
	peer: TOKENS_FOR_SEED.content,
	hosts: ["cg-container", "wc-chess-board"],
	cls: effectsClass,
	palette: EFFECT_COLORS,
	styles: BOARD_EFFECT_STYLES,
	icons: MOVE_QUALITY_ICONS,
});

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
});

function boot(html: string) {
	const win = makeWindow("https://www.chess.com/game/174252011111");
	cleanups.push(() => win.happyDOM.close());
	win.document.body.innerHTML = html;
	const rec = recordPosts(win);
	cleanups.push(rec.restore);
	const keysBefore = Object.keys(win);
	runProgram(bound, win);
	return { win, posts: rec.posts, keysBefore };
}

function reply(posts: Posted[], id: string): Record<string, unknown> | undefined {
	return posts.find((p) => p.data[key] === page && p.data.i === id)?.data;
}

function captureAnimations(win: ReturnType<typeof makeWindow>, reduced = false) {
	const records: Array<{
		node: unknown;
		frames: Keyframe[];
		options: KeyframeAnimationOptions;
		cancelled: boolean;
		finish(): void;
	}> = [];
	const prototype = win.Element.prototype;
	const previous = Object.getOwnPropertyDescriptor(prototype, "animate");
	Object.defineProperty(prototype, "animate", {
		configurable: true,
		value: function (this: unknown, frames: Keyframe[], options: KeyframeAnimationOptions) {
			let finish = () => {};
			let reject = (_error: Error) => {};
			const finished = new Promise<void>((resolve, fail) => {
				finish = resolve;
				reject = fail;
			});
			void finished.catch(() => {});
			const record = { node: this, frames, options, cancelled: false, finish };
			records.push(record);
			return {
				finished,
				cancel: () => {
					record.cancelled = true;
					reject(new Error("cancelled"));
				},
			};
		},
	});
	Object.defineProperty(win, "matchMedia", {
		configurable: true,
		value: () => ({ matches: reduced }),
	});
	cleanups.push(() => {
		if (previous) Object.defineProperty(prototype, "animate", previous);
		else Reflect.deleteProperty(prototype, "animate");
	});
	return records;
}

/** A wire batch: `{ r, u, z, b? }` with the single-letter field names. */
function batch(
	list: Array<{ n: string; f: string; t: string }>,
	extra: Record<string, unknown> = {}
): Record<string, unknown> {
	return { r: "w", u: true, z: list, ...extra };
}

const THREAT = { n: K.threat, f: "e4", t: "c6" };
/** The arrow silhouette's lengths at the layer's scale (`BOARD_EFFECT_GEOMETRY.arrowScale`). */
const S = arrowGeometry(BOARD_EFFECT_GEOMETRY.arrowScale);

/** The x of the arrow's tip in path space: the `Q <x>,0` control point of the point's curve. */
function tipOf(d: string | null | undefined): number {
	return Number(/Q ([\d.]+),0 /.exec(d ?? "")?.[1]);
}

/**
 * The colour and end-opacities behind a `url(#…)` paint: every arrow (its `fill`, and a dotted
 * shaft's `stroke`) is painted through a per-group `<linearGradient>` in board coordinates
 * (`userSpaceOnUse`), so the colour is read off its stops rather than off the element.
 */
interface Attributed {
	getAttribute(name: string): string | null;
}
interface PaintedNode extends Attributed {
	ownerDocument: {
		getElementById(
			id: string
		): (Attributed & { querySelectorAll(selector: string): Iterable<Attributed> }) | null;
	};
}
function paintOf(el: PaintedNode | null | undefined, attribute: "stroke" | "fill" = "stroke") {
	const ref = /^url\(#(.+)\)$/.exec(el?.getAttribute(attribute) ?? "");
	const gradient = ref?.[1] ? el?.ownerDocument.getElementById(ref[1]) : null;
	const stops = [...(gradient?.querySelectorAll("stop") ?? [])];
	return {
		id: ref?.[1] ?? null,
		units: gradient?.getAttribute("gradientUnits") ?? null,
		color: stops[0]?.getAttribute("stop-color") ?? null,
		opacities: stops.map((stop) => stop.getAttribute("stop-opacity")),
		offsets: stops.map((stop) => stop.getAttribute("offset")),
	};
}

describe("effects-overlay", () => {
	it("acknowledges only newly inserted rating badges, including late verdicts and recaptures", () => {
		const { win, posts } = boot("<cg-container></cg-container>");
		captureAnimations(win);
		const verdict = batch([], { b: { q: "e4", j: 6 } });
		sendToPage(win, command("effects", "rays", batch([])));
		expect(reply(posts, "rays")?.p).toBe(false);
		sendToPage(win, command("effects", "rating", verdict));
		expect(reply(posts, "rating")?.p).toBe(true);
		sendToPage(win, command("effects", "repeat", verdict));
		expect(reply(posts, "repeat")?.p).toBe(false);
		sendToPage(win, command("effects", "recapture", { ...verdict, u: false }));
		expect(reply(posts, "recapture")?.p).toBe(true);
		sendToPage(win, command("effects", "invalid", batch([], { b: { q: "a1", j: 99 } })));
		expect(reply(posts, "invalid")?.p).toBe(false);
		win.document.body.innerHTML = "";
		sendToPage(win, command("effects", "missing-board", verdict));
		expect(reply(posts, "missing-board")?.p).toBe(false);
	});
	it("emits no forbidden substring and no literal host selector / colour / class", () => {
		expect(forbiddenIn(emitted.code)).toEqual([]);
		expect(emitted.code).not.toContain("cg-container");
		expect(emitted.code).not.toContain(EFFECT_COLORS.mine);
		expect(emitted.code).not.toContain(effectsClass);
		expect(emitted.code).not.toMatch(/window\.\w+\s*=/);
		// The wire names no category and no chess idea: the batch is letters and an index.
		for (const name of ["blunder", "brilliant", "threat", "check", "fork", "castle"])
			expect(emitted.code).not.toContain(name);
	});

	it("inserts nothing until a batch arrives, then one pointer-transparent svg above the mark", () => {
		const { win, posts, keysBefore } = boot("<cg-container><cg-board></cg-board></cg-container>");
		expect(Object.keys(win)).toEqual(keysBefore);
		expect(win.document.querySelectorAll("svg")).toHaveLength(0);
		runProgram(bound, win); // a second evaluation still inserts nothing
		sendToPage(win, command("effects", "1", batch([THREAT])));
		const svgs = win.document.querySelectorAll(`cg-container > svg.${effectsClass}`);
		expect(svgs).toHaveLength(1);
		const style = svgs[0]?.getAttribute("style") ?? "";
		expect(style).toContain("pointer-events:none");
		// Above the recommendation mark's `z-index: 3`.
		expect(Number(/z-index:(\d+)/.exec(style)?.[1])).toBeGreaterThan(3);
		expect(svgs[0]?.getAttribute("id")).toBeNull();
		expect(reply(posts, "1")).toBeDefined();
		sendToPage(win, command("effectsClear", "2"));
		expect(win.document.querySelectorAll("svg")).toHaveLength(0);
	});

	it("draws a threat as the recommendation arrow, downscaled, filled in the side's colour", () => {
		// The owner's 2026-09-13 instruction: "reuse the arrows from highlight move (but downscale
		// them)". One silhouette from `arrow-shape.ts` — no separate shaft, head or dashes.
		const a = boot("<cg-container></cg-container>");
		sendToPage(a.win, command("effects", "1", batch([THREAT])));
		const paths = a.win.document.querySelectorAll("path");
		expect(paths).toHaveLength(1);
		const arrow = paths[0];
		const d = arrow?.getAttribute("d") ?? "";
		expect(d).toContain(" Q ");
		expect(d).not.toMatch(/NaN|Infinity/);
		expect(arrow?.getAttribute("stroke")).toBeNull();
		expect(arrow?.getAttribute("stroke-dasharray")).toBeNull();
		// Its geometry is the highlight arrow's at `arrowScale`: every length shrunk alike.
		const full = arrowGeometry(1);
		expect(BOARD_EFFECT_GEOMETRY.arrowScale).toBeLessThan(1);
		for (const key of Object.keys(S) as Array<keyof typeof S>)
			expect(S[key]).toBeCloseTo(full[key] * BOARD_EFFECT_GEOMETRY.arrowScale, 9);
		expect(d.startsWith(`M ${S.tailRadius},${-S.shaftHalfWidth} H `)).toBe(true);
		expect(d).toContain(`,${-S.headHalfWidth} `);
		// e4 → c6 with white at the bottom: the group sits at e4's centre plus the inset along the
		// move, rotated onto it; the kind's own size is a scale about that start, and the path is
		// built at length / size so the tip still lands on c6's centre.
		const k = BOARD_EFFECT_STYLES.t.scale;
		const [, x, y, angle] =
			/^translate\(([-\d.]+) ([-\d.]+)\) rotate\(([-\d.]+)\)$/.exec(
				arrow?.parentElement?.getAttribute("transform") ?? ""
			) ?? [];
		const inset = S.startInset / Math.SQRT2;
		expect(Number(x)).toBeCloseTo(4.5 - inset, 9);
		expect(Number(y)).toBeCloseTo(4.5 - inset, 9);
		expect(Number(angle)).toBeCloseTo(-135, 9);
		expect(arrow?.getAttribute("transform")).toBe(`scale(${k})`);
		const length = Math.hypot(2, 2) - S.startInset;
		expect(tipOf(d) * k).toBeCloseTo(length + S.tipRadius * k, 9);
		// Painted through the arrow's own base-fade gradient in the side's opaque colour, under
		// the arrow's soft shadow tinted with the palette's edge.
		const paint = paintOf(arrow, "fill");
		expect(paint.id?.startsWith(effectsClass)).toBe(true);
		expect(paint.units).toBe("userSpaceOnUse");
		expect(paint.color).toBe(EFFECT_COLORS.mine);
		expect(paint.opacities).toEqual(["0", "0.45", "1"]);
		const shadow = a.win.document.querySelector("feDropShadow");
		expect(shadow?.getAttribute("flood-color")).toBe(EFFECT_COLORS.edge);
		expect(arrow?.parentElement?.getAttribute("filter")).toBe(`url(#${shadow?.parentElement?.id})`);
		// No pulse ring on the target square (removed at the owner's request, 2026-09-13).
		expect(a.win.document.querySelectorAll("circle")).toHaveLength(0);

		const b = boot("<cg-container></cg-container>");
		sendToPage(b.win, command("effects", "1", { r: "w", u: false, z: [THREAT] }));
		expect(paintOf(b.win.document.querySelector("path"), "fill").color).toBe(EFFECT_COLORS.theirs);
	});

	it("paints every kind in one pastel, translucent colour per side: ours blue, theirs red, the castle and the uncovering line like the capture", () => {
		// The owner's 2026-09-13 instructions: "blue for your attacks and reddish for their attacks",
		// then "make sure the enemy castle/discover lines are also red like the take lines — (and
		// ours are blue)", then "more pastel, less opacity": one colour per side, whatever the kind —
		// the pastel `azure.500` / `crimson.500` at the a48 step (`effect.mine` / `effect.theirs`),
		// not the opaque `*-strong` hex.
		const channels = (hex: string): string =>
			[1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(" ");
		const translucent = (hex: string): string => `rgb(${channels(hex)} / ${alpha.a48})`;
		expect(EFFECT_COLORS.mine).toBe(TOKENS.color.dark.effectMine);
		expect(EFFECT_COLORS.theirs).toBe(TOKENS.color.dark.effectTheirs);
		expect<string>(EFFECT_COLORS.mine).toBe(translucent(palette["azure.500"]));
		expect<string>(EFFECT_COLORS.theirs).toBe(translucent(palette["crimson.500"]));
		for (const colour of [EFFECT_COLORS.mine, EFFECT_COLORS.theirs]) {
			expect(colour).toMatch(/^rgb\(\d+ \d+ \d+ \/ 0\.48\)$/);
			expect(colour).not.toMatch(/^#[0-9a-f]{6}$/i);
			expect(colour).not.toBe(TOKENS.color.dark.effectMineStrong);
			expect(colour).not.toBe(TOKENS.color.dark.effectTheirsStrong);
		}
		const kinds = [
			{ n: K.castle, f: "e1", t: "g1" },
			{ n: K.discovery, f: "a1", t: "a8" },
			{ n: K.capture, f: "e4", t: "c6" },
			{ n: K.pin, f: "c4", t: "f7" },
			{ n: K.passant, f: "e5", t: "d5" },
		];
		// The arrows (filled, or a head plus a dotted shaft) paint through their gradient; the seize
		// mark's outline is stroked in the colour directly.
		const coloursOf = (win: ReturnType<typeof makeWindow>) => [
			...[...win.document.querySelectorAll("path")].map((p) => paintOf(p, "fill").color),
			...[...win.document.querySelectorAll("line")].map((l) => paintOf(l, "stroke").color),
			...[...win.document.querySelectorAll("rect")].map((r) => r.getAttribute("stroke")),
		];
		const dotted = kinds.filter((k) => BOARD_EFFECT_STYLES[k.n].dash > 0).length;
		expect(dotted).toBe(3);
		const ours = boot("<cg-container></cg-container>");
		sendToPage(ours.win, command("effects", "1", batch(kinds)));
		expect(coloursOf(ours.win)).toEqual(
			Array.from({ length: kinds.length + dotted }, () => EFFECT_COLORS.mine)
		);
		const theirs = boot("<cg-container></cg-container>");
		sendToPage(theirs.win, command("effects", "1", { r: "w", u: false, z: kinds }));
		expect(coloursOf(theirs.win)).toEqual(
			Array.from({ length: kinds.length + dotted }, () => EFFECT_COLORS.theirs)
		);
	});

	it("draws the line kinds dotted: the highlight arrow's head over a round-dotted shaft, dots running to the head", () => {
		// The owner, 2026-09-13: "include making them dotted like they were before (a modified
		// version of the highlight move arrow)". Discovery, pin and castle carry the earlier cut's
		// dash lengths; the strikes (threat, fork, check, en passant) stay solid.
		expect(BOARD_EFFECT_STYLES.d.dash).toBe(0.14);
		expect(BOARD_EFFECT_STYLES.p.dash).toBe(0.09);
		expect(BOARD_EFFECT_STYLES.s.dash).toBe(0.12);
		for (const code of [K.threat, K.fork, K.check, K.passant, K.capture, K.promotion])
			expect(BOARD_EFFECT_STYLES[code].dash).toBe(0);
		const { win } = boot("<cg-container></cg-container>");
		const animations = captureAnimations(win);
		sendToPage(win, command("effects", "1", batch([{ n: K.pin, f: "c4", t: "f7" }])));
		const st = BOARD_EFFECT_STYLES.p;
		const k = st.scale;
		const length = Math.hypot(3, 3) - S.startInset;
		// The head: the same rounded tip as the full silhouette, on the target, but no shaft edges.
		const paths = [...win.document.querySelectorAll("path")];
		expect(paths).toHaveLength(1);
		const head = paths[0];
		const d = head?.getAttribute("d") ?? "";
		expect(d.startsWith("M ")).toBe(true);
		expect(d).toContain(" Q ");
		expect(d).not.toContain(" H ");
		expect(d).not.toMatch(/NaN|Infinity/);
		expect(tipOf(d) * k).toBeCloseTo(length + S.tipRadius * k, 9);
		expect(head?.getAttribute("transform")).toBe(`scale(${k})`);
		// The shaft: a line down the arrow's axis from the tail cap to the head's base, the
		// silhouette's shaft width, round-capped, dotted in path units (so it scales with the arrow)
		// and painted through the head's own gradient.
		const shafts = [...win.document.querySelectorAll("line")];
		expect(shafts).toHaveLength(1);
		const shaft = shafts[0];
		expect(shaft?.parentElement).toBe(head?.parentElement ?? null);
		expect(Number(shaft?.getAttribute("x1"))).toBeCloseTo(S.tailRadius, 9);
		expect(shaft?.getAttribute("y1")).toBe("0");
		expect(shaft?.getAttribute("y2")).toBe("0");
		expect(Number(shaft?.getAttribute("x2"))).toBeCloseTo(
			length / k - S.headLength - S.cornerRadius,
			9
		);
		expect(shaft?.getAttribute("fill")).toBe("none");
		expect(Number(shaft?.getAttribute("stroke-width"))).toBeCloseTo(2 * S.shaftHalfWidth, 9);
		expect(shaft?.getAttribute("stroke-linecap")).toBe("round");
		expect(shaft?.getAttribute("transform")).toBe(`scale(${k})`);
		const [dot, gap] = (shaft?.getAttribute("stroke-dasharray") ?? "").split(" ").map(Number);
		expect(dot).toBeCloseTo(st.dash * BOARD_EFFECT_GEOMETRY.arrowScale, 9);
		expect(gap).toBeCloseTo(
			st.dash * BOARD_EFFECT_GEOMETRY.arrowScale * BOARD_EFFECT_GEOMETRY.dotGapRatio,
			9
		);
		expect(BOARD_EFFECT_GEOMETRY.dotGapRatio).toBeGreaterThan(1);
		expect(paintOf(shaft).id).toBe(paintOf(head, "fill").id);
		expect(paintOf(shaft).color).toBe(EFFECT_COLORS.mine);
		// The draw: the head grows from the stub's head, and the dots run from the tail to the head
		// — the pattern offset by the shaft's length sliding to zero — over the same draw, both
		// invisible until the fan delay is up.
		const draws = animations.filter((a) => a.options.duration === BOARD_EFFECT_MOTION.drawMs);
		expect(draws.map((a) => a.node)).toEqual([head, shaft]);
		const stub = arrowStubLength(BOARD_EFFECT_GEOMETRY.arrowScale);
		const headFrames = draws[0]?.frames as Array<Keyframe & { d: string }>;
		expect(headFrames[0]?.d.startsWith('path("M ')).toBe(true);
		expect(headFrames[0]?.d).not.toContain(" H ");
		expect(tipOf(headFrames[0]?.d)).toBeCloseTo(stub + S.tipRadius, 9);
		expect(headFrames[1]?.d).toBe(`path("${d}")`);
		expect(headFrames.map((f) => f.opacity)).toEqual([0, 1]);
		const run = Number(shaft?.getAttribute("x2")) - Number(shaft?.getAttribute("x1"));
		expect(draws[1]?.frames.map((f) => f.strokeDashoffset)).toEqual([String(run), "0"]);
		expect(draws[1]?.frames.map((f) => f.opacity)).toEqual([0, 1]);
		for (const draw of draws)
			expect(draw.options).toEqual({
				duration: BOARD_EFFECT_MOTION.drawMs,
				delay: 0,
				easing: BOARD_EFFECT_MOTION.easing,
				fill: "backwards",
			});
		// The group's hold and fade as for every kind: two draws plus one fade.
		expect(animations).toHaveLength(3);
	});

	it("grows each arrow from the stub after its fan delay, sizes the kind, then holds and fades the group", () => {
		const { win } = boot("<cg-container></cg-container>");
		const animations = captureAnimations(win);
		sendToPage(
			win,
			command(
				"effects",
				"1",
				batch([
					{ n: K.check, f: "d5", t: "e8" },
					{ n: K.fork, f: "d5", t: "b6" },
					{ n: K.fork, f: "d5", t: "f6" },
				])
			)
		);
		const paths = [...win.document.querySelectorAll("path")];
		expect(paths).toHaveLength(3);
		// A check is drawn a little larger than a fork, which is larger than a threat.
		expect(BOARD_EFFECT_STYLES.c.scale).toBeGreaterThan(BOARD_EFFECT_STYLES.k.scale);
		expect(BOARD_EFFECT_STYLES.k.scale).toBeGreaterThan(BOARD_EFFECT_STYLES.t.scale);
		expect(paths.map((p) => p.getAttribute("transform"))).toEqual([
			`scale(${BOARD_EFFECT_STYLES.c.scale})`,
			`scale(${BOARD_EFFECT_STYLES.k.scale})`,
			`scale(${BOARD_EFFECT_STYLES.k.scale})`,
		]);
		// The draw is the layer's own: the shape grows from the stub (head, tail cap and one corner)
		// to its full path over `drawMs`, invisible until its delay is up.
		const draws = animations.filter((a) => a.options.duration === BOARD_EFFECT_MOTION.drawMs);
		expect(draws.map((a) => a.node)).toEqual(paths);
		const stub = arrowStubLength(BOARD_EFFECT_GEOMETRY.arrowScale);
		const delays = [0, 0, BOARD_EFFECT_STYLES.k.delayMs];
		for (const [i, delay] of delays.entries()) {
			const draw = draws[i];
			const frames = draw?.frames as Array<Keyframe & { d: string }>;
			expect(frames).toHaveLength(2);
			expect(frames[0]?.d.startsWith('path("M ')).toBe(true);
			expect(tipOf(frames[0]?.d)).toBeCloseTo(stub + S.tipRadius, 9);
			expect(frames[0]?.opacity).toBe(0);
			expect(frames[1]?.d).toBe(`path("${paths[i]?.getAttribute("d")}")`);
			expect(frames[1]?.opacity).toBe(1);
			expect(draw?.options).toEqual({
				duration: BOARD_EFFECT_MOTION.drawMs,
				delay,
				easing: BOARD_EFFECT_MOTION.easing,
				fill: "backwards",
			});
		}
		// The pulse rings on the target square are gone (owner, 2026-09-13): arrows only.
		expect(win.document.querySelectorAll("circle")).toHaveLength(0);
		// The hold and fade run on each group as before; the run of forks unfurls one step apart.
		const groupFades = animations.filter((a) => a.options.duration === LIFE);
		expect(groupFades).toHaveLength(3);
		expect(groupFades.map((a) => a.options.delay)).toEqual(delays);
		for (const fade of groupFades) {
			expect(fade.frames.map((f) => f.opacity)).toEqual([1, 1, 0]);
			expect(fade.options.fill).toBe("forwards");
		}
		expect(animations).toHaveLength(6);
	});

	it("draws nothing for a promotion, and every directional kind through the one silhouette at its own size", () => {
		const a = boot("<cg-container></cg-container>");
		sendToPage(a.win, command("effects", "1", batch([{ n: K.promotion, f: "b8", t: "b8" }])));
		expect(a.win.document.querySelectorAll("path")).toHaveLength(0);
		expect(a.win.document.querySelectorAll("circle")).toHaveLength(0);
		expect(BOARD_EFFECT_STYLES.u.scale).toBe(0);

		let drawn = 0;
		let dotted = 0;
		for (const [code, st] of Object.entries(BOARD_EFFECT_STYLES)) {
			if (st.scale === 0) continue;
			drawn += 1;
			const { win } = boot("<cg-container></cg-container>");
			sendToPage(win, command("effects", "1", batch([{ n: code, f: "a1", t: "a8" }])));
			const paths = win.document.querySelectorAll("path");
			expect(paths).toHaveLength(1);
			expect(paths[0]?.getAttribute("d")).toContain(" Q ");
			expect(paths[0]?.getAttribute("stroke-dasharray")).toBeNull();
			expect(paths[0]?.getAttribute("transform")).toBe(`scale(${st.scale})`);
			// a1 → a8: straight up from a1's centre, less the inset.
			expect(paths[0]?.parentElement?.getAttribute("transform")).toBe(
				`translate(0.5 ${7.5 - S.startInset}) rotate(-90)`
			);
			// A solid kind is the one filled silhouette; a dotted kind adds the shaft line under it.
			const shafts = win.document.querySelectorAll("line");
			if (st.dash > 0) {
				dotted += 1;
				expect(shafts).toHaveLength(1);
				expect(shafts[0]?.getAttribute("stroke-dasharray")).toMatch(/^[\d.]+ [\d.]+$/);
				expect(paths[0]?.getAttribute("d")).not.toContain(" H ");
			} else {
				expect(shafts).toHaveLength(0);
				expect(
					paths[0]?.getAttribute("d")?.startsWith(`M ${S.tailRadius},${-S.shaftHalfWidth} H `)
				).toBe(true);
			}
		}
		expect(drawn).toBe(7);
		expect(dotted).toBe(3);
	});

	it("draws a short arrow between adjacent squares, as the recommendation mark does", () => {
		// The pill dropped adjacent squares (its insets left nothing); the arrow's own guard is the
		// inset plus the head, well under one square.
		const { win } = boot("<cg-container></cg-container>");
		sendToPage(win, command("effects", "1", batch([{ n: K.threat, f: "e4", t: "e5" }])));
		const paths = win.document.querySelectorAll("path");
		expect(paths).toHaveLength(1);
		const k = BOARD_EFFECT_STYLES.t.scale;
		expect(tipOf(paths[0]?.getAttribute("d")) * k).toBeCloseTo(1 - S.startInset + S.tipRadius * k, 9);
		expect(win.document.querySelectorAll("circle")).toHaveLength(0);
	});

	it("draws a capture as the seize mark closing in on the captured square, not a ray from the origin", () => {
		// The owner, 2026-09-13: "no longer do a slash — come up with another creative, simple,
		// minimalist animation for when taking pieces". A rounded-square outline in the mover's
		// colour starts larger than the square, contracts onto it and fades as it lands.
		const { win } = boot("<cg-container></cg-container>");
		const animations = captureAnimations(win);
		// e4 takes on c6, white at the bottom: c6 is column 2, row 2 (centre 2.5, 2.5).
		sendToPage(win, command("effects", "1", batch([{ n: K.capture, f: "e4", t: "c6" }])));
		expect(win.document.querySelectorAll("path")).toHaveLength(0); // no arrow from e4
		expect(win.document.querySelectorAll("line")).toHaveLength(0);
		expect(win.document.querySelectorAll("circle")).toHaveLength(0);
		const rects = win.document.querySelectorAll("rect");
		expect(rects).toHaveLength(1);
		const box = rects[0];
		// Its own group is translated to the square's centre, and the outline is the unit square
		// about that origin, so the scale contracts onto the square.
		expect(box?.parentElement?.getAttribute("transform")).toBe("translate(2.5 2.5)");
		expect(box?.getAttribute("x")).toBe("-0.5");
		expect(box?.getAttribute("y")).toBe("-0.5");
		expect(box?.getAttribute("width")).toBe("1");
		expect(box?.getAttribute("height")).toBe("1");
		expect(box?.getAttribute("rx")).toBe(String(BOARD_EFFECT_SEIZE.radius));
		expect(box?.getAttribute("fill")).toBe("none");
		expect(box?.getAttribute("stroke")).toBe(EFFECT_COLORS.mine);
		expect(box?.getAttribute("stroke-width")).toBe(String(BOARD_EFFECT_SEIZE.width));
		expect(box?.getAttribute("style")).toContain("transform-origin:0px 0px");
		expect(box?.getAttribute("transform")).toBeNull();
		// The contraction: `from` × the square to `to` ×, the colour fading to transparent.
		expect(BOARD_EFFECT_SEIZE.from).toBeGreaterThan(1);
		expect(BOARD_EFFECT_SEIZE.to).toBeLessThan(1);
		const seize = animations.find((a) => a.options.duration === BOARD_EFFECT_SEIZE.ms);
		expect(seize?.node).toBe(box);
		expect(seize?.frames.map((f) => f.transform)).toEqual([
			`scale(${BOARD_EFFECT_SEIZE.from})`,
			`scale(${BOARD_EFFECT_SEIZE.to})`,
		]);
		expect(seize?.frames.map((f) => f.opacity)).toEqual([1, 0]);
		expect(seize?.options).toEqual({
			duration: BOARD_EFFECT_SEIZE.ms,
			delay: 0,
			easing: BOARD_EFFECT_MOTION.easing,
			fill: "both",
		});
		// The group's hold and fade run as for every kind, and the mark lives in the same list.
		expect(animations.filter((a) => a.options.duration === LIFE)).toHaveLength(1);
		expect(animations).toHaveLength(2);
		// The opponent's capture takes their colour.
		const theirs = boot("<cg-container></cg-container>");
		sendToPage(
			theirs.win,
			command("effects", "1", { r: "w", u: false, z: [{ n: K.capture, f: "e4", t: "c6" }] })
		);
		expect(theirs.win.document.querySelector("rect")?.getAttribute("stroke")).toBe(
			EFFECT_COLORS.theirs
		);
		// Reduced motion: the outline is drawn once at the square's own size and left for the next
		// batch, like every other kind.
		const still = boot("<cg-container></cg-container>");
		const none = captureAnimations(still.win, true);
		sendToPage(still.win, command("effects", "1", batch([{ n: K.capture, f: "e4", t: "c6" }])));
		expect(none).toEqual([]);
		const rest = still.win.document.querySelector("rect");
		expect(rest?.getAttribute("transform")).toBeNull();
		expect(rest?.getAttribute("stroke")).toBe(EFFECT_COLORS.mine);
	});

	it("mirrors the board when the batch says black is at the bottom", () => {
		// The seize mark is centred on the captured square: a8 is the top-left square with white
		// at the bottom and the bottom-right one with black at the bottom.
		const centreOf = (win: ReturnType<typeof makeWindow>): [number, number] => {
			const [, x, y] =
				/^translate\(([\d.]+) ([\d.]+)\)$/.exec(
					win.document.querySelector("rect")?.parentElement?.getAttribute("transform") ?? ""
				) ?? [];
			return [Number(x), Number(y)];
		};
		const white = boot("<cg-container></cg-container>");
		sendToPage(white.win, command("effects", "1", batch([{ n: K.capture, f: "a1", t: "a8" }])));
		const black = boot("<cg-container></cg-container>");
		sendToPage(
			black.win,
			command("effects", "1", { r: "b", u: true, z: [{ n: K.capture, f: "a1", t: "a8" }] })
		);
		const top = centreOf(white.win);
		const flipped = centreOf(black.win);
		expect(top[0]).toBeCloseTo(0.5, 6);
		expect(top[1]).toBeCloseTo(0.5, 6);
		expect(flipped[0]).toBeCloseTo(7.5, 6);
		expect(flipped[1]).toBeCloseTo(7.5, 6);
	});

	it("renders the verdict chip in the bottom-left of the destination square and animates it once", () => {
		const { win } = boot("<cg-container></cg-container>");
		const animations = captureAnimations(win);
		const payload = batch([THREAT], { b: { q: "e4", j: 9 } });
		sendToPage(win, command("effects", "chip", payload));
		const chip = [...win.document.querySelectorAll("g")].find((g) =>
			(g.getAttribute("transform") ?? "").includes("scale(")
		);
		expect(chip).toBeDefined();
		const [, x, y] =
			/translate\(([-\d.]+) ([-\d.]+)\)/.exec(chip?.getAttribute("transform") ?? "") ?? [];
		// e4 on a white-at-the-bottom board is col 4, row 4; the chip sits low and left inside it.
		expect(Number(x)).toBeCloseTo(4 + MOVE_QUALITY.chipAnchorX - MOVE_QUALITY.chipSize / 2, 6);
		expect(Number(y)).toBeCloseTo(4 + MOVE_QUALITY.chipAnchorY - MOVE_QUALITY.chipSize / 2, 6);
		const brilliant = MOVE_QUALITY_ICONS[9];
		const discs = [...win.document.querySelectorAll("path")].map((p) => p.getAttribute("fill"));
		expect(discs).toContain(brilliant!.background);
		expect(discs).toContain(MOVE_QUALITY_ART.shadowFill);
		// Each glyph path appears twice: its shadow copy and the white face.
		const glyphs = [...win.document.querySelectorAll("path")].filter(
			(p) => p.getAttribute("d") === brilliant?.glyph[0]
		);
		expect(glyphs).toHaveLength(2);
		const chipRun = animations.find((a) => a.options.duration === CHIP_LIFE);
		expect(chipRun?.frames.at(0)).toMatchObject({ opacity: 0 });
		expect(chipRun?.frames.at(-1)).toMatchObject({ opacity: 0, offset: 1 });
		// It holds at the chip opacity, not fully opaque.
		expect(chipRun?.frames.slice(1, -1).map((f) => f.opacity)).toEqual([
			MOVE_QUALITY.chipOpacity,
			MOVE_QUALITY.chipOpacity,
			MOVE_QUALITY.chipOpacity,
		]);
		expect(chipRun?.options.fill).toBe("forwards");
		// The arrow the chip was sent beside is on the layer with it, plus the chip's own paths
		// (rim, disc, and every glyph twice).
		const glyphCount = brilliant?.glyph.length ?? 0;
		expect(win.document.querySelectorAll("path")).toHaveLength(1 + 2 + 2 * glyphCount);
		// The same payload again replays nothing.
		const before = animations.length;
		sendToPage(win, command("effects", "chip-again", payload));
		expect(animations).toHaveLength(before);
	});

	it("draws the forced-mate chip, the eleventh category, from its wire index like any other", () => {
		expect(MOVE_QUALITY_ICONS).toHaveLength(MOVE_QUALITY_ORDER.length);
		const index = MOVE_QUALITY_ORDER.indexOf("mate");
		expect(index).toBe(10);
		const { win } = boot("<cg-container></cg-container>");
		captureAnimations(win);
		sendToPage(win, command("effects", "mate", batch([], { b: { q: "f7", j: index } })));
		const mate = MOVE_QUALITY_ICONS[index];
		const fills = [...win.document.querySelectorAll("path")].map((p) => p.getAttribute("fill"));
		expect(fills).toContain(mate!.background);
		const glyphs = [...win.document.querySelectorAll("path")].filter(
			(p) => p.getAttribute("d") === mate?.glyph[0]
		);
		expect(glyphs).toHaveLength(2);
		expect(win.document.querySelectorAll("path")).toHaveLength(2 + 2 * (mate?.glyph.length ?? 0));
	});

	it("draws just the chip from a batch with no rays at all", () => {
		// Owner, 2026-09-15: board effects off, move ratings on — the batch carries an empty effect
		// list and the layer is the chip alone.
		const { win, posts } = boot("<cg-container></cg-container>");
		const animations = captureAnimations(win);
		sendToPage(win, command("effects", "chip-only", batch([], { b: { q: "e4", j: 6 } })));
		expect(reply(posts, "chip-only")?.p).toBe(true);
		const icon = MOVE_QUALITY_ICONS[6];
		const paths = [...win.document.querySelectorAll("path")];
		// The rim, the disc and each glyph twice — and nothing painted through an arrow gradient.
		expect(paths).toHaveLength(2 + 2 * (icon?.glyph.length ?? 0));
		expect(paths.some((p) => (p.getAttribute("fill") ?? "").startsWith("url("))).toBe(false);
		expect(win.document.querySelectorAll("line")).toHaveLength(0);
		// One animation: the chip's own life, no effect group behind it.
		expect(animations).toHaveLength(1);
		expect(animations[0]?.options.duration).toBe(CHIP_LIFE);
		// The other side's chip-only batch that follows adds its own chip on its own square.
		sendToPage(
			win,
			command("effects", "chip-only-2", { ...batch([], { b: { q: "d5", j: 2 } }), u: false })
		);
		expect(reply(posts, "chip-only-2")?.p).toBe(true);
		expect(
			[...win.document.querySelectorAll("g")].filter((g) =>
				(g.getAttribute("transform") ?? "").includes("scale(")
			)
		).toHaveLength(2);
	});

	it("adds a later verdict without replaying the rays it was sent beside", () => {
		const { win } = boot("<cg-container></cg-container>");
		const animations = captureAnimations(win);
		sendToPage(win, command("effects", "rays", batch([THREAT])));
		const rayAnimations = animations.length;
		const shaft = win.document.querySelector("path");
		sendToPage(win, command("effects", "verdict", batch([], { b: { q: "e4", j: 6 } })));
		// The shaft is the same element, none of its animations were cancelled, and only the chip
		// animation was added.
		expect(win.document.querySelector("path")).toBe(shaft);
		expect(animations.slice(0, rayAnimations).some((a) => a.cancelled)).toBe(false);
		expect(animations).toHaveLength(rayAnimations + 1);
		// And the chip is drawn beside the rays, not instead of them.
		expect(shaft?.isConnected).toBe(true);
		const chip = [...win.document.querySelectorAll("g")].find((g) =>
			(g.getAttribute("transform") ?? "").includes("scale(")
		);
		expect(chip?.isConnected).toBe(true);
	});

	it.each([false, true])(
		"late badges preserve newer arrows without replaying them (reduced motion: %s)",
		(reduced) => {
			const { win } = boot("<cg-container></cg-container>");
			const animations = captureAnimations(win, reduced);
			sendToPage(win, command("effects", "first", batch([THREAT])));
			const next = batch([{ n: K.check, f: "f8", t: "e8" }], { u: false });
			sendToPage(win, command("effects", "second", next));
			const arrows = [...win.document.querySelectorAll("path")];
			const before = animations.length;
			sendToPage(win, command("effects", "old-badge", batch([], { b: { q: "e4", j: 6 } })));
			expect(arrows.every((arrow) => arrow.isConnected)).toBe(true);
			expect(animations).toHaveLength(before + (reduced ? 0 : 1));
			const withBadge = win.document.querySelectorAll("path").length;
			// The badge did not disturb the current ray-batch deduplication either.
			sendToPage(win, command("effects", "repeat-second", next));
			expect(win.document.querySelectorAll("path")).toHaveLength(withBadge);
			expect(arrows.every((arrow) => arrow.isConnected)).toBe(true);
		}
	);

	it("keeps the previous move's rays and chip running when a new batch arrives; each removes itself", async () => {
		const { win } = boot("<cg-container></cg-container>");
		const animations = captureAnimations(win);
		sendToPage(win, command("effects", "first", batch([THREAT], { b: { q: "e4", j: 0 } })));
		const first = [...animations];
		const firstShaft = win.document.querySelector("path");
		const pathsAfterFirst = win.document.querySelectorAll("path").length;
		expect(pathsAfterFirst).toBeGreaterThan(1);
		sendToPage(win, command("effects", "second", batch([{ n: K.threat, f: "g1", t: "e7" }])));
		// Nothing of the first batch was cancelled or removed: the second's arrow is added.
		expect(first.some((a) => a.cancelled)).toBe(false);
		expect(firstShaft?.isConnected).toBe(true);
		expect(win.document.querySelectorAll("path")).toHaveLength(pathsAfterFirst + 1);
		// The first group's own fade ends: its arrow goes, the chip and the second group stay.
		const firstFade = first.find((a) => a.options.duration === LIFE);
		firstFade?.finish();
		await Promise.resolve();
		await Promise.resolve();
		expect(firstShaft?.isConnected).toBe(false);
		expect(win.document.querySelectorAll("path")).toHaveLength(pathsAfterFirst);
		// The chip's own run ends: it goes, the second group is still there.
		first.find((a) => a.options.duration === CHIP_LIFE)?.finish();
		await Promise.resolve();
		await Promise.resolve();
		expect(win.document.querySelectorAll("path")).toHaveLength(1);
	});

	it("replaces a chip on the same square and keeps one on another square", () => {
		const { win } = boot("<cg-container></cg-container>");
		const animations = captureAnimations(win);
		const chips = () =>
			[...win.document.querySelectorAll("g")].filter((g) =>
				(g.getAttribute("transform") ?? "").includes("scale(")
			);
		sendToPage(win, command("effects", "a", batch([], { b: { q: "f8", j: 6 } })));
		const theirs = chips()[0];
		// Our recapture on the same square with the same verdict: a new chip, the old one gone.
		sendToPage(win, command("effects", "b", { r: "w", u: false, z: [], b: { q: "f8", j: 6 } }));
		expect(theirs?.isConnected).toBe(false);
		expect(chips()).toHaveLength(1);
		expect(animations.filter((a) => a.options.duration === CHIP_LIFE)).toHaveLength(2);
		expect(animations[0]?.cancelled).toBe(true);
		// A chip on another square is added beside it.
		sendToPage(win, command("effects", "c", batch([], { b: { q: "e4", j: 4 } })));
		expect(chips()).toHaveLength(2);
	});

	it("caps the live groups across batches, evicting the oldest first", () => {
		const { win } = boot("<cg-container></cg-container>");
		const animations = captureAnimations(win);
		const cap = BOARD_EFFECT_LIMITS.maxLiveGroups;
		sendToPage(win, command("effects", "0", batch([THREAT])));
		const oldest = win.document.querySelector("path");
		const oldestAnimations = [...animations];
		for (let i = 1; i <= cap; i += 1) {
			// Distinct batches: a different target square each time, and the side alternating.
			const t = `${"abcdefgh"[i % 8]}${1 + (i % 4) * 2}`;
			sendToPage(
				win,
				command("effects", String(i), { r: "w", u: i % 2 === 0, z: [{ n: K.threat, f: "e4", t }] })
			);
		}
		const groups = win.document.querySelectorAll(`svg.${effectsClass} > g`);
		expect(groups).toHaveLength(cap);
		expect(oldest?.isConnected).toBe(false);
		expect(oldestAnimations.every((a) => a.cancelled)).toBe(true);
	});

	it("keeps a static, usable layer when reduced motion is enabled, replaced by the next batch", () => {
		const { win } = boot("<cg-container></cg-container>");
		const animations = captureAnimations(win, true);
		sendToPage(win, command("effects", "reduced", batch([THREAT], { b: { q: "e4", j: 4 } })));
		expect(animations).toEqual([]);
		const shaft = win.document.querySelector("path");
		const staticPaths = win.document.querySelectorAll("path").length;
		expect(staticPaths).toBeGreaterThan(1);
		// A late verdict for the same batch joins it; a new batch replaces the whole static layer.
		sendToPage(win, command("effects", "late", batch([], { b: { q: "e4", j: 6 } })));
		expect(shaft?.isConnected).toBe(true);
		sendToPage(win, command("effects", "next", batch([{ n: K.threat, f: "g1", t: "e7" }])));
		expect(shaft?.isConnected).toBe(false);
		expect(win.document.querySelectorAll("path")).toHaveLength(1);
	});

	it("repairs the layer after the board host is replaced", () => {
		const { win } = boot("<cg-container></cg-container>");
		const payload = batch([THREAT]);
		sendToPage(win, command("effects", "before-spa", payload));
		win.document.body.innerHTML = "<cg-container></cg-container>";
		sendToPage(win, command("effects", "after-spa", payload));
		expect(win.document.querySelectorAll(`svg.${effectsClass}`)).toHaveLength(1);
		expect(win.document.querySelectorAll("path")).toHaveLength(1);
	});

	it("ignores an unknown kind and an unknown verdict index rather than throwing", () => {
		const { win } = boot("<cg-container></cg-container>");
		sendToPage(
			win,
			command("effects", "junk", batch([{ n: "?", f: "a1", t: "a8" }], { b: { q: "a1", j: 99 } }))
		);
		expect(win.document.querySelectorAll("path")).toHaveLength(0);
		expect(win.document.querySelectorAll("circle")).toHaveLength(0);
	});

	it("fades the layer out on clear and lets a new batch build a fresh one beside it", async () => {
		const { win } = boot("<cg-container></cg-container>");
		const animations = captureAnimations(win);
		sendToPage(win, command("effects", "1", batch([THREAT])));
		const before = animations.length;
		sendToPage(win, command("effectsClear", "2"));
		const fade = animations[animations.length - 1];
		expect(animations).toHaveLength(before + 1);
		expect(fade?.frames.map((f) => f.opacity)).toEqual([1, 0]);
		const svg = win.document.querySelector("svg");
		expect(svg?.classList.contains(effectsClass)).toBe(false);
		sendToPage(win, command("effects", "3", batch([THREAT])));
		expect(win.document.querySelectorAll("svg")).toHaveLength(2);
		expect(win.document.querySelectorAll(`svg.${effectsClass}`)).toHaveLength(1);
		fade?.finish();
		await Promise.resolve();
		await Promise.resolve();
		expect(win.document.querySelectorAll("svg")).toHaveLength(1);
	});
});

const LIFE = BOARD_EFFECT_MOTION.drawMs + BOARD_EFFECT_MOTION.holdMs + BOARD_EFFECT_MOTION.fadeMs;
const CHIP_LIFE = MOVE_QUALITY.chipInMs + MOVE_QUALITY.chipHoldMs + MOVE_QUALITY.chipOutMs;
