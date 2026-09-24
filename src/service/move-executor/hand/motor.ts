/**
 * The hand's primitives (§9.3–§9.6a): every travel, press, release and pause one execution or
 * opponent-turn bout dispatches, each gated by the `FocusGate` (and the §9.5 board-reflow guard
 * when given one), keeping the `HandOwnership` position, the input-critical signal and the
 * execution record in step with what actually went out. The gestures (`gestures/*`) and the
 * sequence (`sequence.ts`) are written entirely in these terms; nothing else touches the backend.
 */

import { CDP } from "@core/constants/cdp";
import type { BoardGeometryReply } from "@core/constants/messages";
import { log } from "@core/logger";
import type { InputBackend } from "@core/motor/input-backend";
import type { HandState, PathPoint, Pt, Rect } from "@core/motor/types";
import type { Rng } from "@core/rng";
import { errorMessage } from "@core/util/errors";
import { type Scheduler, sleep, throwIfAborted } from "@core/util/scheduler";
import { type BoardRectSource, boardShift } from "@service/board-watch";
import type { FocusVerdict } from "@service/focus-gate";
import type { PromoPiece, Square } from "@typedefs/game";
import { BoardMovedError, SkipError } from "./errors";
import type { GeometryProvider } from "./geometry";
import type { InputCriticality } from "./input-criticality";
import type { ExecutionRecord } from "./record";

export interface FocusSource {
	canExecute(tabId: number): FocusVerdict;
}

export interface OwnershipSink {
	position(tabId: number): Pt | null;
	setPosition(tabId: number, p: Pt): void;
}

export interface HandMotorDeps {
	backend: InputBackend;
	focus: FocusSource;
	ownership: OwnershipSink;
	geometry: GeometryProvider | null;
	board: BoardRectSource | null;
	rng: Rng;
	now: () => number;
	scheduler: Scheduler;
	onState: ((state: HandState) => void) | null;
	/** Runs after the final admission guard, immediately before the committed mouse-down. */
	onCommittedPress: (() => void) | null;
	input: InputCriticality;
	record: ExecutionRecord;
}

export class HandMotor {
	readonly backend: InputBackend;
	readonly board: BoardRectSource | null;
	readonly rng: Rng;
	readonly now: () => number;
	readonly scheduler: Scheduler;
	readonly input: InputCriticality;
	readonly record: ExecutionRecord;
	private readonly focus: FocusSource;
	private readonly ownership: OwnershipSink;
	private readonly geometry: GeometryProvider | null;
	private readonly onState: ((state: HandState) => void) | null;
	private readonly onCommittedPress: (() => void) | null;
	private current: HandState = "rest";
	private tabIdValue = -1;
	private signalValue: AbortSignal | null = null;

	constructor(deps: HandMotorDeps) {
		this.backend = deps.backend;
		this.focus = deps.focus;
		this.ownership = deps.ownership;
		this.geometry = deps.geometry;
		this.board = deps.board;
		this.rng = deps.rng;
		this.now = deps.now;
		this.scheduler = deps.scheduler;
		this.onState = deps.onState;
		this.onCommittedPress = deps.onCommittedPress;
		this.input = deps.input;
		this.record = deps.record;
	}

	get tabId(): number {
		return this.tabIdValue;
	}

	/** The running execution's / bout's signal; `null` while the hand is idle. */
	get signal(): AbortSignal | null {
		return this.signalValue;
	}

	/** Bind the hand to one execution or bout (`end()` unbinds it). */
	begin(tabId: number, signal: AbortSignal): void {
		this.tabIdValue = tabId;
		this.signalValue = signal;
	}

	end(): void {
		this.signalValue = null;
	}

	/** Another execution or bout owns the hand, or a button is still down. */
	busy(): boolean {
		return this.signalValue !== null || this.backend.pressed();
	}

	state(): HandState {
		return this.current;
	}

	setState(s: HandState): void {
		if (this.current === s) return;
		this.current = s;
		this.onState?.(s);
	}

	position(): Pt {
		return this.backend.position();
	}

	/** Publish wherever the backend's pointer is now as the hand's position. */
	syncPosition(tabId: number = this.tabIdValue): void {
		this.ownership.setPosition(tabId, this.backend.position());
	}

	/** The focus gate's verdict for the bound tab right now. */
	verdict(): FocusVerdict {
		return this.focus.canExecute(this.tabIdValue);
	}

	/** Whether geometry can be re-read at all (a provider was given). */
	hasGeometry(): boolean {
		return this.geometry !== null;
	}

	gate(): void {
		const verdict = this.focus.canExecute(this.tabIdValue);
		if (!verdict.ok) throw new SkipError(verdict.reason);
	}

	/**
	 * §9.5: has the page moved the board since the touch was planned? A shift beyond
	 * `EXECUTOR.boardMoveTolerancePx` means every remaining point of the path — and the release
	 * above all — is in a coordinate space the page has left behind.
	 */
	guardBoard(planned: Rect): void {
		const live = boardShift(this.board, this.tabIdValue, planned);
		if (live === null) return;
		throw new BoardMovedError(live);
	}

