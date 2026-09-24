// scripts/nnue-assets.ts — public entry for the NNUE source codec and the build's asset copy.
// The codec lives in `nnue-assets/codec.ts`; the copy step in `build/copy-assets.ts`.

export {
	type BundledAssetFilterOptions,
	bundledAssetFilter,
	copyBundledAssets,
} from "./build/copy-assets";
export { sha256Hex } from "./lib/hash";
export {
	encodeNnueSource,
	type NnueSource,
	nnueHashPrefix,
	readNnueSource,
	verifyNnueHash,
	writeBundledNnue,
} from "./nnue-assets/codec";
