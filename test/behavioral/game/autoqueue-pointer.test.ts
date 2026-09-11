import { afterEach, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
import { TIMINGS } from "@core/constants/timings";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

it("registry re-queue uses the virtual hand while auto-move remains off in the next game", async () => {
	const target = {
		targetId: "queue-button",
		rect: { left: 950, top: 650, width: 180, height: 45 },
		viewport: { width: 1280, height: 800 },
	};
	h = await createGameHarness({
		settings: { automation: { autoMove: false, autoQueue: true } },
		onCommand: (command) => {
			if (command.kind === "startNewGame")
				h.site.post({ kind: "startNewGameResult", id: command.id, status: "ready", target });
		},
	});
	h.site.dom.document.body.insertAdjacentHTML("beforeend", '<button id="queue">New Game</button>');
	h.site.dom.layout("#queue", { x: 950, y: 650, width: 180, height: 45 });
	let clicks = 0;
	h.site.dom.query("#queue").addEventListener("click", () => {
		clicks++;
		h.site.startGame({ gameId: "queued-without-auto-move" });
	});
	await h.arrive();
	expect(h.executor()?.isArmed()).toBe(false);
	await h.drive(() => h.site.endGame("1-0"));
	expect(await h.until(() => clicks === 1, TIMINGS.autoQueueDelayRangeMs[1] + 5_000)).toBe(true);
	await h.advance(100);
	const mouse = h.sim.debugger.commandsFor(CDP.inputDispatchMouseEvent);
	const approach = mouse.filter((command) => command.params?.type === "mouseMoved");
	expect(approach.length).toBeGreaterThan(10);
	expect(approach.at(-1)!.at - approach[0]!.at).toBeGreaterThan(200);
	expect(mouse.filter((command) => command.params?.type === "mousePressed")).toHaveLength(1);
	expect(mouse.filter((command) => command.params?.type === "mouseReleased")).toHaveLength(1);
	expect(h.commands().filter((command) => command.kind === "cursorTo").length).toBeGreaterThan(10);
	expect(h.session().view().gameId).toBe("queued-without-auto-move");
	expect(h.executor()?.isArmed()).toBe(false);
	expect(h.settings().automation.autoMove).toBe(false);
	expect(h.sim.input.pointer(h.tabId)?.buttons).toBe(0);
});
