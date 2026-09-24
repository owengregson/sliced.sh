import { describe, expect, it } from "bun:test";
import { cliFlags, flagValue } from "../../../scripts/lib/cli";

describe("cliFlags", () => {
	it("is the set of argv tokens", () => {
		const flags = cliFlags(["--dev", "--fast"]);
		expect(flags.has("--dev")).toBe(true);
		expect(flags.has("--watch")).toBe(false);
	});
});

describe("flagValue", () => {
	it("returns the token after the flag, or undefined when the flag is absent", () => {
		expect(flagValue(["--seed", "abc"], "--seed", "tool")).toBe("abc");
		expect(flagValue(["--other"], "--seed", "tool")).toBeUndefined();
	});

	it("rejects a flag with no value, naming the tool", () => {
		expect(() => flagValue(["--seed"], "--seed", "tool")).toThrow("tool: --seed requires a value");
		expect(() => flagValue(["--seed", "--dev"], "--seed", "tool")).toThrow(
			"tool: --seed requires a value"
		);
	});
});
