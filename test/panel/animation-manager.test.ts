// test/panel/animation-manager.test.ts — `ANIM` takes every duration/easing from TOKENS.motion
// and degrades to opacity-only crossfades under reduced motion (Appendix F §8.4).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TOKENS } from "@design/tokens.generated";
import { ANIM } from "@panel/animation-manager";
import { createSimulator, type Simulator } from "@test/sim";
import { bootPanelContext, type PanelContext } from "@test/sim/contexts/panel-context";

interface Recorded {
	keyframes: Keyframe[];
	options: KeyframeAnimationOptions;
}

let sim: Simulator;
let panel: PanelContext;

beforeEach(async () => {
	sim = createSimulator();
	panel = await bootPanelContext(sim);
});
afterEach(async () => {
	await panel.teardown();
	await sim.dispose();
});

function animatable(): { el: HTMLElement; calls: Recorded[] } {
	const el = document.createElement("div");
	const calls: Recorded[] = [];
	(el as HTMLElement & { animate: unknown }).animate = (
		keyframes: Keyframe[],
		options: KeyframeAnimationOptions
	) => {
		calls.push({ keyframes, options });
		return { finished: Promise.resolve() } as unknown as Animation;
	};
	return { el, calls };
}

describe("ANIM", () => {
	it("exposes the token tables and no literals", () => {
		expect(ANIM.duration).toBe(TOKENS.motion.durationMs);
		expect(ANIM.easing).toBe(TOKENS.motion.easing);
	});

	it("fade uses duration 2-5 with standard (in) / exit (out) curves", async () => {
		const { el, calls } = animatable();
		await ANIM.fade(el, "in");
		await ANIM.fade(el, "out");
		expect(calls[0]?.options).toMatchObject({
			duration: TOKENS.motion.durationMs["2-5"],
			easing: TOKENS.motion.easing.standard,
		});
		expect(calls[0]?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
		expect(calls[1]?.options.easing).toBe(TOKENS.motion.easing.exit);
	});

	it("slide moves by space.2 by default; rise by space.4 with the emphasized curve; spring over duration 6", async () => {
		const { el, calls } = animatable();
		await ANIM.slide(el, "left");
		await ANIM.rise(el);
		await ANIM.spring(el);
		expect(calls[0]?.keyframes[0]?.transform).toBe(`translateX(${TOKENS.space[2]}px)`);
		expect(calls[0]?.options.duration).toBe(TOKENS.motion.durationMs["2-5"]);
		expect(calls[1]?.keyframes[0]?.transform).toBe(`translateY(${TOKENS.space[4]}px)`);
		expect(calls[1]?.options).toMatchObject({
			duration: TOKENS.motion.durationMs[4],
			easing: TOKENS.motion.easing.emphasized,
		});
		expect(calls[2]?.options).toMatchObject({
			duration: TOKENS.motion.durationMs[6],
			easing: TOKENS.motion.easing.spring,
		});
	});

	it("reduced motion strips every transform and crossfades at duration 2-5", async () => {
		document.body.dataset.reducedMotion = "true";
		const { el, calls } = animatable();
		await ANIM.slide(el, "left");
		await ANIM.rise(el);
		await ANIM.spring(el);
		await ANIM.popIn(el);
		await ANIM.scaleIn(el);
		for (const c of calls) {
			expect(c.options.duration).toBe(TOKENS.motion.durationMs["2-5"]);
			for (const k of c.keyframes) expect(k.transform).toBeUndefined();
		}
		expect(calls).toHaveLength(5);
	});

	it("resolves immediately when the element cannot animate", async () => {
		const el = document.createElement("div");
		await expect(ANIM.fade(el, "in")).resolves.toBeUndefined();
	});
});
