import { NEW_GAME_INPUT } from "@core/constants/cdp";
import type { NewGameTarget } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import { CLICK, MOTOR_DEFAULTS, SAMPLING } from "@core/motor/constants";
import { clampIntoRect, rectShiftPx, sampleRange } from "@core/motor/geometry";
import { perMoveProfile } from "@core/motor/motor-profile";
import { generatePath } from "@core/motor/path-generator";
import { samplePointInRect } from "@core/motor/sampling";
import type { Pt } from "@core/motor/types";
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

export type NewGameInputStatus = "started" | "searching" | "not-ready" | "in-game";
export interface NewGameInputOptions {
	link: ContentLink;
	debugger: DebuggerManager;
	ownership: HandOwnership;
	focus: Pick<FocusGate, "canExecute">;
	rng: Rng;
	scheduler?: Scheduler;
	now?: () => number;
	showCursor?: () => boolean;
}

/** One native button gesture per attempt. Subsequent lobby steps use fresh discovery next time. */
export class NewGameInput {
	private readonly scheduler: Scheduler;
	private readonly now: () => number;
	private readonly active = new Map<number, AbortController>();
	private disposed = false;

	constructor(private readonly options: NewGameInputOptions) {
		this.scheduler = options.scheduler ?? defaultScheduler;
		this.now = options.now ?? defaultNow;
	}

