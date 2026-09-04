// test/core/util/lru.test.ts
import { describe, expect, it } from "bun:test";
import { LruCache } from "@core/util/lru";

describe("LruCache", () => {
	it("evicts the least recently used entry at capacity", () => {
		const c = new LruCache<string, number>(2);
		c.set("a", 1);
		c.set("b", 2);
		c.set("c", 3);
		expect(c.has("a")).toBe(false);
		expect(c.get("b")).toBe(2);
		expect(c.get("c")).toBe(3);
		expect(c.size).toBe(2);
	});
	it("get moves an entry to the front", () => {
		const c = new LruCache<string, number>(2);
		c.set("a", 1);
		c.set("b", 2);
		expect(c.get("a")).toBe(1);
		c.set("c", 3);
		expect(c.has("b")).toBe(false);
		expect(c.has("a")).toBe(true);
	});
	it("set on an existing key updates and refreshes it", () => {
		const c = new LruCache<string, number>(2);
		c.set("a", 1);
		c.set("b", 2);
		c.set("a", 10);
		c.set("c", 3);
		expect(c.has("b")).toBe(false);
		expect(c.get("a")).toBe(10);
		expect(c.size).toBe(2);
	});
	it("peek() reads without refreshing recency", () => {
		const c = new LruCache<string, number>(2);
		c.set("a", 1);
		c.set("b", 2);
		expect(c.peek("a")).toBe(1);
		expect(c.peek("zz")).toBeUndefined();
		c.set("c", 3);
		expect(c.has("a")).toBe(false);
	});
	it("has() does not refresh recency", () => {
		const c = new LruCache<string, number>(2);
		c.set("a", 1);
		c.set("b", 2);
		expect(c.has("a")).toBe(true);
		c.set("c", 3);
		expect(c.has("a")).toBe(false);
		expect(c.has("b")).toBe(true);
	});
	it("delete, clear, missing get", () => {
		const c = new LruCache<number, string>(3);
		c.set(1, "x");
		expect(c.delete(1)).toBe(true);
		expect(c.delete(1)).toBe(false);
		expect(c.get(1)).toBeUndefined();
		c.set(2, "y");
		c.clear();
		expect(c.size).toBe(0);
	});
	it("rejects a non-positive capacity", () => {
		expect(() => new LruCache(0)).toThrow();
	});
});
