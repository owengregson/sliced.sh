// test/offscreen/engine-host-parts.test.ts — the engine host's parts on their own: the info-line
// coalescer, the crash-reboot steps and the UCI line readers.
import { describe, expect, it } from "bun:test";
import { TIMINGS } from "@core/constants/timings";
import { InfoCoalescer } from "@offscreen/engine-host/info-coalescer";
import { RebootBackoff } from "@offscreen/engine-host/reboot-backoff";
import {
	idName,
	isBadNnue,
	multipvOf,
	npsOf,
	threadsOption,
} from "@offscreen/engine-host/uci-lines";
import { FakeScheduler } from "../fakes/engine-transport";

describe("InfoCoalescer", () => {
	it("keeps the newest line per multipv index and forwards them in index order", () => {
		const clock = new FakeScheduler();
		const out: string[] = [];
		const info = new InfoCoalescer(clock.scheduler, (line) => out.push(line));
		info.add(2, "b1");
		info.add(1, "a1");
		info.add(2, "b2");
		expect(out).toEqual([]);
		clock.advance(0);
		expect(out).toEqual(["a1", "b2"]);
	});

	it("waits out the forward interval after a flush, and a reset drops what is pending", () => {
		const clock = new FakeScheduler();
		const out: string[] = [];
		const info = new InfoCoalescer(clock.scheduler, (line) => out.push(line));
		info.add(1, "a");
		info.flush();
		info.add(1, "b");
		clock.advance(TIMINGS.engineInfoForwardMs - 1);
		expect(out).toEqual(["a"]);
		clock.advance(1);
		expect(out).toEqual(["a", "b"]);
		info.add(1, "c");
		info.reset();
		clock.advance(TIMINGS.engineInfoForwardMs);
		expect(out).toEqual(["a", "b"]);
		expect(clock.pending).toBe(0);
	});
});

describe("RebootBackoff", () => {
	it("arms one reboot per step and stops when the steps run out", () => {
		const clock = new FakeScheduler();
		const reboots = new RebootBackoff(clock.scheduler);
		let fired = 0;
		for (const wait of TIMINGS.engineRestartBackoffMs) {
			expect(reboots.arm(() => fired++)).toBe(true);
			expect(reboots.pending).toBe(true);
			clock.advance(wait);
			expect(reboots.pending).toBe(false);
		}
		expect(fired).toBe(TIMINGS.engineRestartBackoffMs.length);
		expect(reboots.arm(() => fired++)).toBe(false);
		expect(reboots.pending).toBe(false);
	});

	it("cancels an armed reboot", () => {
		const clock = new FakeScheduler();
		const reboots = new RebootBackoff(clock.scheduler);
		let fired = false;
		reboots.arm(() => {
			fired = true;
		});
		reboots.cancel();
		clock.advance(Math.max(...TIMINGS.engineRestartBackoffMs));
		expect(fired).toBe(false);
		expect(reboots.attempt).toBe(1);
	});
});

describe("uci-lines", () => {
	it("reads the facts the host takes from relayed lines", () => {
		expect(threadsOption("setoption name Threads value 6")).toBe(6);
		expect(threadsOption("setoption name Hash value 6")).toBeUndefined();
		expect(multipvOf("info depth 9 multipv 3 score cp 10")).toBe(3);
		expect(multipvOf("info depth 9 score cp 10")).toBe(1);
		expect(npsOf("info depth 9 nps 123456")).toBe(123456);
		expect(npsOf("info depth 9")).toBeUndefined();
		expect(idName("id name Stockfish 19 ")).toBe("Stockfish 19");
		expect(idName("id author x")).toBeUndefined();
		expect(isBadNnue("BAD_NNUE nn-aaaaaaaaaaaa.nnue")).toBe(true);
		expect(isBadNnue("abort")).toBe(false);
	});
});
