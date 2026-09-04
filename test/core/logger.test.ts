// test/core/logger.test.ts
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { getLogLevel, LOG_PREFIX, log, printLog, setLogLevel } from "@core/logger";

afterEach(() => setLogLevel("info"));

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
	it("log.* never throws outside the service worker, even with a stub chrome", () => {
		expect(() => {
			log.debug("a");
			log.info("b", { c: 1 });
			log.warn(new Error("w"));
			log.error("e");
		}).not.toThrow();
	});
});
