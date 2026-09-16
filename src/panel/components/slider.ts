/**
 * Slider with value bubble (Appendix F §5.3): track / fill / thumb (`role="slider"`) / bubble /
 * caption / resting value. Arrow keys step, Shift ×10, PageUp/Down ×10, Home/End. Pointer drags
 * follow the track; `onChange(value, commit)` fires live while dragging and once with
 * `commit = true` on release (keyboard steps always commit). Danger zone past a threshold.
 * Scrub sounds come from a per-slider detent scheduler (`createDetentScheduler`); a `readout`
 * shows the numeric value under the thumb while the slider changes and fades
 * `UI_TIMINGS.sliderReadoutFadeMs` after the last change. A strength slider in its hot range
 * launches its warm sweeps itself (`launchSweep`), so no change of cadence ever re-times a sweep
 * that is already crossing.
 */

import { STRENGTH_UI, UI_TIMINGS } from "@core/constants/ui";
import { clamp } from "@core/util/clamp";
import { TOKENS } from "@design/tokens.generated";
import { createDetentScheduler, playSliderSound } from "../sounds";
import { instantiate, part } from "../template";
import html from "../views/templates/components/slider.html?raw";

export interface SliderThreshold {
	value: number;
	label: string;
	lowerLabel: string;
	upperLabel: string;
	description: string;
}

export interface SliderOptions {
	min: number;
	max: number;
	step: number;
	value: number;
	/** Human label shown in the bubble and `aria-valuetext` ("Club 1200", "Natural", "1/9"). */
	label: (value: number) => string;
	/** Resting numeric text on the right (default: the number). */
	format?: (value: number) => string;
	/**
	 * Numeric readout under the thumb for sliders whose resting text is a label ("Natural"):
	 * shown while the value changes, faded out `UI_TIMINGS.sliderReadoutFadeMs` after the last
	 * change. `aria-hidden` — the bubble already carries `aria-valuetext`.
	 */
	readout?: (value: number) => string;
	/**
	 * One line under the track naming the current value's category ("Club"), kept in step with the
	 * value (owner, 2026-09-15 — it replaced a row listing every category). `aria-hidden`: the
	 * thumb's `aria-valuetext` already says it.
	 */
	caption?: (value: number) => string;
	threshold?: SliderThreshold;
	/**
	 * Unlabelled hairline markers at these values (no title, no label row): reference points that
	 * are not the primary `threshold` (the offset sliders' even point).
	 */
	markers?: readonly number[];
	/** Continuous orange-to-red rating fill, with a glow at very high strength. */
	strength?: boolean;
	danger?: (value: number) => boolean;
	dangerHint?: string;
	disabled?: boolean;
	/**
	 * Show `value` as given — clamped to the range but not snapped to `step`: a reading of what is
	 * in effect (the Elo an opponent-matched game plays at), not a position the user picked.
	 */
	exact?: boolean;
	ariaLabel?: string;
	onChange: (value: number, commit: boolean) => void;
}

export interface SliderUpdate {
	value?: number;
	/** With `value`: show it as given (`SliderOptions.exact`). A later user step snaps again. */
	exact?: boolean;
	disabled?: boolean;
	min?: number;
	max?: number;
}

export interface SliderHandle {
	readonly el: HTMLElement;
	readonly value: number;
	update(patch: SliderUpdate): void;
	dispose(): void;
}

/** The two keyframe names a sweep alternates between (`css/views/live-progress.css`). */
const SWEEP_NAMES = ["a", "b"] as const;

