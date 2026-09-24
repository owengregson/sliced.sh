/**
 * The site controls the service worker may click — new game, resign (and its confirmation),
 * rematch — read passively here, never activated. Each discovery names the element with an id
 * the worker revalidates by: a `targetId` + `point` must name the very element the rect was read
 * from, under that point, or the answer is `not-ready`. The service worker decides *whether* to
 * act; this only says *where*.
 */

import type {
	NewGameTarget,
	NewGameTargetResult,
	RematchAction,
	RematchTargetResult,
	ResignStep,
	ResignTargetResult,
} from "@core/constants/messages";
import type { Pt } from "@core/motor/types";
import type { NewGameMode } from "../contract";
import { newGameControl, newGameSearchActive } from "../new-game";
import { pageKindFromPath } from "../page-kind";
import { incomingRematchShowing, rematchControl } from "../rematch";
import { resignControl, visibleControls } from "../resign";

interface KnownTarget {
	element: HTMLElement;
	id: string;
}

type Revalidated = { status: "ready"; target: NewGameTarget } | { status: "not-ready" };

/**
 * Remembered controls, one slot per control kind. A slot keeps its id for as long as discovery
 * keeps finding the same element; a different element gets a fresh id.
 */
class TargetSlots<K extends string> {
	private readonly slots = new Map<K, KnownTarget>();

	constructor(
		private readonly doc: Document,
		private readonly win: Window
	) {}

	get(key: K): KnownTarget | null {
		return this.slots.get(key) ?? null;
	}

	/**
	 * Name `control` for slot `key`: with a `targetId` it must be the element that id was issued
	 * for, and with a `point` the element under it must be (inside) the control.
	 */
	resolve(key: K, control: HTMLElement, targetId?: string, point?: Pt): Revalidated {
		const known = this.get(key);
		if (targetId !== undefined && (known?.element !== control || targetId !== known.id))
			return { status: "not-ready" };
		if (point) {
			const hit = this.doc.elementFromPoint(point.x, point.y);
			if (!hit || (hit !== control && !control.contains(hit))) return { status: "not-ready" };
		}
		const entry =
			known?.element === control ? known : { element: control, id: this.win.crypto.randomUUID() };
		this.slots.set(key, entry);
		const rect = control.getBoundingClientRect();
		return {
			status: "ready",
			target: {
				targetId: entry.id,
				rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
				viewport: { width: this.win.innerWidth, height: this.win.innerHeight },
			},
		};
	}
}

export interface ControlTargetsHost {
	readonly doc: Document;
	readonly win: Window;
	/** The URL's game id, else the current reading's (`readSnapshot()` — only asked when needed). */
	currentGameId(): string | null | undefined;
	/** A game is being played on this board. */
	inGame(): boolean;
}

export class ControlTargets {
	private readonly restart: TargetSlots<"restart">;
	private readonly resigns: TargetSlots<ResignStep>;
	private readonly rematches: TargetSlots<RematchAction>;
	/** The clickable controls visible when the resign control was read: the confirmation is what is new. */
	private resignBaseline: ReadonlySet<Element> | null = null;

	constructor(private readonly host: ControlTargetsHost) {
		this.restart = new TargetSlots(host.doc, host.win);
		this.resigns = new TargetSlots(host.doc, host.win);
		this.rematches = new TargetSlots(host.doc, host.win);
	}

	/** Discover a control without activating it, or revalidate the exact element under a point. */
	newGame(
		mode: NewGameMode,
		expectedGameId?: string | null,
		targetId?: string,
		point?: Pt
	): NewGameTargetResult {
		const { doc, win } = this.host;
		const currentId = this.host.currentGameId();
		if (expectedGameId && currentId && currentId !== expectedGameId) return { status: "in-game" };
		const kind = pageKindFromPath(win.location.pathname);
		if (kind !== "live-game" && kind !== "live-lobby" && kind !== "vs-computer")
			return { status: "not-ready" };
		if (newGameSearchActive(doc, win)) return { status: "searching" };
		if (this.host.inGame()) return { status: "in-game" };
		const control = newGameControl(doc, win, mode, kind === "vs-computer", kind === "live-lobby");
		if (!control) return { status: "not-ready" };
		return this.restart.resolve("restart", control, targetId, point);
	}

	/**
	 * Discover the rematch control of `action` without activating it, or revalidate the exact
	 * element under `point` (2026-09-13) — the same passive discipline as `newGame`, on the
	 * same pages.
	 */
	rematch(action: RematchAction, targetId?: string, point?: Pt): RematchTargetResult {
		const { doc, win } = this.host;
		const kind = pageKindFromPath(win.location.pathname);
		if (kind !== "live-game" && kind !== "live-lobby") return { status: "not-ready" };
		if (this.host.inGame()) return { status: "in-game" };
		const control = rematchControl(doc, win, action);
		if (!control) return { status: "not-ready" };
		return this.rematches.resolve(action, control, targetId, point);
	}

	/** Whether the opponent's own rematch offer is showing (the incoming panel with its Accept). */
	incomingRematch(): boolean {
		return incomingRematchShowing(this.host.doc, this.host.win);
	}

	/**
	 * Discover the resign control of `step` without activating it, or revalidate the exact
	 * element under `point` (2026-09-12). Only a page that can host a live game answers.
	 */
	resign(step: ResignStep, targetId?: string, point?: Pt): ResignTargetResult {
		const { doc, win } = this.host;
		const kind = pageKindFromPath(win.location.pathname);
		if (kind !== "live-game" && kind !== "vs-computer") return { status: "not-ready" };
		// The confirmation is never the resign control we already found (its label may say "Resign"),
		// and it is looked for first among the controls that were not visible when that control was
		// read — the popup the resign click opens.
		const exclude = step === "confirm" ? (this.resigns.get("resign")?.element ?? null) : null;
		const control = resignControl(
			doc,
			win,
			step,
			exclude,
			step === "confirm" ? this.resignBaseline : null
		);
		if (!control) return { status: "not-ready" };
		if (step === "resign") this.resignBaseline = visibleControls(doc, win);
		return this.resigns.resolve(step, control, targetId, point);
	}
}
