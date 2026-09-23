/** The CDP input backend for one execution or bout, wired to the page's pointer admission. */

import type { PreparedPointer } from "@core/constants/cdp";
import type { Pt } from "@core/motor/types";
import { CdpInputBackend } from "../cdp-input-backend";
import type { ExecutorContext } from "./context";

export function createBackend(ctx: ExecutorContext, start: Pt): CdpInputBackend {
	const link = ctx.link;
	return CdpInputBackend.forTab(ctx.debugger, ctx.tabId, start, {
		now: ctx.now,
		scheduler: ctx.scheduler,
		...(link.preparePointer
			? {
					beforeDispatch: (p: PreparedPointer, signal?: AbortSignal) =>
						link.preparePointer?.(ctx.tabId, p, signal) ?? Promise.resolve(undefined),
				}
			: {}),
		...(link.confirmPointer
			? {
					afterDispatch: (p: PreparedPointer) =>
						link.confirmPointer?.(ctx.tabId, p) ?? Promise.resolve(true),
				}
			: {}),
		onDispatch: (p) => ctx.emit("pointer", p),
	});
}
