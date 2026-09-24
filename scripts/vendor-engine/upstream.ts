// scripts/vendor-engine/upstream.ts — where the vendored Stockfish comes from and where it lands.

import path from "node:path";
import { ROOT } from "../lib/paths";

export const PACKAGE_NAME = "@lichess-org/stockfish-web";
export const PACKAGE_DIR = path.join(ROOT, "node_modules", ...PACKAGE_NAME.split("/"));
export const PACKAGE_REPO = "https://github.com/lichess-org/stockfish-web";
export const STOCKFISH_REPO = "https://github.com/official-stockfish/Stockfish";
/**
 * Upstream base of the `sf_19` targets (package README). These two values are the written offer of
 * corresponding source (GPL-3.0 §6 / AGPL-3.0 §6) rendered into `docs/third-party.md`: no check
 * verifies them against the installed package, so they must be updated by hand with the version.
 */
export const STOCKFISH_BASE_COMMIT = "edb0d9db6731067ec50ce619ff372b463bc4dd5d";
export const STOCKFISH_TAG = "sf_19";

export const LICENSE_FILE = "LICENSE";
export const TYPES_FILE = "stockfishWeb.d.ts";
export const TYPES_DEST = path.join(ROOT, "src", "types", "stockfish-web.d.ts");
export const DOCS_DEST = path.join(ROOT, "docs", "third-party.md");
