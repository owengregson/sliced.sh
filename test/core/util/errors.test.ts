// test/core/util/errors.test.ts
import { describe, expect, it } from "bun:test";
import { errorMessage } from "@core/util/errors";

describe("errorMessage", () => {
	it("uses Error.message, falls back to String() for empty messages and non-errors", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
		expect(errorMessage(new TypeError(""))).toBe("TypeError");
		expect(errorMessage(new DOMException("timed out", "TimeoutError"))).toBe("timed out");
		expect(errorMessage("plain")).toBe("plain");
		expect(errorMessage(42)).toBe("42");
		expect(errorMessage(undefined)).toBe("undefined");
	});
});
