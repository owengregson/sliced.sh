// test/pagescript/bind.test.ts
import { describe, expect, it } from "bun:test";
import { bindCode, defineProgram, emit, js, paramPlaceholder } from "@pagescript";

const P = { name: "x", type: "json" } as const;

const seed = "bind-seed";

describe("bindCode", () => {
	it("substitutes JSON-encoded values for each placeholder, quotes included", () => {
		const code = `f(${paramPlaceholder("s")}, ${paramPlaceholder("n")}, ${paramPlaceholder("b")}, ${paramPlaceholder("j")})`;
		const params = [
			{ name: "s", type: "string" },
			{ name: "n", type: "number" },
			{ name: "b", type: "boolean" },
			{ name: "j", type: "json" },
		] as const;
		const out = bindCode(code, params, { s: "wc-chess-board", n: 3, b: false, j: { a: [1, "x"] } });
		expect(out).toBe('f(("wc-chess-board"), (3), (false), ({"a":[1,"x"]}))');
	});

	it("escapes strings safely (quotes, backslashes, newlines, $ patterns)", () => {
		const code = `g(${paramPlaceholder("s")})`;
		const value = 'say "hi"\\ $& $1 $$ \n end';
		const out = bindCode(code, [{ name: "s", type: "string" }], { s: value });
		expect(new Function(`return ${out.slice(2, -1)};`)()).toBe(value);
		expect(out).toBe(`g((${JSON.stringify(value)}))`);
	});

	it("replaces every occurrence of a placeholder", () => {
		const code = `[${paramPlaceholder("x")}, ${paramPlaceholder("x")}]`;
		expect(bindCode(code, [{ name: "x", type: "number" }], { x: 7 })).toBe("[(7), (7)]");
	});

	it("parenthesises substitutions so object bodies and unary operands stay expressions", () => {
		const arrowProg = defineProgram({
			name: "arrow",
			params: { cfg: "json" },
			build: (p) => js.program([js.ret(js.call(js.arrow([], p.cfg)))]),
		});
		expect(new Function(arrowProg.bind({ cfg: { a: 1 } }))()).toEqual({ a: 1 });
		const powProg = defineProgram({
			name: "pow",
			params: { n: "number" },
			build: (p) => js.program([js.ret(js.op(p.n, "**", js.num(2)))]),
		});
		expect(new Function(powProg.bind({ n: -3 }))()).toBe(9);
	});

	it("substitutes in a single pass: a value containing placeholder text is not re-substituted", () => {
		const code = `[${paramPlaceholder("a")}, ${paramPlaceholder("b")}]`;
		const params = [
			{ name: "a", type: "json" },
			{ name: "b", type: "string" },
		] as const;
		const out = bindCode(code, params, { a: { s: '"$$param:b"' }, b: "safe" });
		expect(new Function(`return ${out};`)()).toEqual([{ s: '"$$param:b"' }, "safe"]);
		expect(out.split("safe")).toHaveLength(2);
	});

	it("rejects a placeholder in the code that no declared parameter covers", () => {
		expect(() => bindCode(`f(${paramPlaceholder("ghost")})`, [P], { x: 1 })).toThrow(/ghost/);
	});

	it("rejects a missing argument and a wrongly typed argument", () => {
		const code = `h(${paramPlaceholder("s")})`;
		expect(() => bindCode(code, [{ name: "s", type: "string" }], {})).toThrow(/s/);
		expect(() => bindCode(code, [{ name: "s", type: "string" }], { s: 1 })).toThrow(/string/);
		expect(() => bindCode(code, [{ name: "n", type: "number" }], { n: "1" })).toThrow(/number/);
		expect(() => bindCode(code, [{ name: "b", type: "boolean" }], { b: 0 })).toThrow(/boolean/);
		expect(() => bindCode(code, [{ name: "j", type: "json" }], { j: () => undefined })).toThrow(
			/json/i
		);
		expect(() => bindCode(code, [{ name: "n", type: "number" }], { n: Number.NaN })).toThrow(
			/number/
		);
	});
});

describe("defineProgram", () => {
	it("returns name, params, build and a typed bind()", () => {
		const prog = defineProgram({
			name: "p",
			params: { sel: "string", depth: "number", on: "boolean", cfg: "json" },
			build: (p) => js.program([js.ret(js.arr(p.sel, p.depth, p.on, p.cfg))]),
		});
		expect(prog.name).toBe("p");
		expect(prog.params).toEqual({ sel: "string", depth: "number", on: "boolean", cfg: "json" });
		expect(prog.entry).toBe(false);
		const bound = prog.bind({ sel: "#b", depth: 2, on: true, cfg: { from: "#fff", to: null } });
		expect(new Function(bound)()).toEqual(["#b", 2, true, { from: "#fff", to: null }]);
		expect(bound).not.toContain("$$param");
		// The bind argument shape is derived from `params` (checked by tsc, not at runtime).
		// @ts-expect-error depth must be a number
		const wrong = () => prog.bind({ sel: "#b", depth: "2", on: true, cfg: null });
		expect(wrong).toThrow(/number/);
	});

	it("bind() uses the build seed so spoofed identifiers agree with emit()", () => {
		const prog = defineProgram({
			name: "seeded",
			params: {},
			build: () => js.program([js.const_("x", js.spoof("ready"))]),
		});
		const { code } = emit(prog, { seed: "deadbeef01234567deadbeef01234567" });
		expect(prog.bind({})).toBe(code);
	});

	it("carries entry and entryArgs through for the generator", () => {
		const prog = defineProgram({
			name: "bridge",
			params: { sel: "string" },
			entry: true,
			entryArgs: { sel: "cg-board" },
			build: (p) => js.program([js.expr(p.sel)]),
		});
		expect(prog.entry).toBe(true);
		expect(prog.entryArgs).toEqual({ sel: "cg-board" });
	});

	it("rejects entryArgs on a program that is not an entry", () => {
		expect(() =>
			defineProgram({
				name: "x",
				params: { sel: "string" },
				entryArgs: { sel: "a" },
				build: () => js.program([]),
			})
		).toThrow(/entry/);
	});

	it("rejects a param name that is not a valid identifier", () => {
		expect(() =>
			defineProgram({ name: "x", params: { "bad name": "string" }, build: () => js.program([]) })
		).toThrow(/bad name/);
	});

	it("bind() rethrows emit-time validation errors", () => {
		const prog = defineProgram({
			name: "bad",
			params: {},
			build: () => js.program([js.ret(js.param("nope"))]),
		});
		expect(() => prog.bind({})).toThrow(/nope/);
		expect(() => emit(prog, { seed })).toThrow(/nope/);
	});
});
