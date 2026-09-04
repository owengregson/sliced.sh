// test/core/util/dedupe-async.test.ts
import { describe, expect, it } from "bun:test";
import { dedupeAsync } from "@core/util/dedupe-async";

describe("dedupeAsync", () => {
	it("shares one in-flight promise, then runs again after settling", async () => {
		let calls = 0;
		let release: (v: number) => void = () => {};
		const fn = dedupeAsync(
			() =>
				new Promise<number>((r) => {
					calls++;
					release = r;
				})
		);
		const p1 = fn();
		const p2 = fn();
		expect(p1).toBe(p2);
		release(7);
		expect(await p1).toBe(7);
		expect(calls).toBe(1);
		const p3 = fn();
		expect(p3).not.toBe(p1);
		release(8);
		expect(await p3).toBe(8);
		expect(calls).toBe(2);
	});
	it("clears the in-flight slot on rejection", async () => {
		let n = 0;
		const fn = dedupeAsync(async () => {
			n++;
			if (n === 1) throw new Error("first");
			return n;
		});
		await expect(fn()).rejects.toThrow("first");
		expect(await fn()).toBe(2);
	});
});
