// test/core/serialization.test.ts
import { describe, expect, it } from "bun:test";
import { safeJsonParse, stableStringify, toSerializable } from "@core/serialization";

describe("serialization", () => {
	it("safeJsonParse returns the fallback on bad input", () => {
		expect(safeJsonParse<{ a: number } | null>('{"a":1}', null)).toEqual({ a: 1 });
		expect(safeJsonParse("{nope", { d: true })).toEqual({ d: true });
		expect(safeJsonParse(null, 3)).toBe(3);
		expect(safeJsonParse(undefined, 3)).toBe(3);
	});
	it("stableStringify sorts keys recursively and keeps array order", () => {
		expect(stableStringify({ b: 1, a: { z: [3, { y: 1, x: 2 }], c: null } })).toBe(
			'{"a":{"c":null,"z":[3,{"x":2,"y":1}]},"b":1}'
		);
		expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
		expect(stableStringify([undefined, 1])).toBe("[null,1]");
		expect(stableStringify("s")).toBe('"s"');
		expect(stableStringify(undefined)).toBeUndefined();
		const cyc: Record<string, unknown> = {};
		cyc.self = cyc;
		expect(() => stableStringify(cyc)).toThrow(TypeError);
	});
	it("toSerializable flattens Errors and non-JSON values", () => {
		const e = new RangeError("bad");
		const out = toSerializable(e) as { name: string; message: string; stack?: string };
		expect(out.name).toBe("RangeError");
		expect(out.message).toBe("bad");
		expect(toSerializable(() => 1)).toBe("[function]");
		expect(toSerializable(undefined)).toBe("undefined");
		expect(toSerializable(10n)).toBe("10n");
		expect(toSerializable({ a: [1, "x", new Error("in")] })).toEqual({
			a: [1, "x", expect.objectContaining({ message: "in" })],
		});
	});
});
