import type { EngineOptions } from "@core/engine/options";

/** Keys of `EngineOptions` whose value differs between `next` and `prev` (all of them when `prev` is undefined). */
export function diffOptions(
	next: EngineOptions,
	prev: EngineOptions | undefined
): Partial<EngineOptions> {
	if (!prev) return { ...next };
	const out: Partial<EngineOptions> = {};
	for (const key of Object.keys(next) as Array<keyof EngineOptions>) {
		const value = next[key];
		if (value !== undefined && prev[key] !== value) Object.assign(out, { [key]: value });
	}
	return out;
}
