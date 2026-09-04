/** Small, dependency-free serialization helpers (JSON safety, stable keys, log-safe values). */

export type SerializedValue =
	| null
	| boolean
	| number
	| string
	| SerializedValue[]
	| { [key: string]: SerializedValue };

/** `JSON.parse` that returns `fallback` on missing or malformed input. */
export function safeJsonParse<T>(text: string | null | undefined, fallback: T): T {
	if (typeof text !== "string") return fallback;
	try {
		return JSON.parse(text) as T;
	} catch {
		return fallback;
	}
}

function sortKeysDeep(value: unknown, seen: WeakSet<object>): unknown {
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) throw new TypeError("stableStringify: circular structure");
	seen.add(value);
	let out: unknown;
	if (Array.isArray(value)) {
		out = value.map((v) => sortKeysDeep(v, seen));
	} else {
		const obj = value as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const k of Object.keys(obj).sort()) sorted[k] = sortKeysDeep(obj[k], seen);
		out = sorted;
	}
	seen.delete(value);
	return out;
}

/** `JSON.stringify` with object keys sorted at every level (arrays keep their order). */
export function stableStringify(value: unknown): string | undefined {
	return JSON.stringify(sortKeysDeep(value, new WeakSet()));
}

/**
 * Convert an arbitrary value to something `chrome.runtime.sendMessage` can carry:
 * Errors become `{ name, message, stack }`, non-JSON primitives become strings.
 */
export function toSerializable(value: unknown, depth = 0): SerializedValue {
	if (value === null) return null;
	switch (typeof value) {
		case "boolean":
		case "string":
			return value;
		case "number":
			return Number.isFinite(value) ? value : String(value);
		case "undefined":
			return "undefined";
		case "bigint":
			return `${value}n`;
		case "function":
			return "[function]";
		case "symbol":
			return value.toString();
		default:
			break;
	}
	if (depth > 8) return "[nested]";
	if (value instanceof Error) {
		const out: { [key: string]: SerializedValue } = { name: value.name, message: value.message };
		if (typeof value.stack === "string") out.stack = value.stack;
		return out;
	}
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map((v) => toSerializable(v, depth + 1));
	const out: { [key: string]: SerializedValue } = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>))
		out[k] = toSerializable(v, depth + 1);
	return out;
}
