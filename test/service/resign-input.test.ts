// test/service/resign-input.test.ts — 2026-09-12: `ResignInput` on the simulator with the real
// chess.com adapter answering the `resign` reads, mirroring `new-game-input.test.ts`: two native
// held clicks (resign, then its confirmation after `RESIGN.confirmDelayMs`), each revalidated
// against the element the rect was read from; every abort path releases the button off-page.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { SiteAdapter } from "@content/adapters/adapter";
import { createChesscomAdapter } from "@content/adapters/chesscom";
import { CDP, NEW_GAME_INPUT } from "@core/constants/cdp";
import type { GamePortCommand, GamePortMessage } from "@core/constants/messages";
import { PORT_NAMES } from "@core/constants/ports";
import { RESIGN } from "@core/constants/resign";
import { type ConnectedPort, connectPort } from "@core/messaging/ports";
import { createRng } from "@core/rng";
import { defaultScheduler } from "@core/util/scheduler";
import { ContentLink } from "@service/content-link";
import { DebuggerManager } from "@service/debugger-manager";
import { HandOwnership } from "@service/hand-ownership";
import { ResignInput } from "@service/resign-input";
import { createSimulator, type Simulator } from "@test/sim";
import { bootContentContext, type ContentContext } from "@test/sim/contexts/content-context";
import { bootSwContext, type SwContext } from "@test/sim/contexts/sw-context";
import type { TabDom } from "@test/sim/dom/tab-dom";

let sim: Simulator;
let sw: SwContext;
let content: ContentContext;
let dom: TabDom;
let tabId: number;
let link: ContentLink;
let manager: DebuggerManager;
let ownership: HandOwnership;
let input: ResignInput;
let adapter: SiteAdapter;
let port: ConnectedPort<GamePortMessage>;
let commands: Array<GamePortCommand & { at: number }>;
let beforeCommand: ((command: GamePortCommand) => void) | undefined;
let delivered: boolean;
let showCursor: boolean;
let clicks: Array<{ id: string; trusted: boolean; at: number }>;
const RESIGN_RECT = { x: 500, y: 620, width: 120, height: 40 };
const CONFIRM_RECT = { x: 660, y: 620, width: 100, height: 40 };

/** A resign control and a confirmation that appears only once resign has been clicked. */
function layoutControls(): void {
	dom.setHTML(
		'<div class="game-controls-component"><button id="draw">Draw</button>' +
			'<button id="resign" aria-label="Resign">Resign</button></div>' +
			'<div id="prompt" class="board-modal-container" hidden>' +
			'<button id="no">No</button><button id="confirm" class="confirm-button">Resign</button></div>'
	);
	dom.layout("#draw", { ...RESIGN_RECT, x: 360 });
	dom.layout("#resign", RESIGN_RECT);
	dom.layout("#no", { ...CONFIRM_RECT, x: 800 });
	dom.layout("#confirm", CONFIRM_RECT);
	for (const id of ["draw", "resign", "no", "confirm"])
		dom.query(`#${id}`).addEventListener("click", (event) =>
			clicks.push({
				id,
				trusted: (event as unknown as { isTrusted: boolean }).isTrusted,
				at: sim.now(),
			})
		);
	dom
		.query("#resign")
		.addEventListener("click", () => dom.query("#prompt").removeAttribute("hidden"));
}

