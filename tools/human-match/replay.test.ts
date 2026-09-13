// tools/human-match/replay.test.ts — smoke run of the human move-match harness on the checked-in
// Maia fixture (`--fixture`): every metric path executes and the report is well-formed. The numbers
// are meaningless by construction (synthetic human moves); nothing here is a result.
import { describe, expect, it } from "bun:test";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const SCRATCH = process.env.TMPDIR ?? "/tmp";

interface Report {
	header: string[];
	draws: number;
	buckets: Array<{
		bucket: number;
		n: number;
		logQ: number | null;
		logP: number | null;
		top1Q: number | null;
		expQ: number | null;
		bot: { lossCp: number | null; blunder: number | null };
		human: { lossCp: number | null };
		meters: { maiaShare: number | null; railed: number | null };
	}>;
}

describe("tools/human-match/replay.ts --fixture", () => {
	it("replays the fixture, writes markdown + JSON, and every bucket carries finite metrics", async () => {
		const json = path.join(SCRATCH, `sliced-human-match-smoke-${process.pid}.json`);
		const md = path.join(SCRATCH, `sliced-human-match-smoke-${process.pid}.md`);
		const proc = Bun.spawn(
			[
				process.execPath,
				path.join(ROOT, "tools/human-match/replay.ts"),
				"--fixture",
				"--draws",
				"20",
				"--limit",
				"30",
				"--out",
				md,
				"--json",
				json,
			],
			{ cwd: ROOT, stdout: "pipe", stderr: "pipe" }
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(code, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);
		const report = (await Bun.file(json).json()) as Report;
		expect(report.draws).toBe(20);
		expect(report.header.join(" ")).toContain("Smoke run");
		expect(report.buckets.length).toBeGreaterThan(0);
		let positions = 0;
		for (const b of report.buckets) {
			positions += b.n;
			expect(Number.isFinite(b.logQ)).toBe(true);
			expect(Number.isFinite(b.logP)).toBe(true);
			expect(b.top1Q).toBeGreaterThanOrEqual(0);
			expect(b.expQ).toBeLessThanOrEqual(1);
			expect(b.bot.lossCp).toBeGreaterThanOrEqual(0);
			expect(b.meters.maiaShare).toBeGreaterThan(0);
			expect(b.meters.railed ?? 0).toBeLessThanOrEqual(1);
		}
		expect(positions).toBe(30);
		const text = await Bun.file(md).text();
		expect(text).toContain("| E[log q(m_human)]  (wrapper) |");
		expect(text).toContain("| lag-1 loss autocorrelation bot / human |");
	}, 12_000);
});
