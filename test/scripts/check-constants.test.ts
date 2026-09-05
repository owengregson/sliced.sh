// test/scripts/check-constants.test.ts
import { expect, it } from "bun:test";
import {
	FORBIDDEN_PAGE_APIS,
	findDuplicateLiterals,
	findForbiddenPageApis,
} from "../../scripts/check-constants";

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

it("flags every forbidden page API under src/content/** and src/page/**, comments included", () => {
	const files = {
		"src/content/x.ts": [
			`const a = window.localStorage.getItem("k");`,
			`// never call dispatchEvent here`,
			`el.dispatchEvent(new PointerEvent("pointerdown"));`,
		].join("\n"),
		"src/page/y.ts": `speechSynthesis.speak(u); chrome.tabs.update(1, {}); window.open("x");`,
		"src/service/z.ts": `localStorage; dispatchEvent; new MouseEvent("click"); chrome.notifications;`,
	};
	expect(findForbiddenPageApis(files)).toEqual([
		{ file: "src/content/x.ts", api: "localStorage", line: 1 },
		{ file: "src/content/x.ts", api: "dispatchEvent", line: 2 },
		{ file: "src/content/x.ts", api: "dispatchEvent", line: 3 },
		{ file: "src/content/x.ts", api: "new PointerEvent", line: 3 },
		{ file: "src/page/y.ts", api: "speechSynthesis", line: 1 },
		{ file: "src/page/y.ts", api: "chrome.tabs.update", line: 1 },
		{ file: "src/page/y.ts", api: "window.open", line: 1 },
	]);
});

it("covers the §13.3 rule 2 / §9 list and passes clean page-realm sources", () => {
	expect([...FORBIDDEN_PAGE_APIS]).toEqual([
		"localStorage",
		"sessionStorage",
		"indexedDB",
		"document.cookie",
		"dispatchEvent",
		"new PointerEvent",
		"new MouseEvent",
		"speechSynthesis",
		"chrome.tabs.update",
		"chrome.tabs.create",
		"chrome.notifications",
		"window.open",
	]);
	expect(
		findForbiddenPageApis({
			"src/content/ok.ts": `win.addEventListener("keydown", fn, true); chrome.runtime.connect({ name });`,
		})
	).toEqual([]);
});
