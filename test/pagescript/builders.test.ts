// test/pagescript/builders.test.ts
import { describe, expect, it } from "bun:test";
import { js } from "@pagescript";
import { generate } from "astring";

const print = (node: { type: string }): string => generate(node, { indent: "", lineEnd: "" });

describe("js builders: literals & identifiers", () => {
	it("id / str / num / bool / nil / undef", () => {
		expect(js.id("document")).toEqual({ type: "Identifier", name: "document" });
		expect(js.str('a"b')).toEqual({ type: "Literal", value: 'a"b' });
		expect(print(js.str('a"b\n'))).toBe('"a\\"b\\n"');
		expect(js.num(3.5)).toEqual({ type: "Literal", value: 3.5 });
		expect(print(js.num(-2))).toBe("-2");
		expect(() => js.num(Number.NaN)).toThrow(RangeError);
		expect(js.bool(true)).toEqual({ type: "Literal", value: true });
		expect(js.nil()).toEqual({ type: "Literal", value: null });
		expect(print(js.nil())).toBe("null");
		expect(js.undef()).toEqual({ type: "Identifier", name: "undefined" });
	});

	it("param / spoof produce placeholder identifiers", () => {
		expect(js.param("sel")).toEqual({ type: "Identifier", name: "$$param:sel" });
		expect(js.spoof("ready")).toEqual({ type: "Identifier", name: "$$spoof:ready" });
		expect(() => js.param("")).toThrow();
		expect(() => js.spoof("")).toThrow();
	});

	it("tpl builds a template literal with escaped raw quasis", () => {
		const t = js.tpl(["a`${", "b\\"], js.id("x"));
		expect(t.type).toBe("TemplateLiteral");
		expect(t.quasis).toHaveLength(2);
		expect(t.quasis[1]?.tail).toBe(true);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the escaped template text is the expected output
		expect(print(t)).toBe("`a\\`\\${${x}b\\\\`");
		expect(new Function("x", `return ${print(t)};`)("Z")).toBe("a`${Zb\\");
		expect(() => js.tpl(["a"], js.id("x"))).toThrow(RangeError);
	});

	it("arr / obj / spread", () => {
		expect(print(js.arr(js.num(1), js.spread(js.id("rest"))))).toBe("[1, ...rest]");
		expect(print(js.obj({ a: js.num(1), "b-c": js.str("x") }))).toBe('{a: 1,"b-c": "x"}');
		expect(print(js.obj({}))).toBe("{}");
		const o = js.obj({ a: js.num(1) });
		expect(o.properties[0]).toMatchObject({
			type: "Property",
			kind: "init",
			computed: false,
			shorthand: false,
			method: false,
		});
	});
});

describe("js builders: access & calls", () => {
	it("member chains strings as dotted access and expressions as computed access", () => {
		const m = js.member(js.id("document"), "body", "children", js.num(0));
		expect(m.type).toBe("MemberExpression");
		expect(print(m)).toBe("document.body.children[0]");
		expect(print(js.member(js.id("o"), "not-ident"))).toBe('o["not-ident"]');
		expect(print(js.member(js.id("o"), js.str("k")))).toBe('o["k"]');
		expect(() => js.member(js.id("o"))).toThrow(RangeError);
	});

	it("member treats a spoofed identifier as a property name, not a variable", () => {
		expect(print(js.member(js.id("window"), js.spoof("x")))).toBe("window.$$spoof:x");
		const m = js.member(js.id("window"), js.spoof("x"));
		expect(m.computed).toBe(false);
	});

	it("member keeps a bind parameter computed so it becomes a string key after bind", () => {
		expect(print(js.member(js.id("o"), js.param("k")))).toBe("o[$$param:k]");
	});

	it("call / new_ / opt", () => {
		expect(print(js.call(js.id("f"), js.num(1), js.spread(js.id("r"))))).toBe("f(1, ...r)");
		expect(print(js.new_(js.id("Map"), js.id("e")))).toBe("new Map(e)");
		expect(print(js.new_(js.id("Map")))).toBe("new Map()");
		const o = js.opt(js.id("a"), "b", "c");
		expect(o.type).toBe("ChainExpression");
		expect(print(o)).toBe("a?.b?.c");
		expect(print(js.opt(js.id("a"), "not-ident"))).toBe('a?.["not-ident"]');
		expect(() => js.opt(js.id("a"))).toThrow(RangeError);
	});
});

