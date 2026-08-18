import { formatRange } from "./format.js";
import { clamp } from "./range.js";

export function add(a, b) {
	return a + b;
}

export function clampReport(n, min, max) {
	const c = clamp(n, min, max);
	return formatRange(c, min, max);
}
