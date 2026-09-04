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
