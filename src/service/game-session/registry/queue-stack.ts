/**
 * The per-worker page-input stack the sessions share for everything outside a move: the queue's
 * new-game clicks (`NewGameInput`), the resign clicks (`ResignInput`), the titled-opponent rematch
 * step (`RematchStep`) and the auto-queue that drives them. Built once per registry; every seeded
 * stream is derived from one queue seed so a worker lifetime does not replay another's paths.
 */

import { REMATCH } from "@core/constants/rematch";
import { createRng } from "@core/rng";
import type { Scheduler } from "@core/util/scheduler";
import { AutoQueue } from "@service/auto-queue";
import { createAutoQueuePersistence } from "@service/auto-queue-persistence";
import { NewGameInput } from "@service/new-game-input";
import { RematchStep } from "@service/rematch";
import { ResignInput } from "@service/resign-input";
import type { SessionRegistryDeps } from "../registry";
import type { GameSession } from "../session";

export interface QueueStack {
	autoQueue: AutoQueue;
	newGameInput: NewGameInput;
	/** 2026-09-12: the resign + confirm clicks, one hand-driven attempt per tab (`RESIGN`). */
	resignInput: ResignInput;
	/** 2026-09-13: the rematch step for titled opponents, clicking through `newGameInput`. */
	rematchStep: RematchStep;
}

export interface QueueStackContext {
	deps: SessionRegistryDeps;
	scheduler: Scheduler;
	now: () => number;
	/** The live session on a tab, if any. */
	session(tabId: number): GameSession | null;
	/** The auto-queue's pending state changed. */
	onChanged(): void;
}

export function createQueueStack(ctx: QueueStackContext): QueueStack {
	const { deps, scheduler, now } = ctx;
	// New worker lifetimes must not replay identical session lengths and button paths.
	// Tests can inject a fixed seed; sampled session/break deadlines are persisted separately.
	const queueSeed = deps.seed ?? crypto.randomUUID();
	const newGameInput = new NewGameInput({
		link: deps.link,
		debugger: deps.debugger,
		ownership: deps.ownership,
		focus: deps.focus,
		rng: createRng(`${queueSeed}:queue-input`),
		scheduler,
		now,
		showCursor: () => deps.getSettings().display.virtualCursor,
	});
	const resignInput = new ResignInput({
		link: deps.link,
		debugger: deps.debugger,
		ownership: deps.ownership,
		focus: deps.focus,
		rng: createRng(`${queueSeed}:resign-input`),
		scheduler,
		now,
		showCursor: () => deps.getSettings().display.virtualCursor,
	});
	const rematchStep = new RematchStep({
		// A passive read over the same port request the click path revalidates with.
		incoming: async (tabId, signal) => {
			const reply = await deps.link.request(
				tabId,
				{ kind: "rematch", action: "accept" },
				REMATCH.targetTimeoutMs,
				signal
			);
			return reply.incoming;
		},
		// The queue's own click path (`NewGameInput`): the same hand, guards and revalidation.
		click: async (tabId, gameId, action, signal) => {
			await ctx.session(tabId)?.executor()?.whenIdle();
			const reply = await newGameInput.attempt(tabId, gameId, signal, {
				kind: "rematch",
				action,
			});
			return { status: reply.status === "searching" ? "not-ready" : reply.status };
		},
		scheduler,
		now,
	});
	const autoQueue = new AutoQueue({
		attempt: async (tabId, gameId, signal) => {
			await ctx.session(tabId)?.executor()?.whenIdle();
			return newGameInput.attempt(tabId, gameId, signal);
		},
		scheduler,
		now,
		rng: createRng(`${queueSeed}:auto-queue`),
		persistence: createAutoQueuePersistence(),
		rematch: {
			step: rematchStep,
			allowed: () => deps.getSettings().automation.rematchTitled,
		},
		onBreak: (tabId) => ctx.session(tabId)?.takeQueueBreak(),
		canQueue: (tabId, gameId) => {
			if (deps.settingsKnown?.() === false) return "hold";
			const settings = deps.getSettings();
			if (!settings.enabled || !settings.automation.autoQueue) return "cancel";
			const session = ctx.session(tabId);
			if (!session) return "hold";
			const view = session.view();
			if (view.gameId !== null && view.gameId !== gameId) return "cancel";
			// A finished board can render its toolbar before its requeue popup. Retain the
			// deadline, but permit no native gesture until the adapter sees queue controls.
			if (view.pageKind === "live-spectate") return "hold";
			return view.state === "game-over" || view.state === "waiting-for-game" ? "allow" : "hold";
		},
		onChanged: () => ctx.onChanged(),
	});
	return { autoQueue, newGameInput, resignInput, rematchStep };
}
