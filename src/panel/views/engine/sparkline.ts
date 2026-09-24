/**
 * The nps sparkline: a ring of ≤ `LIMITS.npsSparklineSamples` samples drawn as an SVG polyline.
 * Geometry is token-sized here; colours come from `css/views/engine.css` (theme tokens).
 */

import { LIMITS } from "@core/constants/limits";
import { TOKENS } from "@design/tokens.generated";
import { COPY } from "../../copy";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface Sparkline {
	push(value: number): void;
	dispose(): void;
}

export function createSparkline(
	host: HTMLElement,
	label: string = COPY.engineView.sparkline,
	capacity: number = LIMITS.npsSparklineSamples
): Sparkline {
	const width = capacity * TOKENS.unit;
	const height = TOKENS.space[8];
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("class", "sl-engine__spark-svg");
	svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
	svg.setAttribute("width", String(width));
	svg.setAttribute("height", String(height));
	svg.setAttribute("preserveAspectRatio", "none");
	const area = document.createElementNS(SVG_NS, "polygon");
	area.setAttribute("class", "sl-engine__spark-area");
	const line = document.createElementNS(SVG_NS, "polyline");
	line.setAttribute("class", "sl-engine__spark-line");
	svg.append(area, line);
	host.replaceChildren(svg);
	host.setAttribute("aria-label", label);
	const samples: number[] = [];

	function render(): void {
		const max = Math.max(1, ...samples);
		const step = samples.length > 1 ? width / (samples.length - 1) : 0;
		const points = samples.map((v, i) => {
			const x = samples.length > 1 ? i * step : width;
			const y = height - (v / max) * height;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		});
		line.setAttribute("points", points.join(" "));
		const first = points[0];
		const last = points[points.length - 1];
		area.setAttribute(
			"points",
			first && last
				? [`${first.split(",")[0]},${height}`, ...points, `${last.split(",")[0]},${height}`].join(" ")
				: ""
		);
	}

	return {
		push(value) {
			samples.push(Math.max(0, value));
			if (samples.length > capacity) samples.shift();
			render();
		},
		dispose() {
			svg.remove();
		},
	};
}
