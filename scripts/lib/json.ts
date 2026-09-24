// scripts/lib/json.ts — narrowing readers for untyped input (manifests, HTML attributes); no `any`.

export const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

export const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
