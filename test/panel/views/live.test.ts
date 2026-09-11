// test/panel/views/live.test.ts — the Live game view (Appendix F §4.4–§4.5, §5.5–§5.10,
// §6.1–§6.3) as a projection of `PanelSnapshot`: hands-off mode (§13.4), telemetry pill,
// mirrored rows, clocks, eval numeral, move card states, play button transitions, PV rows,
// strength popover, toggles (hold-to-arm, keybind pre-arm), session strip, detached banner,
// toasts, and cleanup.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromeLocalGet } from "@core/chrome/storage";
import { LOCAL_KEYS, MSG, TOAST_KEYS, UI_TIMINGS } from "@core/constants";
import { LIMITS } from "@core/constants/limits";
import { TOKENS } from "@design/tokens.generated";
import { currentBannerKind } from "@panel/components/banner";
import { COPY, COPY_LIVE } from "@panel/copy";
import { bootShell, type PanelShell } from "@panel/shell";
import { liveView } from "@panel/views/live";
import { bootPanelDom, click, key, type PanelDom, pointer } from "../dom";
import {
	FEN_B,
	fakeStore,
	INTERACTIVE_SELECTOR,
	idleSnapshot,
	type LiveHarness,
	liveSnapshot,
	makeRecommendation,
	mountLive,
	THINK_MS,
} from "./live-harness";

const LIVE_CSS =
	readFileSync(path.resolve(import.meta.dir, "../../../css/views/live.css"), "utf8") +
	readFileSync(path.resolve(import.meta.dir, "../../../css/views/workspace.css"), "utf8");

let dom: PanelDom;
let h: LiveHarness | null = null;
let shell: PanelShell | null = null;

beforeEach(async () => {
	dom = await bootPanelDom();
});
afterEach(async () => {
	shell?.dispose();
	shell = null;
	h?.teardown();
	h = null;
	await dom.teardown();
});

const playButton = (): HTMLButtonElement => {
	if (!h) throw new Error("no harness");
	return h.q<HTMLButtonElement>(".sl-move__action .sl-button");
};
const playLabel = (): string => playButton().querySelector(".sl-button__label")?.textContent ?? "";
const pillText = (name: string): string =>
	h?.q(`.sl-pill[data-pill="${name}"] .sl-pill__text`).textContent ?? "";
const pillClass = (name: string): string => h?.q(`.sl-pill[data-pill="${name}"]`).className ?? "";

