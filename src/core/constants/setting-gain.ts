/**
 * Internal gains on the user's sliders (owner, 2026-09-13): "move the default multipliers
 * INTERNALLY". The Settings view, the stored profile and every range in `SETTINGS_RANGES` /
 * `LIMITS` stay in the user's own units — a user at 1.0× still sees, stores and exports 1.0× —
 * and the number the model or the hand actually acts on is `user × gain` (or, for the premove
 * knob, the piecewise map below). Applied once per setting, at the boundary where a `Settings`
 * leaf becomes a model or executor input, and nowhere in the panel:
 *
 * - timing knobs → `timingSettingsFor` (`src/service/game-session/presets.ts`),
 * - hand knobs   → `executorSettingsFor` (`src/service/game-session/executor-settings.ts`).
 *
 * The one knob the same instruction re-based *visibly* is the persona offset: "+150 (not +50)
 * — dont internal shift this one, just shift the setting default", so that is a plain change of
 * `DEFAULT_SETTINGS.strength.personaEloOffset` and has no entry here.
 */

/** Declared here rather than imported, so a constants registry never depends on the timing model. */
type GainTcClass = "bullet" | "blitz" | "rapid" | "classical" | "untimed";

export const SETTING_GAIN = {
	/**
	 * "preview rate 1.0x = 1.25x" (owner, 2026-09-13). `Settings.execution.previewSelectScale`
	 * multiplies the modelled preview-selection rate (`previewProbability`); the stored default
	 * goes back to 1.0 (it had been raised to 1.1 on 2026-09-11 for the same reason) and the hand
	 * runs at this multiple of the slider.
	 *
	 * **1.25 could not stand: it puts the hand above the human band.**
	 * `DidSelectMultiplePieces` is a §13.2 population rate with a 4–12 % band, and the pooled gate
	 * (`test/behavioral/telemetry/single-piece-select.test.ts`, 30 seeded games, 594 non-trivial
	 * moves) measures, on 2026-09-14:
	 *
	 * | gain | 1.00 | 1.05 | 1.10 | 1.12 | 1.15 | 1.20 | 1.25 |
	 * |---|---|---|---|---|---|---|---|
	 * | rate | 10.61 % | 11.28 % | **11.45 %** | 11.45 % | 11.78 % | 12.63 % | 13.30 % |
	 *
	 * The baseline is already 10.6 %, so the whole band affords about 1.17× before a human stops
	 * previewing this often — the knob had less headroom than the instruction assumed. 1.10 is the
	 * value taken: 11.45 %, three moves of margin under the ceiling, where 1.15 leaves one. Nothing
	 * is lost that the user cannot take back by hand — the slider itself still goes to 2.0, and this
	 * gain only re-bases where its 1.0 sits.
	 */
	previewSelectScale: 1.1,
	/**
	 * "motor speed default natural = 1 slider tick before Fast". The slider is
	 * `SETTINGS_RANGES.motorSpeed` (0.5…2, step 0.05) and the panel labels it Slow below 0.85,
	 * Natural up to and including 1.15, Fast above (`motorLabel`, `src/panel/views/settings/rows.ts`):
	 * the first Fast tick is 1.20, one tick before it is 1.15, and the default the user sees is
	 * 1.0 — so gain = 1.15 / 1.0 = 1.15. The executor's clamp (`boundedMotorSpeed`) is widened by
	 * the same factor so the top of the slider keeps its meaning.
	 */
	motorSpeed: 1.15,
	/** "long think frequency 1.0x = 0.8x": `λ0` runs at 0.8× the slider. */
	longThinkFrequency: 0.8,
	/**
	 * "base speed 1.0x = 1.3x": the sampled think time runs at 1.3× the slider — **except in the
	 * two classes where that measurably loses games on the clock**.
	 *
	 * The gain multiplies a *duration*, so 1.3 is 30 % longer per move than the build before
	 * 2026-09-13. In rapid and classical there is room for it and the owner asked for it. In blitz
	 * there is not: measured over the owner's own 97 chess.com games (3+0, our Elo 2401–2452,
	 * `docs/research/chessmimic-bands-and-the-clock-2026-09-13.md`) we reached move 20 with 75 s
	 * against the human opponents' 101 s and move 30 with 40 s against their 59 s, and lost 8 of 27
	 * on time. The simulator prices this term at 11.7 s of that gap by move 20 alone (101.7 s left
	 * at 1.0 against 90.0 s at 1.3), and it is also what pushes a sub-second draw over a second —
	 * the fast tail `TIMING_CONSTANTS.chessmimic.fastFloor` exists to restore. A 10+0 is untouched:
	 * the same simulator leaves 297 s at move 40.
	 *
	 * So the gain is per time-control class, read at `timingSettingsFor` where the class is known.
	 * A game whose time control is not known yet takes the blitz value: erring fast costs a little
	 * realism, erring slow costs the game, and an unknown live time control is far more likely to
	 * be blitz than classical.
	 */
	speedScale: {
		bullet: 1,
		blitz: 1,
		rapid: 1.3,
		classical: 1.3,
		untimed: 1.3,
	} as Readonly<Record<GainTcClass, number>>,
	/**
	 * "premove tendency = 80%". The slider is a probability-like knob on [0, 1] shown as a
	 * percentage, so a plain multiplier would push its top past 1; instead the user's value goes
	 * through a monotone piecewise-linear map whose knots are (0 → 0, 0.5 → 0.8, 1 → 1): the
	 * default 50 % acts as 80 %, and both ends still mean "never" and "always".
	 */
	premoveTendency: {
		knots: [
			[0, 0],
			[0.5, 0.8],
			[1, 1],
		] as ReadonlyArray<readonly [user: number, effective: number]>,
	},
} as const;

/**
 * The premove knob the timing model acts on for a slider value: linear between the
 * `SETTING_GAIN.premoveTendency.knots`, clamped to the slider's own [0, 1].
 */
export function effectivePremoveTendency(user: number): number {
	const knots = SETTING_GAIN.premoveTendency.knots;
	const first = knots[0];
	const last = knots[knots.length - 1];
	if (!first || !last) return user;
	if (!Number.isFinite(user) || user <= first[0]) return first[1];
	if (user >= last[0]) return last[1];
	for (let i = 1; i < knots.length; i++) {
		const lo = knots[i - 1];
		const hi = knots[i];
		if (!lo || !hi || user > hi[0]) continue;
		const t = (user - lo[0]) / (hi[0] - lo[0]);
		return lo[1] + t * (hi[1] - lo[1]);
	}
	return last[1];
}
