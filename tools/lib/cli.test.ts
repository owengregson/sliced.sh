import { describe, expect, it } from "bun:test";
import { flagText, flagValue, flagValues, hasFlag, parseFlags } from "./cli";

describe("lookup flags", () => {
	const argv = ["bun", "tool.ts", "--frames", "a.jsonl", "--set", "x=1", "--frames", "b", "--print"];

	it("reads the first occurrence, a present-but-empty flag as undefined, else the fallback", () => {
		expect(flagValue(argv, "frames")).toBe("a.jsonl");
		expect(flagValue(argv, "print", "fallback")).toBeUndefined();
		expect(flagValue(argv, "tc", "180")).toBe("180");
	});

	it("collects every occurrence that has a value, in order", () => {
		expect(flagValues(argv, "frames")).toEqual(["a.jsonl", "b"]);
		expect(flagValues(argv, "print")).toEqual([]);
		expect(hasFlag(argv, "print")).toBe(true);
		expect(hasFlag(argv, "verbose")).toBe(false);
	});
});

describe("strict flags", () => {
	const table = { "--out": "value", "--engine": "switch" } as const;

	it("keeps the last value of a repeated flag and consumes the next token whatever it is", () => {
		const seen = parseFlags(["--out", "a", "--out", "--engine"], table, { missingValue: "throw" });
		expect(flagText(seen, "--out")).toBe("--engine");
		expect(seen.has("--engine")).toBe(false);
		expect(parseFlags(["--engine"], table, { missingValue: "throw" }).get("--engine")).toBe(true);
	});

	it("throws on an unknown token and, when asked, on a missing value", () => {
		expect(() => parseFlags(["--bogus"], table, { missingValue: "throw" })).toThrow(
			"unknown argument --bogus"
		);
		expect(() => parseFlags(["--out"], table, { missingValue: "throw" })).toThrow(
			"--out needs a value"
		);
		const lenient = parseFlags(["--out"], table, { missingValue: "undefined" });
		expect(lenient.has("--out")).toBe(true);
		expect(flagText(lenient, "--out")).toBeUndefined();
	});
});
