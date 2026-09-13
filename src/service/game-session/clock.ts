import type { PositionSnapshot } from "@typedefs/game";

/** Project a captured running clock to the instant a decision is made. */
export function remainingClockMs(
	snapshot: PositionSnapshot,
	color: "w" | "b",
	nowMs: number
): number {
	const clock = snapshot.clocks[color];
	return Math.max(0, clock.ms - (clock.running ? Math.max(0, nowMs - snapshot.capturedAt) : 0));
}
