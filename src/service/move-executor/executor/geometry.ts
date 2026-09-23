/** The executor's geometry reads over the content link: the board, and the promotion picker. */

import { EXECUTOR } from "@core/constants/cdp";
import type { BoardGeometryReply } from "@core/constants/messages";
import { log } from "@core/logger";
import { errorMessage } from "@core/util/errors";
import type { RequestInput } from "@service/content-link";
import type { PromoPiece, Square } from "@typedefs/game";
import type { ExecutorLink } from "./types";

/** `null` when the adapter could not answer (timeout, no port, abort) — never a throw. */
export async function readBoardGeometry(
	link: ExecutorLink,
	tabId: number,
	promotion?: { piece: PromoPiece; to: Square },
	signal?: AbortSignal
): Promise<BoardGeometryReply | null> {
	try {
		const cmd: RequestInput<"geometry"> = promotion
			? {
					kind: "geometry",
					promotion: promotion.piece,
					to: promotion.to,
					timeoutMs: EXECUTOR.promotionPickerTimeoutMs,
				}
			: { kind: "geometry" };
		const budget = promotion
			? EXECUTOR.promotionPickerTimeoutMs + EXECUTOR.geometryTimeoutMs
			: EXECUTOR.geometryTimeoutMs;
		const { kind: _kind, id: _id, ...reply } = await link.request(tabId, cmd, budget, signal);
		return reply;
	} catch (error) {
		log.debug("executor: geometry unavailable", { tabId, error: errorMessage(error) });
		return null;
	}
}
