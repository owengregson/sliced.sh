/** Review frames by position: the deepest complete MultiPV frame the review engine produced. */

import { REVIEW } from "@core/constants/review";
import { type ReviewFrame, reviewLines } from "@core/engine/move-quality";

import { reviewKey } from "./keys";

export interface StoredFrame extends ReviewFrame {
	/** The search for this position ran to its end: nothing deeper is coming. */
	done: boolean;
}

/** A frame no further search will improve on. */
export function isFinal(frame: StoredFrame | undefined): boolean {
	return frame !== undefined && (frame.done || frame.depth >= REVIEW.targetDepth);
}

export class FrameStore {
	private readonly frames = new Map<string, StoredFrame>();

	get(key: string): StoredFrame | undefined {
		return this.frames.get(key);
	}

	/** The frame held for `fen`, without its bookkeeping. */
	frameFor(fen: string): ReviewFrame | null {
		const frame = this.frames.get(reviewKey(fen));
		return frame ? { lines: frame.lines, depth: frame.depth } : null;
	}

	clear(): void {
		this.frames.clear();
	}

	/**
	 * Keep `frame` unless a deeper one is held. Past `REVIEW.knownPositions`, the oldest frames
	 * are evicted, except the positions `pinned()` still needs (read only when evicting).
	 */
	store(key: string, frame: ReviewFrame, done: boolean, pinned: () => ReadonlySet<string>): void {
		// Remember completed shallow searches too: they cannot grade moves, but forgetting the
		// exhausted budget would immediately queue the same hopeless position forever.
		const lines = reviewLines(frame, 0);
		if (lines.length === 0 && !done) return;
		const existing = this.frames.get(key);
		if (existing && existing.depth > frame.depth) {
			if (done) existing.done = true;
			return;
		}
		this.frames.delete(key);
		this.frames.set(key, {
			lines,
			depth: frame.depth,
			done: done || (existing?.done === true && existing.depth === frame.depth),
		});
		if (this.frames.size <= REVIEW.knownPositions) return;
		const keep = pinned();
		for (const oldest of this.frames.keys()) {
			if (this.frames.size <= REVIEW.knownPositions) break;
			if (!keep.has(oldest)) this.frames.delete(oldest);
		}
	}
}
