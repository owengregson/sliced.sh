import type { ResignStep } from "@core/constants/messages";
import { RESIGN } from "@core/constants/resign";
import { sampleRange } from "@core/motor/geometry";
import type { Pt } from "@core/motor/types";
import {
	type ControlRead,
	NativeControlInput,
	type NativeControlInputOptions,
} from "@service/native-control-input";

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
					const read: ControlRead = (targetId, point) =>
						this.read(tabId, step, gesture.signal, targetId, point);
					if ((await gesture.attachAndClick(read)).status !== "clicked")
						return { status: "not-ready", step };
					step = "confirm";
					await gesture.wait(sampleRange(RESIGN.confirmDelayMs, this.options.rng));
					// The prompt can arrive after the click receipt, so allow a bounded render window.
					const giveUp = gesture.now() + RESIGN.confirmWaitMs;
					let confirm = await read();
					while (confirm.status !== "ready" && gesture.now() < giveUp) {
						await gesture.wait(RESIGN.confirmPollMs);
						confirm = await read();
					}
					if (confirm.status !== "ready") return { status: "not-ready", step };
					return (await gesture.clickControl(confirm.target, read))
						? { status: "resigned" }
						: { status: "not-ready", step };
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
