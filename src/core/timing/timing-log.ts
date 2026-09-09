/**
 * Timing log (§8.6): a `TimingLogEntry` per planned move in a
 * `LIMITS.timingLogMax`-entry ring buffer persisted under
 * `LOCAL_KEYS.timingLog`. The service worker calls `flush()` on the
 * `ALARM_NAMES.timingLogFlush` alarm and on game end; the Engine view exports
 * the rows as JSON.
 */

import { chromeLocalGet, chromeLocalSet } from "@core/chrome/storage";
import { LIMITS } from "@core/constants/limits";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import type { PersonaId } from "@typedefs/settings";
import type { MoveTelemetryRecord } from "@typedefs/telemetry";
import type { TimingLogEntry, TimingMode } from "@typedefs/timing";

const TOP_TERMS = 5;

export interface TimingLogInput {
	gameId: string;
	ply: number;
	mode: TimingMode;
	plannedMs: number;
	alloc: number;
	clockMs: number;
	comp: number;
	eps: number;
	/** All `β_i f_i` contributions; the entry keeps the top 5 by |value|. */
	terms: ReadonlyArray<readonly [string, number]>;
	persona: PersonaId;
}

export function buildTimingLogEntry(input: TimingLogInput): TimingLogEntry {
	const topTerms = [...input.terms]
		.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
		.slice(0, TOP_TERMS)
		.map(([name, value]): [string, number] => [name, value]);
	return {
		gameId: input.gameId,
		ply: input.ply,
		mode: input.mode,
		plannedMs: input.plannedMs,
		actualMs: null,
		alloc: input.alloc,
		clockMs: input.clockMs,
		comp: input.comp,
		eps: input.eps,
		topTerms,
		persona: input.persona,
	};
}

/** In-memory ring buffer with explicit persistence; no timers of its own. */
export class TimingLogWriter {
	private buffer: TimingLogEntry[] = [];
	private dirty = false;

	constructor(private readonly max: number = LIMITS.timingLogMax) {}

	append(entry: TimingLogEntry): void {
		this.buffer.push(entry);
		if (this.buffer.length > this.max) this.buffer.splice(0, this.buffer.length - this.max);
		this.dirty = true;
	}

	/** Record the realised think time on the entry for `(gameId, ply)` (latest match). */
	markActual(gameId: string, ply: number, actualMs: number): boolean {
		for (let i = this.buffer.length - 1; i >= 0; i--) {
			const e = this.buffer[i];
			if (e && e.gameId === gameId && e.ply === ply) {
				e.actualMs = actualMs;
				this.dirty = true;
				return true;
			}
		}
		return false;
	}

	/**
	 * Attach the move's §13.2 telemetry record to the entry for `(gameId, ply)`
	 * (latest match). Task 30's `GameSession` calls it once the execution result is in.
	 */
	attachTelemetry(gameId: string, ply: number, telemetry: MoveTelemetryRecord): boolean {
		for (let i = this.buffer.length - 1; i >= 0; i--) {
			const e = this.buffer[i];
			if (e && e.gameId === gameId && e.ply === ply) {
				e.telemetry = telemetry;
				this.dirty = true;
				return true;
			}
		}
		return false;
	}

	entries(): readonly TimingLogEntry[] {
		return this.buffer;
	}

	/** Persist when something changed; resolves `true` if a write happened. */
	async flush(): Promise<boolean> {
		if (!this.dirty) return false;
		await chromeLocalSet(
			LOCAL_KEYS.timingLog,
			this.buffer.map((e) => ({ ...e }))
		);
		this.dirty = false;
		return true;
	}

	/** Replace the buffer with what is stored (call once at start-up). */
	async load(): Promise<void> {
		const stored = await chromeLocalGet(LOCAL_KEYS.timingLog);
		this.buffer = Array.isArray(stored) ? stored.slice(-this.max) : [];
		this.dirty = false;
	}

	clear(): void {
		this.buffer = [];
		this.dirty = true;
	}

	dispose(): void {
		this.buffer = [];
		this.dirty = false;
	}
}
