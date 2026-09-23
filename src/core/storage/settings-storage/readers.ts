/**
 * Field readers for `normalizeSettings`: each takes an untrusted stored value and its default
 * and returns a valid value — finite and clamped for numbers, a member for enums, a complete
 * shape for keybinds. The enum sets are `Record<Enum, true>` so they stay exhaustive.
 */

import { LIMITS } from "@core/constants/limits";
import { clamp, clampInt } from "@core/util/clamp";
import type { Keybind, LogLevel, MoveQualityChipSide, Settings } from "@typedefs/settings";

export type Obj = Record<string, unknown>;
/** `Record<Enum, true>` forces the list to stay exhaustive against the union in `@typedefs/settings`. */
export type EnumSet<E extends string> = Readonly<Record<E, true>>;

export const INPUT_MODES: EnumSet<Settings["execution"]["inputMode"]> = {
	auto: true,
	drag: true,
	click: true,
};
export const HIGHLIGHT_STYLES: EnumSet<Settings["automation"]["highlightStyle"]> = {
	squares: true,
	arrows: true,
	both: true,
};
export const CHIP_SIDES: EnumSet<MoveQualityChipSide> = { mine: true, theirs: true, both: true };
export const THEMES: EnumSet<Settings["display"]["theme"]> = {
	dark: true,
	light: true,
	system: true,
};
export const REDUCED_MOTION: EnumSet<Settings["display"]["reducedMotion"]> = {
	system: true,
	on: true,
	off: true,
};
export const LOG_LEVELS: EnumSet<LogLevel> = {
	silent: true,
	error: true,
	warn: true,
	info: true,
	debug: true,
};

export const isObj = (v: unknown): v is Obj =>
	typeof v === "object" && v !== null && !Array.isArray(v);
export const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
export const num = (v: unknown, d: number): number =>
	typeof v === "number" && Number.isFinite(v) ? v : d;
export const numIn = (v: unknown, d: number, min: number, max: number): number =>
	typeof v === "number" && Number.isFinite(v) ? clamp(v, min, max) : d;
export const intIn = (v: unknown, d: number, min: number, max: number): number =>
	typeof v === "number" && Number.isFinite(v) ? clampInt(v, min, max) : d;
export const oneOf = <E extends string>(v: unknown, d: E, set: EnumSet<E>): E =>
	typeof v === "string" && Object.hasOwn(set, v) ? (v as E) : d;

export function keybind(v: unknown, d: Keybind): Keybind {
	if (
		!isObj(v) ||
		typeof v.key !== "string" ||
		typeof v.code !== "string" ||
		typeof v.altKey !== "boolean" ||
		typeof v.ctrlKey !== "boolean" ||
		typeof v.metaKey !== "boolean" ||
		typeof v.shiftKey !== "boolean"
	)
		return { ...d };
	return {
		key: v.key,
		code: v.code,
		altKey: v.altKey,
		ctrlKey: v.ctrlKey,
		metaKey: v.metaKey,
		shiftKey: v.shiftKey,
	};
}

export function threads(
	v: unknown,
	d: Settings["engine"]["threads"]
): Settings["engine"]["threads"] {
	if (v === "auto") return "auto";
	if (typeof v === "number" && Number.isFinite(v))
		return clampInt(v, LIMITS.threadsMin, LIMITS.threadsMax);
	return d;
}

/** Imported ranges are finite, bounded and ordered, including profiles from earlier versions. */
export function minuteRange(
	lo: unknown,
	hi: unknown,
	defaults: [number, number],
	max: number
): [number, number] {
	const first = intIn(lo, defaults[0], LIMITS.autoQueueMinutesMin, max);
	const second = intIn(hi, defaults[1], LIMITS.autoQueueMinutesMin, max);
	return first <= second ? [first, second] : [second, first];
}
