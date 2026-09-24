/** Assembling the `PanelSnapshot` a panel should see for the tab its window shows. */

import { chromeLocalGet } from "@core/chrome/storage";
import { tabsQuery } from "@core/chrome/tabs";
import { EXECUTOR } from "@core/constants/cdp";
import { DEFAULT_ENGINE_STATUS } from "@core/constants/defaults";
import type { PanelPortMessage, PanelSnapshot, PanelToast } from "@core/constants/messages";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { TOAST_KEYS } from "@core/constants/toasts";
import { log } from "@core/logger";
import { errorMessage } from "@core/util/errors";
import { EMPTY_SESSION_STATS } from "@service/handlers/log/session-reset";
import type { SessionGameView, SnapshotSources } from "@service/panel-broadcaster/sources";
import type {
	ExecutionResult,
	GameSessionState,
	GameSessionView,
	SessionStats,
} from "@typedefs/game";
import type { Settings } from "@typedefs/settings";

export type ToastLevel = Extract<PanelPortMessage, { kind: "toast" }>["level"];

const IDLE_VIEW: Readonly<SessionGameView> = Object.freeze({
	state: "idle",
	gameId: null,
	site: null,
	pageKind: "other",
	myColor: null,
	sideToMove: null,
	ply: 0,
	clocks: null,
});

const isLive = (state: GameSessionState): boolean => state.startsWith("live:");

/** The active tab of `windowId` (or of the last-focused window) — the tab a panel shows. */
export async function activeTabId(windowId: number | null): Promise<number | null> {
	try {
		const tabs = await tabsQuery(
			windowId === null ? { active: true, lastFocusedWindow: true } : { active: true, windowId }
		);
		const id = tabs[0]?.id;
		return typeof id === "number" ? id : null;
	} catch (error) {
		log.debug("panel-broadcaster: tabs.query failed", { error: errorMessage(error) });
		return null;
	}
}

export async function readStats(): Promise<SessionStats> {
	return (await chromeLocalGet(LOCAL_KEYS.sessionStats)) ?? { ...EMPTY_SESSION_STATS };
}

/** Only execution problems notify; successful moves update the snapshot silently. */
export function toastFor(result: ExecutionResult): { level: ToastLevel; toast: PanelToast } | null {
	if (result.outcome === "failed" && result.reason === EXECUTOR.reasons.unverified)
		return { level: "warn", toast: { key: TOAST_KEYS.notVerified } };
	return null;
}

export interface SnapshotInput {
	/** The tab the panel shows; `null` → the idle snapshot. */
	tabId: number | null;
	settings: Settings;
	stats: SessionStats;
	/** The tab's last execution result, as the broadcaster stamped it. */
	lastExecution: ExecutionResult | undefined;
}

/** The snapshot of `input.tabId`, read synchronously from `sources`. */
export function assembleSnapshot(sources: SnapshotSources, input: SnapshotInput): PanelSnapshot {
	const { tabId, settings, stats } = input;
	const session = tabId === null ? null : sources.session(tabId);
	const executor = tabId === null ? null : sources.executor(tabId);
	const hand = tabId === null ? null : sources.hand;

	const view: GameSessionView = {
		...(session?.view() ?? IDLE_VIEW),
		hand: executor ? executor.handView() : "detached",
	};
	const last = tabId === null ? undefined : input.lastExecution;
	if (last) view.lastExecution = last;

	const autoMove: PanelSnapshot["autoMove"] = { armed: executor?.isArmed() ?? false };
	const pending = executor?.pendingMove() ?? null;
	// A move whose deadline is `now + thinkMs` is never *parked* — the hand owns the whole
	// window — so once it starts the countdown (Task 24) reads the plan the hand is running.
	// `instant` plans still include preparation and motion. Hiding their plan makes an
	// armed, interruptible run look idle ("Awaiting command") until its first committed press.
	const running = pending === null ? (executor?.runningMove() ?? null) : null;
	const scheduled = pending?.rec.plan ?? running?.plan;
	if (scheduled) {
		autoMove.scheduledAt = scheduled.deadlineMs;
		autoMove.plan = scheduled;
	}

	const executorState: PanelSnapshot["executor"] = {
		debuggerAttached: tabId !== null && hand ? hand.debugger.isAttached(tabId) : false,
	};
	const lastError = tabId !== null && hand ? hand.debugger.lastError(tabId) : undefined;
	if (lastError !== undefined) executorState.lastError = lastError;

	const focus =
		tabId !== null && hand
			? hand.focus.snapshot(tabId)
			: { pageHasFocus: false, blurSeenThisMove: false };

	const snapshot: PanelSnapshot = {
		license: sources.license(),
		site: view.site,
		pageKind: view.pageKind,
		session: view,
		engine: sources.engineStatus() ?? { ...DEFAULT_ENGINE_STATUS, nnue: [] },
		executor: executorState,
		settings,
		autoMove,
		stats,
		focus: {
			...focus,
			handsOff: isLive(view.state),
			realPointerEventsDuringHand: tabId !== null && hand ? hand.ownership.realPointerCount(tabId) : 0,
		},
	};
	const recommendation = session?.recommendation() ?? null;
	if (recommendation) snapshot.recommendation = recommendation;
	const opponent = session?.opponent() ?? null;
	if (opponent) snapshot.opponent = opponent;
	return snapshot;
}
