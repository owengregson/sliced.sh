/**
 * What the session draws on the page: the recommendation's board mark (native, or the bridge's own
 * overlay while the hand acts), the virtual-cursor mirror, and the content-script settings that
 * gate both (§13.3 rule 4). Each post is unconditional where the page, not this worker, is the
 * only truth about what is drawn.
 */

import type { GamePortCommand } from "@core/constants/messages";
import type { Recommendation } from "@typedefs/game";
import type { SessionCore } from "./core";

export class BoardMarks {
	/**
	 * The recommendation whose mark is currently drawn through the bridge's own SVG overlay
	 * (`markForExecution`), so the re-post happens once per mark and not on every hand-state
	 * change. Reset by `clear` — after a clear there is no mark of ours at all — and by any
	 * ordinary `highlight`.
	 */
	private markedOverlayFor: Recommendation | null = null;

	constructor(private readonly core: SessionCore) {}

	private post(cmd: GamePortCommand): void {
		this.core.deps.link.post(this.core.tabId, cmd);
	}

	/** Content-script settings that gate what it may draw (§13.3 rule 4). */
	pushContentSettings(): void {
		const core = this.core;
		const settings = core.settings();
		const commands: GamePortCommand[] = [
			// §4.4: the master switch gates the board marks too — and because the content script
			// clears what it has drawn the moment this turns off, this is also the clear. The same
			// holds for the effect layer, which has its own element and its own clear: flipping
			// `boardEffects` or `moveQualityChips` off mid-game erases whatever it had drawn on the
			// next push. The two are independent (owner, 2026-09-15): the rating sounds follow the
			// ratings alone, never the rays.
			{
				kind: "settings",
				queueInput: core.mayQueue(),
				freeTitle:
					core.settingsKnown() && settings.enabled && settings.automation.freeTitle
						? settings.automation.freeTitleBadge
						: null,
				highlightMoves: core.mayAct() && settings.automation.highlightMoves,
				boardEffects: core.mayAct() && settings.automation.boardEffects,
				// The completed game's review stays visible after its controls become read-only.
				moveRatings: core.settingsKnown() && settings.enabled && settings.automation.moveQualityChips,
				moveRatingSounds:
					core.mayAct() && settings.automation.moveQualityChips && settings.automation.moveRatingSounds,
				forcedMateSounds:
					core.mayAct() &&
					settings.automation.moveQualityChips &&
					settings.automation.moveRatingSounds &&
					settings.automation.forcedMateSounds,
			},
			{ kind: "keybinds", keybinds: settings.keybinds },
		];
		for (const cmd of commands) this.post(cmd);
	}

	highlight(rec: Recommendation, overlay = false): void {
		const settings = this.core.settings();
		if (!this.core.mayAct() || !settings.automation.highlightMoves) return;
		// No colour check of its own. `runPipeline` is the only caller (and re-checks
		// `snapshot` identity before getting here), every `Recommendation` carries the snapshot's own
		// `fen` (`recommendation.ts`), and `runPipeline`'s precondition is already that that FEN's
		// turn is our colour — so a check here could only ever differ from the one above by reading a
		// *different* colour source, and the only other source is the game's own copy of it. A guard
		// that cannot catch anything its caller misses is a guard nothing can test, so the properties
		// it would have rested on are asserted instead
		// (`test/behavioral/game/wrong-colour-guard.test.ts`): the mark is withdrawn when a correction
		// lands, and `rec.fen` is the snapshot's own FEN.
		this.markedOverlayFor = overlay ? rec : null;
		this.post({
			kind: "highlight",
			from: rec.chosen.from,
			to: rec.chosen.to,
			style: settings.automation.highlightStyle,
			...(overlay ? { overlay: true as const } : {}),
		});
	}

	/**
	 * The hand has started acting on the current recommendation: redraw its mark as *ours* before
	 * the first press.
	 *
	 * The owner's report of 2026-09-10 is that the mark vanishes "when the mouse starts its
	 * action ... rather than when it finishes it". Nothing of ours clears there any more — the one
	 * clear in the execution path, the content script's pre-`observeMove` clear, is gone (§13.3
	 * rule 4 is overruled for this mark) and completion is the only clear. What is left is the
	 * site: chess.com clears its own user markings on a left press on the board, and the hand's
	 * action is a sequence of presses — each preview touch of another piece is one, which is
	 * exactly the "even if its going to touch other pieces" detail. That is site behaviour and
	 * cannot be proved from this repository, so the fix does not depend on it: an overlay mark is
	 * an `<svg>` the bridge owns, so nothing the site does to *its* markings can reach it, and if
	 * the overlay turns out not to render on the live canvas board the result is exactly today's
	 * behaviour and nothing else changes.
	 *
	 * Two conditions, and neither carries correctness on its own any more:
	 *
	 * - `markedOverlayFor === rec` keeps this to **one** page round trip per mark rather than one
	 *   per hand-state change (the hand changes state a dozen times per move). It is safe across a
	 *   retry tier only because nothing clears the mark between tiers; when something does clear
	 *   it — `clear` — that field is reset, so the next hand start redraws.
	 * - `runningMove()?.rec !== rec` keeps the redraw to the recommendation actually being
	 *   executed. `core.rec` and the running move **do** diverge in practice — `cancelInFlight()`
	 *   does not await `MoveExecutor.cancel()`, so while a cancelled run winds down the session has
	 *   already analysed the next position and replaced `core.rec` (measured: hundreds of
	 *   milliseconds). What keeps this branch unreachable today is a `HandController` invariant
	 *   instead: after an abort the only state it emits is `rest` (`hand-controller.ts`'s catch path
	 *   and `recover()`, which calls no `setState`), and `rest` is filtered out by the session's
	 *   `hand` listener before this function is reached. So the guard does no work today and is
	 *   deliberately untested — but it is load-bearing on that invariant, not on the two
	 *   recommendations never differing. A change that made the abort path emit, say, `dropping`
	 *   would put it straight to work.
	 */
	markForExecution(): void {
		const rec = this.core.rec;
		const executor = this.core.executor;
		if (!rec || !executor || this.markedOverlayFor === rec) return;
		if (executor.runningMove()?.rec !== rec) return;
		this.highlight(rec, true);
	}

