import { log } from "@core/logger";
import type { Site } from "@typedefs/game";
import type { ProbeReport } from "../contract";

/** Logs a self-check's required selector misses and extra warnings only when they change. */
export class ProbeLog {
	private lastSignature: string | null = null;

	constructor(private readonly site: () => Site) {}

	report(report: ProbeReport, required: ReadonlySet<string>, warnings: string[]): void {
		const misses = report.misses.filter((c) => required.has(c));
		const signature = `${misses.join(",")}|${warnings.join(";")}`;
		if (signature === this.lastSignature) return;
		this.lastSignature = signature;
		for (const concern of misses) log.warn("adapter.selectorMiss", { site: this.site(), concern });
		for (const w of warnings) log.warn(w);
	}
}
