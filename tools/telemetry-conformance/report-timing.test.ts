import { expect, it } from "bun:test";
import path from "node:path";

it("keeps full-turn time out of physical hold statistics while reading legacy exports", async () => {
	const script = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("conformance", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
rows = [
    {"actualMs": 4000, "executionMs": 3500},
    {"actualMs": 4000, "executionMs": 3500, "telemetry": {"ac": {"MoveHoldTime": 3400}}},
    {"actualMs": 3200},
    {"actualMs": None},
]
print(json.dumps([module.hold_ms(row) for row in rows]))`;
	const proc = Bun.spawn(["python3", "-c", script, path.resolve(import.meta.dir, "report.py")], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	const error = await new Response(proc.stderr).text();
	expect(await proc.exited, error).toBe(0);
	expect(JSON.parse(out)).toEqual([3500, 3400, 3200, null]);
});
