/**
 * `SiteAdapter.observeMove`: watch the page until a move the hand submitted has landed, or has
 * snapped back, or the watch times out. Two proofs, in order of strength:
 *
 *   - with the move's source position (`expected.beforeFen`), `createMoveProof` — the move must be
 *     the legal successor of that exact position, corroborated by an independent reading;
 *   - without one, the piece standing on its destination with its origin empty, confirmed by the
 *     move list (or the last-move marks), else by a short settle (`TIMINGS.adapterMoveConfirmMs`).
 */

import type { ExpectedMove } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import type { BridgeState } from "../bridge-protocol";
import type { MoveWatch } from "../contract";
import { pieceAt, placementOf } from "../dom-fen";
import { createMoveProof } from "../move-proof";

const MOVE_CONFIRM_MS = TIMINGS.adapterMoveConfirmMs;

export interface MoveObservationHost {
	readonly doc: Document;
	/** The site adapter's view of the board for this watch. */
	watchMove(): MoveWatch;
	/** A fresh bridge answer (`null` when the bridge is absent or slow). */
	refreshBridgeState(): Promise<BridgeState | null>;
	observerCtor(): typeof MutationObserver;
}

export function observeMove(
	host: MoveObservationHost,
	expected: ExpectedMove,
	timeoutMs: number
): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const initial = host.watchMove();
		const proof = createMoveProof(expected);
		if (initial.independentPlacement !== false && proof?.(initial)) {
			resolve(true);
			return;
		}
		const mover = initial.placement ? pieceAt(initial.placement, expected.from) : null;
		if (!mover && !proof) {
			resolve(false);
			return;
		}
		const wantAtDest = expected.promotion
			? mover === mover?.toUpperCase()
				? expected.promotion.toUpperCase()
				: expected.promotion
			: mover;
		let landed = false;
		let done = false;
		let checkingBridge = false;
		let confirmTimer: ReturnType<typeof setTimeout> | null = null;
		const Observer = host.observerCtor();
		const observer = new Observer(() => check());
		const finish = (ok: boolean): void => {
			if (done) return;
			done = true;
			observer.disconnect();
			clearTimeout(timeout);
			if (confirmTimer !== null) clearTimeout(confirmTimer);
			resolve(ok);
		};
		const timeout = setTimeout(() => finish(landed), timeoutMs);
		const check = (): void => {
			if (done) return;
			const now = host.watchMove();
			if (proof) {
				if (now.independentPlacement === false) {
					if (checkingBridge) return;
					checkingBridge = true;
					void host.refreshBridgeState().then((state) => {
						checkingBridge = false;
						if (done) return;
						const latest = host.watchMove();
						if (latest.independentPlacement !== false) {
							if (proof(latest)) finish(true);
							return;
						}
						// A canvas move list cannot corroborate its own replay. Use only the FEN
						// returned by this fresh request, never an older value merged into the cache.
						const fen = state?.fen;
						if (
							typeof fen === "string" &&
							proof({ ...latest, fen, placement: placementOf(fen), independentPlacement: true })
						)
							finish(true);
					});
					return;
				}
				if (proof(now)) finish(true);
				return;
			}
			if (!now.placement) return;
			const atFrom = pieceAt(now.placement, expected.from);
			const atTo = pieceAt(now.placement, expected.to);
			if (atTo === wantAtDest && atFrom === null) {
				const confirmed =
					now.moveCount > initial.moveCount ||
					(now.lastMoveSquares.includes(expected.from) && now.lastMoveSquares.includes(expected.to));
				if (confirmed) {
					finish(true);
					return;
				}
				if (!landed) {
					landed = true;
					confirmTimer = setTimeout(
						() => {
							const p = host.watchMove().placement;
							finish(p !== null && pieceAt(p, expected.to) === wantAtDest);
						},
						Math.min(MOVE_CONFIRM_MS, timeoutMs)
					);
				}
				return;
			}
			if (landed && atFrom === mover) finish(false); // snapped back
		};
		observer.observe(host.doc.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["class", "style"],
		});
		check();
		// Canvas-only state can advance without another DOM mutation while this watch is open.
		if (proof && initial.independentPlacement !== false) void host.refreshBridgeState().then(check);
	});
}
