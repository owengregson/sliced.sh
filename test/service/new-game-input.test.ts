import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { SiteAdapter } from "@content/adapters/adapter";
import { createChesscomAdapter } from "@content/adapters/chesscom";
import { CDP, NEW_GAME_INPUT } from "@core/constants/cdp";
import type { GamePortCommand, GamePortMessage } from "@core/constants/messages";
import { PORT_NAMES } from "@core/constants/ports";
import { type ConnectedPort, connectPort } from "@core/messaging/ports";
import { createRng } from "@core/rng";
import { defaultScheduler } from "@core/util/scheduler";
import { ContentLink } from "@service/content-link";
import { DebuggerManager } from "@service/debugger-manager";
import { HandOwnership } from "@service/hand-ownership";
import { NewGameInput } from "@service/new-game-input";
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
let input: NewGameInput;
let adapter: SiteAdapter;
let port: ConnectedPort<GamePortMessage>;
let commands: Array<GamePortCommand & { at: number }>;
let beforeCommand: ((command: GamePortCommand) => void) | undefined;
let delivered: boolean;
let showCursor: boolean;
const RECT = { x: 500, y: 220, width: 160, height: 44 };

beforeEach(async () => {
	sim = createSimulator({ startAt: 1_000_000 });
	sim.time.install();
	({ dom, tabId } = sim.openTab("https://www.chess.com/play/online"));
	dom.setHTML(
		'<div class="play-menu-component"><button aria-label="New Game">New Game</button></div>'
	);
	dom.layout("button", RECT);
	commands = [];
	delivered = true;
	showCursor = true;
	beforeCommand = undefined;
	sw = await bootSwContext(sim, {
		entry: () => {
			link = new ContentLink({ now: sim.now, scheduler: defaultScheduler });
			manager = new DebuggerManager({ now: sim.now, scheduler: defaultScheduler });
			ownership = new HandOwnership(link, { now: sim.now });
			input = new NewGameInput({
				link,
				debugger: manager,
				ownership,
				rng: createRng("queue-input"),
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
					if (command.kind === "startNewGame")
						port.post({
							kind: "startNewGameResult",
							id: command.id,
							...adapter.newGameTarget("new", command.gameId, command.targetId, command.point),
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
	let result: Awaited<ReturnType<NewGameInput["attempt"]>> | undefined;
	await sw.run(async () => {
		void input.attempt(tabId, null, signal).then((value) => {
			result = value;
		});
		for (let i = 0; i < 2_000 && result === undefined; i++) await sim.time.advance(5);
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

describe("NewGameInput", () => {
	it("uses a visible sampled approach and native held click, without arming auto-play", async () => {
		const clicks: boolean[] = [];
		dom
			.query("button")
			.addEventListener("click", (event) =>
				clicks.push((event as unknown as { isTrusted: boolean }).isTrusted)
			);
		expect(await run()).toEqual({ status: "started" });
		const events = mouse();
		const approach = events.filter((event) => event.type === "mouseMoved");
		const press = events.find((event) => event.type === "mousePressed")!;
		const release = events.find((event) => event.type === "mouseReleased")!;
		expect(approach.length).toBeGreaterThan(10);
		expect(approach.at(-1)!.at - approach[0]!.at).toBeGreaterThan(200);
		expect(release.at - press.at).toBeGreaterThanOrEqual(30);
		expect(press.buttons).toBe(1);
		expect(release.buttons).toBe(0);
		expect(press.clickCount).toBe(1);
		expect(clicks).toEqual([true]);
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
		expect(commands.filter((command) => command.kind === "cursorDelivery")).toHaveLength(2);
		expect(commands.at(-1)?.kind).toBe("cursorHide");
		expect(ownership.isArmed(tabId)).toBe(false);
		expect(manager.isFocusMaintained(tabId)).toBe(false);
		expect(sim.input.pointer(tabId)?.buttons).toBe(0);
	});

	it("uses another complete native gesture for the lobby's next Play control and stops once searching", async () => {
		const first = dom.query("button");
		first.addEventListener("click", () => {
			dom.query(".play-menu-component").innerHTML = '<button id="play">Play</button>';
			dom.layout("#play", { ...RECT, x: 760 });
			dom.query("#play").addEventListener("click", () => {
				dom.query("#play").textContent = "Cancel";
			});
		});
		expect(await run()).toEqual({ status: "started" });
		expect(await run()).toEqual({ status: "started" });
		expect(await run()).toEqual({ status: "searching" });
		expect(mouse().filter((event) => event.type === "mousePressed")).toHaveLength(2);
		expect(mouse().filter((event) => event.type === "mouseReleased")).toHaveLength(2);
	});

	it.each(["moved", "replaced", "covered"] as const)(
		"rejects a %s target before pressing",
		async (change) => {
			beforeCommand = (command) => {
				if (command.kind !== "startNewGame" || !command.targetId) return;
				if (change === "moved") dom.layout("button", { ...RECT, x: 600 });
				if (change === "replaced") {
					dom.query("button").outerHTML = '<button aria-label="New Game">New Game</button>';
					dom.layout("button", RECT);
				}
				if (change === "covered") {
					dom.document.body.insertAdjacentHTML("beforeend", '<div id="cover"></div>');
					dom.layout("#cover", RECT);
				}
			};
			expect(await run()).toEqual({ status: "not-ready" });
			expect(mouse().some((event) => event.type === "mousePressed")).toBe(false);
		}
	);

	it("cancels after a press by releasing off-page without clicking the old control", async () => {
		const controller = new AbortController();
		let clicked = 0;
		dom.query("button").addEventListener("click", () => clicked++);
		dom.query("button").addEventListener("mousedown", () => controller.abort());
		expect(await run(controller.signal)).toEqual({ status: "not-ready" });
		expect(
			mouse()
				.filter((event) => event.type === "mouseReleased")
				.at(-1)
		).toMatchObject(NEW_GAME_INPUT.cancelPoint);
		expect(clicked).toBe(0);
		expect(sim.input.pointer(tabId)?.buttons).toBe(0);
	});

	it("a rejected page press receipt owes a cleanup release but never activates the control", async () => {
		delivered = false;
		let clicked = 0;
		dom.query("button").addEventListener("click", () => clicked++);
		expect(await run()).toEqual({ status: "not-ready" });
		expect(clicked).toBe(0);
		expect(mouse().filter((event) => event.type === "mouseReleased")).toHaveLength(1);
		expect(sim.input.pointer(tabId)?.buttons).toBe(0);
	});

	it("a control moving during the held press cancels its release instead of clicking", async () => {
		let clicked = 0;
		dom.query("button").addEventListener("click", () => clicked++);
		dom
			.query("button")
			.addEventListener("mousedown", () => dom.layout("button", { ...RECT, x: 800 }));
		expect(await run()).toEqual({ status: "not-ready" });
		expect(clicked).toBe(0);
		expect(
			mouse()
				.filter((event) => event.type === "mouseReleased")
				.at(-1)
		).toMatchObject(NEW_GAME_INPUT.cancelPoint);
	});

	it("a disconnect during admission stops before the first native event", async () => {
		beforeCommand = (command) => {
			if (command.kind === "cursorPrepare") port.disconnect();
		};
		expect(await run()).toEqual({ status: "not-ready" });
		expect(mouse()).toHaveLength(0);
		expect(manager.isFocusMaintained(tabId)).toBe(false);
	});

	it("borrows an existing armed hand's focus without releasing it", async () => {
		await sw.run(async () => {
			await manager.ensureAttached(tabId);
			await manager.setFocusMaintained(tabId, true, manager.reserveFocus(tabId));
			ownership.armed(tabId, { x: 100, y: 100 });
		});
		expect(await run()).toEqual({ status: "started" });
		expect(ownership.isArmed(tabId)).toBe(true);
		expect(manager.isFocusMaintained(tabId)).toBe(true);
	});

	it("does not hide or restore focus belonging to a new game that starts during release", async () => {
		dom.query("button").addEventListener("click", () => {
			const reservation = manager.reserveFocus(tabId);
			void manager.setFocusMaintained(tabId, true, reservation);
			ownership.armed(tabId);
			link.post(tabId, { kind: "cursorTo", x: 55, y: 66, down: false });
		});
		expect(await run()).toEqual({ status: "started" });
		expect(commands.at(-1)?.kind).not.toBe("cursorHide");
		expect(manager.isFocusMaintained(tabId)).toBe(true);
		expect(ownership.isArmed(tabId)).toBe(true);
	});

	it("honors a hidden cursor preference while retaining native input", async () => {
		showCursor = false;
		expect(await run()).toEqual({ status: "started" });
		expect(commands.some((command) => command.kind === "cursorTo")).toBe(false);
		expect(mouse().filter((event) => event.type === "mousePressed")).toHaveLength(1);
	});
});
