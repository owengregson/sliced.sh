import type { PageBridge, SiteAdapter } from "@content/adapters/adapter";
import type { FeedPort } from "@content/feed-port";
import type { GamePortCommand } from "@core/constants/messages";
import type { PageKind, Site } from "@typedefs/game";

export interface ContentOptions {
	window?: Window;
	document?: Document;
	/** Injected bridge (tests); default: a `PageBridgeClient` on `window`. */
	bridge?: PageBridge & { dispose?: () => void };
	/** Injected game port factory (tests); default: `createFeedPort`. */
	port?: (onCommand: (cmd: GamePortCommand) => void) => FeedPort;
	adapterVersion?: string;
}

export interface ContentHandle {
	readonly site: Site;
	pageKind(): PageKind;
	/** `null` while the boot is deferred (no `<body>` yet). */
	adapter(): SiteAdapter | null;
	dispose(): void;
}
