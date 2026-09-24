// scripts/lib/download.ts — the vendor step's only network access, logged and status-checked.

/** GET `url`, announcing it; a non-2xx status is an error naming the URL. */
export async function download(url: string): Promise<Response> {
	console.log(`downloading ${url}`);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
	return res;
}
