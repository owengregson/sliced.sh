/** tools/timing-crawl/crawl/log.ts — the crawl log's line format: an ISO-second timestamp, then the message. */

export function log(msg: string): void {
	console.log(`${new Date().toISOString().slice(0, 19)} ${msg}`);
}