describe("hands-off mode (§13.4 / §10.4)", () => {
	it("locks every control, shows the Play keybind only, never takes focus", async () => {
		h = await mountLive(dom.sim, liveSnapshot());
		expect(h.root.dataset.view).toBe("live");
		expect(h.root.classList.contains("sl-live--hands-off")).toBe(true);
		const controls = h.qa(INTERACTIVE_SELECTOR);
		expect(controls.length).toBeGreaterThan(5);
		for (const el of controls) {
			expect({ el: el.className, disabled: el.getAttribute("aria-disabled") }).toEqual({
				el: el.className,
				disabled: "true",
			});
			expect(el.getAttribute("tabindex")).toBe("-1");
		}
		// CSS: the view's own lock (the shell adds `.sl-hands-off` on top).
		expect(LIVE_CSS).toMatch(/\.sl-live--hands-off[^{]*\{[^}]*pointer-events:\s*none/);
		// The Play button is a keybind hint only.
		const button = playButton();
		expect(button.getAttribute("aria-disabled")).toBe("true");
		expect(button.querySelector<HTMLElement>(".sl-button__kbd")?.hidden).toBe(false);
		expect(button.querySelector(".sl-button__kbd")?.textContent).toBe(COPY.keybind.keys.space);
		expect(h.q(".sl-move").classList.contains("sl-move--hands-off")).toBe(true);
		expect(LIVE_CSS).toMatch(
			/\.sl-move--hands-off[^{]*\.sl-button__label[^{]*\{[^}]*display:\s*inline/
		);
		expect(document.activeElement).toBe(document.body);
		// Nothing dispatches from pointer or keyboard while hands-off.
		const row = h.qa(".sl-pv")[1];
		if (row) pointer(row, "pointerover");
		if (row) click(row);
		click(h.q(".sl-live__strength-open"));
		click(playButton());
		key(document, "keydown", { key: "A", code: "KeyA", shiftKey: true });
		key(document, "keydown", { key: " ", code: "Space" });
		await dom.tick(UI_TIMINGS.preArmMs);
		expect(h.store.calls).toEqual([]);
		expect(document.querySelector(".sl-popover")).toBeNull();
		expect(h.toasts()).toHaveLength(0);
		expect(document.activeElement).toBe(document.body);
	});

	it("through the shell: banner with the three keybinds, view switch disabled, controls locked", async () => {
		dom.sim.openTab("https://www.chess.com/game/174252011111", { active: true });
		const app = document.getElementById("app");
		if (!app) throw new Error("no #app");
		const store = fakeStore(null);
		shell = bootShell(app, { store, views: { live: liveView } });
		store.emit(liveSnapshot());
		await dom.tick(0);
		expect(shell.router.current).toBe("live");
		expect(shell.handsOff).toBe(true);
		expect(app.classList.contains("sl-hands-off")).toBe(true);
		expect(app.querySelector(".sl-segment")?.getAttribute("aria-disabled")).toBe("true");
		expect(currentBannerKind()).toBe("hands-off");
		const banner = app.querySelector(".sl-banner--hands-off")?.textContent?.trim() ?? "";
		expect(banner).toBe(COPY.banner.handsOff);
		const shortcuts = app.querySelector(".sl-shortcuts")?.textContent ?? "";
		expect(shortcuts).toContain("Shift+A");
		expect(shortcuts).toContain("Space");
		expect(shortcuts).toContain("Shift+X");
		expect(app.querySelectorAll(".sl-banner")).toHaveLength(1); // no second (detached) banner
		const live = app.querySelector<HTMLElement>(".sl-live");
		expect(live?.classList.contains("sl-live--hands-off")).toBe(true);
		for (const el of live?.querySelectorAll(INTERACTIVE_SELECTOR) ?? [])
			expect(el.getAttribute("aria-disabled")).toBe("true");
		expect(document.activeElement).toBe(document.body);
	});
});

describe("telemetry, hand and executor pills (§10.4, §9.7)", () => {
	it("Telemetry reflects snapshot.focus; hand state from session.hand", async () => {
		h = await mountLive(dom.sim, liveSnapshot());
		expect(h.q('.sl-pill[data-pill="telemetry"]').getAttribute("aria-label")).toContain(
			COPY.telemetry.label
		);
		expect(pillText("telemetry")).toBe(COPY.telemetry.clean);
		expect(pillClass("telemetry")).toContain("sl-pill--ok");
		h.store.emit(liveSnapshot({ focus: { blurSeenThisMove: true } }));
		expect(pillText("telemetry")).toBe(COPY.telemetry.blur);
		expect(pillClass("telemetry")).toContain("sl-pill--warn");
		h.store.emit(liveSnapshot({ focus: { realPointerEventsDuringHand: 2 } }));
		expect(pillText("telemetry")).toBe(COPY.telemetry.mouse);
		expect(pillClass("telemetry")).toContain("sl-pill--danger");
		expect(pillText("hand")).toBe(COPY_LIVE.hand.resting);
		h.store.emit(liveSnapshot({ hand: "paused" }));
		expect(pillText("hand")).toBe(COPY_LIVE.hand.paused);
		expect(pillClass("hand")).toContain("sl-pill--warn");
		h.store.emit(liveSnapshot({ hand: "moving" }));
		expect(pillText("hand")).toBe(COPY_LIVE.hand.moving);
		h.store.emit(liveSnapshot({ hand: "detached" }));
		expect(pillText("hand")).toBe(COPY_LIVE.hand.detached);
		expect(pillClass("hand")).toContain("sl-pill--danger");
	});

	it("executor pill: hidden until auto-play is used, then Attached / Detached / Not started", async () => {
		h = await mountLive(dom.sim, idleSnapshot());
		expect(h.q('.sl-pill[data-pill="executor"]').hidden).toBe(true);
		h.store.emit(idleSnapshot({ autoMove: { armed: true } }));
		expect(h.q('.sl-pill[data-pill="executor"]').hidden).toBe(false);
		expect(pillText("executor")).toBe(COPY.executor.notStarted);
		h.store.emit(idleSnapshot({ autoMove: { armed: true }, executor: { debuggerAttached: true } }));
		expect(pillText("executor")).toBe(COPY.executor.attached);
		expect(pillClass("executor")).toContain("sl-pill--ok");
		h.store.emit(idleSnapshot({ autoMove: { armed: false }, executor: { debuggerAttached: false } }));
		expect(h.q('.sl-pill[data-pill="executor"]').hidden).toBe(false);
		expect(pillText("executor")).toBe(COPY.executor.detached);
		expect(pillClass("executor")).toContain("sl-pill--warn");
	});
});

describe("rows, clocks and eval (§4.4 items 1–3, §5.5, §5.9)", () => {
	it("mirrors the rows by myColor and flips the rail", async () => {
		h = await mountLive(dom.sim, liveSnapshot({ myColor: "w" }));
		const rows = h.qa(".sl-live__row");
		expect(rows.map((r) => r.dataset.row)).toEqual(["opponent", "me"]);
		expect(rows.map((r) => r.dataset.color)).toEqual(["b", "w"]);
		expect(h.q('.sl-live__row[data-row="opponent"] .sl-live__name').textContent).toBe("IM_Pawnstar");
		expect(h.q('.sl-live__row[data-row="opponent"] .sl-live__rating').textContent).toBe("1843");
		expect(h.q('.sl-live__row[data-row="me"] .sl-live__name').textContent).toBe(COPY_LIVE.you);
		expect(h.q(".sl-evalbar").classList.contains("sl-evalbar--flipped")).toBe(false);
		expect(h.q(".sl-evalbar").getAttribute("role")).toBe("meter");
		h.store.emit(
			liveSnapshot({
				myColor: "b",
				sideToMove: "b",
				recommendation: makeRecommendation({ fen: FEN_B }),
			})
		);
		const flipped = h.qa(".sl-live__row");
		expect(flipped.map((r) => r.dataset.color)).toEqual(["w", "b"]);
		expect(h.q(".sl-evalbar").classList.contains("sl-evalbar--flipped")).toBe(true);
	});

	it("active clock styling, caret on the side to move, <20 s danger, unknown clocks", async () => {
		h = await mountLive(dom.sim, liveSnapshot({ myColor: "w", sideToMove: "w" }));
		const me = h.q('.sl-live__row[data-row="me"]');
		const opp = h.q('.sl-live__row[data-row="opponent"]');
		expect(me.dataset.active).toBe("true");
		expect(opp.dataset.active).toBe("false");
		expect(me.querySelector(".sl-clock")?.getAttribute("data-state")).toBe("active");
		expect(me.querySelector(".sl-clock__time")?.textContent).toBe("03:12");
		expect(opp.querySelector(".sl-clock")?.getAttribute("data-state")).toBe("inactive");
		expect(opp.querySelector(".sl-clock__time")?.textContent).toBe("02:58");
		expect(me.querySelector<HTMLElement>(".sl-live__caret")?.hidden).toBe(false);
		expect(opp.querySelector<HTMLElement>(".sl-live__caret")?.hidden).toBe(true);
		h.store.emit(
			liveSnapshot({
				sideToMove: "w",
				clocks: { w: { ms: 15_000, running: true }, b: { ms: 15_000, running: false } },
			})
		);
		expect(me.querySelector(".sl-clock")?.getAttribute("data-state")).toBe("low");
		expect(opp.querySelector(".sl-clock")?.getAttribute("data-state")).toBe("inactive");
		h.store.emit(liveSnapshot({ clocks: null }));
		expect(me.querySelector(".sl-clock")?.getAttribute("data-state")).toBe("unknown");
		expect(me.querySelector(".sl-clock__tenths")?.textContent).toBe(COPY.clock.unavailable);
	});

	it("eval numeral: sign always shown, mates as M5 / −M3, WDL from White's point of view", async () => {
		h = await mountLive(dom.sim, liveSnapshot());
		expect(h.q(".sl-live__eval-score").textContent).toBe("+1.34");
		expect(h.q('.sl-live__wdl [data-wdl="w"]').textContent).toBe("W 71");
		expect(h.q('.sl-live__wdl [data-wdl="d"]').textContent).toBe("D 22");
		expect(h.q('.sl-live__wdl [data-wdl="l"]').textContent).toBe("L 7");
		expect(h.q(".sl-evalbar").getAttribute("aria-valuetext")).toBe(
			COPY.eval.valueText(`${COPY.eval.whiteName} +1.34`, 71, 22, 7)
		);
		// Black to move: the engine's side-to-move score flips to White's point of view.
		h.store.emit(
			liveSnapshot({
				myColor: "b",
				sideToMove: "b",
				recommendation: makeRecommendation({ fen: FEN_B, eval: { cp: 134 }, wdl: [710, 220, 70] }),
			})
		);
		expect(h.q(".sl-live__eval-score").textContent).toBe("−1.34");
		expect(h.q('.sl-live__wdl [data-wdl="w"]').textContent).toBe("W 7");
		h.store.emit(liveSnapshot({ recommendation: makeRecommendation({ eval: { mate: 5 } }) }));
		expect(h.q(".sl-live__eval-score").textContent).toBe("M5");
		h.store.emit(
			liveSnapshot({
				myColor: "b",
				sideToMove: "b",
				recommendation: makeRecommendation({ fen: FEN_B, eval: { mate: -3 } }),
			})
		);
		expect(h.q(".sl-live__eval-score").textContent).toBe("M3"); // Black is mated in 3 → White mates
		h.store.emit(liveSnapshot({ recommendation: makeRecommendation({ eval: { mate: -3 } }) }));
		expect(h.q(".sl-live__eval-score").textContent).toBe("−M3");
		h.store.emit(liveSnapshot({ recommendation: makeRecommendation({ eval: { cp: 0 } }) }));
		expect(h.q(".sl-live__eval-score").textContent).toBe("0.00");
	});
});

describe("move card states (§5.6)", () => {
	it("your-move, opponent-to-move with the expected reply, thinking, armed, disabled", async () => {
		h = await mountLive(dom.sim, liveSnapshot());
		const card = h.q(".sl-move");
		expect(card.dataset.state).toBe("your-move");
		expect(card.querySelector(".sl-move__header")?.textContent).toBe(
			COPY.move.headerYours(COPY.move.white)
		);
		expect(card.querySelector(".sl-move__san")?.textContent).toBe("Nf3");
		expect(card.querySelector(".sl-move__uci")?.textContent).toBe("g1 → f3");
		expect(card.classList.contains("sl-move--armed")).toBe(false);
		expect(card.querySelector<HTMLElement>(".sl-move__plan")?.hidden).toBe(true);

		h.store.emit(liveSnapshot({ state: "live:opponent-turn", sideToMove: "b" }));
		await dom.tick(0); // the SAN exits up, then the reply enters (§6.3)
		expect(card.dataset.state).toBe("opponent");
		expect(card.classList.contains("sl-move--opponent")).toBe(true);
		expect(card.querySelector(".sl-move__header")?.textContent).toBe(COPY.move.headerTheirs);
		expect(card.querySelector(".sl-move__san")?.textContent).toBe("Nc6"); // expected reply

		h.store.emit(liveSnapshot({ state: "live:my-turn:analysing", recommendation: null }));
		expect(card.dataset.state).toBe("thinking");
		expect(card.querySelector(".sl-move__header")?.textContent).toBe(COPY.move.thinking);

		// The colour's third value: the page has not said which side we are, or the adapter withdrew the
		// answer it gave after the site contradicted it. The card must not name a side — `headerYours`
		// would read a null colour as white — and must not pretend a move is coming, because with no
		// colour the session plans nothing at all (review R2-1).
		h.store.emit(liveSnapshot({ myColor: null, recommendation: null }));
		expect(card.dataset.state).toBe("colour-unknown");
		expect(card.querySelector(".sl-move__header")?.textContent).toBe(COPY.waiting.reading);
		expect(card.querySelector(".sl-move__san")?.textContent).toBe("");
		// no inert control offered either: the play button stays disabled, as it is for every state
		// that is not our move
		expect(playButton().getAttribute("aria-disabled")).toBe("true");

		h.store.emit(
			liveSnapshot({
				autoMove: { armed: true, scheduledAt: Date.now() + THINK_MS, plan: makeRecommendation().plan },
			})
		);
		expect(card.dataset.state).toBe("your-move");
		expect(card.classList.contains("sl-move--armed")).toBe(true);
		expect(card.querySelector<HTMLElement>(".sl-move__plan")?.hidden).toBe(false);
		expect(card.querySelector(".sl-move__plan-text")?.textContent).toBe(
			COPY.move.plan("4.2", COPY.execution.drag, false)
		);

		h.store.emit(liveSnapshot({ settings: { enabled: false } }));
		expect(card.dataset.state).toBe("disabled");
		expect(card.querySelector(".sl-move__header")?.textContent).toBe(COPY.move.disabled);

		h.store.emit(liveSnapshot({ engine: { state: "crashed" } }));
		expect(card.dataset.state).toBe("engine-stopped");
	});

	it("unarmed on my turn: the note says which key arms the hand, not nothing", async () => {
		// auto-play ships off, so this is what a fresh install sees on its first turn: the play
		// button is disabled and the card must say why rather than looking dead.
		h = await mountLive(dom.sim, liveSnapshot());
		const note = h.q(".sl-move__note");
		expect(note.hidden).toBe(false);
		expect(note.textContent).toBe(COPY.move.noteUnarmed("Shift+A"));
		h.store.emit(
			liveSnapshot({
				autoMove: { armed: true, scheduledAt: Date.now() + THINK_MS, plan: makeRecommendation().plan },
			})
		);
		// armed: the informational notes get the line back
		expect(h.q(".sl-move__note").textContent).not.toBe(COPY.move.noteUnarmed("Shift+A"));
	});

	it("play button: disabled until armed → Play move → Auto-playing in 4.2s → hover Cancel this move → Playing…; flash on executed", async () => {
		h = await mountLive(dom.sim, idleSnapshot());
		// §13.4: the hand plays only once armed (the debugger attaches at arm time, never
		// mid-game) — until then the button is a label and a keybind hint.
		expect(playLabel()).toBe(COPY.move.play);
		expect(playButton().getAttribute("aria-disabled")).toBe("true");
		click(playButton());
		expect(h.store.calls).toEqual([]);

		const plan = makeRecommendation().plan;
		h.store.emit(idleSnapshot({ autoMove: { armed: true } }));
		expect(playButton().getAttribute("aria-disabled")).toBeNull();
		click(playButton());
		expect(h.store.calls).toEqual([{ type: MSG.PANEL_PLAY_NOW, tabId: h.tabId }]);

		h.store.emit(
			idleSnapshot({ autoMove: { armed: true, scheduledAt: Date.now() + THINK_MS, plan } })
		);
		expect(playLabel()).toBe(COPY.move.armed("4.2"));
		expect(playButton().classList.contains("sl-button--armed")).toBe(true);
		await dom.tick(1000);
		expect(playLabel()).toBe(COPY.move.armed("3.2"));
		pointer(playButton(), "pointerenter");
		expect(playLabel()).toBe(COPY.move.cancel);
		await dom.tick(500);
		expect(playLabel()).toBe(COPY.move.cancel); // paused visual while hovering
		pointer(playButton(), "pointerleave");
		await dom.tick(100);
		expect(playLabel()).toBe(COPY.move.armed("2.6"));
		await dom.tick(2000);
		expect(playLabel()).toBe(COPY.move.armed("1")); // whole seconds at ≤ 1 s

		// Cancel-on-click skips the move; auto-play stays armed.
		pointer(playButton(), "pointerenter");
		click(playButton());
		expect(h.store.calls.at(-1)).toEqual({ type: MSG.PANEL_CANCEL_PENDING, tabId: h.tabId });
		expect(h.toasts()).toHaveLength(0); // only once the SW confirmed the skip
		await dom.tick(0);
		expect(h.toasts()[0]?.querySelector(".sl-toast__text")?.textContent).toBe(
			COPY.toast.skipped("Nf3")
		);
		pointer(playButton(), "pointerleave");

		// Executing → "Playing…"; executed → card flash + opponent state. The "Played …" toast is
		// the service worker's (a `toast` port message), not this view's.
		h.store.emit(liveSnapshot({ state: "live:my-turn:executing", autoMove: { armed: true, plan } }));
		expect(playLabel()).toBe(COPY.move.executing);
		expect(playButton().getAttribute("aria-busy")).toBe("true");
		h.store.emit(
			liveSnapshot({
				state: "live:opponent-turn",
				sideToMove: "b",
				autoMove: { armed: true },
				lastExecution: {
					ok: true,
					outcome: "executed",
					tier: "drag",
					attempts: 1,
					endPoint: { x: 0, y: 0 },
					elapsedMs: 3900,
					timeline: [],
				},
			})
		);
		await dom.tick(0);
		expect(h.toasts().filter((t) => t.classList.contains("sl-toast--success"))).toHaveLength(0);
		expect(h.q(".sl-move").classList.contains("sl-move--played")).toBe(true);
		expect(h.q(".sl-move").dataset.state).toBe("opponent");
	});

	it("the same execution across snapshots flashes once; a new one (by `at` or ply) flashes again", async () => {
		h = await mountLive(dom.sim, idleSnapshot());
		const executed = (
			at: number | undefined
		): NonNullable<ReturnType<typeof idleSnapshot>["session"]["lastExecution"]> => {
			const e: NonNullable<ReturnType<typeof idleSnapshot>["session"]["lastExecution"]> = {
				ok: true,
				outcome: "executed",
				tier: "drag",
				attempts: 1,
				endPoint: { x: 0, y: 0 },
				elapsedMs: 3900,
				timeline: [{ phase: "drag", startMs: 0, endMs: 300 }],
			};
			if (at !== undefined) e.at = at;
			return e;
		};
		// §6.3: the card's border flash is what a played move shows here (the toast is the SW's).
		const flashing = (): boolean => h?.q(".sl-move").classList.contains("sl-move--played") ?? false;
		const flashEnds = async (): Promise<void> => {
			await dom.tick(TOKENS.motion.durationMs[4] + 1);
			expect(flashing()).toBe(false);
		};
		// Snapshots are fresh objects every push: the same result must not re-fire.
		h.store.emit(idleSnapshot({ lastExecution: executed(1000) }));
		expect(flashing()).toBe(true);
		await flashEnds();
		h.store.emit(idleSnapshot({ lastExecution: executed(1000) }));
		h.store.emit(idleSnapshot({ lastExecution: executed(1000) }));
		expect(flashing()).toBe(false);
		h.store.emit(idleSnapshot({ lastExecution: executed(2000) }));
		expect(flashing()).toBe(true);
		await flashEnds();
		// An `at` id survives ply changes: the same result recorded at ply N persists while the
		// board moves on (N+1 my move, N+2 the reply) and must not re-fire.
		let ply = idleSnapshot().session.ply;
		for (let i = 0; i < 2; i += 1) {
			ply += 1;
			const later = idleSnapshot({ lastExecution: executed(2000) });
			later.session.ply = ply;
			h.store.emit(later);
			expect(flashing()).toBe(false);
		}
		// Without `at`: structural identity, cleared by a ply change.
		h.store.emit(idleSnapshot({ lastExecution: executed(undefined) }));
		expect(flashing()).toBe(true);
		await flashEnds();
		h.store.emit(idleSnapshot({ lastExecution: executed(undefined) }));
		expect(flashing()).toBe(false);
		const next = idleSnapshot({ lastExecution: executed(undefined) });
		next.session.ply += 2;
		h.store.emit(next);
		expect(flashing()).toBe(true);
	});

	it("Esc cancels the countdown; the play keybind plays now; port toasts surface", async () => {
		h = await mountLive(
			dom.sim,
			idleSnapshot({
				autoMove: { armed: true, scheduledAt: Date.now() + THINK_MS, plan: makeRecommendation().plan },
			})
		);
		expect(playLabel()).toBe(COPY.move.armed("4.2"));
		key(document, "keydown", { key: "Escape", code: "Escape" });
		expect(h.store.calls.at(-1)).toEqual({ type: MSG.PANEL_CANCEL_PENDING, tabId: h.tabId });
		await dom.tick(0); // the skip is confirmed → "Skipped Nf3 · auto-play stays on"
		expect(h.toasts()[0]?.querySelector(".sl-toast__text")?.textContent).toBe(
			COPY.toast.skipped("Nf3")
		);
		key(document, "keydown", { key: " ", code: "Space" });
		expect(h.store.calls.at(-1)).toEqual({ type: MSG.PANEL_PLAY_NOW, tabId: h.tabId });
		// Port toasts name a `TOAST_KEYS` key; the copy (and the drag/click wording) is resolved here.
		h.store.port({ kind: "toast", level: "warn", key: TOAST_KEYS.notVerified });
		await dom.tick(0); // the skipped toast leaves
		expect(h.toasts()).toHaveLength(1);
		expect(h.toasts()[0]?.classList.contains("sl-toast--warn")).toBe(true);
		expect(h.toasts()[0]?.querySelector(".sl-toast__text")?.textContent).toBe(COPY.toast.notVerified);
		h.store.port({
			kind: "toast",
			level: "info",
			key: TOAST_KEYS.played,
			args: { san: "Nf3", elapsedMs: 3900 },
		});
		await dom.tick(0);
		expect(h.toasts()).toHaveLength(1);
		expect(h.toasts()[0]?.querySelector(".sl-toast__text")?.textContent).toBe(COPY.toast.notVerified);
	});
});

describe("lines (§5.7)", () => {
	it("row count from settings, stripe colours by index, hover previews, click pins", async () => {
		h = await mountLive(dom.sim, idleSnapshot());
		expect(h.q(".sl-live__lines-title").textContent).toBe(COPY.lines.header);
		expect(h.q(".sl-live__count").textContent).toBe("3");
		let rows = h.qa(".sl-pv");
		expect(rows).toHaveLength(3);
		expect(rows.map((r) => r.dataset.index)).toEqual(["1", "2", "3"]);
		expect(rows[0]?.querySelector(".sl-pv__score")?.textContent).toBe("+1.34");
		expect(rows[0]?.querySelector(".sl-pv__moves")?.textContent).toBe("Nf3 Nc6 Bb5");
		for (const n of ["", "-2", "-3"]) expect(LIVE_CSS).toContain(`--sl-color-hl-arrow${n}`);
		h.store.emit(
			idleSnapshot({
				settings: {
					...idleSnapshot().settings,
					display: { ...idleSnapshot().settings.display, pvCount: 2 },
				},
			})
		);
		rows = h.qa(".sl-pv");
		expect(rows).toHaveLength(2);
		expect(h.q(".sl-live__count").textContent).toBe("2");
		h.store.emit(idleSnapshot());
		rows = h.qa(".sl-pv");
		const second = rows[1];
		if (!second) throw new Error("no row 2");
		pointer(second, "pointerover");
		expect(h.store.calls.at(-1)).toEqual({
			type: MSG.PANEL_PREVIEW_LINE,
			tabId: h.tabId,
			multipv: 2,
		});
		pointer(second, "pointerout");
		expect(h.store.calls.at(-1)).toEqual({
			type: MSG.PANEL_PREVIEW_LINE,
			tabId: h.tabId,
			multipv: null,
		});
		click(second);
		expect(second.getAttribute("aria-pressed")).toBe("true");
		expect(h.store.calls.at(-1)).toEqual({
			type: MSG.PANEL_PREVIEW_LINE,
			tabId: h.tabId,
			multipv: 2,
		});
		// Pinned: leaving the row keeps the preview.
		pointer(second, "pointerover");
		pointer(second, "pointerout");
		expect(h.store.calls.at(-1)).toEqual({
			type: MSG.PANEL_PREVIEW_LINE,
			tabId: h.tabId,
			multipv: 2,
		});
		click(second);
		expect(second.getAttribute("aria-pressed")).toBe("false");
		expect(h.store.calls.at(-1)).toEqual({
			type: MSG.PANEL_PREVIEW_LINE,
			tabId: h.tabId,
			multipv: null,
		});
		// No lines: the empty row.
		h.store.emit(idleSnapshot({ recommendation: null }));
		expect(h.qa(".sl-pv")).toHaveLength(0);
		expect(h.q(".sl-pv-list__empty").hidden).toBe(false);
	});

	it("the count chip opens the 1–5 stepper and writes display.pvCount", async () => {
		h = await mountLive(dom.sim, idleSnapshot());
		click(h.q(".sl-live__count"));
		const pop = document.querySelector<HTMLElement>(".sl-popover");
		expect(pop).not.toBeNull();
		const chips = [...(pop?.querySelectorAll<HTMLElement>(".sl-chip") ?? [])];
		expect(chips.map((c) => c.textContent?.trim())).toEqual(["1", "2", "3", "4", "5"]);
		const five = chips[4];
		if (five) click(five);
		await dom.tick(0);
		const settings = await chromeLocalGet(LOCAL_KEYS.settings);
		expect(settings?.display.pvCount).toBe(5);
	});
});

describe("strength card (§4.4 item 7, §5.12)", () => {
	it("shows Elo · band · persona; the popover applies setSettings and says Applies from next move", async () => {
		h = await mountLive(dom.sim, idleSnapshot());
		expect(h.q(".sl-live__strength-elo").textContent).toBe("1500");
		expect(h.q(".sl-live__strength-label").textContent).toBe(
			`${COPY.strength.bands.expert} · ${COPY.personaName.balanced}`
		);
		click(h.q(".sl-live__strength-open"));
		const pop = document.querySelector<HTMLElement>(".sl-popover");
		expect(pop).not.toBeNull();
		expect(pop?.querySelector(".sl-popover__footer")?.textContent).toBe(COPY.strength.popoverFooter);
		expect(document.activeElement).toBe(document.body);
		const thumb = pop?.querySelector<HTMLElement>('[role="slider"]');
		expect(thumb?.getAttribute("aria-valuemin")).toBe("400");
		expect(thumb?.getAttribute("aria-valuemax")).toBe(String(LIMITS.eloMax));
		expect(pop?.querySelector<HTMLElement>(".sl-slider__divider")?.dataset.value).toBe(
			String(LIMITS.nnueSmallEloMax)
		);
		expect(thumb?.getAttribute("aria-valuenow")).toBe("1500");
		if (thumb) key(thumb, "keydown", { key: "ArrowRight", code: "ArrowRight" });
		await dom.tick(0);
		expect((await chromeLocalGet(LOCAL_KEYS.settings))?.strength.targetElo).toBe(1550);
		const chips = [...(pop?.querySelectorAll<HTMLElement>(".sl-chip") ?? [])];
		expect(chips).toHaveLength(4);
		const aggressive = chips.find((c) => c.dataset.value === "aggressive");
		if (aggressive) click(aggressive);
		await dom.tick(0);
		expect((await chromeLocalGet(LOCAL_KEYS.settings))?.strength.persona).toBe("aggressive");
		const mode = pop?.querySelector<HTMLElement>('.sl-segment__item[data-value="engine-elo"]');
		if (mode) click(mode);
		await dom.tick(0);
		expect((await chromeLocalGet(LOCAL_KEYS.settings))?.strength.selectionMode).toBe("engine-elo");
		// The card follows the snapshot, not the popover.
		h.store.emit(
			idleSnapshot({
				settings: {
					...idleSnapshot().settings,
					strength: { ...idleSnapshot().settings.strength, targetElo: 2650, persona: "blitz" },
				},
			})
		);
		expect(h.q(".sl-live__strength-elo").textContent).toBe("2650");
		expect(h.q(".sl-live__strength-label").textContent).toBe(
			`${COPY.strength.bands.elite} · ${COPY.personaName.blitz}`
		);
		key(document, "keydown", { key: "Escape", code: "Escape" });
		await dom.tick(0);
		expect(document.querySelector('.sl-popover[data-state="open"]')).toBeNull();
	});
});

describe("toggles row (§6.1)", () => {
	const toggle = (name: string): HTMLElement => {
		if (!h) throw new Error("no harness");
		return h.q(`.sl-toggle[data-toggle="${name}"]`);
	};

	it("auto-play arms after a 600 ms hold (not 400), disarms on one click, banner once", async () => {
		h = await mountLive(dom.sim, idleSnapshot());
		const t = toggle("autoplay");
		expect(t.querySelector(".sl-toggle__label")?.textContent).toBe(COPY.toggle.autoplay);
		pointer(t, "pointerdown", { pointerId: 1, isPrimary: true });
		expect(t.querySelector(".sl-toggle__label")?.textContent).toBe(COPY.toggle.arming);
		await dom.tick(400);
		pointer(t, "pointerup", { pointerId: 1, isPrimary: true });
		click(t);
		expect(h.store.calls).toEqual([]);
		expect(t.getAttribute("aria-checked")).toBe("false");
		// The once-per-session hint after an early release.
		expect(document.querySelector(".sl-popover--tooltip")?.textContent).toBe(COPY.toggle.armTooltip);

		pointer(t, "pointerdown", { pointerId: 1, isPrimary: true });
		await dom.tick(UI_TIMINGS.armHoldMs);
		pointer(t, "pointerup", { pointerId: 1, isPrimary: true });
		click(t);
		expect(t.getAttribute("aria-checked")).toBe("true");
		expect(t.querySelector(".sl-toggle__label")?.textContent).toBe(COPY.toggle.armed);
		expect(h.store.calls).toEqual([{ type: MSG.PANEL_SET_AUTO_MOVE, tabId: h.tabId, armed: true }]);
		expect(currentBannerKind()).toBe("warn");
		expect(h.banners()[0]?.textContent).toContain(COPY.banner.debugger);

		click(t);
		expect(t.getAttribute("aria-checked")).toBe("false");
		expect(h.store.calls.at(-1)).toEqual({
			type: MSG.PANEL_SET_AUTO_MOVE,
			tabId: h.tabId,
			armed: false,
		});

		// Disarming during a countdown toasts the move that will not be played.
		h.store.emit(
			idleSnapshot({
				autoMove: { armed: true, scheduledAt: Date.now() + THINK_MS, plan: makeRecommendation().plan },
			})
		);
		expect(t.getAttribute("aria-checked")).toBe("true");
		click(t);
		expect(h.toasts()[0]?.querySelector(".sl-toast__text")?.textContent).toBe(
			COPY.toast.disarmed("Nf3")
		);
	});

	it("highlight and auto-queue write settings; the row reflects snapshots", async () => {
		const mounted = idleSnapshot();
		h = await mountLive(dom.sim, mounted);
		// each toggle writes the opposite of the value it was mounted with (whatever ships by default)
		const wantHighlight = !mounted.settings.automation.highlightMoves;
		const wantQueue = !mounted.settings.automation.autoQueue;
		click(toggle("highlight"));
		await dom.tick(0);
		expect((await chromeLocalGet(LOCAL_KEYS.settings))?.automation.highlightMoves).toBe(
			wantHighlight
		);
		click(toggle("autoqueue"));
		await dom.tick(0);
		expect((await chromeLocalGet(LOCAL_KEYS.settings))?.automation.autoQueue).toBe(wantQueue);
		h.store.emit(
			idleSnapshot({
				settings: {
					...idleSnapshot().settings,
					automation: { ...idleSnapshot().settings.automation, highlightMoves: true, autoQueue: false },
				},
			})
		);
		expect(toggle("highlight").getAttribute("aria-checked")).toBe("true");
		expect(toggle("autoqueue").getAttribute("aria-checked")).toBe("false");
	});

	it("keybind pre-arm: toast with a 1 s cancel window; second press cancels; armed → instant disarm", async () => {
		h = await mountLive(dom.sim, idleSnapshot());
		key(document, "keydown", { key: "A", code: "KeyA", shiftKey: true });
		const toast = h.toasts()[0];
		expect(toast?.querySelector(".sl-toast__text")?.textContent).toBe(COPY.toast.preArm("Shift+A"));
		expect(toast?.querySelector(".sl-toast__action .sl-button__label")?.textContent).toBe(
			COPY_LIVE.cancel
		);
		const ring = toast?.querySelector(".sl-ring .sl-ring__progress");
		expect(ring).not.toBeNull(); // §6.1 step 5: the toast carries a ring
		expect(Number(ring?.getAttribute("stroke-dashoffset"))).toBeCloseTo(0, 6);
		await dom.tick(UI_TIMINGS.preArmMs / 2);
		expect(Number(ring?.getAttribute("stroke-dashoffset"))).toBeGreaterThan(0);
		await dom.tick(UI_TIMINGS.preArmMs / 2 - 1);
		expect(h.store.calls).toEqual([]);
		await dom.tick(1);
		expect(h.store.calls).toEqual([{ type: MSG.PANEL_SET_AUTO_MOVE, tabId: h.tabId, armed: true }]);
		await dom.tick(0);
		expect(h.toasts()).toHaveLength(0); // the pre-arm toast leaves when it fires

		h.store.emit(idleSnapshot());
		key(document, "keydown", { key: "A", code: "KeyA", shiftKey: true });
		await dom.tick(500);
		key(document, "keydown", { key: "A", code: "KeyA", shiftKey: true });
		await dom.tick(UI_TIMINGS.preArmMs);
		expect(h.store.calls).toHaveLength(1); // cancelled

		h.store.emit(idleSnapshot());
		key(document, "keydown", { key: "A", code: "KeyA", shiftKey: true });
		const action = h.toasts()[0]?.querySelector<HTMLElement>(".sl-toast__action .sl-button");
		if (action) click(action);
		await dom.tick(UI_TIMINGS.preArmMs);
		expect(h.store.calls).toHaveLength(1); // the toast action cancels too

		h.store.emit(idleSnapshot({ autoMove: { armed: true } }));
		key(document, "keydown", { key: "A", code: "KeyA", shiftKey: true });
		expect(h.store.calls.at(-1)).toEqual({
			type: MSG.PANEL_SET_AUTO_MOVE,
			tabId: h.tabId,
			armed: false,
		});
		// A bare "a" without Shift is not the keybind.
		h.store.emit(idleSnapshot());
		key(document, "keydown", { key: "a", code: "KeyA" });
		await dom.tick(UI_TIMINGS.preArmMs);
		expect(h.store.calls).toHaveLength(2);
	});
});

describe("session strip and detached banner (§4.4 item 9, §13.6, §9.7)", () => {
	it("stats, band check against the derived target, warning after three games", async () => {
		h = await mountLive(dom.sim, idleSnapshot({ stats: { top1Pct: 48, acpl: 52 } }));
		expect(h.q(".sl-live__stats").textContent).toBe(COPY.session(6, 48, "3.1"));
		expect(h.q(".sl-live__band").textContent).toBe(COPY_LIVE.band.stats(48, 52));
		expect(h.q(".sl-live__band").dataset.band).toBe("in"); // 1893 → the 1600 knot: 47–53 %, 45–60
		expect(h.q(".sl-live__band").getAttribute("title")).toBe(COPY_LIVE.band.target(47, 53, 45, 60));
		expect(h.q(".sl-live__band-warning").hidden).toBe(true);
		h.store.emit(idleSnapshot({ stats: { top1Pct: 70, acpl: 20, outOfBandStreak: 2 } }));
		expect(h.q(".sl-live__band").dataset.band).toBe("out");
		expect(h.q(".sl-live__band-warning").hidden).toBe(true);
		h.store.emit(idleSnapshot({ stats: { top1Pct: 70, acpl: 20, outOfBandStreak: 3 } }));
		expect(h.q(".sl-live__band-warning").hidden).toBe(false);
		expect(h.q(".sl-live__band-warning").textContent).toBe(COPY_LIVE.band.warning(3));
		// Without an opponent the slider value is the target; without stats no band line.
		h.store.emit(idleSnapshot({ opponent: null, stats: {} }));
		expect(h.q(".sl-live__band").hidden).toBe(true);
		expect(h.q(".sl-live__stats").textContent).toBe(COPY_LIVE.sessionNoStats(6, "3.1"));
	});

	it("detached banner with Reattach and Dismiss, outside hands-off only", async () => {
		h = await mountLive(
			dom.sim,
			idleSnapshot({ autoMove: { armed: true }, executor: { debuggerAttached: true } })
		);
		expect(currentBannerKind()).toBeNull();
		h.store.emit(
			idleSnapshot({
				autoMove: { armed: false },
				executor: { debuggerAttached: false },
				hand: "detached",
			})
		);
		expect(currentBannerKind()).toBe("warn");
		const banner = h.banners()[0];
		expect(banner?.querySelector(".sl-banner__text")?.textContent).toBe(COPY.banner.detached);
		const buttons = [
			...(banner?.querySelectorAll<HTMLElement>(".sl-banner__actions .sl-button") ?? []),
		];
		expect(buttons.map((b) => b.querySelector(".sl-button__label")?.textContent)).toEqual([
			COPY.banner.reattach,
			COPY.banner.dismiss,
		]);
		const reattach = buttons[0];
		if (reattach) click(reattach);
		expect(h.store.calls.at(-1)).toEqual({ type: MSG.PANEL_REATTACH_DEBUGGER, tabId: h.tabId });
		await dom.tick(0);
		expect(currentBannerKind()).toBeNull();
		// Detached again: Dismiss hides it until the next attach/detach cycle.
		h.store.emit(idleSnapshot({ executor: { debuggerAttached: true } }));
		h.store.emit(idleSnapshot({ executor: { debuggerAttached: false }, hand: "detached" }));
		expect(currentBannerKind()).toBe("warn");
		const dismiss = h
			.banners()[0]
			?.querySelectorAll<HTMLElement>(".sl-banner__actions .sl-button")[1];
		if (dismiss) click(dismiss);
		await dom.tick(0);
		expect(currentBannerKind()).toBeNull();
		h.store.emit(idleSnapshot({ executor: { debuggerAttached: false }, hand: "detached" }));
		expect(currentBannerKind()).toBeNull();
		// A live game never shows it (hands-off).
		h.store.emit(liveSnapshot({ executor: { debuggerAttached: true } }));
		h.store.emit(liveSnapshot({ executor: { debuggerAttached: false }, hand: "detached" }));
		expect(currentBannerKind()).toBeNull();
	});
});

describe("hands-off exit", () => {
	it("restores every control's previous aria-disabled / tabindex (mirrors the shell)", async () => {
		// Armed throughout: the play button carries its own `aria-disabled` while the hand is
		// unarmed (§13.4), which the hands-off restore must not be blamed for.
		h = await mountLive(dom.sim, idleSnapshot({ autoMove: { armed: true } }));
		const count = h.q(".sl-live__count");
		count.setAttribute("tabindex", "0"); // a control that had its own tabindex
		const row = h.qa(".sl-pv")[0];
		expect(row?.hasAttribute("tabindex")).toBe(false);
		h.store.emit(liveSnapshot({ autoMove: { armed: true } }));
		expect(count.getAttribute("tabindex")).toBe("-1");
		expect(count.getAttribute("aria-disabled")).toBe("true");
		expect(h.qa(".sl-pv")[0]?.getAttribute("tabindex")).toBe("-1");
		h.store.emit(idleSnapshot({ autoMove: { armed: true } }));
		expect(count.getAttribute("tabindex")).toBe("0");
		expect(count.hasAttribute("aria-disabled")).toBe(false);
		for (const el of h.qa(INTERACTIVE_SELECTOR)) {
			expect({ el: el.className, tabindex: el.getAttribute("tabindex") }).not.toEqual({
				el: el.className,
				tabindex: "-1",
			});
			expect(el.getAttribute("aria-disabled")).toBeNull();
		}
		// The keyboard path is live again: Space plays.
		key(document, "keydown", { key: " ", code: "Space" });
		expect(h.store.calls.at(-1)).toEqual({ type: MSG.PANEL_PLAY_NOW, tabId: h.tabId });
	});
});

describe("cleanup", () => {
	it("unmount removes the DOM, timers and listeners", async () => {
		const baseline = dom.sim.time.pendingTimers();
		h = await mountLive(
			dom.sim,
			idleSnapshot({
				autoMove: { armed: true, scheduledAt: Date.now() + THINK_MS, plan: makeRecommendation().plan },
			})
		);
		const before = dom.sim.time.pendingTimers();
		expect(before).toBeGreaterThan(0);
		const content = h.content;
		const store = h.store;
		h.cleanup();
		expect(content.querySelector(".sl-live")).toBeNull();
		expect(dom.sim.time.pendingTimers()).toBe(baseline); // every view timer is gone
		key(document, "keydown", { key: " ", code: "Space" });
		key(document, "keydown", { key: "A", code: "KeyA", shiftKey: true });
		await dom.tick(UI_TIMINGS.preArmMs);
		store.emit(idleSnapshot());
		expect(store.calls).toEqual([]);
		expect(content.children).toHaveLength(0);
	});
});

it("the visible board shortcut guide follows custom keybindings", async () => {
	const snapshot = liveSnapshot();
	snapshot.settings.keybinds = {
		...snapshot.settings.keybinds,
		playMove: { ...snapshot.settings.keybinds.playMove, key: "f", code: "KeyF" },
		disable: { ...snapshot.settings.keybinds.disable, key: "q", code: "KeyQ" },
	};
	h = await mountLive(dom.sim, snapshot);
	expect(h.q('[data-shortcut="playMove"] kbd').textContent).toBe("F");
	expect(h.q('[data-shortcut="disable"] kbd').textContent).toBe("Shift+Q");
	expect(h.q(".sl-shortcuts").textContent).not.toContain("Shift+X");
});

it("keeps one evaluation chip anchored through recommendation gaps, turn changes and compact mode", async () => {
	const first = liveSnapshot();
	h = await mountLive(dom.sim, first);
	const chip = h.q(".sl-live__eval-chip");
	const slot = h.q(".sl-live__eval");
	expect(slot.parentElement).toBe(h.root);
	expect(slot.previousElementSibling?.classList.contains("sl-live__heading")).toBe(true);
	expect(chip.dataset.evaluation).toBe("current");
	for (const state of ["live:opponent-turn", "live:my-turn:analysing"] as const) {
		h.store.emit(
			liveSnapshot({
				state,
				sideToMove: state === "live:opponent-turn" ? "b" : "w",
				recommendation: null,
			})
		);
		expect(h.q(".sl-live__eval-chip")).toBe(chip);
		expect(slot.hidden).toBe(false);
		expect(h.q(".sl-live__eval-score").textContent).toBe("+1.34");
		expect(chip.dataset.evaluation).toBe("cached");
		expect(chip.getAttribute("aria-label")).toContain("Last evaluation");
		expect(h.q(".sl-live__eval-label").textContent).toBe(COPY.eval.cachedLabel);
		expect(slot.previousElementSibling?.classList.contains("sl-live__heading")).toBe(true);
	}
	const nextGame = liveSnapshot({ recommendation: null });
	nextGame.session.gameId = "g2";
	h.store.emit(nextGame);
	expect(h.q(".sl-live__eval-score").textContent).toBe(COPY.eval.pending);
	expect(chip.dataset.evaluation).toBe("pending");
	expect(slot.hidden).toBe(false);
	h.store.emit(
		liveSnapshot({ settings: { display: { ...first.settings.display, evalBar: false } } })
	);
	expect(slot.hidden).toBe(true);
	h.store.emit(first);
	expect(slot.hidden).toBe(false);
	expect(h.q(".sl-live__eval-score").textContent).toBe("+1.34");
});

it("updates the fixed evaluation chip from current-position pondering in White's POV", async () => {
	h = await mountLive(dom.sim, liveSnapshot());
	const chip = h.q(".sl-live__eval-chip");
	const opponent = liveSnapshot({ state: "live:opponent-turn", sideToMove: "b" });
	opponent.session.evaluation = { fen: FEN_B, eval: { cp: -280 }, wdl: [100, 200, 700] };
	h.store.emit(opponent);
	expect(h.q(".sl-live__eval-chip")).toBe(chip);
	expect(h.q(".sl-live__eval-score").textContent).toBe("+2.80");
	expect(chip.dataset.evaluation).toBe("current");
	expect(h.q(".sl-live__eval-label").textContent).toBe(COPY.eval.label);
	expect(h.q('[data-wdl="w"]').textContent).toBe("W 70");
	expect(h.q('[data-wdl="l"]').textContent).toBe("L 10");
	const analysing = liveSnapshot({ state: "live:my-turn:analysing", recommendation: null });
	analysing.session.evaluation = { fen: makeRecommendation().fen, eval: { cp: 310 } };
	h.store.emit(analysing);
	expect(h.q(".sl-live__eval-score").textContent).toBe("+3.10");
	expect(chip.dataset.evaluation).toBe("current");
	delete analysing.session.evaluation;
	h.store.emit(analysing);
	expect(h.q(".sl-live__eval-score").textContent).toBe("+3.10");
	expect(chip.dataset.evaluation).toBe("cached");
});
