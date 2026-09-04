/**
 * Animation manager (Part I §10.2, Appendix F §3.2/§6): every duration and easing comes from
 * `TOKENS.motion` — no numeric literal lives here, so CSS and JS motion can never disagree.
 *
 * Under reduced motion (Appendix F §8.4) every helper degrades to an opacity-only crossfade at
 * `duration["2-5"]`; transforms are never applied. Without the Web Animations API (tests) the
 * helpers resolve immediately, leaving the element in its final state.
 */

import { TOKENS } from "@design/tokens.generated";
import { isReducedMotion } from "./theme";

export type FadeDirection = "in" | "out";
export type SlideDirection = "left" | "right" | "up" | "down";

type Animatable = HTMLElement & {
	animate?: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => Animation;
};

const durationMs = TOKENS.motion.durationMs;
const easing = TOKENS.motion.easing;

function run(
	el: HTMLElement,
	keyframes: Keyframe[],
	options: KeyframeAnimationOptions
): Promise<void> {
	const target = el as Animatable;
	if (typeof target.animate !== "function") return Promise.resolve();
	try {
		const animation = target.animate(keyframes, { fill: "both", ...options });
		return animation.finished.then(
			() => undefined,
			() => undefined
		);
	} catch {
		return Promise.resolve();
	}
}

function translate(dir: SlideDirection, px: number): string {
	switch (dir) {
		case "left":
			return `translateX(${px}px)`;
		case "right":
			return `translateX(${-px}px)`;
		case "up":
			return `translateY(${px}px)`;
		case "down":
			return `translateY(${-px}px)`;
	}
}

export const ANIM = {
	duration: durationMs,
	easing,

	/** Opacity crossfade: enter `duration["2-5"]` standard, exit `duration["2-5"]` exit curve. */
	fade(el: HTMLElement, dir: FadeDirection): Promise<void> {
		const frames: Keyframe[] =
			dir === "in" ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }];
		return run(el, frames, {
			duration: durationMs["2-5"],
			easing: dir === "in" ? easing.standard : easing.exit,
		});
	},

	/** Tab-to-tab: crossfade + `px` slide (default `space.2`) in the tab-order direction. */
	slide(el: HTMLElement, dir: SlideDirection, px: number = TOKENS.space[2]): Promise<void> {
		if (isReducedMotion()) return ANIM.fade(el, "in");
		return run(
			el,
			[
				{ opacity: 0, transform: translate(dir, px) },
				{ opacity: 1, transform: "translate(0, 0)" },
			],
			{ duration: durationMs["2-5"], easing: easing.standard }
		);
	},

	/** Interrupt card entrance: rises `space.4` → 0 over `duration[4]`, emphasized. */
	rise(el: HTMLElement, px: number = TOKENS.space[4]): Promise<void> {
		if (isReducedMotion()) return ANIM.fade(el, "in");
		return run(
			el,
			[
				{ opacity: 0, transform: `translateY(${px}px)` },
				{ opacity: 1, transform: "translateY(0)" },
			],
			{ duration: durationMs[4], easing: easing.emphasized }
		);
	},

	/** New SAN / armed thumb snap: spring curve over `duration[6]` (§6.3). */
	spring(el: HTMLElement, px: number = TOKENS.space[2]): Promise<void> {
		if (isReducedMotion()) return ANIM.fade(el, "in");
		return run(
			el,
			[
				{ opacity: 0, transform: `translateY(${px}px)` },
				{ opacity: 1, transform: "translateY(0)" },
			],
			{ duration: durationMs[6], easing: easing.spring }
		);
	},

	/** Old SAN exits upward `space.2` with fade over `duration["2-5"]`, exit curve (§6.3). */
	exitUp(el: HTMLElement, px: number = TOKENS.space[2]): Promise<void> {
		if (isReducedMotion()) return ANIM.fade(el, "out");
		return run(
			el,
			[
				{ opacity: 1, transform: "translateY(0)" },
				{ opacity: 0, transform: `translateY(${-px}px)` },
			],
			{ duration: durationMs["2-5"], easing: easing.exit }
		);
	},

	/** Toast / popover entrance: rise `space.2` + fade, `duration[4]` emphasized (§5.11). */
	popIn(el: HTMLElement, px: number = TOKENS.space[2]): Promise<void> {
		if (isReducedMotion()) return ANIM.fade(el, "in");
		return run(
			el,
			[
				{ opacity: 0, transform: `translateY(${px}px)` },
				{ opacity: 1, transform: "translateY(0)" },
			],
			{ duration: durationMs[4], easing: easing.emphasized }
		);
	},

	/** Popover opening: scale 0.96 → 1 + fade, `duration["2-5"]` emphasized (§5.12). */
	scaleIn(el: HTMLElement): Promise<void> {
		if (isReducedMotion()) return ANIM.fade(el, "in");
		return run(
			el,
			[
				{ opacity: 0, transform: "scale(0.96)" },
				{ opacity: 1, transform: "scale(1)" },
			],
			{ duration: durationMs["2-5"], easing: easing.emphasized }
		);
	},

	/** Popover closing: `duration["1-5"]` exit curve. */
	scaleOut(el: HTMLElement): Promise<void> {
		return run(el, [{ opacity: 1 }, { opacity: 0 }], {
			duration: durationMs["1-5"],
			easing: easing.exit,
		});
	},
} as const;

export type AnimationManager = typeof ANIM;
