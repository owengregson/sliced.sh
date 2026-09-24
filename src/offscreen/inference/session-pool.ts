// src/offscreen/inference/session-pool.ts
/**
 * The resident onnxruntime sessions of one model family, keyed by band or size: the loads in
 * flight (shared by concurrent callers), the sessions whose load completed, and the LRU order
 * that caps how many stay resident.
 *
 * Releasing: a session that has finished loading is released by `release`; one still loading is
 * released by `adopt`'s settle handler when it sees the pool no longer holds its promise.
 * Exactly one of the two runs, so `release()` is never called twice on one session.
 */

import type { OrtSession } from "../ort-loader";

export interface SessionPoolOptions<K> {
	/** Most sessions kept resident (at least 1). */
	max: number;
	/** Frees a session's memory (the family decides whether it waits for running queries). */
	releaseSession(session: OrtSession): void;
	/** Called after `key` left the pool, for the family's log line. */
	onRelease(key: K, why: string): void;
	/** Why the LRU cap dropped a key. */
	evictReason: string;
}

export interface AdoptHooks {
	/** The load completed and the session is resident. */
	onLoaded(): void;
	/** The load failed; the key has already left the pool. */
	onFailed(error: unknown): void;
}

export class SessionPool<K> {
	private readonly sessions = new Map<K, Promise<OrtSession>>();
	/** Sessions whose load has completed (released synchronously on eviction / dispose). */
	private readonly ready = new Map<K, OrtSession>();
	/** Most recently used last. */
	private readonly lru: K[] = [];

	constructor(private readonly options: SessionPoolOptions<K>) {}

	/** The load (or loaded session) for `key`, if the pool holds one. */
	get(key: K): Promise<OrtSession> | undefined {
		return this.sessions.get(key);
	}

	has(key: K): boolean {
		return this.sessions.has(key);
	}

	/** Mark `key` most recently used. */
	touch(key: K): void {
		const at = this.lru.indexOf(key);
		if (at >= 0) this.lru.splice(at, 1);
		this.lru.push(key);
	}

	/** The most recently used key, if any. */
	mostRecent(): K | null {
		return this.lru.length > 0 ? (this.lru[this.lru.length - 1] ?? null) : null;
	}

	/** Drop the least recently used keys beyond the cap. */
	evictBeyondLimit(): void {
		while (this.lru.length > this.options.max) {
			const victim = this.lru.shift();
			if (victim === undefined) break;
			this.release(victim, this.options.evictReason);
		}
	}

	/** Drop `key`'s session (see the module note on who releases a load still in flight). */
	release(key: K, why: string): void {
		this.sessions.delete(key);
		const s = this.ready.get(key);
		this.ready.delete(key);
		if (s) this.options.releaseSession(s);
		this.options.onRelease(key, why);
	}

	/** Release every session and forget the LRU order. */
	releaseAll(why: string): void {
		for (const key of [...this.sessions.keys()]) this.release(key, why);
		this.lru.length = 0;
	}

	/** Hold `load` as `key`'s session and settle it into the pool (or out of it) when it lands. */
	adopt(key: K, load: Promise<OrtSession>, hooks: AdoptHooks): void {
		this.sessions.set(key, load);
		load.then(
			(session) => {
				if (this.sessions.get(key) === load) {
					this.ready.set(key, session);
					hooks.onLoaded();
				} else this.options.releaseSession(session); // evicted or disposed while loading
			},
			(error: unknown) => {
				if (this.sessions.get(key) === load) this.sessions.delete(key);
				const at = this.lru.indexOf(key);
				if (at >= 0) this.lru.splice(at, 1);
				hooks.onFailed(error);
			}
		);
	}
}
