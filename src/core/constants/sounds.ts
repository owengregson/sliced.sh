import type { MoveQuality } from "@core/constants/move-quality";

/** Directory of every UI sound, relative to the extension root. */
export const SOUNDS_DIR = "assets/sounds/";

export const MOVE_RATING_SOUNDS = {
	brilliant: "brilliant.mp3",
	great: "great.mp3",
	inaccuracy: "inaccuracy.mp3",
	mistake: "mistake.mp3",
	blunder: "blunder.mp3",
} as const;

export type MoveRatingSoundQuality = keyof typeof MOVE_RATING_SOUNDS;

/** The rating clips play at the media element's own volume and speed. */
export const MOVE_RATING_PLAYBACK = {
	volume: 1,
	playbackRate: 1,
} as const;

/** The chip whose sound is `FORCED_MATE_SOUNDS.file` rather than a `MOVE_RATING_SOUNDS` clip. */
export type ForcedMateSoundQuality = Extract<MoveQuality, "mate">;

/**
 * The forced-mate sound (owner, 2026-09-14; one clip since 2026-09-15: "just use forced.mp3
 * without a number, don't swap between the sound files"). Every move of a forced mating sequence,
 * the checkmate included, plays `file` at the pitch the service worker put on its chip
 * (`MOVE_QUALITY.mateTopSemitones` and friends), applied the way the panel pitches its slider
 * ticks: `playbackRate` 2^(semitones / `semitonesPerOctave`) with `preservesPitch` off, so a
 * higher step is also a shorter one. That resampling replaces the 2026-09-14 1.5× pitch-preserving
 * speed-up — one media element cannot both time-stretch and resample. At `volumeScale` of
 * `MOVE_RATING_PLAYBACK.volume`.
 */
export const FORCED_MATE_SOUNDS = {
	file: "forced.mp3",
	volumeScale: 0.8,
	semitonesPerOctave: 12,
} as const;

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
