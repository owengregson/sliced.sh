/** Directory of every UI sound, relative to the extension root. */
export const SOUNDS_DIR = "assets/sounds/";

/** File names under `SOUNDS_DIR`. */
export const SOUNDS = {
	clickLight: "click_light.wav",
	clickHeavy: "click_heavy.wav",
	clickLightOff: "click_light_disable.wav",
	clickHeavyOff: "click_heavy_disable.wav",
	guiOpen: "gui_open.mp3",
	guiOff: "gui_disable.wav",
	slide: "slider_slide.mp3",
	smallSlide: "small_slide.mp3",
	tick: "tick_light.mp3",
	makeMove: "make_move.wav",
	slamLight: "slam_light.wav",
	slamHeavy: "slam_heavy.wav",
	slamLow: "slam_low.wav",
} as const;

/**
 * Scrubbing feedback (2026-09-13): the slider's steps are grouped into at most `maxDetents`
 * audible detents and a quiet, pitch-mapped sample plays when the thumb crosses one. A per-slider
 * rate limiter keeps the ticks at or under `maxTicksPerSecond` by thinning to every k-th detent
 * when the crossing rate is higher, so a fast sweep is a smooth ripple and a slow drag ticks every
 * detent. Volume falls with the crossing speed (`volumeAtSpeed`); the release plays one softer
 * settle tick only when the value changed since the press (`createDetentScheduler`).
 */
export const SLIDER_SOUND = {
	/** Audible detents per slider at most; steps are grouped so no slider exceeds this. */
	maxDetents: 24,
	/** Ticks per second at most, per slider, whatever the drag speed. */
	maxTicksPerSecond: 14,
	pitchMin: 0.8,
	pitchRange: 0.65,
	/** The volume of a deliberate (slow) step. */
	volume: 0.22,
	/**
	 * Crossing speed in detents per second: at or below `slowDetentsPerSec` a tick has the full
	 * `volume`; at or above `fastDetentsPerSec` it has `minFraction` of it; linear between.
	 */
	volumeAtSpeed: { slowDetentsPerSec: 4, fastDetentsPerSec: 30, minFraction: 0.35 },
	/** The settle tick on release, as a fraction of `volume`. */
	settleFraction: 0.7,
} as const;
