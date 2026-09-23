/**
 * §4.3: re-ask the site for a time control it has not given us yet.
 *
 * `timeControl.get()` is `null` until the game actually starts, and two page signals normally
 * land at that moment — the bridge's own `CreateGame` / `ModeChanged` event and the active
 * clock gaining its turn class, both of which `schedule()` a re-evaluation that re-reads the
 * bridge. Neither is guaranteed, and a first move planned without the time control runs the
 * entire clockless branch, so this is the bounded safety net: while the page *shows clocks*
 * (a timed game) and the site has not answered, ask again on a slow timer. Passive reads only
 * (§13.3), capped per game, and never armed for a page with no clocks at all — an untimed
 * computer game is not waiting for an answer, it has none.
 */

import { TIME_CONTROL, TIMINGS } from "@core/constants/timings";
import type { AdapterReading } from "../contract";

export interface TimeControlProbeHost {
	destroyed(): boolean;
	/** Whether the bridge's page side is up (there is nobody to re-ask otherwise). */
	bridgeReady(): boolean;
	/** Re-evaluate the page (which re-reads the bridge). */
	schedule(): void;
}

export class TimeControlProbe {
	private timer: ReturnType<typeof setTimeout> | null = null;
	/** Bridge re-asks spent on a time control this game has not been told (`TIME_CONTROL.maxProbes`). */
	private probes = 0;

	constructor(private readonly host: TimeControlProbeHost) {}

	/** Arm one re-ask for `reading`, if it still lacks a time control and the page shows clocks. */
	arm(reading: AdapterReading): void {
		if (this.host.destroyed() || this.timer !== null) return;
		if (reading.snapshot.timeControl !== undefined) return;
		if (this.probes >= TIME_CONTROL.maxProbes) return;
		const { w, b } = reading.snapshot.clocks;
		if (w.ms <= 0 && b.ms <= 0) return;
		if (!this.host.bridgeReady()) return;
		this.probes += 1;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.host.schedule();
		}, TIMINGS.adapterTimeControlRetryMs);
	}

	/** A new game has its own budget of re-asks. */
	newGame(): void {
		this.probes = 0;
	}

	dispose(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}
}
