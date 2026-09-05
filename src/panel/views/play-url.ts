/** Where "Play" / "Start a new game" deep-link per site (Appendix F §4.2 / §4.3), as `URLS` keys. */

import type { Site } from "@typedefs/game";
import type { UrlKey } from "../actions";

export const PLAY_URL: Readonly<Record<Site, UrlKey>> = {
	chesscom: "chesscomPlay",
	lichess: "lichessLobby",
};
