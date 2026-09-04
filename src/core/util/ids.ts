let counter = 0;

/** Unique id: `crypto.randomUUID()` when available, else a time+counter fallback. */
export function newId(): string {
	const c = globalThis.crypto;
	if (c && typeof c.randomUUID === "function") return c.randomUUID();
	counter = (counter + 1) % 0xffffff;
	return `${Date.now().toString(36)}-${counter.toString(36).padStart(5, "0")}`;
}
