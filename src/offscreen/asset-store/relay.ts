// src/offscreen/asset-store/relay.ts
/**
 * Downloads relayed by the service worker (the offscreen document is COEP-restricted): the
 * request message goes out, base64 chunks come back over the same port (`handleChunk`) and are
 * reassembled in index order with progress callbacks. Chunks carry base64 because runtime ports
 * JSON-serialise their payloads (see `NnueChunk`).
 *
 * Every download carries a **stall** budget, rearmed by each chunk that makes progress: a
 * service worker that never answers (no handler registered, the relay wedged, the port silently
 * dead) rejects the download instead of leaving a promise pending forever. The budget is a stall,
 * not a total, so a slow 72 MB NNUE still finishes; only a new, non-empty index rearms, so a
 * repeated or empty chunk cannot extend a download indefinitely, and a whole-transfer backstop
 * caps it regardless.
 */

import type { EnginePortMessage } from "@core/constants/messages";
import { log } from "@core/logger";
import { base64ToBytes } from "@core/util/base64";
import type { TimerScheduler } from "@core/util/scheduler";
import { errorMessage } from "../shared/errors";
import type { AssetChunk } from "./types";

/** Rejection message when the relay went quiet; the caller may retry or substitute. */
export const ASSET_DOWNLOAD_STALLED = "download stalled";
/** Rejection message when a download ran past its whole-transfer backstop. */
export const ASSET_DOWNLOAD_TOO_LONG = "download exceeded its total budget";

interface Download {
	chunks: Array<Uint8Array | undefined>;
	received: number;
	total: number;
	resolve: (data: Uint8Array) => void;
	reject: (error: Error) => void;
	/** Stall-budget timer handle; cleared whenever the download leaves `downloads`. */
	timer: unknown;
	/** Whole-download backstop handle; cleared with `timer`. */
	totalTimer: unknown;
}

export interface DownloadRelayDeps {
	/** Log prefix, e.g. `nnue-store`. */
	label: string;
	/** Posts the download request to the service worker. */
	post: (msg: EnginePortMessage) => void;
	/** The port message asking the service worker to download `name`. */
	request(name: string): EnginePortMessage;
	onProgress: ((name: string, progress: number) => void) | undefined;
	scheduler: TimerScheduler;
	stallMs: number;
	totalMs: number;
}

/** The chunks laid end to end, skipping holes. */
function concat(chunks: ReadonlyArray<Uint8Array | undefined>): Uint8Array {
	let length = 0;
	for (const c of chunks) length += c?.length ?? 0;
	const out = new Uint8Array(length);
	let at = 0;
	for (const c of chunks) {
		if (!c) continue;
		out.set(c, at);
		at += c.length;
	}
	return out;
}

export class DownloadRelay {
	private readonly downloads = new Map<string, Download>();

	constructor(private readonly deps: DownloadRelayDeps) {}

	/** Ask the service worker for `name`; resolves with the reassembled bytes (unverified). */
	download(name: string): Promise<Uint8Array> {
		const { scheduler: sched, totalMs } = this.deps;
		return new Promise<Uint8Array>((resolve, reject) => {
			const d: Download = {
				chunks: [],
				received: 0,
				total: 0,
				resolve,
				reject,
				timer: undefined,
				totalTimer: undefined,
			};
			this.downloads.set(name, d);
			this.rearmStall(name, d);
			d.totalTimer = sched.setTimeout(() => {
				this.abandon(name, d, ASSET_DOWNLOAD_TOO_LONG, { totalMs });
			}, totalMs);
			this.deps.post(this.deps.request(name));
		});
	}

	/** Route every relayed chunk of this family here. */
	handleChunk(msg: AssetChunk): void {
		const { label } = this.deps;
		const d = this.downloads.get(msg.name);
		if (!d) {
			log.debug(`${label}: chunk for an asset nobody requested`, { name: msg.name });
			return;
		}
		if ("error" in msg) {
			this.take(msg.name);
			d.reject(new Error(msg.error));
			return;
		}
		let bytes: Uint8Array;
		try {
			bytes = base64ToBytes(msg.bytes);
		} catch (error) {
			this.take(msg.name);
			d.reject(new Error(`${label} chunk ${msg.index} undecodable: ${errorMessage(error)}`));
			return;
		}
		d.total = msg.total;
		// Only a new, non-empty index counts as progress, so a repeated or empty chunk cannot
		// keep rearming the stall budget forever.
		const progressed = d.chunks[msg.index] === undefined && bytes.length > 0;
		if (d.chunks[msg.index] === undefined) d.received++;
		d.chunks[msg.index] = bytes;
		if (progressed) this.rearmStall(msg.name, d);
		this.deps.onProgress?.(msg.name, d.total > 0 ? d.received / d.total : 1);
		if (d.received < d.total) return;
		this.take(msg.name);
		d.resolve(concat(d.chunks));
	}

	/** Fail every pending download (the port went away). */
	abortAll(reason: string): void {
		const sched = this.deps.scheduler;
		const pending = [...this.downloads.values()];
		this.downloads.clear();
		for (const d of pending) {
			sched.clearTimeout(d.timer);
			sched.clearTimeout(d.totalTimer);
			d.reject(new Error(reason));
		}
	}

	/** Drop `name`'s download and stop its timers; returns the entry if there was one. */
	private take(name: string): Download | undefined {
		const sched = this.deps.scheduler;
		const d = this.downloads.get(name);
		if (!d) return undefined;
		this.downloads.delete(name);
		sched.clearTimeout(d.timer);
		sched.clearTimeout(d.totalTimer);
		return d;
	}

	/** Drop `name`'s download, stop both of its timers and reject it. */
	private abandon(name: string, d: Download, why: string, detail: Record<string, unknown>): void {
		const sched = this.deps.scheduler;
		if (this.downloads.get(name) !== d) return;
		this.downloads.delete(name);
		sched.clearTimeout(d.timer);
		sched.clearTimeout(d.totalTimer);
		log.warn(`${this.deps.label}: ${why}`, {
			name,
			received: d.received,
			total: d.total,
			...detail,
		});
		d.reject(new Error(`${why}: ${name}`));
	}

	/** (Re)start `name`'s stall budget: no progress within `stallMs` rejects the download. */
	private rearmStall(name: string, d: Download): void {
		const { scheduler: sched, stallMs } = this.deps;
		sched.clearTimeout(d.timer);
		d.timer = sched.setTimeout(() => {
			this.abandon(name, d, ASSET_DOWNLOAD_STALLED, { stallMs });
		}, stallMs);
	}
}
