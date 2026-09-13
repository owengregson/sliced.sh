import { NEW_GAME_INPUT } from "@core/constants/cdp";
import type { NewGameTarget, NewGameTargetResult } from "@core/constants/messages";
import { log } from "@core/logger";
import { CLICK, MOTOR_DEFAULTS, SAMPLING } from "@core/motor/constants";
import { clampIntoRect, rectShiftPx, sampleRange } from "@core/motor/geometry";
import { perMoveProfile } from "@core/motor/motor-profile";
import { generatePath } from "@core/motor/path-generator";
import { samplePointInRect } from "@core/motor/sampling";
import type { MotorProfile, Pt } from "@core/motor/types";
import type { Rng } from "@core/rng";
import {
	defaultNow,
	defaultScheduler,
	type Scheduler,
	sleep,
	throwIfAborted,
} from "@core/util/scheduler";
import type { ContentLink } from "@service/content-link";
import type { DebuggerManager } from "@service/debugger-manager";
import type { FocusGate } from "@service/focus-gate";
import type { HandOwnership } from "@service/hand-ownership";
import { CdpInputBackend } from "@service/move-executor/cdp-input-backend";

export interface NativeControlInputOptions {
	link: ContentLink;
	debugger: DebuggerManager;
	ownership: HandOwnership;
	focus: Pick<FocusGate, "canExecute">;
	rng: Rng;
	scheduler?: Scheduler;
	now?: () => number;
	showCursor?: () => boolean;
}

/** Owns cancellation and cleanup for one control sequence per tab. */
export class NativeControlInput {
	private readonly active = new Map<number, AbortController>();
	private disposed = false;

	constructor(private readonly options: NativeControlInputOptions) {}

	async run<T>(
		tabId: number,
		signal: AbortSignal,
		action: (gesture: NativeControlGesture) => Promise<T>
	): Promise<T | null> {
		if (this.disposed || signal.aborted || this.active.has(tabId)) return null;
		const controller = new AbortController();
		this.active.set(tabId, controller);
		const abort = () => controller.abort();
		signal.addEventListener("abort", abort, { once: true });
		const off = this.options.link.onDisconnect((id) => {
			if (id === tabId) abort();
		});
		const gesture = new NativeControlGesture(this.options, tabId, controller.signal);
		try {
			throwIfAborted(controller.signal);
			return await action(gesture);
		} catch (error) {
			if (!controller.signal.aborted) log.debug("native control input stopped", { tabId, error });
			throw error;
		} finally {
			await gesture.dispose();
			off();
			signal.removeEventListener("abort", abort);
			this.active.delete(tabId);
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const controller of this.active.values()) controller.abort();
	}
}

/** Shared native hand for new-game, rematch and resignation controls. */
class NativeControlGesture {
	readonly now: () => number;
	private readonly scheduler: Scheduler;
	private focusReservation: number | null = null;
	private pointerVersion: number | null = null;
	private backend: CdpInputBackend | null = null;
	private motor: MotorProfile | null = null;

	constructor(
		private readonly options: NativeControlInputOptions,
		private readonly tabId: number,
		readonly signal: AbortSignal
	) {
		this.now = options.now ?? defaultNow;
		this.scheduler = options.scheduler ?? defaultScheduler;
	}

	async attach(): Promise<void> {
		const manager = this.options.debugger;
		await manager.ensureAttached(this.tabId);
		throwIfAborted(this.signal);
		if (!manager.isFocusMaintained(this.tabId)) {
			this.focusReservation = manager.reserveFocus(this.tabId);
			await manager.setFocusMaintained(this.tabId, true, this.focusReservation);
		}
		this.guard();
	}

	async wait(ms: number): Promise<void> {
		await sleep(ms, this.scheduler, this.signal);
		throwIfAborted(this.signal);
	}

