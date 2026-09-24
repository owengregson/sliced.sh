import type { NewGameTargetResult, RematchAction } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import type { Pt } from "@core/motor/types";
import { NativeControlInput, type NativeControlInputOptions } from "@service/native-control-input";

export type NewGameInputStatus = "started" | "searching" | "not-ready" | "in-game";
export type NewGameControl = { kind: "new" } | { kind: "rematch"; action: RematchAction };
export type NewGameInputOptions = NativeControlInputOptions;
const NEW_GAME: NewGameControl = { kind: "new" };

/** One native button gesture per attempt. Subsequent lobby steps use fresh discovery. */
export class NewGameInput {
	private readonly input: NativeControlInput;

	constructor(private readonly options: NewGameInputOptions) {
		this.input = new NativeControlInput(options);
	}

	async attempt(
		tabId: number,
		gameId: string | null,
		signal: AbortSignal,
		control: NewGameControl = NEW_GAME
	): Promise<{ status: NewGameInputStatus }> {
		try {
			return (
				(await this.input.run<{ status: NewGameInputStatus }>(tabId, signal, async (gesture) => {
					const click = await gesture.attachAndClick((targetId, point) =>
						this.read(tabId, gameId, control, gesture.signal, targetId, point)
					);
					if (click.status === "clicked") return { status: "started" };
					return { status: click.status === "missed" ? "not-ready" : click.status };
				})) ?? { status: "not-ready" }
			);
		} catch {
			return { status: "not-ready" };
		}
	}

	dispose(): void {
		this.input.dispose();
	}

	private async read(
		tabId: number,
		gameId: string | null,
		control: NewGameControl,
		signal: AbortSignal,
		targetId?: string,
		point?: Pt
	): Promise<NewGameTargetResult> {
		const revalidation = {
			...(targetId !== undefined ? { targetId } : {}),
			...(point !== undefined ? { point } : {}),
		};
		if (control.kind === "rematch")
			return this.options.link.request(
				tabId,
				{ kind: "rematch", action: control.action, ...revalidation },
				TIMINGS.autoQueueRequestTimeoutMs,
				signal
			);
		return this.options.link.request(
			tabId,
			{ kind: "startNewGame", gameId, ...revalidation },
			TIMINGS.autoQueueRequestTimeoutMs,
			signal
		);
	}
}