	async attempt(
		tabId: number,
		gameId: string | null,
		signal: AbortSignal
	): Promise<{ status: NewGameInputStatus }> {
		if (this.disposed || signal.aborted || this.active.has(tabId)) return { status: "not-ready" };
		const { link, debugger: manager, ownership, focus, rng } = this.options;
		const controller = new AbortController();
		this.active.set(tabId, controller);
		const abort = () => controller.abort();
		signal.addEventListener("abort", abort, { once: true });
		const off = link.onDisconnect((id) => {
			if (id === tabId) abort();
		});
		let focusReservation: number | null = null;
		const guard = () => {
			throwIfAborted(controller.signal);
			if (
				!link.isConnected(tabId) ||
				!manager.isAttached(tabId) ||
				(focusReservation !== null && !manager.hasFocusReservation(tabId, focusReservation)) ||
				!focus.canExecute(tabId).ok
			)
				throw new Error("post-game input is not available");
		};
		let backend: CdpInputBackend | null = null;
		let pointerVersion: number | null = null;
		const mirror = (point: Pt, down: boolean) => {
			// The click can synchronously start another game before Chrome acknowledges release.
			// Its new hand/cursor takes precedence over the old action's trailing receipt.
			if (
				(pointerVersion !== null && link.pointerVersion(tabId) !== pointerVersion) ||
				(focusReservation !== null && !manager.hasFocusReservation(tabId, focusReservation))
			)
				return;
			ownership.setPosition(tabId, point);
			if (this.options.showCursor?.() === false) return;
			link.post(tabId, { kind: "cursorTo", ...point, down });
			pointerVersion = link.pointerVersion(tabId);
		};
		try {
			throwIfAborted(controller.signal);
			let reply = await link.request(
				tabId,
				{ kind: "startNewGame", gameId },
				TIMINGS.autoQueueRequestTimeoutMs,
				controller.signal
			);
			if (reply.status !== "ready") return { status: reply.status };
			// Queueing borrows an existing hold or temporarily maintains native page focus. It
			// never arms auto-play; an executor for a new game can supersede this reservation.
			await manager.ensureAttached(tabId);
			throwIfAborted(controller.signal);
			if (!manager.isFocusMaintained(tabId)) {
				focusReservation = manager.reserveFocus(tabId);
				await manager.setFocusMaintained(tabId, true, focusReservation);
			}
			guard();
			// Chrome's debugger infobar can shift the layout during attach.
			reply = await link.request(
				tabId,
				{ kind: "startNewGame", gameId },
				TIMINGS.autoQueueRequestTimeoutMs,
				controller.signal
			);
			if (reply.status !== "ready") return { status: reply.status };
			const target = reply.target;
			const viewport = { left: 0, top: 0, ...target.viewport };
			const visible = {
				left: Math.max(0, target.rect.left),
				top: Math.max(0, target.rect.top),
				width:
					Math.min(target.viewport.width, target.rect.left + target.rect.width) -
					Math.max(0, target.rect.left),
				height:
					Math.min(target.viewport.height, target.rect.top + target.rect.height) -
					Math.max(0, target.rect.top),
			};
			if (visible.width <= 0 || visible.height <= 0) return { status: "not-ready" };
			const point = samplePointInRect(
				visible,
				SAMPLING.press.sigmaFrac,
				SAMPLING.press.innerFrac,
				rng
			);
			const start = clampIntoRect(
				ownership.startPoint(tabId, () => ({
					x: target.viewport.width * rng.next(),
					y: target.viewport.height - NEW_GAME_INPUT.entryInsetPx,
				})),
				viewport
			);
			const motor = perMoveProfile(MOTOR_DEFAULTS, rng);
			if (this.options.showCursor?.() === false) link.post(tabId, { kind: "cursorHide" });
			else mirror(start, false);
			backend = CdpInputBackend.forTab(manager, tabId, start, {
				now: this.now,
				scheduler: this.scheduler,
				beforeDispatch: (pointer, inputSignal) => link.preparePointer(tabId, pointer, inputSignal),
				afterDispatch: (pointer) => link.confirmPointer(tabId, pointer),
				onDispatch: (p) => mirror({ x: p.x, y: p.y }, p.pressed),
			});
			await backend.travel(generatePath(start, point, visible, motor, rng), controller.signal, guard);
			await sleep(sampleRange(CLICK.preGrabPauseMs, rng), this.scheduler, controller.signal);
			await this.revalidate(tabId, gameId, target, point, controller.signal);
			guard();
			await backend.press(point, this.now(), controller.signal, guard);
			await sleep(sampleRange(motor.pressHoldMs, rng), this.scheduler, controller.signal);
			await this.revalidate(tabId, gameId, target, point, controller.signal);
			guard();
			await backend.release(point, this.now());
			return { status: "started" };
		} catch (error) {
			if (!controller.signal.aborted)
				log.debug("post-game input stopped before completing a control", error);
			return { status: "not-ready" };
		} finally {
			// A press admitted by Chrome owes a release even if its page receipt failed. Releasing
			// off-page cancels the old button instead of clicking a moved/replaced target on abort.
			if (backend?.pressed()) {
				try {
					await backend.release(NEW_GAME_INPUT.cancelPoint, this.now());
				} catch (error) {
					log.debug("post-game pointer release failed", error);
				}
			}
			backend?.dispose();
			if (pointerVersion !== null && link.pointerVersion(tabId) === pointerVersion)
				link.post(tabId, { kind: "cursorHide" });
			if (focusReservation !== null) {
				try {
					await manager.setFocusMaintained(tabId, false, focusReservation);
				} catch (error) {
					log.debug("post-game focus restoration failed", error);
				}
			}
			off();
			signal.removeEventListener("abort", abort);
			this.active.delete(tabId);
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const controller of this.active.values()) controller.abort();
	}

	private async revalidate(
		tabId: number,
		gameId: string | null,
		target: NewGameTarget,
		point: Pt,
		signal: AbortSignal
	): Promise<void> {
		const reply = await this.options.link.request(
			tabId,
			{ kind: "startNewGame", gameId, targetId: target.targetId, point },
			TIMINGS.autoQueueRequestTimeoutMs,
			signal
		);
		if (
			reply.status !== "ready" ||
			reply.target.targetId !== target.targetId ||
			rectShiftPx(reply.target.rect, target.rect) > 0 ||
			reply.target.viewport.width !== target.viewport.width ||
			reply.target.viewport.height !== target.viewport.height
		)
			throw new Error("post-game control changed");
	}
}
