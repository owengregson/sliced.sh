// test/page/lichess-bridge.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { SELECTORS } from "@content/adapters/selectors";
import { bindCode, emit } from "@pagescript";
import { lichessEntryArgs } from "../../src/page/index";
import { lichessBridge } from "../../src/page/lichess-bridge";
import {
	command,
	forbiddenIn,
	makeWindow,
	type Posted,
	postsOf,
	recordPosts,
	runProgram,
	SEED,
	sendToPage,
	TOKENS_FOR_SEED,
} from "./helpers";

const emitted = emit(lichessBridge, { seed: SEED });
const bound = bindCode(emitted.code, emitted.params, lichessEntryArgs({ seed: SEED }));
const { key, page, overlayClass } = TOKENS_FOR_SEED;

const ROUND_HTML = `
<main class="round">
  <div class="round__app">
    <div class="cg-wrap orientation-white manipulable">
      <cg-container style="width: 544px; height: 544px;">
        <cg-board></cg-board>
        <svg class="cg-shapes"><g></g></svg>
      </cg-container>
    </div>
  </div>
</main>`;

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
});

interface FakeLichess {
	events: { on(name: string, cb: () => void): void; fire(name: string): void };
	chessground?: () => { getFen(): string };
}

function fakeLichess(): FakeLichess {
	const handlers = new Map<string, Array<() => void>>();
	return {
		events: {
			on(name, cb) {
				handlers.set(name, [...(handlers.get(name) ?? []), cb]);
			},
			fire(name) {
				for (const cb of handlers.get(name) ?? []) cb();
			},
		},
	};
}

function boot(opts: { url?: string; lichess?: FakeLichess | null; html?: string } = {}) {
	const win = makeWindow(opts.url ?? "https://lichess.org/abcdefgh");
	cleanups.push(() => win.happyDOM.close());
	win.document.body.innerHTML = opts.html ?? ROUND_HTML;
	if (opts.lichess !== null)
		(win as unknown as { lichess: FakeLichess }).lichess = opts.lichess ?? fakeLichess();
	const rec = recordPosts(win);
	cleanups.push(rec.restore);
	const keysBefore = Object.keys(win);
	runProgram(bound, win);
	return {
		win,
		posts: rec.posts,
		keysBefore,
		lichess: (win as unknown as { lichess?: FakeLichess }).lichess,
	};
}

function reply(posts: Posted[], id: string): Record<string, unknown> | undefined {
	return posts.find((p) => p.data[key] === page && p.data.i === id)?.data;
}

describe("lichess-bridge — emitted code (§13.3)", () => {
	it("contains no forbidden substring, no literal selector or hostname, no window property write", () => {
		expect(forbiddenIn(emitted.code)).toEqual([]);
		expect(forbiddenIn(bound)).toEqual([]);
		expect(emitted.code).not.toContain(SELECTORS.lichess.container);
		expect(emitted.code).not.toContain("lichess.org");
		expect(emitted.code).not.toMatch(/window\.\w+\s*=|window\[[^\]]+\]\s*=/);
		expect(emitted.code).not.toContain("defineProperty");
		expect(emitted.code).not.toMatch(/localStorage|sessionStorage|indexedDB|cookie/);
	});
});

