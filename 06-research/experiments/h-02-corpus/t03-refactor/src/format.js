import { clamp } from "./range.js";

export function formatRange(value, min, max) {
	const c = clamp(value, min, max);
	return `[${c}/${min}..${max}]`;
}