	/**
	 * Erase whatever is marked on the board. The invariant is that a mark belongs to the
	 * recommendation that is current *now*, so this runs at every point one stops being current:
	 * the move was played (by the hand or by the owner), the position moved on, the colour is not
	 * known yet, the game started or ended, the tab navigated, the switch went off, `Shift+X`.
	 *
	 * Before this existed the only two callers were the switch and `Shift+X`, so the mark for the
	 * move just played sat on the board for the whole of the opponent's turn — and on a board that
	 * draws through native markings a second `highlight` *stacked* on top of it rather than
	 * replacing it (owner's live test, 2026-09-09: "old move highlights are not erased").
	 */
	clear(): void {
		this.markedOverlayFor = null;
		this.post({ kind: "clearHighlight" });
	}

	/**
	 * Fix D: the hand dispatched a point, so the mirror on the page moves to it. Called for every
	 * acknowledged point — what the page was told, not what was planned — which is why the mirror
	 * is the truth about where the pointer is rather than an animation of a route.
	 *
	 * **Cadence, measured in the simulator** (ten runs, five seeds x preview on/off, gaps pooled
	 * rather than per-run medians): 86-153 points per ~3 s move, 33-53/s, gap p50 **7 ms**, p90
	 * **33 ms**, p99 ~580 ms, and **83%** of gaps inside one 16.7 ms frame. The long tail is the
	 * hand's own deliberate pauses, not a transport problem. An independent re-measurement got
	 * p50 7.7 / p90 24.3 over 1228 gaps, so treat ~7 ms median and a tens-of-ms p90 as the figures.
	 *
	 * **Why every point is posted rather than coalesced onto a frame.** Not because of load — the
	 * port is nowhere near strained, which is the only test the brief set. The §13.3 question is
	 * the real one, and frame coalescing would genuinely reduce page-observable surface: fewer
	 * `postMessage` envelopes and, since a `MutationObserver` queues one record per changed-property
	 * write, proportionally fewer `style` records during the bursts. Two reasons it is still not
	 * worth doing:
	 *
	 *  1. The coordinates are not new information to the page. Every mirrored point corresponds to a
	 *     *trusted* `pointermove` / `pointerdown` / `pointerup` the page already received from CDP at
	 *     that same cadence, so chess.com has the stream and its timing with or without us. What an
	 *     envelope adds is the conjunction "whatever posts these knows the pointer stream" — and a
	 *     visible arrow that tracks the pointer already discloses exactly that, at any sample rate.
	 *  2. The brief ruled on load ("coalesce only if a measurement shows the port or the bridge
	 *     cannot keep up"), and it does keep up.
	 *
	 * If that trade is ever revisited, the place to do it is the ISOLATED relay
	 * (`src/content/virtual-cursor.ts`), which already owns a `dispose()` and whose
	 * `requestAnimationFrame` is not the page's function and so cannot be counted or intercepted by
	 * a page script — not the MAIN-world program, where a loop would be page-realm surface of its
	 * own. That buys ≤1 frame of latency and `docs/qa-checklist.md` §B5.9 is the measurement.
	 *
	 * Between moves no point arrives, so the mirror simply stays where the pointer is.
	 */
	cursorTo(p: { x: number; y: number; pressed: boolean }): void {
		if (!this.virtualCursorAllowed()) return;
		this.post({
			kind: "cursorTo",
			x: p.x,
			y: p.y,
			down: p.pressed,
			...(this.core.settings().display.cursorEffects ? {} : { effects: false }),
		});
	}

	/** §4.4 and `Settings.display.virtualCursor`: may the mirror be on the page at all? */
	virtualCursorAllowed(): boolean {
		return this.core.mayAct() && this.core.settings().display.virtualCursor;
	}

	/**
	 * Erase the mirror. Unconditional and idempotent, like `clear()` beside it, and that is
	 * deliberate: the element lives in the *page*, so nothing this worker remembers is evidence
	 * about whether it is there. Chrome does not call `dispose()` when it suspends a worker — the
	 * session object simply vanishes and a new one is built on wake, while the content script
	 * reconnects rather than reboots and still holds the element. A guard on worker-local state
	 * would make every hide path a no-op from then on and strand the arrow on a live game for
	 * good. Removing an element that is not there is already a no-op on the page side, and the
	 * deduplication lives one layer down in `src/content/virtual-cursor.ts`, where the flag and the
	 * element share a lifetime.
	 *
	 * **The hide contract (owner, 2026-09-13).** The arrow is where the pointer rests, and it stays
	 * there — between games, across a navigation, through a disarm and through the debugger
	 * detaching — for as long as the assistant is on and this session is alive. Three things hide
	 * it: the switch going off (`Settings.enabled`, including `Shift+X` on this tab),
	 * `Settings.display.virtualCursor` going off, and the tab going away (`tabRemoved`, `dispose`;
	 * the content script also erases it when the port drops, since a mirror nobody can move must
	 * not keep the input shield up). Nothing else posts this. The next game's hand starts from the
	 * point the arrow is parked on (`MoveExecutor.arm` prefers `HandOwnership.position` while the
	 * mirror is on the page), so what is shown and where the hand goes from stay one point.
	 */
	hideCursor(): void {
		this.post({ kind: "cursorHide" });
	}
}