describe("js builders: statements", () => {
	it("const_ / let_ / assign / expr", () => {
		expect(print(js.const_("x", js.num(1)))).toBe("const x = 1;");
		expect(print(js.let_("y"))).toBe("let y;");
		expect(print(js.let_("y", js.num(2)))).toBe("let y = 2;");
		expect(print(js.assign(js.member(js.id("a"), "b"), js.num(3)))).toBe("a.b = 3;");
		expect(print(js.expr(js.call(js.id("f"))))).toBe("f();");
		expect(() => js.const_("not ident", js.num(1))).toThrow();
		expect(print(js.assign(js.id("a"), js.num(3)))).toBe("a = 3;");
		expect(() => js.assign(js.param("p"), js.num(1))).toThrow(/target/);
		expect(() => js.assign(js.str("s"), js.num(1))).toThrow(/target/);
		expect(() => js.assign(js.call(js.id("f")), js.num(1))).toThrow(/target/);
	});

	it("if_ / forOf / while_", () => {
		expect(print(js.if_(js.id("t"), [js.ret(js.num(1))]))).toBe("if (t) {return 1;}");
		expect(print(js.if_(js.id("t"), [js.ret(js.num(1))], [js.ret(js.num(2))]))).toBe(
			"if (t) {return 1;} else {return 2;}"
		);
		expect(print(js.forOf("el", js.id("list"), [js.expr(js.call(js.id("f"), js.id("el")))]))).toBe(
			"for (const el of list) {f(el);}"
		);
		expect(print(js.while_(js.bool(true), [js.expr(js.call(js.id("tick")))]))).toBe(
			"while (true) {tick();}"
		);
	});

	it("ret / throw_ / try_", () => {
		expect(print(js.ret())).toBe("return;");
		expect(print(js.ret(js.num(1)))).toBe("return 1;");
		expect(print(js.throw_(js.new_(js.id("Error"), js.str("x"))))).toBe('throw new Error("x");');
		expect(print(js.try_([js.expr(js.call(js.id("f")))], "e", [js.ret(js.id("e"))]))).toBe(
			"try {f();} catch (e) {return e;}"
		);
		expect(
			print(
				js.try_(
					[js.expr(js.call(js.id("f")))],
					"e",
					[js.ret(js.id("e"))],
					[js.expr(js.call(js.id("done")))]
				)
			)
		).toBe("try {f();} catch (e) {return e;} finally {done();}");
	});
});

describe("js builders: functions", () => {
	it("fn / arrow / iife", () => {
		expect(print(js.fn(["a", "b"], [js.ret(js.id("a"))]))).toBe("function (a, b) {return a;}");
		expect(print(js.fn([], [], { async: true, name: "go" }))).toBe("async function go() {}");
		expect(print(js.arrow(["x"], js.id("x")))).toBe("x => x");
		expect(print(js.arrow(["x", "y"], js.id("x")))).toBe("(x, y) => x");
		expect(print(js.arrow([], js.obj({ a: js.num(1) })))).toBe("() => ({a: 1})");
		expect(print(js.arrow([], [js.ret(js.num(1))], { async: true }))).toBe("async () => {return 1;}");
		const arrow = js.arrow([], js.id("x"));
		expect(arrow.expression).toBe(true);
		expect(print(js.iife([js.ret(js.num(1))]))).toBe("(() => {return 1;})()");
		expect(print(js.iife([js.ret(js.num(1))], { async: true }))).toBe("(async () => {return 1;})()");
	});
});

describe("js builders: operators", () => {
	it("op / not / and / or / nullish / cond / await_ / typeof_", () => {
		expect(print(js.op(js.id("a"), "===", js.num(1)))).toBe("a === 1");
		expect(print(js.op(js.op(js.id("a"), "+", js.id("b")), "*", js.id("c")))).toBe("(a + b) * c");
		expect(print(js.not(js.id("a")))).toBe("!a");
		expect(print(js.not(js.and(js.id("a"), js.id("b"))))).toBe("!(a && b)");
		expect(print(js.and(js.id("a"), js.id("b")))).toBe("a && b");
		expect(print(js.or(js.id("a"), js.id("b")))).toBe("a || b");
		expect(print(js.nullish(js.id("a"), js.id("b")))).toBe("a ?? b");
		expect(print(js.cond(js.id("t"), js.num(1), js.num(2)))).toBe("t ? 1 : 2");
		expect(print(js.await_(js.call(js.id("f"))))).toBe("await f()");
		expect(print(js.typeof_(js.id("a")))).toBe("typeof a");
		expect(print(js.op(js.typeof_(js.id("a")), "===", js.str("string")))).toBe(
			'typeof a === "string"'
		);
	});
});

describe("js builders: program", () => {
	it("program prints its statements in order", () => {
		const p = js.program([js.const_("a", js.num(1)), js.ret(js.id("a"))]);
		expect(p.type).toBe("Program");
		expect(print(p)).toBe("const a = 1;return a;");
	});
});
