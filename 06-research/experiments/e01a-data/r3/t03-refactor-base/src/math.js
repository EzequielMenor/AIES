import { clamp } from "./range.js";

export function add(a, b) {
	return a + b;
}

export function clampReport(n, min, max) {
	const c = clamp(n, min, max);
	return `[${c}/${min}..${max}]`;
}
