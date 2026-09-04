/**
 * Per-game "form" latent (§7.2 inputs, Appendix E §1.5 consistency):
 * `form_t = 0.85·form_{t−1} + N(0, 0.25)`, clamped ±1. The timing personas are
 * Task 16; this file only owns the strength-side form term.
 */

import type { Rng } from "@core/rng";
import { clamp } from "@core/util/clamp";
import { SELECTION_CONSTANTS as C } from "./constants";

export class FormLatent {
	private current: number;

	constructor(
		private readonly rng: Rng,
		initial = 0
	) {
		this.current = clamp(initial, -C.form.clampAbs, C.form.clampAbs);
	}

	/** The latest form value in [−1, 1]. */
	get value(): number {
		return this.current;
	}

	/** Advance one move: AR(1) step with the seeded rng; returns the new value. */
	next(): number {
		const drawn = C.form.ar * this.current + this.rng.normal(0, C.form.noiseSigma);
		this.current = clamp(drawn, -C.form.clampAbs, C.form.clampAbs);
		return this.current;
	}
}

export function createFormLatent(rng: Rng, initial = 0): FormLatent {
	return new FormLatent(rng, initial);
}

/** The Elo shift the form term contributes: `150·form` (§7.2 step 1). */
export function formEloShift(form: number): number {
	return C.form.eloPerUnit * form;
}
