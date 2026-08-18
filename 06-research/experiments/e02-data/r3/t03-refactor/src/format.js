export function formatRange(value, min, max) {
	const c = Math.min(Math.max(value, min), max);
	return `[${c}/${min}..${max}]`;
}