	async readGeometry(
		tabId: number,
		promotion?: { piece: PromoPiece; to: Square }
	): Promise<BoardGeometryReply | null> {
		if (!this.geometry) return null;
		try {
			return await this.geometry.read(tabId, promotion, this.signalValue ?? undefined);
		} catch (error) {
			log.debug("hand: geometry read failed", {
				tabId,
				promotion: promotion?.piece ?? null,
				error: errorMessage(error),
			});
			return null;
		}
	}

	/** The backend's absolute-time travel; the gate (and `guard`, if any) runs before every point (§9.6a). */
	async travel(path: readonly PathPoint[], guard?: () => void): Promise<void> {
		if (path.length === 0) return;
		this.input.setTravelling(true);
		try {
			await this.backend.travel(path, this.signalValue ?? undefined, () => {
				this.gate();
				guard?.();
			});
		} finally {
			this.syncPosition();
			this.input.setTravelling(false);
		}
	}

	/**
	 * The return leg of a reflow escape: no gate, no abort signal. The button is held, so this
	 * travel must finish and be followed by the release whatever else has happened.
	 */
	async escapeTravel(path: readonly PathPoint[]): Promise<void> {
		if (path.length === 0) return;
		this.input.setTravelling(true);
		try {
			await this.backend.travel(path);
		} finally {
			this.syncPosition();
			this.input.setTravelling(false);
		}
	}

	async press(p: Pt, committed = false, guard?: () => void): Promise<void> {
		throwIfAborted(this.signalValue ?? undefined);
		this.gate();
		this.input.setPressed(true);
		await this.backend.press(p, this.now(), this.signalValue ?? undefined, () => {
			this.gate();
			guard?.();
			if (committed) this.onCommittedPress?.();
		});
		this.record.pressedAny = true;
		if (committed) this.record.pressedCommitted = true;
		this.syncPosition();
	}

	/**
	 * An ungated press: the escape click that clears a standing click-click selection, which must go
	 * out whatever the focus gate or a cancel says (`gestures/escape.ts`).
	 */
	async pressUngated(p: Pt): Promise<void> {
		await this.backend.press(p, this.now());
		this.record.pressedAny = true;
	}

	async release(p: Pt): Promise<void> {
		await this.backend.release(p, this.now());
		this.input.setPressed(false);
		this.syncPosition();
	}

	/** A right-button press: a line-preview arrow's start. Gated like every press, never a §13.2 press. */
	async pressRight(p: Pt, guard?: () => void): Promise<void> {
		throwIfAborted(this.signalValue ?? undefined);
		this.gate();
		this.input.setPressed(true);
		await this.backend.press(
			p,
			this.now(),
			this.signalValue ?? undefined,
			() => {
				this.gate();
				guard?.();
			},
			"right"
		);
		this.syncPosition();
	}

	async releaseRight(p: Pt): Promise<void> {
		await this.backend.release(p, this.now(), "right");
		this.input.setPressed(false);
		this.syncPosition();
	}

	async pause(ms: number, guard?: () => void): Promise<void> {
		if (ms > 0) {
			this.input.pauseUntil(this.now() + ms);
			try {
				await sleep(ms, this.scheduler, this.signalValue ?? undefined);
			} finally {
				this.input.resumeDeadline();
			}
		}
		throwIfAborted(this.signalValue ?? undefined);
		this.gate();
		guard?.();
	}

	/** An unsignalled, ungated wait: for legs that must finish once the button is down. */
	waitUngated(ms: number): Promise<void> {
		return sleep(ms, this.scheduler);
	}

	async sleepUntil(atMs: number): Promise<void> {
		await this.pause(atMs - this.now());
	}

	/** Never leave a button held: an abort or skip mid-drag drops the piece where it is. */
	async recover(): Promise<void> {
		const held = this.heldButtons();
		if ((held & CDP.mouse.rightButtons) !== 0) {
			// A line-preview arrow cut short: let go where the pointer is (an arrow to nowhere).
			try {
				await this.releaseRight(this.backend.position());
			} catch (error) {
				log.warn("hand: right-button release after abort failed", {
					tabId: this.tabIdValue,
					error: errorMessage(error),
				});
			}
		}
		if (!this.backend.pressed()) return;
		try {
			await this.release(this.backend.position());
			// This release can complete a drag or a held promotion-picker click. Only a
			// subsequent successful verification turns this timestamp into an observation.
			if (this.record.pressedCommitted) this.record.submittedAt = this.now();
		} catch (error) {
			log.warn("hand: release after abort failed", {
				tabId: this.tabIdValue,
				error: errorMessage(error),
			});
		}
	}

	/** Every button the backend still holds (`CDP.mouse` bits). */
	private heldButtons(): number {
		const mask = this.backend.pressedButtons?.();
		if (mask !== undefined) return mask;
		return this.backend.pressed() ? CDP.mouse.leftButtons : CDP.mouse.noButtons;
	}
}
