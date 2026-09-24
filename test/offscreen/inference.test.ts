// test/offscreen/inference.test.ts — the pieces the timing and policy hosts share: the doubling
// load cooldown, the resident-session pool, the release-after-run guard, the single-threaded
// retry, the thread cap, and the single-flight loader the asset stores share.
import { describe, expect, it } from "bun:test";
import { FailureBackoff } from "@offscreen/inference/failure-backoff";
import {
	cappedThreads,
	createSessionWithFallback,
	lazyRuntime,
} from "@offscreen/inference/ort-session";
import { RunGuard } from "@offscreen/inference/run-guard";
import { SessionPool } from "@offscreen/inference/session-pool";
import type { OrtRuntime, OrtSession } from "@offscreen/ort-loader";
import { SingleFlight } from "@offscreen/shared/single-flight";

function fakeSession(log: string[], name: string): OrtSession {
	return {
		run: async () => ({}),
		release: async () => {
			log.push(`release ${name}`);
		},
	};
}

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("FailureBackoff", () => {
	it("doubles the cooldown per consecutive failure up to the ceiling, and clears on success", () => {
		let t = 0;
		const backoff = new FailureBackoff<string>(() => t, { retryAfterMs: 100, retryMaxMs: 350 });
		expect(backoff.inCooldown("a")).toBe(false);
		expect(backoff.fail("a")).toBe(1);
		expect(backoff.inCooldown("a")).toBe(true);
		t = 100;
		expect(backoff.inCooldown("a")).toBe(false);
		expect(backoff.fail("a")).toBe(2);
		expect(backoff.cooldownFor(2)).toBe(200);
		expect(backoff.cooldownFor(3)).toBe(350);
		t = 299;
		expect(backoff.inCooldown("a")).toBe(true);
		backoff.clear("a");
		expect(backoff.count("a")).toBe(0);
		expect(backoff.inCooldown("a")).toBe(false);
	});

	it("never lets the ceiling fall under the first cooldown", () => {
		const backoff = new FailureBackoff<string>(() => 0, { retryAfterMs: 500, retryMaxMs: 10 });
		expect(backoff.cooldownFor(1)).toBe(500);
	});
});

describe("SessionPool", () => {
	function pool(log: string[], max = 1) {
		return new SessionPool<string>({
			max,
			releaseSession: (s) => void s.release(),
			onRelease: (key, why) => log.push(`drop ${key} ${why}`),
			evictReason: "lru",
		});
	}

	it("keeps the most recent sessions and evicts the least recently used", async () => {
		const log: string[] = [];
		const p = pool(log);
		const a = fakeSession(log, "a");
		p.adopt("a", Promise.resolve(a), { onLoaded: () => log.push("a ready"), onFailed: () => {} });
		p.touch("a");
		await Promise.resolve();
		await Promise.resolve();
		expect(p.mostRecent()).toBe("a");
		p.adopt("b", Promise.resolve(fakeSession(log, "b")), { onLoaded: () => {}, onFailed: () => {} });
		p.touch("b");
		p.evictBeyondLimit();
		await Promise.resolve();
		expect(log).toEqual(["a ready", "release a", "drop a lru"]);
		expect(p.has("a")).toBe(false);
		expect(p.mostRecent()).toBe("b");
	});

	it("releases a session evicted while it was still loading exactly once, when it lands", async () => {
		const log: string[] = [];
		const p = pool(log);
		const load = deferred<OrtSession>();
		p.adopt("a", load.promise, { onLoaded: () => log.push("loaded"), onFailed: () => {} });
		p.release("a", "dispose");
		load.resolve(fakeSession(log, "a"));
		await load.promise;
		await Promise.resolve();
		expect(log).toEqual(["drop a dispose", "release a"]);
	});

	it("forgets a failed load and reports it", async () => {
		const log: string[] = [];
		const p = pool(log);
		const load = deferred<OrtSession>();
		p.adopt("a", load.promise, {
			onLoaded: () => {},
			onFailed: (e) => log.push(`failed ${String(e)}`),
		});
		p.touch("a");
		load.reject("boom");
		await load.promise.catch(() => {});
		expect(log).toEqual(["failed boom"]);
		expect(p.has("a")).toBe(false);
		expect(p.mostRecent()).toBeNull();
	});
});

describe("RunGuard", () => {
	it("defers a release until the last run on the session settles", async () => {
		const log: string[] = [];
		const guard = new RunGuard();
		const s = fakeSession(log, "s");
		const gate = deferred<void>();
		const running = guard.run(s, () => gate.promise);
		guard.release(s);
		expect(log).toEqual([]);
		gate.resolve();
		await running;
		expect(log).toEqual(["release s"]);
		guard.release(fakeSession(log, "t"));
		expect(log).toEqual(["release s", "release t"]);
	});
});

describe("onnxruntime helpers", () => {
	it("retries once single-threaded when the threaded build cannot create a session", async () => {
		const threads: number[] = [];
		const rt: OrtRuntime = {
			threads: 4,
			setThreads(n) {
				rt.threads = n;
			},
			async createSession() {
				threads.push(rt.threads);
				if (rt.threads > 1) throw new Error("pthreads unavailable");
				return fakeSession([], "x");
			},
			tensor: () => ({ type: "float32", data: [], dims: [] }),
		};
		await createSessionWithFallback(rt, new Uint8Array(), "test");
		expect(threads).toEqual([4, 1]);
	});

	it("starts the runtime once", async () => {
		let calls = 0;
		const runtime = lazyRuntime(async () => {
			calls++;
			return {} as OrtRuntime;
		});
		expect(runtime()).toBe(runtime());
		await runtime();
		expect(calls).toBe(1);
	});

	it("caps threads at the limit and at the core count, never under one", () => {
		expect(cappedThreads(16, 4)).toBe(4);
		expect(cappedThreads(2.5, 4)).toBe(2);
		expect(cappedThreads(undefined, 4)).toBe(1);
		expect(cappedThreads(Number.NaN, 4)).toBe(1);
		expect(cappedThreads(0, 4)).toBe(1);
	});
});

describe("SingleFlight", () => {
	it("shares a load between concurrent callers and forgets it once settled", async () => {
		const flights = new SingleFlight<string, number>();
		let loads = 0;
		const load = async () => ++loads;
		const first = flights.run("k", load);
		expect(flights.run("k", load)).toBe(first);
		expect(await first).toBe(1);
		expect(await flights.run("k", load)).toBe(2);
	});
});