describe("lichess-bridge — behaviour", () => {
	it("posts ready, subscribes events.on('ply') and relays ply; defines nothing on window; inserts nothing", () => {
		const { win, posts, keysBefore, lichess } = boot();
		expect(Object.keys(win)).toEqual(keysBefore);
		expect(postsOf(posts, "ready")).toHaveLength(1);
		lichess?.events.fire("ply");
		lichess?.events.fire("ply");
		expect(postsOf(posts, "ply")).toHaveLength(2);
		expect(win.document.querySelectorAll("cg-container > *").length).toBe(2); // board + cg-shapes only
		for (const p of posts) {
			for (const n of Object.keys(p.data).filter((x) => x !== key)) expect(n).toMatch(/^[a-z]$/);
		}
	});
	it("getState → { h: hasApi, n: position from chessground when reachable }", () => {
		const lichess = fakeLichess();
		lichess.chessground = () => ({ getFen: () => "8/8/8/8/8/8/8/K6k w - - 0 1" });
		const { win, posts } = boot({ lichess });
		sendToPage(win, command("getState", "1"));
		expect(reply(posts, "1")?.p).toEqual({ h: true, n: "8/8/8/8/8/8/8/K6k w - - 0 1" });
	});
	it("getState without the public API → { h: false, n: null }; the API appearing later is picked up", async () => {
		const { win, posts } = boot({ lichess: null });
		sendToPage(win, command("getState", "1"));
		expect(reply(posts, "1")?.p).toEqual({ h: false, n: null });
		const late = fakeLichess();
		(win as unknown as { lichess: FakeLichess }).lichess = late;
		await new Promise((r) => setTimeout(r, 300));
		late.events.fire("ply");
		expect(postsOf(posts, "ply")).toHaveLength(1);
	});
	it("draw appends one svg overlay to cg-container (never inside svg.cg-shapes), idempotently; clear removes it", () => {
		const { win, posts } = boot();
		const payload = {
			r: "w",
			h: [
				{ q: "e2", c: "rgb(1 2 3 / 0.3)" },
				{ q: "e4", c: "rgb(1 2 3 / 0.5)" },
			],
			a: [{ f: "e2", t: "e4", c: "rgb(1 2 3 / 0.6)" }],
		};
		sendToPage(win, command("draw", "1", payload));
		sendToPage(win, command("draw", "2", payload));
		const overlays = win.document.querySelectorAll(`cg-container > svg.${overlayClass}`);
		expect(overlays).toHaveLength(1);
		const svg = overlays[0];
		expect(svg?.getAttribute("viewBox")).toBe("0 0 8 8");
		expect(svg?.getAttribute("style")).toContain("pointer-events:none");
		expect(svg?.hasAttribute("id")).toBe(false);
		expect([...(svg?.attributes ?? [])].some((a) => a.name.startsWith("data-"))).toBe(false);
		expect(svg?.textContent).toBe("");
		expect(win.document.querySelector(`${SELECTORS.lichess.shapes} .${overlayClass}`)).toBeNull();
		expect(win.document.querySelector(`${SELECTORS.lichess.shapes} rect`)).toBeNull();
		const rects = svg?.querySelectorAll("rect") ?? [];
		expect(rects).toHaveLength(2);
		expect(rects[0]?.getAttribute("x")).toBe("4"); // e-file, white at the bottom
		expect(rects[0]?.getAttribute("y")).toBe("6"); // rank 2 → row 6
		expect(rects[0]?.getAttribute("fill")).toBe("rgb(1 2 3 / 0.3)");
		const polygon = svg?.querySelector("polygon");
		expect(polygon?.getAttribute("fill")).toBe("rgb(1 2 3 / 0.6)");
		expect(polygon?.getAttribute("points")?.split(" ")).toHaveLength(7);
		expect(reply(posts, "2")?.p).toEqual({ y: [] });
		sendToPage(win, command("clear", "3"));
		expect(win.document.querySelector(`.${overlayClass}`)).toBeNull();
		expect(reply(posts, "3")?.k).toBe("clear");
		// clearing again is harmless
		sendToPage(win, command("clear", "4"));
		expect(reply(posts, "4")).toBeDefined();
	});
	it("mirrors the overlay for the black orientation", () => {
		const { win } = boot();
		sendToPage(win, command("draw", "1", { r: "b", h: [{ q: "e2", c: "x" }], a: [] }));
		const rect = win.document.querySelector(`.${overlayClass} rect`);
		expect(rect?.getAttribute("x")).toBe("3");
		expect(rect?.getAttribute("y")).toBe("1");
	});
	it("stays silent on another host", () => {
		const { win, posts, keysBefore } = boot({ url: "https://www.chess.com/play/online" });
		expect(posts).toHaveLength(0);
		sendToPage(win, command("getState", "1"));
		expect(posts).toHaveLength(0);
		expect(Object.keys(win)).toEqual(keysBefore);
	});
	it("answers legalMoves with an empty list and cursor with null before any trusted pointer event", () => {
		const { win, posts } = boot();
		sendToPage(win, command("legalMoves", "1"));
		expect(reply(posts, "1")?.p).toEqual([]);
		sendToPage(win, command("cursor", "2"));
		expect(reply(posts, "2")?.p).toBeNull();
	});
});
