import type { ResignStep } from "@core/constants/messages";
import { RESIGN } from "@core/constants/resign";
import { sampleRange } from "@core/motor/geometry";
import type { Pt } from "@core/motor/types";
import { NativeControlInput, type NativeControlInputOptions } from "@service/native-control-input";

export type ResignInputStatus = "resigned" | "not-ready" | "aborted";
export interface ResignInputResult {
	status: ResignInputStatus;
	/** The step the attempt stopped at (absent on `resigned`). */
	step?: ResignStep;
}
export type ResignInputOptions = NativeControlInputOptions;

/** Executes the resign control and its confirmation; the session decides when to resign. */
export class ResignInput {
	private readonly input: NativeControlInput;

	constructor(private readonly options: ResignInputOptions) {
		this.input = new NativeControlInput(options);
	}

	async attempt(tabId: number, signal: AbortSignal): Promise<ResignInputResult> {
		let step: ResignStep = "resign";
		try {
			return (
				(await this.input.run<ResignInputResult>(tabId, signal, async (gesture) => {
					let reply = await this.read(tabId, step, gesture.signal);
					if (reply.status !== "ready") return { status: "not-ready", step };
					await gesture.attach();
					// Attaching the debugger can move the control by adding its infobar.
					reply = await this.read(tabId, step, gesture.signal);
					if (reply.status !== "ready") return { status: "not-ready", step };
					const { target } = reply;
					if (
						!(await gesture.click(target, (point) =>
							this.read(tabId, step, gesture.signal, target.targetId, point)
						))
					)
						return { status: "not-ready", step };
					step = "confirm";
					await gesture.wait(sampleRange(RESIGN.confirmDelayMs, this.options.rng));
					// The prompt can arrive after the click receipt, so allow a bounded render window.
					const giveUp = gesture.now() + RESIGN.confirmWaitMs;
					let confirm = await this.read(tabId, step, gesture.signal);
					while (confirm.status !== "ready" && gesture.now() < giveUp) {
						await gesture.wait(RESIGN.confirmPollMs);
						confirm = await this.read(tabId, step, gesture.signal);
					}
					if (confirm.status !== "ready") return { status: "not-ready", step };
					const confirmedTarget = confirm.target;
					const clicked = await gesture.click(confirmedTarget, (point) =>
						this.read(tabId, step, gesture.signal, confirmedTarget.targetId, point)
					);
					return clicked ? { status: "resigned" } : { status: "not-ready", step };
				})) ?? { status: "not-ready" }
			);
		} catch {
			return { status: signal.aborted ? "aborted" : "not-ready", step };
		}
	}

	dispose(): void {
		this.input.dispose();
	}

	private read(tabId: number, step: ResignStep, signal: AbortSignal, targetId?: string, point?: Pt) {
		return this.options.link.request(
			tabId,
			{
				kind: "resign",
				step,
				...(targetId !== undefined ? { targetId } : {}),
				...(point !== undefined ? { point } : {}),
			},
			RESIGN.targetTimeoutMs,
			signal
		);
	}
}