	/** Revalidate the same element and geometry both before pressing and before release. */
	async click(
		target: NewGameTarget,
		read: (point: Pt) => Promise<NewGameTargetResult>
	): Promise<boolean> {
		const { rng, ownership, link, debugger: manager } = this.options;
		const left = Math.max(0, target.rect.left);
		const top = Math.max(0, target.rect.top);
		const visible = {
			left,
			top,
			width: Math.min(target.viewport.width, target.rect.left + target.rect.width) - left,
			height: Math.min(target.viewport.height, target.rect.top + target.rect.height) - top,
		};
		if (visible.width <= 0 || visible.height <= 0) return false;
		const point = samplePointInRect(visible, SAMPLING.press.sigmaFrac, SAMPLING.press.innerFrac, rng);
		if (this.backend === null) {
			const start = clampIntoRect(
				ownership.startPoint(this.tabId, () => ({
					x: target.viewport.width * rng.next(),
					y: target.viewport.height - NEW_GAME_INPUT.entryInsetPx,
				})),
				{ left: 0, top: 0, ...target.viewport }
			);
			this.motor = perMoveProfile(MOTOR_DEFAULTS, rng);
			if (this.options.showCursor?.() === false) link.post(this.tabId, { kind: "cursorHide" });
			else this.mirror(start, false);
			this.backend = CdpInputBackend.forTab(manager, this.tabId, start, {
				now: this.now,
				scheduler: this.scheduler,
				beforeDispatch: (pointer, signal) => link.preparePointer(this.tabId, pointer, signal),
				afterDispatch: (pointer) => link.confirmPointer(this.tabId, pointer),
				onDispatch: (p) => this.mirror({ x: p.x, y: p.y }, p.pressed),
			});
		}
		const backend = this.backend;
		const motor = this.motor;
		if (motor === null) return false;
		const revalidate = async () => {
			const reply = await read(point);
			if (
				reply.status !== "ready" ||
				reply.target.targetId !== target.targetId ||
				rectShiftPx(reply.target.rect, target.rect) > 0 ||
				reply.target.viewport.width !== target.viewport.width ||
				reply.target.viewport.height !== target.viewport.height
			)
				throw new Error("native control changed");
			this.guard();
		};
		await backend.travel(
			generatePath(backend.position(), point, visible, motor, rng),
			this.signal,
			this.guard
		);
		await this.wait(sampleRange(CLICK.preGrabPauseMs, rng));
		await revalidate();
		await backend.press(point, this.now(), this.signal, this.guard);
		await this.wait(sampleRange(motor.pressHoldMs, rng));
		await revalidate();
		await backend.release(point, this.now());
		return true;
	}

	async dispose(): Promise<void> {
		// Even a rejected page receipt owes a release. Off-page release cancels a stale control.
		if (this.backend?.pressed()) {
			try {
				await this.backend.release(NEW_GAME_INPUT.cancelPoint, this.now());
			} catch (error) {
				log.debug("native control pointer release failed", error);
			}
		}
		this.backend?.dispose();
		if (this.focusReservation !== null) {
			try {
				await this.options.debugger.setFocusMaintained(this.tabId, false, this.focusReservation);
			} catch (error) {
				log.debug("native control focus restoration failed", error);
			}
		}
	}

	private readonly guard = (): void => {
		throwIfAborted(this.signal);
		const { link, debugger: manager, focus } = this.options;
		if (
			!link.isConnected(this.tabId) ||
			!manager.isAttached(this.tabId) ||
			(this.focusReservation !== null &&
				!manager.hasFocusReservation(this.tabId, this.focusReservation)) ||
			!focus.canExecute(this.tabId).ok
		)
			throw new Error("native control input is not available");
	};

	private mirror(point: Pt, down: boolean): void {
		const { link, debugger: manager, ownership } = this.options;
		// A click can start a new game before its release receipt returns; the new hand wins.
		if (
			(this.pointerVersion !== null && link.pointerVersion(this.tabId) !== this.pointerVersion) ||
			(this.focusReservation !== null &&
				!manager.hasFocusReservation(this.tabId, this.focusReservation))
		)
			return;
		ownership.setPosition(this.tabId, point);
		if (this.options.showCursor?.() === false) return;
		link.post(this.tabId, { kind: "cursorTo", ...point, down });
		this.pointerVersion = link.pointerVersion(this.tabId);
	}
}
