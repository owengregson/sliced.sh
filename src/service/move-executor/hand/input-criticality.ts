/**
 * The hand's input-critical signal (`HandControllerDeps.onCriticalInput` / `onInputDeadline`):
 * whether synchronous classification must yield right now — a committed approach, a held button or
 * a travel in progress — and the absolute moment the next input is due. Independent review search
 * may continue throughout; this only tells the executor's `InputCriticalWindow` when to close.
 */
export class InputCriticality {
	private committed = false;
	private pressed = false;
	private travelling = false;
	private critical = false;
	private deadline: number | null = null;

	constructor(
		/** Absolute approach start, refined from actual geometry; null once input has finished. */
		private readonly onDeadline: ((atMs: number | null) => void) | null,
		/** Synchronous classification must yield, but independent review search may continue. */
		private readonly onCritical: ((busy: boolean) => void) | null
	) {}

	setDeadline(atMs: number | null): void {
		this.deadline = atMs;
		this.onDeadline?.(atMs);
	}

	/**
	 * A stationary wait is usable only until the next action's input lead. Keep the
	 * original committed-approach boundary if it is earlier than this local pause.
	 */
	pauseUntil(atMs: number): void {
		this.onDeadline?.(Math.min(this.deadline ?? Infinity, atMs));
	}

	/** The pause is over: republish the standing boundary. */
	resumeDeadline(): void {
		this.onDeadline?.(this.deadline);
	}

	/** From the committed approach on, input stays critical until `finish()`. */
	commit(): void {
		this.committed = true;
		this.update();
	}

	setPressed(pressed: boolean): void {
		this.pressed = pressed;
		this.update();
	}

	setTravelling(travelling: boolean): void {
		this.travelling = travelling;
		this.update();
	}

	finish(): void {
		// Clear the future guard before reopening classification. Recovery has already settled.
		this.setDeadline(null);
		this.committed = false;
		this.pressed = false;
		this.travelling = false;
		this.update();
	}

	private update(): void {
		const busy = this.committed || this.pressed || this.travelling;
		if (busy === this.critical) return;
		this.critical = busy;
		this.onCritical?.(busy);
	}
}
