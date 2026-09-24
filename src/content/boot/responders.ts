/**
 * The executor's reads of the board, answered on the game port:
 *   - `observeMove` — the verifier (it never touches the board's marks — the mark of the move
 *     being submitted belongs to the hand's whole action);
 *   - `geometry` — square/board rects plus colour-aware occupancy; with `promotion` it waits for
 *     the picker on `to` and reports its rect;
 *   - `boardCheck` — the executor's colour-aware position guard;
 *   - `cursorProbe` — the bridge closure's last trusted position, else the tracker's.
 */

import {
	BRIDGE_KINDS,
	type PageBridge,
	type Rect,
	type SiteAdapter,
	toRect,
} from "@content/adapters/adapter";
import { occupancyOf, waitForPromotionRect } from "@content/board-state";
import type { CursorTracker } from "@content/cursor-tracker";
import type { BridgeCursor } from "@content/page-bridge-client";
import { ALL_SQUARES, squareOf } from "@core/chess/squares";
import { EXECUTOR } from "@core/constants/cdp";
import type { GamePortCommand, GamePortMessage } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import type { Square } from "@typedefs/game";

type ObserveMoveCommand = Extract<GamePortCommand, { kind: "observeMove" }>;
type GeometryCommand = Extract<GamePortCommand, { kind: "geometry" }>;
type BoardCheckCommand = Extract<GamePortCommand, { kind: "boardCheck" }>;

const EMPTY_RECT: Rect = toRect({ x: 0, y: 0, width: 0, height: 0 });

export interface Responders {
	observeMove(cmd: ObserveMoveCommand): void;
	/** `geometry`, with or without a promotion picker to wait for. */
	geometry(cmd: GeometryCommand): void;
	boardCheck(cmd: BoardCheckCommand): void;
	cursorProbe(id: string): void;
}

export interface RespondersDeps {
	adapter: SiteAdapter;
	bridge: PageBridge;
	cursor: CursorTracker;
	post(msg: GamePortMessage): void;
	disposed(): boolean;
}

export function createResponders(deps: RespondersDeps): Responders {
	const { adapter, bridge, cursor, post, disposed } = deps;

	/**
	 * `observeMove` is the executor's **verifier**, and it must not touch the board's marks.
	 *
	 * It used to clear them first, on §13.3 rule 4 ("no mark may be present at move-submission
	 * time"). The owner has overruled that rule for the mark of the move being submitted
	 * (2026-09-10), and the clear here was the reason it could not hold: `runWithRetry` issues a
	 * `verify` after every attempt and a `recheck` before every retry
	 * (`src/service/move-executor/retry-policy.ts`, the `recheck` before each subsequent attempt and
	 * the `verify` after each), both of which are an `observeMove`, so the second attempt — a whole
	 * second visible action, and since click-to-move was removed a second *drag* — ran with nothing
	 * on the board. The only clear now is
	 * completion: `GameSession.onExecuted` for a move that landed, `onNotExecuted` for an attempt
	 * that finally failed. `highlightMoves` going off still clears, which is a different thing.
	 */
	const observeMove = (cmd: ObserveMoveCommand): void => {
		if (disposed()) return;
		cursor.beginHand();
		adapter
			.observeMove(cmd.expected, cmd.timeoutMs)
			.then((ok) => {
				const real = cursor.endHand();
				if (real > 0) log.debug("content: real pointer events during hand", real);
				post(
					ok
						? { kind: "observeMoveResult", id: cmd.id, ok }
						: { kind: "observeMoveResult", id: cmd.id, ok, reason: "not-landed" }
				);
			})
			.catch((error: unknown) => {
				cursor.endHand();
				post({
					kind: "observeMoveResult",
					id: cmd.id,
					ok: false,
					reason: error instanceof Error ? error.message : String(error),
				});
			});
	};

	const geometry = (id: string): GamePortMessage => {
		const boardRect = adapter.getBoardRect();
		const flipped = adapter.isFlipped();
		if (!boardRect || !(boardRect.width > 0)) {
			return { kind: "geometryResult", id, boardRect: EMPTY_RECT, flipped };
		}
		const squares: Partial<Record<Square, Rect>> = {};
		for (let file = 0; file < 8; file += 1) {
			for (let rank = 0; rank < 8; rank += 1) {
				const sq = squareOf(file, rank);
				const r = sq ? adapter.squareRect(sq) : null;
				if (sq && r) squares[sq] = r;
			}
		}
		const reply: GamePortMessage = {
			kind: "geometryResult",
			id,
			boardRect,
			squares: squares as Record<Square, Rect>,
			flipped,
		};
		// The preview planner's deselect choice needs to know what stands where (§9.3a), and the
		// executor's position guard answers from the same read instead of a second round trip.
		const occupancy = occupancyOf(adapter, ALL_SQUARES);
		if (Object.keys(occupancy).length > 0) reply.occupancy = occupancy;
		return reply;
	};

	/** Task 30: `geometry { promotion, to }` — wait for the picker, then answer with its rect. */
	const promotionGeometry = (cmd: GeometryCommand): void => {
		const piece = cmd.promotion;
		const dest = cmd.to;
		const base = geometry(cmd.id);
		if (piece === undefined || dest === undefined || base.kind !== "geometryResult") {
			post({ ...base, promotion: null } as GamePortMessage);
			return;
		}
		void waitForPromotionRect(adapter, dest, piece, {
			timeoutMs: cmd.timeoutMs ?? EXECUTOR.promotionPickerTimeoutMs,
		}).then((rect) => {
			if (disposed()) return;
			// The board may have moved while the picker was opening: re-read the rects.
			const fresh = geometry(cmd.id);
			post(fresh.kind === "geometryResult" ? { ...fresh, promotion: rect } : fresh);
		});
	};

	/**
	 * Task 30: the executor's colour-aware pre-dispatch guard (§9.3). Answers at once with
	 * `own` / `enemy` / `empty` for exactly the squares asked, relative to the side the hand
	 * plays; a square the adapter cannot classify is omitted and the executor dispatches nothing.
	 */
	const boardCheck = (cmd: BoardCheckCommand): void => {
		post({ kind: "boardCheckResult", id: cmd.id, occupancy: occupancyOf(adapter, cmd.squares) });
	};

	/** §5.5 `cursor-probe`: the bridge closure's last trusted position, else the tracker's. */
	const cursorProbe = (id: string): void => {
		const answer = (c: BridgeCursor | null): void => {
			const position = c ? { x: c.x, y: c.y, t: c.t, real: true as const } : cursor.report();
			post({ kind: "cursorProbeResult", id, position });
		};
		if (!bridge.isAvailable()) {
			answer(null);
			return;
		}
		bridge
			.call<BridgeCursor | null>(BRIDGE_KINDS.cursor, undefined, TIMINGS.adapterBridgeTimeoutMs)
			.then(answer)
			.catch(() => answer(null));
	};

	return {
		observeMove,
		geometry(cmd) {
			if (cmd.promotion !== undefined) promotionGeometry(cmd);
			else post(geometry(cmd.id));
		},
		boardCheck,
		cursorProbe,
	};
}
