declare const __SL_VERSION__: string;
declare const __SL_BUILD__: string;
declare const __SL_SPOOF_SEED__: string;
declare const __SL_LICENSE_URL__: string;
declare const __SL_LICENSE_ENFORCE__: boolean;
declare const __SL_DEBUG__: boolean;
declare module "*.html?raw" {
	const source: string;
	export default source;
}
declare namespace chrome.runtime {
	interface ManifestBase {
		debug?: boolean;
	}
}
