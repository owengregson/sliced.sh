import { afterEach, beforeEach, expect, it } from "bun:test";
import { PanelRouter } from "@panel/router";
import { bootPanelDom, type PanelDom } from "./dom";

let dom: PanelDom;
beforeEach(async () => {
	dom = await bootPanelDom();
});
afterEach(async () => {
	await dom.teardown();
});

it("disposing during an async mount aborts it, runs its cleanup, and drops queued routes", async () => {
	const container = document.createElement("main");
	let finish: (() => void) | undefined;
	let cleanupCount = 0;
	let laterMounts = 0;
	let signal: AbortSignal | undefined;
	const router = new PanelRouter(container, {
		waiting: {
			async mount(ctx) {
				signal = ctx.signal;
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				container.append(document.createElement("section"));
				return () => {
					cleanupCount += 1;
				};
			},
		},
		settings: {
			mount() {
				laterMounts += 1;
				return () => {};
			},
		},
	});
	const mounting = router.switch("waiting");
	const queued = router.switch("settings");
	await dom.tick(0);
	router.dispose();
	expect(signal?.aborted).toBe(true);
	finish?.();
	await mounting;
	await queued;
	expect(cleanupCount).toBe(1);
	expect(laterMounts).toBe(0);
	expect(router.current).toBeNull();
	expect(container.children).toHaveLength(0);
});
