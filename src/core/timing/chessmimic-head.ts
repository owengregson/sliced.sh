/**
 * ChessMimic timing head (§8.4b item 6, Appendix J §B; Task 34). The service-worker side of
 * the shipped head: it builds the model inputs (`chessmimic-tokeniser`: FEN tokens, last-12
 * move window; raw rating and clocks, the virtual 300 s clock for clockless games), picks the
 * nearest registered band, sends the query through the injected `infer` port (normally
 * `createTimingInferPort` over the engine port → `timing-inference.ts` in the offscreen
 * document, onnxruntime-web) and decodes the 30 bucket probabilities that come back:
 * `player_clock + increment` mask, temperature-scaled bucket draw, empirical within-bucket
 * draw (`chessmimic-buckets`), persona `s_game` shift and the AR(1) residual on top.
 *
 * The offscreen host standardises the rating/clocks with the scalers of the band that actually
 * answers (it may substitute the nearest loaded band), so the reply names that band and the
 * decoding uses its bucket tables. Inference runs under a 100 ms budget; on timeout, load
 * failure, a malformed reply or an unprepared position the v1 head answers.
 *
 * The parts live under `./chessmimic-head/`: `bands` (band selection), `inputs` (the model
 * inputs), `inference` (the port and its budget) and `head` (the `DistributionHead`).
 */

import type { ChessMimicBand } from "@core/constants/models";

export { CHESSMIMIC_BANDS, selectBand } from "./chessmimic-head/bands";
export { ChessMimicHead, type ChessMimicHeadOptions } from "./chessmimic-head/head";
export type { InferPort, InferResult } from "./chessmimic-head/inference";
export { buildInputs, type ChessMimicInputs } from "./chessmimic-head/inputs";
export type { ChessMimicBand };
