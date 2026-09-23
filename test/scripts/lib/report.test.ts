import { describe, expect, it, spyOn } from "bun:test";
import { bulletList, failOnFindings, formatBytes } from "../../../scripts/lib/report";

describe("formatBytes", () => {
	it("prints KiB below a MiB and MiB from there", () => {
		expect(formatBytes(1536)).toBe("1.5 KiB");
		expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MiB");
	});
});

describe("bulletList", () => {
	it("indents one item per line after a leading newline", () => {
		expect(bulletList(["a", "b"])).toBe("\n  - a\n  - b");
	});
});

describe("failOnFindings", () => {
	it("returns quietly when there is nothing to report", () => {
		expect(() => failOnFindings([], String, (n) => `${n}`)).not.toThrow();
	});

	it("prints every finding, then throws the summary", () => {
		const error = spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(() =>
				failOnFindings(
					[1, 2],
					(n) => `hit ${n}`,
					(n) => `${n} hits`
				)
			).toThrow("2 hits");
			expect(error.mock.calls).toEqual([["hit 1"], ["hit 2"]]);
		} finally {
			error.mockRestore();
		}
	});
});
