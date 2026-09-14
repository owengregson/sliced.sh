// test/service/handlers/policy-infer.test.ts — 2026-09-11: the service-worker side of the Maia-3
// policy port (`createPolicyInferPort` correlates `policy` → `policy-result`, expires a query the
// host never answers, honours the preparation's abort, and warms by posting `policy-warm`).
import { describe, expect, it } from "bun:test";
import { MAIA } from "@core/constants/maia";
import type { EnginePortCommand, EnginePortMessage } from "@core/constants/messages";
import type { PolicyInferenceInputs } from "@core/policy/types";
import type { TimerScheduler } from "@core/util/scheduler";
import { createPolicyInferPort } from "@service/handlers/engine/policy-infer";

function fakePort() {
	const posted: EnginePortCommand[] = [];
	const listeners = new Set<(m: EnginePortMessage) => void>();
	return {
		posted,
		post(cmd: EnginePortCommand) {
			posted.push(cmd);
		},
		onMessage(cb: (m: EnginePortMessage) => void) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		emit(m: EnginePortMessage) {
			for (const l of [...listeners]) l(m);
		},
		listeners,
	};
}

interface FakeScheduler extends TimerScheduler {
	advance(ms: number): void;
	count(): number;
}

function makeScheduler(): FakeScheduler {
	let nextId = 1;
	let clock = 0;
	let timers = new Map<number, { fn: () => void; at: number }>();
	return {
		setTimeout(fn, ms) {
			const id = nextId++;
			timers.set(id, { fn, at: clock + ms });
			return id;
		},
		clearTimeout(handle) {
			timers.delete(handle as number);
		},
		now: () => clock,
		advance(ms) {
			clock += ms;
			const due = [...timers].filter(([, t]) => t.at <= clock);
			timers = new Map([...timers].filter(([, t]) => t.at > clock));
			for (const [, t] of due) t.fn();
		},
		count: () => timers.size,
	};
}

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const inputs: PolicyInferenceInputs = {
	size: "79m",
	fen: START,
	historyFens: [START],
	selfElo: 1500,
	oppoElo: 1550,
};
const moves: Array<[string, number]> = [
	["e2e4", 0.6],
	["d2d4", 0.4],
];
const wdl: [number, number, number] = [0.3, 0.4, 0.3];

describe("createPolicyInferPort", () => {
	it("posts a policy command with a unique id and resolves with the matching result", async () => {
		const port = fakePort();
		const client = createPolicyInferPort(port);
		const p1 = client.infer(inputs);
		const p2 = client.infer({ ...inputs, size: "79m" });
		expect(port.posted).toHaveLength(2);
		const [c1, c2] = port.posted;
		if (c1?.kind !== "policy" || c2?.kind !== "policy") throw new Error("expected policy commands");
		expect(c1.id).not.toBe(c2.id);
		expect(c1.inputs).toEqual(inputs);
		port.emit({ kind: "policy-result", id: c2.id, moves, wdl, size: "79m", ms: 31 });
		port.emit({ kind: "policy-result", id: "unknown", moves, wdl, size: "79m" });
		port.emit({ kind: "policy-result", id: c1.id, moves, wdl, size: "79m", ms: 30 });
		expect(await p1).toEqual({ moves, wdl, size: "79m", ms: 30 });
		expect(await p2).toEqual({ moves, wdl, size: "79m", ms: 31 });
		expect(client.pendingCount()).toBe(0);
	});
	it("resolves null on an error result (the pipeline uses the engine's own policy)", async () => {
		const port = fakePort();
		const client = createPolicyInferPort(port);
		const p = client.infer(inputs);
		const c = port.posted[0];
		if (c?.kind !== "policy") throw new Error("expected policy command");
		port.emit({ kind: "policy-result", id: c.id, moves: null, size: "79m", error: "not-available" });
		expect(await p).toBeNull();
	});
	it("expires a query the host never answers after MAIA.inferenceBudgetMs by default", async () => {
		const port = fakePort();
		const sched = makeScheduler();
		const client = createPolicyInferPort(port, { scheduler: sched });
		const answers = Array.from({ length: 10 }, () => client.infer(inputs));
		expect(client.pendingCount()).toBe(10);
		sched.advance(MAIA.inferenceBudgetMs - 1);
		expect(client.pendingCount()).toBe(10);
		sched.advance(1);
		expect(await Promise.all(answers)).toEqual(new Array<null>(10).fill(null));
		expect(client.pendingCount()).toBe(0);
		expect(sched.count()).toBe(0);
	});
	it("a preparation budget overrides the default, and its abort settles the query with null", async () => {
		const port = fakePort();
		const sched = makeScheduler();
		const client = createPolicyInferPort(port, { scheduler: sched, budgetMs: 100 });
		const slow = client.infer(inputs, { budgetMs: 600 });
		sched.advance(200);
		expect(client.pendingCount()).toBe(1);
		const cmd = port.posted[0];
		if (cmd?.kind !== "policy") throw new Error("missing request");
		port.emit({ kind: "policy-result", id: cmd.id, moves, wdl, size: "79m", ms: 200 });
		expect((await slow)?.moves).toEqual(moves);
		const controller = new AbortController();
		const aborted = client.infer(inputs, { budgetMs: 600, signal: controller.signal });
		expect(client.pendingCount()).toBe(1);
		controller.abort();
		expect(await aborted).toBeNull();
		expect(client.pendingCount()).toBe(0);
		expect(sched.count()).toBe(0);
		// An already-aborted signal never posts.
		const count = port.posted.length;
		expect(await client.infer(inputs, { signal: controller.signal })).toBeNull();
		expect(port.posted).toHaveLength(count);
		client.dispose();
	});
	it("a query answered inside the budget clears its expiry; a late duplicate is ignored", async () => {
		const port = fakePort();
		const sched = makeScheduler();
		const client = createPolicyInferPort(port, { scheduler: sched, budgetMs: 100 });
		const p = client.infer(inputs);
		const c = port.posted[0];
		if (c?.kind !== "policy") throw new Error("expected policy command");
		port.emit({ kind: "policy-result", id: c.id, moves, wdl, size: "79m" });
		expect(await p).toEqual({ moves, wdl, size: "79m" });
		expect(sched.count()).toBe(0);
		port.emit({ kind: "policy-result", id: c.id, moves, wdl, size: "79m" });
		sched.advance(1_000);
		expect(client.pendingCount()).toBe(0);
	});
	it("warm posts policy-warm, policy-status is consumed, and dispose settles pending queries with null", async () => {
		const port = fakePort();
		const client = createPolicyInferPort(port);
		client.warm("79m");
		expect(port.posted).toEqual([{ kind: "policy-warm", size: "79m" }]);
		// Status replies are diagnostics: neither shape throws or disturbs a pending query.
		const p = client.infer(inputs);
		port.emit({ kind: "policy-status", size: "79m", loadMs: 812 });
		port.emit({ kind: "policy-status", size: null, error: "no session available" });
		expect(client.pendingCount()).toBe(1);
		client.dispose();
		expect(await p).toBeNull();
		expect(port.listeners.size).toBe(0);
		expect(client.pendingCount()).toBe(0);
		client.warm("79m"); // after dispose: dropped
		expect(port.posted).toHaveLength(2);
	});
});