beforeEach(async () => {
	sim = createSimulator({ startAt: 1_000_000 });
	sim.time.install();
	({ dom, tabId } = sim.openTab("https://www.chess.com/game/live/1"));
	clicks = [];
	layoutControls();
	commands = [];
	delivered = true;
	showCursor = true;
	beforeCommand = undefined;
	sw = await bootSwContext(sim, {
		entry: () => {
			link = new ContentLink({ now: sim.now, scheduler: defaultScheduler });
			manager = new DebuggerManager({ now: sim.now, scheduler: defaultScheduler });
			ownership = new HandOwnership(link, { now: sim.now });
			input = new ResignInput({
				link,
				debugger: manager,
				ownership,
				rng: createRng("resign-input"),
				focus: {
					canExecute: () =>
						manager.isFocusMaintained(tabId) ? { ok: true } : { ok: false, reason: "unfocused" },
				},
				now: sim.now,
				scheduler: defaultScheduler,
				showCursor: () => showCursor,
			});
		},
	});
	content = await bootContentContext(sim, tabId, {
		entry: () => {
			adapter = createChesscomAdapter({
				document: dom.document as unknown as Document,
				window: dom.window as unknown as Window,
			});
			port = connectPort<GamePortMessage, GamePortCommand>(PORT_NAMES.game, {
				scheduler: defaultScheduler,
				onMessage: (command) => {
					commands.push({ ...command, at: sim.now() });
					beforeCommand?.(command);
					if (command.kind === "resign")
						port.post({
							kind: "resignResult",
							id: command.id,
							...adapter.resignTarget(command.step, command.targetId, command.point),
						});
					else if (command.kind === "cursorPrepare")
						port.post({ kind: "cursorPrepared", id: command.id });
					else if (command.kind === "cursorDelivery")
						port.post({ kind: "cursorDelivered", id: command.id, delivered });
				},
			});
		},
	});
	await sim.time.runMicrotasks();
});

afterEach(async () => {
	input.dispose();
	adapter.destroy();
	await sw.run(() => {
		ownership.dispose();
		link.dispose();
		manager.dispose();
	});
	await content.teardown();
	await sw.teardown();
	await sim.dispose();
});

async function run(signal = new AbortController().signal) {
	let result: Awaited<ReturnType<ResignInput["attempt"]>> | undefined;
	await sw.run(async () => {
		void input.attempt(tabId, signal).then((value) => {
			result = value;
		});
		for (let i = 0; i < 4_000 && result === undefined; i++) await sim.time.advance(5);
	});
	expect(result).toBeDefined();
	return result!;
}

function mouse() {
	return sim.debugger.commandsFor(CDP.inputDispatchMouseEvent).map((command) => ({
		...(command.params as {
			type: string;
			x: number;
			y: number;
			buttons: number;
			clickCount?: number;
		}),
		at: command.at,
	}));
}

const inside = (
	p: { x: number; y: number },
	r: { x: number; y: number; width: number; height: number }
): boolean => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

