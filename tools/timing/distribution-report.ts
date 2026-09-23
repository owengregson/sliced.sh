/**
 * Fixed-position ONNX diagnostics, plus matched human PGN clocks. No assets are rewritten.
 *
 *   bun tools/timing/distribution-report.ts OUTPUT.json [PGN ...]
 *
 * The model cells are in `distribution-report/model-cells.ts`, the human groups in
 * `distribution-report/human-clocks.ts`.
 */
import "../lib/defines";
import { humanClockGroups } from "./distribution-report/human-clocks";
import { middlegamePositions, modelCells, SAMPLES } from "./distribution-report/model-cells";

async function main(argv: readonly string[]): Promise<void> {
	const output = argv[2];
	if (!output)
		throw new Error("Usage: bun tools/timing/distribution-report.ts OUTPUT.json [PGN ...]");
	const positions = middlegamePositions();
	const cells = await modelCells(positions);
	const human = await humanClockGroups(argv.slice(3));
	await Bun.write(
		output,
		`${JSON.stringify(
			{
				method:
					"Four recorded expert middlegame positions, 256 repeated plans each; rating/control substitutions are diagnostics, not held-out human calibration. PGN rows are deduplicated opponents only, first two moves excluded.",
				samplesPerCell: positions.length * SAMPLES,
				cells,
				human,
			},
			null,
			2
		)}\n`
	);
	process.stdout.write(`Wrote ${output}\n`);
}

await main(process.argv);
