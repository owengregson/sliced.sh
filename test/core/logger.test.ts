// test/core/logger.test.ts
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
	__setLogSinkOutsideServiceWorker,
	clearLogSink,
	getLogLevel,
	LOG_PREFIX,
	log,
	printLog,
	setLogLevel,
	setLogSink,
} from "@core/logger";

afterEach(() => {
	setLogLevel("info");
	__setLogSinkOutsideServiceWorker(false);
});

describe("logger", () => {
	it("printLog honours the level and prefixes [sliced]", () => {
		const info = spyOn(console, "info").mockImplementation(() => {});
		const debug = spyOn(console, "debug").mockImplementation(() => {});
		printLog({ level: "info", args: ["hi"], meta: { source: "test", timestamp: 1 } });
		printLog({ level: "debug", args: ["quiet"], meta: { source: "test", timestamp: 1 } });
		expect(info).toHaveBeenCalledTimes(1);
		expect(info.mock.calls[0]?.[0]).toBe(LOG_PREFIX);
		expect(debug).not.toHaveBeenCalled();
		setLogLevel("debug");
		printLog({ level: "debug", args: ["loud"], meta: { source: "test", timestamp: 1 } });
		expect(debug).toHaveBeenCalledTimes(1);
		expect(getLogLevel()).toBe("debug");
		info.mockRestore();
		debug.mockRestore();
	});
	it("the sink applies outside a service worker only with the test-only opt-in; clearLogSink is owner-checked", () => {
		const seen: string[] = [];
		const mine = (e: { args: unknown[] }): void => void seen.push(String(e.args[0]));
		setLogSink(mine);
		log.info("forwarded, not sunk");
		expect(seen).toEqual([]);
		__setLogSinkOutsideServiceWorker(true);
		log.info("sunk");
		expect(seen).toEqual(["sunk"]);
		clearLogSink(() => {}); // someone else's sink: ours stays
		log.info("still sunk");
		expect(seen).toEqual(["sunk", "still sunk"]);
		clearLogSink(mine);
		log.info("gone");
		expect(seen).toEqual(["sunk", "still sunk"]);
	});

	it("log.* never throws outside the service worker, even with a stub chrome", () => {
		expect(() => {
			log.debug("a");
			log.info("b", { c: 1 });
			log.warn(new Error("w"));
			log.error("e");
		}).not.toThrow();
	});
});
