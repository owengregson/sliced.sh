/**
 * SW-side log bridge: prints the `MSG.LOG` envelopes the other contexts
 * forward through `@core/logger`. Task 26 grows this into the streaming
 * bridge for the panel's devtools view.
 */

import { MSG } from "@core/constants/messages";
import { type LogEntry, printLog } from "@core/logger";
import type { MessageRouter } from "@core/messaging/router";

export function installLogBridge(router: MessageRouter): void {
	router.on(MSG.LOG, (msg, sender) => {
		const entry: LogEntry = {
			level: msg.level,
			args: msg.args,
			meta: msg.meta ?? { source: sender.url ?? "unknown", timestamp: Date.now() },
		};
		printLog(entry);
	});
}