export function createSlider(host: HTMLElement | null, options: SliderOptions): SliderHandle {
	const el = instantiate(html);
	const track = part(el, ".sl-slider__track");
	const fill = part(el, ".sl-slider__fill");
	const thumb = part(el, ".sl-slider__thumb");
	const bubble = part(el, ".sl-slider__bubble");
	const readoutEl = part(el, ".sl-slider__readout");
	const valueEl = part(el, ".sl-slider__value");
	const captionEl = part(el, ".sl-slider__caption");
	const hint = part(el, ".sl-slider__hint");
	const divider = part(el, ".sl-slider__divider");
	const ticks = part(el, ".sl-slider__ticks");
	const markers = part(el, ".sl-slider__markers");
	const boundary = part(el, ".sl-slider__boundary");
	const sweeps = Array.from(part(el, ".sl-slider__energy").children) as HTMLElement[];
	const markerEls: Array<{ value: number; el: HTMLElement }> = [];
	for (const markerValue of options.markers ?? []) {
		const marker = document.createElement("span");
		marker.className = "sl-slider__marker";
		marker.dataset.value = String(markerValue);
		markers.append(marker);
		markerEls.push({ value: markerValue, el: marker });
	}
	if (options.threshold) {
		divider.hidden = false;
		boundary.hidden = true;
		divider.setAttribute("title", options.threshold.description);
		thumb.setAttribute("aria-description", options.threshold.description);
	}
	if (options.caption) captionEl.hidden = false;
	const format = options.format ?? ((v: number): string => String(v));

	let min = options.min;
	let max = options.max;
	let value = options.value;
	let exact = options.exact === true;
	let disabled = options.disabled ?? false;
	let dragging: number | null = null;
	/** When the last pointer commit happened (`UI_TIMINGS.sliderCommitGraceMs`). */
	let committedAt: number | null = null;
	let tickRange = "";
	/** Hot-range energy, 0 at `STRENGTH_UI.glowElo` → 1 at the maximum. */
	let energy = 0;
	let sweepTimer: ReturnType<typeof setTimeout> | null = null;
	let sweepIndex = 0;
	const sounds = createDetentScheduler({ min, max, step: options.step });
	const readout = options.readout ?? null;
	let readoutTimer: ReturnType<typeof setTimeout> | null = null;
	if (readout) {
		el.classList.add("sl-slider--has-readout");
		readoutEl.hidden = false;
	}

	function hideReadout(): void {
		if (readoutTimer !== null) {
			clearTimeout(readoutTimer);
			readoutTimer = null;
		}
		el.classList.remove("sl-slider--readout");
	}

	/** Show the numeric readout for this change and (re)start its fade-out timer. */
	function showReadout(): void {
		if (!readout) return;
		if (readoutTimer !== null) clearTimeout(readoutTimer);
		readoutEl.textContent = readout(value);
		el.classList.add("sl-slider--readout");
		readoutTimer = setTimeout(() => {
			readoutTimer = null;
			el.classList.remove("sl-slider--readout");
		}, UI_TIMINGS.sliderReadoutFadeMs);
	}

	/**
	 * The wait before the next warm sweep, from the energy at this moment. Each sweep is one CSS
	 * crossing of a fixed `strength-sweep` duration; only the wait between launches follows the
	 * energy. The sweeps take turns, so the per-sweep period (`sweepTravelWidths + gap` widths at
	 * the fixed speed) is shared between them.
	 *
	 * This is the fix for the owner's 2026-09-15 report ("the animation timeskips when I let go of
	 * the slider knob"): the cadence used to be the running CSS animation's *duration*, written on
	 * release, and a running animation keeps its start time and re-maps elapsed time onto a new
	 * duration — so every sweep jumped. Now a crossing in flight is never re-timed; a new cadence
	 * takes effect at the next launch.
	 */
	function sweepDelayMs(): number {
		const gap = STRENGTH_UI.flowGapMax - (STRENGTH_UI.flowGapMax - STRENGTH_UI.flowGapMin) * energy;
		const travel = STRENGTH_UI.sweepTravelWidths;
		return (
			(TOKENS.motion.durationMs["strength-sweep"] * (travel + gap)) /
			(travel * Math.max(1, sweeps.length))
		);
	}

	/** Restart the next sweep's crossing (switching its keyframe name restarts it without a reflow). */
	function launchSweep(): void {
		const sweep = sweeps[sweepIndex % Math.max(1, sweeps.length)];
		sweepIndex += 1;
		if (sweep)
			sweep.dataset.sweep = sweep.dataset.sweep === SWEEP_NAMES[0] ? SWEEP_NAMES[1] : SWEEP_NAMES[0];
		sweepTimer = setTimeout(launchSweep, sweepDelayMs());
	}

	/** Sweeps run while the strength slider is hot and enabled; leaving stops launching new ones. */
	function syncSweeps(running: boolean): void {
		if (running && sweeps.length > 0) {
			if (sweepTimer === null) launchSweep();
		} else if (sweepTimer !== null) {
			clearTimeout(sweepTimer);
			sweepTimer = null;
		}
	}

	if (options.ariaLabel) thumb.setAttribute("aria-label", options.ariaLabel);

	function snap(raw: number): number {
		const stepped = Math.round((raw - min) / options.step) * options.step + min;
		const decimals = (String(options.step).split(".")[1] ?? "").length;
		return clamp(Number(stepped.toFixed(decimals)), min, max);
	}

	/** A value as the slider holds it: snapped to the step, or clamped only for an exact reading. */
	const fit = (raw: number, asGiven: boolean): number =>
		asGiven ? clamp(raw, min, max) : snap(raw);

	/** Track position of `at`, clamped to the range. */
	const percentOf = (at: number): string =>
		`${(max > min ? clamp((at - min) / (max - min), 0, 1) * 100 : 0).toFixed(3)}%`;

	function render(): void {
		const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
		const range = `${min}:${max}`;
		for (const marker of markerEls) marker.el.style.left = percentOf(marker.value);
		if (options.strength && range !== tickRange) {
			tickRange = range;
			ticks.replaceChildren();
			for (
				let mark = Math.ceil(min / STRENGTH_UI.sliderTickStep) * STRENGTH_UI.sliderTickStep;
				mark <= max;
				mark += STRENGTH_UI.sliderTickStep
			) {
				if (mark < min) continue;
				const tick = document.createElement("span");
				tick.className = "sl-slider__tick";
				tick.style.left = `${(((mark - min) / (max - min)) * 100).toFixed(3)}%`;
				tick.dataset.value = String(mark);
				ticks.append(tick);
			}
		}
		if (options.threshold) {
			divider.style.left = percentOf(options.threshold.value);
			divider.dataset.value = String(options.threshold.value);
		}
		fill.style.width = `${pct.toFixed(3)}%`;
		const hot = options.strength === true && value >= STRENGTH_UI.glowElo;
		el.classList.toggle("sl-slider--strength", options.strength === true);
		el.classList.toggle("sl-slider--hot", hot);
		el.style.setProperty("--sl-slider-heat", String(clamp(pct / 100, 0, 1)));
		energy =
			max > STRENGTH_UI.glowElo
				? clamp((value - STRENGTH_UI.glowElo) / (max - STRENGTH_UI.glowElo), 0, 1)
				: 0;
		el.style.setProperty("--sl-slider-energy", String(energy));
		thumb.style.left = `${pct.toFixed(3)}%`;
		thumb.setAttribute("aria-valuemin", String(min));
		thumb.setAttribute("aria-valuemax", String(max));
		thumb.setAttribute("aria-valuenow", String(value));
		const text = options.label(value);
		thumb.setAttribute("aria-valuetext", text);
		bubble.textContent = text;
		valueEl.textContent = format(value);
		if (options.caption) captionEl.textContent = options.caption(value);
		const danger = options.danger?.(value) === true;
		el.classList.toggle("sl-slider--danger", danger);
		hint.hidden = disabled || !(danger && options.dangerHint);
		hint.textContent = danger && options.dangerHint ? options.dangerHint : "";
		el.classList.toggle("sl-slider--disabled", disabled);
		thumb.setAttribute("tabindex", disabled ? "-1" : "0");
		if (disabled) thumb.setAttribute("aria-disabled", "true");
		else thumb.removeAttribute("aria-disabled");
		syncSweeps(hot && !disabled);
	}

	/**
	 * Apply a user change. A pointer move ticks when it crosses a detent (rate-limited); a
	 * keyboard step always ticks; both show the readout.
	 */
	function set(next: number, commit: boolean, source: "pointer" | "keyboard"): void {
		const snapped = snap(next);
		const changed = snapped !== value;
		value = snapped;
		exact = false;
		render();
		if (changed) {
			showReadout();
			const tick = source === "pointer" ? sounds.move(value) : sounds.key(value);
			if (tick) playSliderSound(tick);
		}
		if (changed || commit) options.onChange(value, commit);
	}

	const onKeyDown = (event: KeyboardEvent): void => {
		if (disabled) return;
		const coarse = options.step * UI_TIMINGS.sliderCoarseMultiplier;
		const fine = event.shiftKey ? coarse : options.step;
		let next: number | null = null;
		switch (event.key) {
			case "ArrowRight":
			case "ArrowUp":
				next = value + fine;
				break;
			case "ArrowLeft":
			case "ArrowDown":
				next = value - fine;
				break;
			case "PageUp":
				next = value + coarse;
				break;
			case "PageDown":
				next = value - coarse;
				break;
			case "Home":
				next = min;
				break;
			case "End":
				next = max;
				break;
		}
		if (next === null) return;
		event.preventDefault();
		set(next, true, "keyboard");
	};

	function valueAt(clientX: number): number {
		const rect = track.getBoundingClientRect();
		if (rect.width <= 0) return value;
		const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
		return min + ratio * (max - min);
	}

	const onPointerDown = (event: PointerEvent): void => {
		if (disabled || event.isPrimary === false) return;
		event.preventDefault();
		dragging = event.pointerId;
		el.classList.add("sl-slider--active");
		try {
			track.setPointerCapture?.(event.pointerId);
		} catch {
			// happy-dom / unsupported: fall back to track-scoped events
		}
		sounds.press(value);
		set(valueAt(event.clientX), false, "pointer");
	};
	const onPointerMove = (event: PointerEvent): void => {
		if (dragging === null || event.pointerId !== dragging) return;
		set(valueAt(event.clientX), false, "pointer");
	};
	const onPointerUp = (event: PointerEvent): void => {
		if (dragging === null || event.pointerId !== dragging) return;
		dragging = null;
		el.classList.remove("sl-slider--active");
		set(valueAt(event.clientX), true, "pointer");
		committedAt = Date.now();
		const settle = sounds.release(value);
		if (settle) playSliderSound(settle);
	};
	const onPointerCancel = (event: PointerEvent): void => {
		if (dragging === null || event.pointerId !== dragging) return;
		dragging = null;
		el.classList.remove("sl-slider--active");
		sounds.release(value);
		set(value, true, "pointer");
	};

	thumb.addEventListener("keydown", onKeyDown);
	track.addEventListener("pointerdown", onPointerDown);
	track.addEventListener("pointermove", onPointerMove);
	track.addEventListener("pointerup", onPointerUp);
	track.addEventListener("pointercancel", onPointerCancel);

	value = fit(value, exact);
	render();
	host?.append(el);

	return {
		el,
		get value() {
			return value;
		},
		update(patch) {
			if (patch.min !== undefined) min = patch.min;
			if (patch.max !== undefined) max = patch.max;
			if (patch.min !== undefined || patch.max !== undefined)
				sounds.setRange({ min, max, step: options.step });
			if (patch.disabled !== undefined) disabled = patch.disabled;
			if (disabled && dragging !== null) {
				try {
					track.releasePointerCapture?.(dragging);
				} catch {
					// A removed or unsupported pointer capture has no remaining drag to release.
				}
				dragging = null;
				el.classList.remove("sl-slider--active");
				sounds.release(value);
				hideReadout();
			}
			// While the pointer owns the thumb, an external value is ignored: the settings view
			// re-applies the *stored* value on every store snapshot, and one snapshot behind the live
			// drag (they come thick and fast while the hand is moving) yanked the thumb back until the
			// next pointer move — the "snapping back and forth" the owner saw (2026-09-11). The
			// commit on release writes the final value, and the snapshots that follow agree with it.
			const next = patch.value === undefined ? undefined : fit(patch.value, patch.exact === true);
			const settling =
				committedAt !== null &&
				Date.now() - committedAt < UI_TIMINGS.sliderCommitGraceMs &&
				next !== undefined &&
				next !== value;
			if (next !== undefined && dragging === null && !settling) {
				value = next;
				exact = patch.exact === true;
			} else value = fit(value, exact);
			render();
		},
		dispose() {
			hideReadout();
			syncSweeps(false);
			thumb.removeEventListener("keydown", onKeyDown);
			track.removeEventListener("pointerdown", onPointerDown);
			track.removeEventListener("pointermove", onPointerMove);
			track.removeEventListener("pointerup", onPointerUp);
			track.removeEventListener("pointercancel", onPointerCancel);
			el.remove();
		},
	};
}
