// test/behavioral/panel/harness.ts — fakes for the panel ↔ SW behavioural tests (Task 28).
// `GameSessionRegistry` does not exist yet (Task 30); these drive the broadcaster's
// `SnapshotSources` read interfaces by hand.
import type {
	ExecutorHandle,
	HandSources,
	OpponentView,
	SessionGameView,
	SessionSource,
	SnapshotSources,
} from "@service/panel-broadcaster";
import type { EngineStatus } from "@typedefs/engine";
import type { Recommendation, Site, Square } from "@typedefs/game";
import type { LicenseState } from "@typedefs/settings";
import type { TimingPlan } from "@typedefs/timing";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** A hand-driven stand-in for Task 30's `GameSession` (what the broadcaster reads). */
export class FakeSession implements SessionSource {
	game: SessionGameView;
	rec: Recommendation | null = null;
	opp: OpponentView | null = null;
	/**
	 * The hand this stand-in schedules on. `handArmed()` and `playNowRequested()` are the session's
	 * halves of `PANEL_SET_AUTO_MOVE` and `PANEL_PLAY_NOW` (both handlers stopped doing it themselves,
	 * so that the double-move gate, the §8.5 re-plan and the `MoveContext` live in one place), so a
	 * fake session has to play those parts too.
	 */
	hand: ExecutorHandle | null = null;

	constructor(site: Site) {
		this.game = {
			state: "waiting-for-game",
			gameId: null,
			site,
			pageKind: "live-lobby",
			myColor: null,
			sideToMove: null,
			ply: 0,
			clocks: null,
		};
	}

	/** Put the session in `live:my-turn:recommended` with `rec` as the current recommendation. */
	recommend(rec: Recommendation, ply = 1): void {
		this.game = {
			...this.game,
			state: "live:my-turn:recommended",
			gameId: "g1",
			pageKind: "live-game",
			myColor: "w",
			sideToMove: "w",
			ply,
			clocks: { w: { ms: 180_000, running: true }, b: { ms: 180_000, running: false } },
		};
		this.rec = rec;
	}

	view(): SessionGameView {
		return { ...this.game };
	}
	recommendation(): Recommendation | null {
		return this.rec;
	}
	opponent(): OpponentView | null {
		return this.opp;
	}
	/** What the real `GameSession.playNowRequested()` does, with this fake's own state. */
	playNowRequested(): Promise<boolean> {
		const hand = this.hand;
		if (!hand) return Promise.resolve(false);
		// `pendingMove()` may be a replacement parked behind a cancelled run, which the no-arg
		// `playNow()` ignores: play the reported move explicitly.
		const rec = hand.pendingMove()?.rec ?? this.rec;
		if (!rec) return Promise.resolve(false);
		void hand.playNow(rec, rec.plan);
		return Promise.resolve(true);
	}
	/** What the real `GameSession.handArmed()` does, with this fake's own state. */
	handArmed(): Promise<void> {
		const rec = this.rec;
		const hand = this.hand;
		if (rec && hand && this.game.state === "live:my-turn:recommended" && hand.pendingMove() === null)
			hand.schedule(rec, rec.plan);
		return Promise.resolve();
	}
}

export interface FakeSourcesOptions {
	sessions: Map<number, FakeSession>;
	executors?: Map<number, ExecutorHandle>;
	hand?: HandSources | null;
	license: () => LicenseState;
	engine?: () => EngineStatus | undefined;
}

export function fakeSources(o: FakeSourcesOptions): SnapshotSources {
	return {
		session: (tabId) => o.sessions.get(tabId) ?? null,
		executor: (tabId) => o.executors?.get(tabId) ?? null,
		hand: o.hand ?? null,
		engineStatus: () => o.engine?.(),
		license: o.license,
	};
}

/** A plan whose hand starts `leadMs` from now and lands on `now + leadMs + thinkMs`. */
export function makePlan(now: number, thinkMs = 1200, leadMs = 0): TimingPlan {
	return {
		thinkMs,
		mode: "normal",
		preMoveHoverMs: thinkMs / 2,
		dragDurationMs: 300,
		deadlineMs: now + leadMs + thinkMs,
		rationale: [],
		features: {},
		orientationMs: thinkMs / 2,
		window: { orientationMs: thinkMs / 2, scanMs: 0, previewMs: 0, decisionMs: 0, approachMs: 300 },
	};
}

export function makeRecommendation(
	plan: TimingPlan,
	now: number,
	move: { from: Square; to: Square } = { from: "e2", to: "e4" }
): Recommendation {
	const uci = `${move.from}${move.to}`;
	return {
		chosen: {
			uci,
			san: uci,
			from: move.from,
			to: move.to,
			source: "engine-elo",
			rankInLines: 0,
			cpLoss: 0,
			rationale: [],
		},
		lines: [
			{ multipv: 1, score: { cp: 30 }, depth: 12, pvUci: [uci, "e7e5"], pvSan: [uci, "e5"] },
			{ multipv: 2, score: { cp: 20 }, depth: 12, pvUci: ["d2d4", "d7d5"], pvSan: ["d4", "d5"] },
		],
		eval: { cp: 30 },
		depth: 12,
		nps: 1_000_000,
		plan,
		computedAt: now,
		fen: START_FEN,
	};
}
