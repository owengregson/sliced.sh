// test/pagescript/emit.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { defineProgram, emit, js, std } from "@pagescript";
import { installDom } from "../dom";

let dom: ReturnType<typeof installDom>;
beforeAll(() => {
	dom = installDom();
});
afterAll(() => dom.dispose());

// --- Task 6 brief, Step 1 (verbatim) ---------------------------------------
it("emits a querySelector call with a bound parameter", () => {
	const prog = defineProgram({
		name: "t",
		params: { sel: "string" },
		build: (p) => js.program([js.ret(std.query(p.sel))]),
	});
	const { code, params } = emit(prog, { seed: "abc" });
	expect(params).toEqual([{ name: "sel", type: "string" }]);
	expect(code).toContain("document.querySelector(");
	expect(prog.bind({ sel: "wc-chess-board" })).toContain(`"wc-chess-board"`);
});
it("spoofed identifiers are deterministic per seed", () => {
	const a = emit(
		defineProgram({
			name: "s",
			params: {},
			build: () => js.program([js.const_("x", js.spoof("ready"))]),
		}),
		{ seed: "s1" }
	).code;
	const b = emit(
		defineProgram({
			name: "s",
			params: {},
			build: () => js.program([js.const_("x", js.spoof("ready"))]),
		}),
		{ seed: "s1" }
	).code;
	const c = emit(
		defineProgram({
			name: "s",
			params: {},
			build: () => js.program([js.const_("x", js.spoof("ready"))]),
		}),
		{ seed: "s2" }
	).code;
	expect(a).toBe(b);
	expect(a).not.toBe(c);
});
it("evaluates in happy-dom", () => {
	document.body.innerHTML = `<div id="b"></div>`;
	const prog = defineProgram({
		name: "e",
		params: { sel: "string" },
		build: (p) => js.program([js.ret(js.member(std.query(p.sel), "id"))]),
	});
	expect(new Function(prog.bind({ sel: "#b" }))()).toBe("b");
});
// ---------------------------------------------------------------------------

describe("emit", () => {
	it("prints compactly (no indentation, no line breaks) and leaves placeholders quoted", () => {
		const prog = defineProgram({
			name: "compact",
			params: { sel: "string" },
			build: (p) =>
				js.program([
					js.const_("el", std.query(p.sel)),
					js.if_(js.id("el"), [js.ret(js.member(js.id("el"), "id"))]),
					js.ret(js.nil()),
				]),
		});
		const { code } = emit(prog, { seed: "seed" });
		expect(code).not.toContain("\n");
		expect(code).not.toContain("\t");
		expect(code).toContain(`document.querySelector("$$param:sel")`);
	});

	it("replaces every $$spoof placeholder with the derived token and never leaks the marker", () => {
		const prog = defineProgram({
			name: "spoofy",
			params: {},
			build: () =>
				js.program([
					js.const_("a", js.spoof("hook")),
					js.const_("b", js.member(js.id("window"), js.spoof("hook"))),
					js.const_("c", js.obj({ k: js.spoof("other") })),
				]),
		});
		const { code } = emit(prog, { seed: "seed" });
		expect(code).not.toContain("$$spoof");
		expect(code).not.toContain("sliced");
		// The same purpose derives the same identifier in both positions.
		const token = /const a = (\w+);/.exec(code)?.[1];
		expect(token).toBeDefined();
		expect(code).toContain(`window.${token}`);
	});

	it("rejects an undeclared $$param", () => {
		const prog = defineProgram({
			name: "bad",
			params: { sel: "string" },
			build: () => js.program([js.ret(std.query(js.param("other")))]),
		});
		expect(() => emit(prog, { seed: "seed" })).toThrow(/other/);
	});

	it("rejects a string literal that collides with the placeholder syntax", () => {
		const prog = defineProgram({
			name: "collide",
			params: { sel: "string" },
			build: () => js.program([js.ret(js.str("$$param:sel"))]),
		});
		expect(() => emit(prog, { seed: "seed" })).toThrow(/placeholder/i);
	});

	it("returns the declared params in declaration order", () => {
		const prog = defineProgram({
			name: "order",
			params: { token: "string", n: "number", on: "boolean", cfg: "json" },
			build: () => js.program([]),
		});
		expect(emit(prog, { seed: "seed" }).params).toEqual([
			{ name: "token", type: "string" },
			{ name: "n", type: "number" },
			{ name: "on", type: "boolean" },
			{ name: "cfg", type: "json" },
		]);
	});

	it("does not mutate the tree returned by build()", () => {
		const tree = js.program([js.const_("x", js.spoof("ready")), js.ret(js.param("sel"))]);
		const before = JSON.stringify(tree);
		emit(defineProgram({ name: "pure", params: { sel: "string" }, build: () => tree }), {
			seed: "seed",
		});
		expect(JSON.stringify(tree)).toBe(before);
	});

	it("snapshot: focus-probe style program (§5.6)", () => {
		const focusProbe = defineProgram({
			name: "focusProbe",
			params: { boardSelector: "string" },
			build: (p) =>
				js.program([
					js.ret(
						js.call(
							js.arrow(
								[],
								[
									js.const_("el", std.query(p.boardSelector)),
									js.ret(
										js.obj({
											hasFocus: js.call(js.member(js.id("document"), "hasFocus")),
											visibility: js.member(js.id("document"), "visibilityState"),
											dpr: js.member(js.id("window"), "devicePixelRatio"),
											rect: js.cond(js.id("el"), std.rect(js.id("el")), js.nil()),
										})
									),
								]
							)
						)
					),
				]),
		});
		const { code } = emit(focusProbe, { seed: "snapshot-seed" });
		expect(code).toBe(
			'return (() => {const el = document.querySelector("$$param:boardSelector");' +
				"return {hasFocus: document.hasFocus(),visibility: document.visibilityState," +
				"dpr: window.devicePixelRatio,rect: el ? " +
				"(r => ({x: r.x,y: r.y,width: r.width,height: r.height}))(el.getBoundingClientRect())" +
				" : null};})();"
		);
	});
});
