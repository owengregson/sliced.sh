// test/pagescript/std.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SPOOF_PURPOSES } from "@core/constants/spoof";
import { defineProgram, deriveToken, emit, js, std } from "@pagescript";
import { installDom } from "../dom";

let dom: ReturnType<typeof installDom>;
beforeAll(() => {
	dom = installDom();
});
afterAll(() => dom.dispose());

const seed = "std-seed";
const run = (body: Parameters<typeof js.program>[0], params = {}): unknown => {
	const prog = defineProgram({ name: "std", params, build: () => js.program(body) });
	return new Function(emit(prog, { seed }).code)();
};

describe("std.query / std.queryAll", () => {
	it("query returns the first match and queryAll a plain array", () => {
		document.body.innerHTML = `<ul><li class="x">1</li><li class="x">2</li></ul>`;
		expect(run([js.ret(js.member(std.query(js.str(".x")), "textContent"))])).toBe("1");
		const all = run([
			js.ret(
				js.call(
					js.member(std.queryAll(js.str(".x")), "map"),
					js.arrow(["e"], js.member(js.id("e"), "textContent"))
				)
			),
		]);
		expect(all).toEqual(["1", "2"]);
		expect(run([js.ret(js.op(std.query(js.str(".nope")), "===", js.nil()))])).toBe(true);
	});
});

describe("std.postToExtension / std.onExtensionMessage", () => {
	it("posts { [spoofedKey]: token, ...payload } to location.origin", () => {
		const win = dom.window;
		const posted: unknown[][] = [];
		const original = win.postMessage;
		win.postMessage = ((...args: unknown[]) => {
			posted.push(args);
		}) as typeof win.postMessage;
		try {
			run([
				js.expr(
					std.postToExtension(js.str("tok-1"), js.obj({ type: js.str("move"), san: js.str("e4") }))
				),
			]);
		} finally {
			win.postMessage = original;
		}
		const key = deriveToken(seed, SPOOF_PURPOSES.messageKey);
		expect(posted).toEqual([[{ [key]: "tok-1", type: "move", san: "e4" }, win.location.origin]]);
	});

	it("onExtensionMessage only invokes the handler for same-window messages carrying the token", () => {
		const win = dom.window;
		const key = deriveToken(seed, SPOOF_PURPOSES.messageKey);
		const seen: unknown[] = [];
		(globalThis as Record<string, unknown>).__seen = seen;
		try {
			run([
				js.expr(
					std.onExtensionMessage(
						js.str("tok-1"),
						js.arrow(["d"], [js.expr(js.call(js.member(js.id("__seen"), "push"), js.id("d")))])
					)
				),
			]);
			const fire = (data: unknown, source: unknown = win, origin = win.location.origin) =>
				win.dispatchEvent(new win.MessageEvent("message", { data, source: source as never, origin }));
			fire({ [key]: "tok-1", type: "cmd" });
			fire({ [key]: "other", type: "cmd" });
			fire({ type: "cmd" });
			fire(null);
			fire("string");
			fire({ [key]: "tok-1", type: "cmd" }, null);
			fire({ [key]: "tok-1", type: "cmd" }, win, "https://evil.test");
		} finally {
			delete (globalThis as Record<string, unknown>).__seen;
		}
		expect(seen).toEqual([{ [key]: "tok-1", type: "cmd" }]);
	});

	it("emits no product-name or extension signature into the page realm", () => {
		const prog = defineProgram({
			name: "sig",
			params: { token: "string" },
			build: (p) =>
				js.program([
					js.expr(std.postToExtension(p.token, js.obj({}))),
					js.expr(std.onExtensionMessage(p.token, js.arrow(["d"], []))),
				]),
		});
		const code = emit(prog, { seed }).code;
		expect(code).not.toMatch(/sliced|__sl|chrome\.|extension/i);
	});
});

describe("std.defineOnce", () => {
	it("installs the value under the spoofed window property only once", () => {
		const key = deriveToken(seed, "probe");
		const win = dom.window as unknown as Record<string, unknown>;
		const g = globalThis as Record<string, unknown>;
		let ticks = 0;
		g.__tick = () => ++ticks;
		delete win[key];
		try {
			const body = [
				std.defineOnce("probe", js.obj({ n: js.call(js.id("__tick")) })),
				js.ret(js.member(js.id("window"), js.spoof("probe"))),
			];
			const first = run(body) as { n: number };
			expect(first).toEqual({ n: 1 });
			expect(run(body)).toBe(first);
			expect(ticks).toBe(1);
			expect(win[key]).toBe(first);
		} finally {
			delete win[key];
			delete g.__tick;
		}
	});
});

describe("std.tryCatchLog / std.rect / std.jsonClone", () => {
	it("tryCatchLog swallows by default and can route the error to a handler", () => {
		expect(
			run([
				std.tryCatchLog([js.throw_(js.new_(js.id("Error"), js.str("boom")))]),
				js.ret(js.str("after")),
			])
		).toBe("after");
		expect(
			run([
				std.tryCatchLog([js.throw_(js.new_(js.id("Error"), js.str("boom")))], (err) => [
					js.ret(js.member(err, "message")),
				]),
			])
		).toBe("boom");
	});

	it("rect returns a plain {x,y,width,height} object", () => {
		document.body.innerHTML = `<div id="r"></div>`;
		const out = run([js.ret(std.rect(std.query(js.str("#r"))))]) as Record<string, unknown>;
		expect(Object.keys(out).sort()).toEqual(["height", "width", "x", "y"]);
		for (const v of Object.values(out)) expect(typeof v).toBe("number");
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
	});

	it("jsonClone deep-copies through JSON", () => {
		(globalThis as Record<string, unknown>).__src = { a: [1, { b: 2 }] };
		try {
			const out = run([js.ret(std.jsonClone(js.id("__src")))]);
			expect(out).toEqual({ a: [1, { b: 2 }] });
			expect(out).not.toBe((globalThis as Record<string, unknown>).__src);
		} finally {
			delete (globalThis as Record<string, unknown>).__src;
		}
	});
});
