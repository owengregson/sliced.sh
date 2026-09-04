// test/scripts/check-constants.test.ts
import { expect, it } from "bun:test";
import { findDuplicateLiterals } from "../../scripts/check-constants";

it("flags a registry literal re-declared outside the registry", () => {
	const files = {
		"src/core/constants/ports.ts": `export const PORT_NAMES = { panel: "sl-panel" } as const;`,
		"src/service/x.ts": `const p = "sl-panel";`,
	};
	expect(findDuplicateLiterals(files)).toEqual([
		{ file: "src/service/x.ts", literal: "sl-panel", definedIn: "src/core/constants/ports.ts" },
	]);
});

it("ignores imports of the registry", () => {
	const files = {
		"src/core/constants/ports.ts": `export const PORT_NAMES = { panel: "sl-panel" } as const;`,
		"src/service/x.ts": `import { PORT_NAMES } from "@core/constants"; const p = PORT_NAMES.panel;`,
	};
	expect(findDuplicateLiterals(files)).toEqual([]);
});

it("flags a numeric literal carrying a // const: marker outside a registry file", () => {
	const files = {
		"src/core/constants/timings.ts": `export const TIMINGS = { analysisDefaultMovetimeMs: 1_500 } as const;`,
		"src/service/y.ts": [
			`const budget = 1500; // const: TIMINGS.analysisDefaultMovetimeMs`,
			`const untagged = 250;`,
			`const orphan = 42; // const:`,
		].join("\n"),
	};
	expect(findDuplicateLiterals(files)).toEqual([
		{ file: "src/service/y.ts", literal: "1500", definedIn: "src/core/constants/timings.ts" },
		{ file: "src/service/y.ts", literal: "42", definedIn: "src/core/constants/" },
	]);
});

it("does not flag a // const: marker inside a registry file", () => {
	const files = {
		"src/core/constants/timings.ts": `export const TIMINGS = { x: 1_500 /* ms */ } as const; // const: x`,
	};
	expect(findDuplicateLiterals(files)).toEqual([]);
});
