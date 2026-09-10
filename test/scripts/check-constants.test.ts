// test/scripts/check-constants.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	checkEmittedPrograms,
	FORBIDDEN_PAGE_APIS,
	FORBIDDEN_PAGE_SUBSTRINGS,
	findDuplicateLiterals,
	findForbiddenPageApis,
	findForbiddenProgramSubstrings,
	findForbiddenSubstrings,
	findUrlLiterals,
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

it("the §13.3 rule 5 word list is the seven words, and findForbiddenSubstrings reports the ones present", () => {
	expect([...FORBIDDEN_PAGE_SUBSTRINGS]).toEqual([
		"sliced",
		"engine",
		"stockfish",
		"eval",
		"bestmove",
		"fen",
		"analysis",
	]);
	expect(findForbiddenSubstrings("const k = window.__x; document.querySelector(s)")).toEqual([]);
	expect(
		findForbiddenSubstrings('const fen = game.getFen(); postMessage({ engine: "stockfish" })')
	).toEqual(["engine", "stockfish", "fen"]);
});

it("scans the `code` export of every emitted page program and fails closed on an unreadable module", () => {
	const clean = `export const name = "probe";\nexport const code = ${JSON.stringify("(() => { const a = window.__t; })();")};\n`;
	const dirty = `export const code = ${JSON.stringify("window.postMessage({ bestmove: 1, fen: 2 })")};\n`;
	const broken = `export const code = 42;\n`;
	expect(
		findForbiddenProgramSubstrings({
			"src/page/generated/probe.ts": clean,
			"src/page/generated/bridge.ts": dirty,
			"src/page/generated/odd.ts": broken,
			"src/page/index.ts": `const engine = "stockfish"; // registry source, not emitted code`,
		})
	).toEqual([
		{ file: "src/page/generated/bridge.ts", word: "bestmove" },
		{ file: "src/page/generated/bridge.ts", word: "fen" },
		{ file: "src/page/generated/odd.ts", word: "<unreadable>" },
	]);
});

it("checkEmittedPrograms fails closed when the generated directory is missing", () => {
	const missing = mkdtempSync(path.join(tmpdir(), "sl-gen-"));
	rmSync(missing, { recursive: true, force: true });
	expect(() => checkEmittedPrograms(missing)).toThrow(/is missing.*gen:pagescript/s);
});

it("checkEmittedPrograms fails closed when the generated directory exists but is empty", () => {
	// "scanned nothing" must never read as "found nothing wrong": a cleaned or half-finished
	// generation leaves the directory behind with no programs in it.
	const empty = mkdtempSync(path.join(tmpdir(), "sl-gen-empty-"));
	try {
		expect(() => checkEmittedPrograms(empty)).toThrow(/holds no emitted page program/);
	} finally {
		rmSync(empty, { recursive: true, force: true });
	}
});

describe("findUrlLiterals (C1: every absolute URL lives in the registry)", () => {
	it("flags a URL written outside the registry, with its file and line", () => {
		const hits = findUrlLiterals({
			"src/content/leak.ts": 'const a = 1;\nconst u = "https://sliced.sh/models/";\n',
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]).toEqual({
			file: "src/content/leak.ts",
			line: 2,
			url: "https://sliced.sh/models/",
		});
	});

	it("allows the registry itself, generated page programs and XML namespaces", () => {
		expect(
			findUrlLiterals({
				"src/core/constants/urls.ts": 'export const U = "https://sliced.sh";',
				"src/page/generated/chesscom-bridge.ts": 'export const code = "http://example.com";',
				"src/page/highlight-overlay.ts": 'const SVG_NS = "http://www.w3.org/2000/svg";',
			})
		).toEqual([]);
	});

	it("catches a URL inside a multi-line template, where no quote sits on its line", () => {
		const hits = findUrlLiterals({
			"src/content/tpl.ts": "const t = `\n  https://sliced.sh/in-a-template\n`;\n",
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]?.url).toBe("https://sliced.sh/in-a-template");
		expect(hits[0]?.line).toBe(2);
	});

	it("does not flag a URL in a comment, whole-line or trailing, which is prose not code", () => {
		expect(
			findUrlLiterals({
				"src/content/a.ts": "// see https://example.com/spec for the rule\n",
				"src/content/b.ts": " * https://example.com/doc\n",
				"src/content/c.ts": "const n = 1; // https://example.com/why\n",
			})
		).toEqual([]);
	});
});