describe("ResignInput", () => {
	it("clicks resign, reads the prompt, then clicks its confirmation — two native held clicks", async () => {
		expect(await run()).toEqual({ status: "resigned" });
		const events = mouse();
		const pressed = events.filter((event) => event.type === "mousePressed");
		const released = events.filter((event) => event.type === "mouseReleased");
		expect(pressed).toHaveLength(2);
		expect(released).toHaveLength(2);
		expect(inside(pressed[0]!, RESIGN_RECT)).toBe(true);
		expect(inside(pressed[1]!, CONFIRM_RECT)).toBe(true);
		for (const press of pressed) {
			expect(press.buttons).toBe(1);
			expect(press.clickCount).toBe(1);
		}
		for (const release of released) expect(release.buttons).toBe(0);
		expect(released[0]!.at - pressed[0]!.at).toBeGreaterThanOrEqual(30);
		// The confirmation is read before it is answered.
		expect(pressed[1]!.at - released[0]!.at).toBeGreaterThanOrEqual(RESIGN.confirmDelayMs[0]);
		// A real approach onto each control.
		const approach = events.filter((event) => event.type === "mouseMoved");
		expect(approach.length).toBeGreaterThan(10);
		// Only the two intended controls received clicks, both trusted, in order.
		expect(clicks.map((c) => [c.id, c.trusted])).toEqual([
			["resign", true],
			["confirm", true],
		]);
		// The mirror followed every dispatched point and stays parked on the confirm click at the end
		// (2026-09-13: the game ending does not hide it; the next game's hand starts from here).
		for (const event of events)
			expect(
				commands.some(
					(command) =>
						command.kind === "cursorTo" &&
						command.x === event.x &&
						command.y === event.y &&
						command.down === (event.buttons === 1)
				)
			).toBe(true);
		expect(commands.some((command) => command.kind === "cursorHide")).toBe(false);
		const lastEvent = events.at(-1);
		expect(commands.filter((command) => command.kind === "cursorTo").at(-1)).toMatchObject({
			x: lastEvent?.x,
			y: lastEvent?.y,
			down: false,
		});
		// Nothing was armed and the borrowed focus was given back.
		expect(ownership.isArmed(tabId)).toBe(false);
		expect(manager.isFocusMaintained(tabId)).toBe(false);
		expect(sim.input.pointer(tabId)?.buttons).toBe(0);
	});

	it("answers not-ready without touching the page when there is no resign control", async () => {
		dom.query("#resign").remove();
		expect(await run()).toEqual({ status: "not-ready", step: "resign" });
		expect(mouse()).toHaveLength(0);
		expect(clicks).toHaveLength(0);
	});

	it("a disabled resign control is not a target", async () => {
		dom.query("#resign").setAttribute("disabled", "");
		expect(await run()).toEqual({ status: "not-ready", step: "resign" });
		expect(mouse()).toHaveLength(0);
	});

	it("a confirmation that never appears stops after the resign click with the button released", async () => {
		dom.query("#prompt").remove();
		expect(await run()).toEqual({ status: "not-ready", step: "confirm" });
		expect(mouse().filter((event) => event.type === "mousePressed")).toHaveLength(1);
		expect(clicks.map((c) => c.id)).toEqual(["resign"]);
		expect(sim.input.pointer(tabId)?.buttons).toBe(0);
		expect(manager.isFocusMaintained(tabId)).toBe(false);
	});

	it.each(["moved", "replaced", "covered"] as const)(
		"rejects a %s resign control before pressing",
		async (change) => {
			beforeCommand = (command) => {
				if (command.kind !== "resign" || !command.targetId) return;
				if (change === "moved") dom.layout("#resign", { ...RESIGN_RECT, x: 600 });
				if (change === "replaced") {
					dom.query("#resign").outerHTML = '<button id="resign" aria-label="Resign">Resign</button>';
					dom.layout("#resign", RESIGN_RECT);
				}
				if (change === "covered") {
					dom.document.body.insertAdjacentHTML("beforeend", '<div id="cover"></div>');
					dom.layout("#cover", RESIGN_RECT);
				}
			};
			expect(await run()).toEqual({ status: "not-ready", step: "resign" });
			expect(mouse().some((event) => event.type === "mousePressed")).toBe(false);
			expect(clicks).toHaveLength(0);
		}
	);

	it("a confirmation that moves during its held press is released off-page, not clicked", async () => {
		dom
			.query("#confirm")
			.addEventListener("mousedown", () => dom.layout("#confirm", { ...CONFIRM_RECT, x: 900 }));
		expect(await run()).toEqual({ status: "not-ready", step: "confirm" });
		expect(clicks.map((c) => c.id)).toEqual(["resign"]);
		expect(
			mouse()
				.filter((event) => event.type === "mouseReleased")
				.at(-1)
		).toMatchObject(NEW_GAME_INPUT.cancelPoint);
		expect(sim.input.pointer(tabId)?.buttons).toBe(0);
	});

	it("an abort during the resign press releases off-page and reports aborted", async () => {
		const controller = new AbortController();
		dom.query("#resign").addEventListener("mousedown", () => controller.abort());
		expect(await run(controller.signal)).toEqual({ status: "aborted", step: "resign" });
		expect(
			mouse()
				.filter((event) => event.type === "mouseReleased")
				.at(-1)
		).toMatchObject(NEW_GAME_INPUT.cancelPoint);
		expect(clicks).toHaveLength(0);
		expect(sim.input.pointer(tabId)?.buttons).toBe(0);
	});

	it("an abort while reading the prompt stops before the confirmation is touched", async () => {
		const controller = new AbortController();
		dom.query("#resign").addEventListener("click", () => controller.abort());
		expect(await run(controller.signal)).toEqual({ status: "aborted", step: "confirm" });
		expect(clicks.map((c) => c.id)).toEqual(["resign"]);
		expect(mouse().filter((event) => event.type === "mousePressed")).toHaveLength(1);
		expect(sim.input.pointer(tabId)?.buttons).toBe(0);
	});

	it("a rejected page press receipt owes a cleanup release but never activates the control", async () => {
		delivered = false;
		expect(await run()).toEqual({ status: "not-ready", step: "resign" });
		expect(clicks).toHaveLength(0);
		expect(mouse().filter((event) => event.type === "mouseReleased")).toHaveLength(1);
		expect(sim.input.pointer(tabId)?.buttons).toBe(0);
	});

	it("a disconnect during admission stops before the first native event", async () => {
		beforeCommand = (command) => {
			if (command.kind === "cursorPrepare") port.disconnect();
		};
		expect(await run()).toEqual({ status: "not-ready", step: "resign" });
		expect(mouse()).toHaveLength(0);
		expect(manager.isFocusMaintained(tabId)).toBe(false);
	});

	it("borrows an existing armed hand's focus without releasing it", async () => {
		await sw.run(async () => {
			await manager.ensureAttached(tabId);
			await manager.setFocusMaintained(tabId, true, manager.reserveFocus(tabId));
			ownership.armed(tabId, { x: 100, y: 100 });
		});
		expect(await run()).toEqual({ status: "resigned" });
		expect(ownership.isArmed(tabId)).toBe(true);
		expect(manager.isFocusMaintained(tabId)).toBe(true);
	});

	it("one attempt per tab at a time", async () => {
		let second: Awaited<ReturnType<ResignInput["attempt"]>> | undefined;
		await sw.run(async () => {
			const first = input.attempt(tabId, new AbortController().signal);
			second = await input.attempt(tabId, new AbortController().signal);
			void first;
		});
		expect(second).toEqual({ status: "not-ready" });
	});

	it("honors a hidden cursor preference while retaining native input", async () => {
		showCursor = false;
		expect(await run()).toEqual({ status: "resigned" });
		expect(commands.some((command) => command.kind === "cursorTo")).toBe(false);
		expect(mouse().filter((event) => event.type === "mousePressed")).toHaveLength(2);
	});

	it("disposal during the confirmation press cancels its click and restores focus", async () => {
		dom.query("#confirm").addEventListener("mousedown", () => input.dispose());
		expect(await run()).toEqual({ status: "not-ready", step: "confirm" });
		expect(clicks.map((click) => click.id)).toEqual(["resign"]);
		expect(mouse().at(-1)).toMatchObject({ type: "mouseReleased", ...NEW_GAME_INPUT.cancelPoint });
		expect(sim.input.pointer(tabId)?.buttons).toBe(0);
		expect(manager.isFocusMaintained(tabId)).toBe(false);
	});

	it("the next game's hand wins when it takes ownership during confirmation release", async () => {
		dom.query("#confirm").addEventListener("click", () => {
			void manager.setFocusMaintained(tabId, true, manager.reserveFocus(tabId));
			ownership.armed(tabId, { x: 55, y: 66 });
			link.post(tabId, { kind: "cursorTo", x: 55, y: 66, down: false });
		});
		expect(await run()).toEqual({ status: "resigned" });
		expect(ownership.position(tabId)).toEqual({ x: 55, y: 66 });
		expect(commands.filter((command) => command.kind === "cursorTo").at(-1)).toMatchObject({
			x: 55,
			y: 66,
			down: false,
		});
		expect(manager.isFocusMaintained(tabId)).toBe(true);
		expect(ownership.isArmed(tabId)).toBe(true);
	});
});
