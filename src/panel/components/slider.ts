/**
 * Slider with value bubble (Appendix F §5.3): track / fill / thumb (`role="slider"`) / bubble /
 * scale / resting value. Arrow keys step, Shift ×10, PageUp/Down ×10, Home/End. Pointer drags
 * follow the track; `onChange(value, commit)` fires live while dragging and once with
 * `commit = true` on release (keyboard steps always commit). Danger zone past a threshold.
 */

import { STRENGTH_UI, UI_TIMINGS } from "@core/constants/ui";
import { clamp } from "@core/util/clamp";
import { playUiSound } from "../sounds";
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
	/** Optional marks row under the track. */
	scale?: readonly string[];
	threshold?: SliderThreshold;
	/** Continuous orange-to-red rating fill, with a glow at very high strength. */
	strength?: boolean;
	danger?: (value: number) => boolean;
	dangerHint?: string;
	disabled?: boolean;
	ariaLabel?: string;
	onChange: (value: number, commit: boolean) => void;
}

export interface SliderUpdate {
	value?: number;
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

export function createSlider(host: HTMLElement | null, options: SliderOptions): SliderHandle {
	const el = instantiate(html);
	const track = part(el, ".sl-slider__track");
	const fill = part(el, ".sl-slider__fill");
	const thumb = part(el, ".sl-slider__thumb");
	const bubble = part(el, ".sl-slider__bubble");
	const valueEl = part(el, ".sl-slider__value");
	const scale = part(el, ".sl-slider__scale");
	const hint = part(el, ".sl-slider__hint");
	const divider = part(el, ".sl-slider__divider");
	const boundary = part(el, ".sl-slider__boundary");
	if (options.threshold) {
		divider.hidden = false;
		boundary.hidden = true;
		divider.setAttribute("title", options.threshold.description);
		thumb.setAttribute("aria-description", options.threshold.description);
	}
	const format = options.format ?? ((v: number): string => String(v));

	let min = options.min;
	let max = options.max;
	let value = options.value;
	let disabled = options.disabled ?? false;
	let dragging: number | null = null;

	if (options.ariaLabel) thumb.setAttribute("aria-label", options.ariaLabel);
	if (options.scale?.length) {
		for (const mark of options.scale) {
			const span = document.createElement("span");
			span.className = "sl-slider__mark";
			span.textContent = mark;
			scale.append(span);
		}
		scale.hidden = false;
	}

	function snap(raw: number): number {
		const stepped = Math.round((raw - min) / options.step) * options.step + min;
		const decimals = (String(options.step).split(".")[1] ?? "").length;
		return clamp(Number(stepped.toFixed(decimals)), min, max);
	}

	function render(): void {
		const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
		if (options.threshold) {
			const thresholdPct =
				max > min ? clamp((options.threshold.value - min) / (max - min), 0, 1) * 100 : 0;
			divider.style.left = `${thresholdPct.toFixed(3)}%`;
			divider.dataset.value = String(options.threshold.value);
		}
		fill.style.width = `${pct.toFixed(3)}%`;
		el.classList.toggle("sl-slider--strength", options.strength === true);
		el.classList.toggle("sl-slider--hot", options.strength === true && value >= STRENGTH_UI.glowElo);
		el.style.setProperty("--sl-slider-heat", String(clamp(pct / 100, 0, 1)));
		thumb.style.left = `${pct.toFixed(3)}%`;
		thumb.setAttribute("aria-valuemin", String(min));
		thumb.setAttribute("aria-valuemax", String(max));
		thumb.setAttribute("aria-valuenow", String(value));
		const text = options.label(value);
		thumb.setAttribute("aria-valuetext", text);
		bubble.textContent = text;
		valueEl.textContent = format(value);
		const danger = options.danger?.(value) === true;
		el.classList.toggle("sl-slider--danger", danger);
		hint.hidden = !(danger && options.dangerHint);
		hint.textContent = danger && options.dangerHint ? options.dangerHint : "";
		el.classList.toggle("sl-slider--disabled", disabled);
		thumb.setAttribute("tabindex", disabled ? "-1" : "0");
		if (disabled) thumb.setAttribute("aria-disabled", "true");
		else thumb.removeAttribute("aria-disabled");
	}

	function set(next: number, commit: boolean): void {
		const snapped = snap(next);
		const changed = snapped !== value;
		value = snapped;
		render();
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
		set(next, true);
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
		set(valueAt(event.clientX), false);
	};
	const onPointerMove = (event: PointerEvent): void => {
		if (dragging === null || event.pointerId !== dragging) return;
		set(valueAt(event.clientX), false);
	};
	const onPointerUp = (event: PointerEvent): void => {
		if (dragging === null || event.pointerId !== dragging) return;
		dragging = null;
		el.classList.remove("sl-slider--active");
		set(valueAt(event.clientX), true);
		playUiSound("sliderRelease");
	};
	const onPointerCancel = (event: PointerEvent): void => {
		if (dragging === null || event.pointerId !== dragging) return;
		dragging = null;
		el.classList.remove("sl-slider--active");
		set(value, true);
	};

	thumb.addEventListener("keydown", onKeyDown);
	track.addEventListener("pointerdown", onPointerDown);
	track.addEventListener("pointermove", onPointerMove);
	track.addEventListener("pointerup", onPointerUp);
	track.addEventListener("pointercancel", onPointerCancel);

	value = snap(value);
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
			if (patch.disabled !== undefined) disabled = patch.disabled;
			if (patch.value !== undefined) value = snap(patch.value);
			else value = snap(value);
			render();
		},
		dispose() {
			thumb.removeEventListener("keydown", onKeyDown);
			track.removeEventListener("pointerdown", onPointerDown);
			track.removeEventListener("pointermove", onPointerMove);
			track.removeEventListener("pointerup", onPointerUp);
			track.removeEventListener("pointercancel", onPointerCancel);
			el.remove();
		},
	};
}
