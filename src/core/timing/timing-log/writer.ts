/** The timing log's ring buffer and its persistence under `LOCAL_KEYS.timingLog`. */
import { chromeLocalGet, chromeLocalSet } from "@core/chrome/storage";
import { LIMITS } from "@core/constants/limits";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import type { MoveTelemetryRecord } from "@typedefs/telemetry";
import type { TimingLogEntry } from "@typedefs/timing";

/** In-memory ring buffer with explicit persistence; no timers of its own. */
export class TimingLogWriter {
	private buffer: TimingLogEntry[] = [];
	private dirty = false;
	private revision = 0;
	private clearRevision = 0;
	private loading: Promise<void> | null = null;
	private writes: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly max: number = LIMITS.timingLogMax,
		private readonly onEntry?: (entry: TimingLogEntry) => void
	) {}

	append(entry: TimingLogEntry): void {
		this.buffer.push(entry);
		if (this.buffer.length > this.max) this.buffer.splice(0, this.buffer.length - this.max);
		this.dirty = true;
		this.revision++;
		this.onEntry?.(entry);
	}

	/**
	 * Append `entry`, or update the row it belongs to. `TimingModel` re-sends the *same object*
	 * to its `onEntry` sink whenever `observe()` fills in the realised time, so a sink that
	 * always appended would put the same row in the ring several times — and, because they are
	 * one object, a later `markActual` / `attachTelemetry` would appear to hit all of them.
	 * Callers that receive model entries use this; a caller building rows itself uses `append`.
	 */
	upsert(entry: TimingLogEntry): void {
		const at = this.buffer.lastIndexOf(entry);
		if (at >= 0) {
			this.dirty = true;
			this.revision++;
			this.onEntry?.(entry);
			return;
		}
		for (let i = this.buffer.length - 1; i >= 0; i--) {
			const e = this.buffer[i];
			if (e && e.gameId === entry.gameId && e.ply === entry.ply) {
				this.buffer[i] = entry;
				this.dirty = true;
				this.revision++;
				this.onEntry?.(entry);
				return;
			}
		}
		this.append(entry);
	}

	/** Record the realised think time on the entry for `(gameId, ply)` (latest match). */
	markActual(gameId: string, ply: number, actualMs: number | null, executionMs?: number): boolean {
		for (let i = this.buffer.length - 1; i >= 0; i--) {
			const e = this.buffer[i];
			if (e && e.gameId === gameId && e.ply === ply) {
				e.actualMs = actualMs;
				if (executionMs !== undefined) e.executionMs = executionMs;
				this.dirty = true;
				this.revision++;
				this.onEntry?.(e);
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
				this.revision++;
				this.onEntry?.(e);
				return true;
			}
		}
		return false;
	}

	entries(): readonly TimingLogEntry[] {
		return this.buffer;
	}

	/** Persist when something changed; resolves `true` if a write happened. */
	flush(): Promise<boolean> {
		const write = this.writes.then(async () => {
			await this.loading;
			if (!this.dirty) return false;
			const revision = this.revision;
			await chromeLocalSet(
				LOCAL_KEYS.timingLog,
				this.buffer.map((e) => ({ ...e }))
			);
			// A move or Clear arriving during storage I/O must remain dirty for the next flush.
			if (this.revision === revision) this.dirty = false;
			return true;
		});
		this.writes = write.catch(() => {});
		return write;
	}

	/** Replace the buffer with what is stored (call once at start-up). */
	load(): Promise<void> {
		if (this.loading) return this.loading;
		const revision = this.revision;
		const cleared = this.clearRevision;
		const read = chromeLocalGet(LOCAL_KEYS.timingLog).then((stored) => {
			if (this.clearRevision !== cleared) return;
			const saved = Array.isArray(stored) ? stored : [];
			if (this.revision === revision) {
				this.buffer = saved.slice(-this.max);
				this.dirty = false;
			} else {
				// Startup can already receive moves while the storage read is pending.
				const fresh = this.buffer;
				this.buffer = [
					...saved.filter(
						(old) => !fresh.some((row) => row.gameId === old.gameId && row.ply === old.ply)
					),
					...fresh,
				].slice(-this.max);
			}
		});
		this.loading = read.finally(() => {
			this.loading = null;
		});
		return this.loading;
	}

	clear(): void {
		this.buffer = [];
		this.dirty = true;
		this.revision++;
		this.clearRevision++;
	}

	dispose(): void {
		this.buffer = [];
		this.dirty = false;
	}
}
