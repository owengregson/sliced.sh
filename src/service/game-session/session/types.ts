/**
 * The seams `GameSession` is built from: what the registry hands it (`GameSessionDeps`), the
 * pipeline and executor factories a harness can replace, and the opponent card it keeps.
 */

import type { TimeControlClass } from "@core/motor/types";
import type { PolicyPort } from "@core/policy/types";
import type { BookPolicy } from "@core/strength/book/book-policy";
import type { TimingLogWriter } from "@core/timing/timing-log";
import type { TimingModel } from "@core/timing/timing-model";
import type { DistributionHead } from "@core/timing/types";
import type { Scheduler } from "@core/util/scheduler";
import type { AutoQueue } from "@service/auto-queue";
import type { ContentLink } from "@service/content-link";
import type { DebuggerManager } from "@service/debugger-manager";
import type { EngineController } from "@service/engine-controller";
import type { FocusGate } from "@service/focus-gate";
import type { HandOwnership } from "@service/hand-ownership";
import type { MoveExecutor } from "@service/move-executor";
import type { ResignInput } from "@service/resign-input";
import type { Site } from "@typedefs/game";
import type { PersonaId, Settings } from "@typedefs/settings";
import type { ReviewSearcher } from "../board-effects";
import type { RecommendationInput, RecommendationOutcome } from "../recommendation";

/** The §3.2 pipeline as the session uses it (`RecommendationPipeline` satisfies it). */
export interface SessionPipeline {
	run(input: RecommendationInput): Promise<RecommendationOutcome | null>;
}

/** What the session asks the registry to build when a game starts. */
export type ExecutorFactory = (config: {
	site: Site;
	persona: PersonaId;
	tcClass: TimeControlClass;
	gameSeed: string;
}) => MoveExecutor;

export interface GameSessionDeps {
	tabId: number;
	link: Pick<ContentLink, "post" | "request" | "onMessage" | "isConnected">;
	engine: EngineController | null;
	book: BookPolicy | null;
	/**
	 * The move-review engine (2026-09-14): the full-network Stockfish every board rating comes from,
	 * independent of `engine`. Absent or `null`: the board effects still go out, without ratings.
	 */
	review?: ReviewSearcher | null | undefined;
	/** Shared timing head (ChessMimic with the v1 fallback); one per service worker. */
	head: DistributionHead;
	/**
	 * `ensureAttached` is optional: the lobby hold uses it to land the infobar on the queue screen,
	 * outside every move window, while the hand itself stays off the mouse (§13.4).
	 */
	debugger: Pick<DebuggerManager, "isAttached" | "detach" | "onDetached"> &
		Partial<Pick<DebuggerManager, "ensureAttached">>;
	focus: Pick<FocusGate, "positionArrived" | "onEdge" | "snapshot">;
	ownership: Pick<HandOwnership, "realPointerCount">;
	timingLog: Pick<TimingLogWriter, "append" | "upsert" | "markActual" | "attachTelemetry" | "flush">;
	autoQueue: Pick<AutoQueue, "schedule" | "cancel" | "view" | "observedGame">;
	/**
	 * 2026-09-12: performs the resign + confirm clicks when `shouldResign` fires (`RESIGN`).
	 * Absent (a harness without one): a lost position is played out as before.
	 */
	resignInput?: Pick<ResignInput, "attempt"> | undefined;
	createExecutor: ExecutorFactory;
	/**
	 * Overrides how the §3.2 pipeline is built for a game (default:
	 * `new RecommendationPipeline({ engine, timing, book })`). The seam exists so a harness can
	 * drive the whole orchestrator with a scripted recommendation — Task 33's conformance
	 * harness plugs in here — without stubbing the engine at the UCI level.
	 */
	createPipeline?: ((timing: TimingModel) => SessionPipeline) | undefined;
	/** The latest settings the registry has read. */
	getSettings(): Settings;
	/**
	 * Whether `getSettings()` is the *stored* settings yet, rather than `DEFAULT_SETTINGS` standing
	 * in until the first `chrome.storage.local` read answers (§4.4 / the MV3 cold start). Omitted
	 * by a caller that hands the session real settings synchronously, which is every harness.
	 */
	settingsKnown?: (() => boolean) | undefined;
	/** Something the panel snapshot reflects changed. */
	notify(): void;
	/** `chrome.tts.speak` through the service's wrapper. */
	speak(text: string): Promise<void>;
	/** Task 34: pre-load the ChessMimic band for a target Elo before the first move. */
	warmTiming?: ((targetElo: number) => void) | undefined;
	/** Policy inference for Maia-led and assisted selection; absent uses the engine fallback. */
	policy?: PolicyPort | undefined;
	/** Synchronize model preloading; engine-only targets clear reconnect warming. */
	warmPolicy?: ((targetElo: number) => void) | undefined;
	/** The session became live / stopped being live (the registry holds `Keepalive`). */
	onLivenessChanged?: (() => void) | undefined;
	now?: () => number;
	scheduler?: Scheduler;
	/** Per-tab base seed; every per-game seed is derived from it. */
	seed?: string;
}

/** The opponent's player card, as the content script last read it. */
export interface OpponentInfo {
	isBot: boolean;
	name: string;
	ratingEstimate: number | null;
	/** The card's title ("FM", "GM", …) when the opponent is titled (2026-09-13). */
	title?: string;
}
